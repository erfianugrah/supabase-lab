/**
 * S22 - the lever that survives on hosted: a header-keyed check that is not
 * the pre-request hook.
 *
 * S16 measured that the hosted edge APPENDS to x-forwarded-for after the
 * client's value (first element attacker-controlled) and that cf-connecting-ip
 * reaches SQL; it never tested cf-connecting-ip's TRUST, and every hosted
 * header probe in this suite so far has been an RPC rather than a policy. So
 * the header the doc tells readers to use had an asserted trust property, and
 * the construction it tells them to use had never been run.
 *
 * pg_headerkit (supabase-community, v1.0.0 on dbdev, last substantive commit
 * 2023-03-03) is the packaged form of the wrong answer, and
 * is reachable from the dbdev launch blog post as an IP allow/denylist recipe
 * for PostgREST, which is how it keeps getting found. It makes two independent
 * mistakes and this module separates them:
 *   - hdr.ip() is SPLIT_PART(x-forwarded-for, ',', 1) - the element the edge
 *     lets the caller choose (S22b)
 *   - 21 of its 24 functions are IMMUTABLE while reading a per-request GUC
 *     (the three STABLE ones are headers(), header() and ip()). The set
 *     includes the zero-arg in_allow_list()/in_deny_list() you would put in a
 *     policy, which call the STABLE ip(). That is a planner property and wrong
 *     no matter which header is read (S22c)
 *
 *   S22a  cf-connecting-ip trust: can a caller put one on the wire at all?
 *   S22b  two policies, same allowlist, same forged request: one keyed on
 *         cf-connecting-ip, one on the hdr.ip() expression
 *   S22c  volatility: EXPLAIN the same body as IMMUTABLE and as STABLE
 *   S22d  pg_tle: install pg_headerkit as a real EXTENSION and ask whether the
 *         platform security advisor lints extension-owned objects
 *
 * REDACTION: the project's view of the caller's address never leaves this
 * module. Results are statuses, booleans and row counts; the address lives in
 * a local and in a table inside the project that is dropped in finally.
 *
 * DESTRUCTIVE: creates three tables, several functions, two policies and
 * (S22d) a pg_tle extension; all dropped in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, httpBody, sql, waitFor } from "../lib/sec.js";

const TA = "sec22_by_cfip";
const TB = "sec22_by_hdrip";
const A = "sec22_allow";
// TEST-NET-3. Never a real address, and never published either way.
const FORGED = "203.0.113.9";

function headerVal(json: unknown, key: string): string {
  const h = json && typeof json === "object" ? (json as Record<string, string>) : {};
  return (h[key] ?? "").trim();
}

const mod: TestModule = {
  id: "S22",
  title: "header-keyed checks on hosted: cf-connecting-ip trust, the policy form, and the IMMUTABLE trap",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const keys = await fetchKeys(ctx);
    const rest = `https://${ctx.apiHost}/rest/v1`;
    let observed = "";
    try {
      await sql(ctx, `
create table if not exists public.${TA} (id bigint generated always as identity primary key);
create table if not exists public.${TB} (id bigint generated always as identity primary key);
truncate public.${TA}; truncate public.${TB};
insert into public.${TA} default values; insert into public.${TB} default values;
create table if not exists public.${A} (ip text primary key);
truncate public.${A};
create or replace function public.sec22_headers() returns json language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json, '{}'::json)
$$;
grant usage on schema public to anon;
grant execute on function public.sec22_headers() to anon;
notify pgrst, 'reload schema';
`);

      // --- S22a: can a caller put a cf-connecting-ip on the wire at all?
      // NOTIFY is asynchronous: without this wait the first call can 404 on a
      // stale PostgREST schema cache (observed once).
      const rpcReady = await waitFor(
        async () => (await httpBody(`${rest}/rpc/sec22_headers`, { method: "POST", key: keys.anonJwt, body: {} })).status === 200,
        90_000,
      );
      if (!rpcReady.ok) throw new Error(`sec22_headers RPC not served after ${rpcReady.elapsedS}s`);
      const plain = await httpBody(`${rest}/rpc/sec22_headers`, { method: "POST", key: keys.anonJwt, body: {} });
      const spoofed = await httpBody(`${rest}/rpc/sec22_headers`, {
        method: "POST", key: keys.anonJwt, body: {},
        headers: { "cf-connecting-ip": FORGED },
      });
      observed = headerVal(plain.json, "cf-connecting-ip");
      const xffPlain = headerVal(plain.json, "x-forwarded-for").split(",").map((s) => s.trim()).filter(Boolean);
      const refused = spoofed.status === 403;
      const reachedSql = headerVal(spoofed.json, "cf-connecting-ip") === FORGED;
      out.push({
        id: "S22a",
        title: "a client-supplied cf-connecting-ip is refused at the edge, not silently overwritten",
        status: plain.status === 200 && refused && !reachedSql ? "pass" : "fail",
        detail: `RPC returning request.headers with the anon key. No client header -> ${plain.status}, cf-connecting-ip present (${observed !== ""}), x-forwarded-for carried ${xffPlain.length} address(es), and cf-connecting-ip equalled its sole element (${xffPlain.length === 1 && xffPlain[0] === observed}). Same call carrying cf-connecting-ip=${FORGED} -> ${spoofed.status}: the edge REFUSES the request rather than overwriting the header, so the forged value never reaches SQL (${!reachedSql}). Addresses deliberately not recorded.`,
        measurements: {
          plain_status: plain.status,
          spoof_status: spoofed.status,
          cfip_present: String(observed !== ""),
          cfip_matches_sole_xff: String(xffPlain.length === 1 && xffPlain[0] === observed),
          forged_reached_sql: String(reachedSql),
        },
      });

      // --- S22b: the same allowlist, the same forged request, two policies.
      // sec22_hdrip is the hdr.ip() body, kept STABLE so this probe isolates
      // the HEADER CHOICE from the volatility bug S22c tests separately.
      await sql(ctx, `
create or replace function public.sec22_cfip() returns text language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json ->> 'cf-connecting-ip', '')
$$;
create or replace function public.sec22_hdrip() returns text language sql stable as $$
  select split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', '') || ',', ',', 1)
$$;
create or replace function public.sec22_allowed(candidate text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select candidate <> '' and exists (select 1 from public.${A} a where a.ip = candidate)
$$;
alter table public.${TA} enable row level security;
alter table public.${TB} enable row level security;
drop policy if exists p on public.${TA};
drop policy if exists p on public.${TB};
create policy p on public.${TA} for select to anon using (public.sec22_allowed(public.sec22_cfip()));
create policy p on public.${TB} for select to anon using (public.sec22_allowed(public.sec22_hdrip()));
grant select on public.${TA}, public.${TB} to anon;
truncate public.${A};
insert into public.${A} (ip) values ('${FORGED}');
notify pgrst, 'reload schema';
`);
      const rows = async (table: string, headers?: Record<string, string>) => {
        const r = await httpBody(`${rest}/${table}?select=id`, { key: keys.anonJwt, headers });
        return { status: r.status, n: Array.isArray(r.json) ? r.json.length : -1 };
      };
      // The forged address is in the allowlist. x-forwarded-for is the header a
      // caller CAN set (S16: the edge appends after the client's value).
      const forgeHdr = { "x-forwarded-for": FORGED };
      const cfipTable = await rows(TA, forgeHdr);
      const hdripTable = await rows(TB, forgeHdr);
      out.push({
        id: "S22b",
        title: "the hdr.ip() expression admits a forged caller; the cf-connecting-ip form does not",
        status: cfipTable.n === 0 && hdripTable.n === 1 ? "pass" : "fail",
        detail: `Allowlist contains only ${FORGED}. One request, carrying x-forwarded-for=${FORGED}, against two tables whose policies differ only in which header they read. Keyed on cf-connecting-ip -> ${cfipTable.status}, ${cfipTable.n} row(s): the forged value is not what the edge set, so the policy denies. Keyed on split_part(x-forwarded-for, ',', 1) - the hdr.ip() body - to ${hdripTable.status}, ${hdripTable.n} row(s): the caller chose an address in the allowlist and the policy admitted them.`,
        measurements: { cfip_policy_status: cfipTable.status, cfip_policy_rows: cfipTable.n, hdrip_policy_status: hdripTable.status, hdrip_policy_rows: hdripTable.n },
      });

      // --- S22c: IMMUTABLE vs STABLE on a zero-arg function reading the GUC.
      await sql(ctx, `
create or replace function public.sec22_imm() returns boolean language sql immutable as $$
  select coalesce(current_setting('request.headers', true)::json ->> 'cf-connecting-ip', '') <> ''
$$;
create or replace function public.sec22_stb() returns boolean language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json ->> 'cf-connecting-ip', '') <> ''
$$;
`);
      const planOf = async (fn: string) => {
        const r = await sql(ctx, `explain (verbose, costs off) select id from public.${TA} where public.${fn}();`);
        return r.map((row) => String(Object.values(row as Record<string, unknown>)[0] ?? "")).join("\n");
      };
      const immPlan = await planOf("sec22_imm");
      const stbPlan = await planOf("sec22_stb");
      // SQL inlining removes the function NAME from both plans; what separates
      // them is whether the GUC read survives into the executable plan.
      const immFoldedToConst = /One-Time Filter:\s*(true|false)\b/i.test(immPlan) && !/current_setting/.test(immPlan);
      const stbKeepsGuc = /current_setting/.test(stbPlan);
      out.push({
        id: "S22c",
        title: "a zero-arg IMMUTABLE function reading request.headers is evaluated at plan time",
        status: immFoldedToConst && stbKeepsGuc ? "pass" : "fail",
        detail: `Same body, same qual, two volatility classes. IMMUTABLE: the plan is a constant One-Time Filter with no current_setting call left in it (${immFoldedToConst}) - the planner evaluated the header read once and baked the answer in, dropping the scan. STABLE: the GUC read survives into the plan and runs per execution (${stbKeepsGuc}). pg_headerkit marks in_allow_list()/in_deny_list() IMMUTABLE and both take zero arguments, so a policy written with them is a plan-time constant rather than a per-request check.`,
        measurements: { immutable_folded_to_const: String(immFoldedToConst), stable_keeps_guc_read: String(stbKeepsGuc) },
        evidence: `IMMUTABLE plan:\n${immPlan}\n\nSTABLE plan:\n${stbPlan}`.slice(0, 1500),
      });

      // --- S22d: does the advisor lint EXTENSION-OWNED objects? pg_tle makes
      // the objects real extension members, which plain SQL would not.
      const avail = await sql(ctx, `select name from pg_available_extensions where name = 'pg_tle';`);
      if (avail.length === 0) {
        out.push({ id: "S22d", title: "advisor coverage of extension-owned objects", status: "skip", detail: "pg_tle absent from pg_available_extensions; an extension-MEMBER object cannot be created" });
      } else {
        const lintNames = (r: { json?: unknown }) =>
          (((r.json as { lints?: { name?: string }[] })?.lints ?? []).map((l) => l.name ?? "?"));
        const before = await mgmt(ctx, "GET", `/projects/${ctx.ref}/advisors/security`);
        const namesBefore = lintNames(before);
        const beforeLints = namesBefore.length;
        // A minimal faithful slice of pg_headerkit: the two traits under test
        // are an unpinned search_path and a table with no RLS.
        let installed = "";
        try {
          await sql(ctx, `
create extension if not exists pg_tle;
select pgtle.install_extension('sec22_hdrkit', '1.0', 'S22 slice of pg_headerkit', $_pgtle_$
  create schema if not exists hdr;
  create table hdr.allow_list (id uuid primary key default gen_random_uuid(), ip inet not null);
  create function hdr.header(item text) returns text language sql stable as 'select coalesce((current_setting(''request.headers'', true)::json)->>item, '''')';
  create function hdr.ip() returns text language sql immutable as 'select split_part(hdr.header(''x-forwarded-for'') || '','', '','', 1)';
$_pgtle_$);
create extension sec22_hdrkit;
`);
          installed = "ok";
        } catch (e) {
          installed = `install failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`;
        }
        const after = await mgmt(ctx, "GET", `/projects/${ctx.ref}/advisors/security`);
        const afterLints = ((after.json as { lints?: unknown[] })?.lints ?? []) as { name?: string; metadata?: Record<string, unknown> }[];
        const blob = JSON.stringify(afterLints);
        const mentionsHdr = /"hdr"|hdr\./.test(blob);
        const namesAfter = lintNames(after);
        // Same-run control: this module's OWN objects are plain SQL of the same
        // two shapes - sec22_cfip/_hdrip/_headers/_imm/_stb have no pinned
        // search_path, sec22_allow has no RLS. If the advisor names those in
        // the same response but not the extension's, the difference is
        // extension membership rather than the lint rules.
        const controlNamed = /sec22_/.test(blob);
        const controlLints = [...new Set(
          (((after.json as { lints?: { name?: string; metadata?: Record<string, unknown> }[] })?.lints ?? [])
            .filter((l) => /sec22_/.test(JSON.stringify(l.metadata ?? {})))
            .map((l) => l.name ?? "?")),
        )].sort().join(",") || "none";
        const addedCount = new Map<string, number>();
        for (const n of namesAfter) addedCount.set(n, (addedCount.get(n) ?? 0) + 1);
        for (const n of namesBefore) addedCount.set(n, (addedCount.get(n) ?? 0) - 1);
        const added = [...addedCount.entries()].filter(([, v]) => v > 0).map(([k, v]) => `${k}x${v}`).sort().join(",") || "none";
        out.push({
          id: "S22d",
          title: "the platform security advisor and extension-owned objects",
          status: installed === "ok" ? "info" : "fail",
          detail: installed === "ok"
            ? `pg_tle available; installed a slice of pg_headerkit as a real extension (two unpinned-search_path functions + an RLS-less table in schema hdr). Advisor lints before: ${beforeLints}, after: ${afterLints.length}; lints added: ${added}; any lint naming an hdr object: ${mentionsHdr}. Same-run control - this module's own plain-SQL objects of the same two shapes are named by: ${controlLints}. ${controlNamed && !mentionsHdr ? "The advisor raises those lints for plain SQL and not for the extension's objects in the SAME response, so extension membership is the difference and a customer installing a dbdev package gets no advisor coverage of what it brought in." : controlNamed && mentionsHdr ? "Both are flagged; extension membership makes no difference." : "The control was not flagged either, so this response does not separate membership from the lint rules."}`
            : installed,
          measurements: { lints_before: beforeLints, lints_after: afterLints.length, lints_added: added, mentions_hdr_object: String(mentionsHdr), control_plain_sql_lints: controlLints },
        });
      }
    } catch (e) {
      out.push({ id: "S22err", title: "S22 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await sql(ctx, `
drop extension if exists sec22_hdrkit cascade;
drop schema if exists hdr cascade;
select pgtle.uninstall_extension('sec22_hdrkit');
`).catch(() => {});
      await sql(ctx, `
drop policy if exists p on public.${TA};
drop policy if exists p on public.${TB};
drop table if exists public.${TA} cascade;
drop table if exists public.${TB} cascade;
drop table if exists public.${A} cascade;
drop function if exists public.sec22_headers();
drop function if exists public.sec22_allowed(text);
drop function if exists public.sec22_cfip();
drop function if exists public.sec22_hdrip();
drop function if exists public.sec22_imm();
drop function if exists public.sec22_stb();
notify pgrst, 'reload schema';
`).catch(() => {});
      out.push({ id: "S22z", title: "cleanup", status: "pass", detail: "tables, policies, functions, and the pg_tle extension dropped" });
    }
    return out;
  },
};
export default mod;
