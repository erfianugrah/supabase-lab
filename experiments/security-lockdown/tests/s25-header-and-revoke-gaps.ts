/**
 * S25 - four open questions left by S16, S21 and S22 (work-supabase-lab#326).
 *
 *   S25a  cf-ipcountry trust. S16 listed it among the keys that reach SQL and
 *         S22a showed a client-supplied cf-connecting-ip is refused with 403;
 *         nobody had tried to forge the country key, which a geo policy would
 *         read. Same RPC shape as S22a.
 *   S25b  PostgREST's PGRST202 near-miss hint names a real function ("Perhaps
 *         you meant to call the function public.x"). DC22 saw it with EXECUTE
 *         granted. Does it still name the function after the S21 recipe
 *         revokes EXECUTE from PUBLIC, anon and authenticated, after USAGE on
 *         public is revoked from anon and authenticated, and after USAGE is
 *         revoked from PUBLIC too (anon otherwise keeps it through PUBLIC)?
 *   S25c  the S21 blanket revoke on a project that already runs a custom
 *         access token hook and a pg_cron job, both created with default
 *         grants: does anything reaching public under another role need its
 *         own grant afterwards?
 *   S25d  a header-keyed allowlist inside a storage.objects policy. S15/S16
 *         measured header-keyed checks on PostgREST only: does the Storage API
 *         put request.headers (and cf-connecting-ip in it) in the GUC its
 *         policies see?
 *
 * Self-provisioned: one Pro-org Micro, created and deleted in this process
 * (lib/project.ts, as S23/S24). Order matters: S25a and S25d run before any
 * revoke, S25c's hook and job are proven live before the revoke, then S25b's
 * stages and S25c's after-checks follow it.
 *
 * REDACTION: the caller's address and country never leave this module. S25d
 * needs the address inside the project (it is the allowlist value), so it is
 * written into a policy that the project deletion removes; results carry
 * statuses, booleans and counts only.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { errCode, httpBody, waitFor } from "../lib/sec.js";
import { createProject, deleteProject, sleep } from "../lib/project.js";

// ZZ is a user-assigned ISO 3166 code: never a real country, never the edge's answer.
const FORGED_COUNTRY = "ZZ";
// TEST-NET-3, as S22.
const TEST_NET = "203.0.113.9";
const HINT_FN = "sec25_private_report";
const HINT_TYPO = "sec25_private_reprot";
const HOOK_FN = "sec25_hook";
const BUCKET = "sec25";

async function q(ctx: Ctx, ref: string, query: string): Promise<{ ok: boolean; json: unknown; text: string }> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, 60_000);
  return { ok: r.status >= 200 && r.status < 300, json: r.json, text: r.text.slice(0, 300) };
}

function header(json: unknown, key: string): string {
  const h = json && typeof json === "object" ? (json as Record<string, string>) : {};
  return String(h[key] ?? "").trim();
}

function jwtClaims(token: string): Record<string, unknown> {
  try {
    const b64 = (token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
  } catch {
    return {};
  }
}

const mod: TestModule = {
  id: "S25",
  title: "cf-ipcountry trust, function hints after revoke, hook and cron after the blanket revoke, request.headers in Storage policies",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 40 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    if (!ctx.orgs.pro) return [{ id: "S25", title: mod.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    try {
      const p = await createProject(ctx, "pvlab-s25-", (r) => {
        ref = r;
        ctx.log(`S25 project ${r}`);
      });
      const base = `https://${p.host}`;
      const rest = `${base}/rest/v1`;
      out.push({
        id: "S25s",
        title: "Setup: self-provisioned Pro-org Micro",
        status: "info",
        detail: `created in ${p.createS} s, ${p.pgVersion}`,
        measurements: { create_s: p.createS, pg: p.pgVersion },
      });

      // ---------------- S25a: can a caller forge cf-ipcountry?
      const s0 = await q(ctx, ref, `
create or replace function public.sec25_headers() returns json language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json, '{}'::json)
$$;
grant execute on function public.sec25_headers() to anon;
create or replace function public.${HINT_FN}() returns int language sql stable as $$ select 42 $$;
notify pgrst, 'reload schema';
`);
      if (!s0.ok) throw new Error(`setup SQL: ${s0.text}`);
      const rpc = (name: string, headers?: Record<string, string>, key = p.anon) =>
        httpBody(`${rest}/rpc/${name}`, { method: "POST", key, body: {}, headers });
      const ready = await waitFor(async () => (await rpc("sec25_headers")).status === 200, 120_000);
      if (!ready.ok) throw new Error(`sec25_headers RPC not served after ${ready.elapsedS}s`);
      const plain = await rpc("sec25_headers");
      const forged = await rpc("sec25_headers", { "cf-ipcountry": FORGED_COUNTRY });
      const realCountry = header(plain.json, "cf-ipcountry");
      const observedIp = header(plain.json, "cf-connecting-ip");
      const forgedSeen = header(forged.json, "cf-ipcountry");
      const verdict = forged.status === 403 ? "refused at the edge (403)"
        : forgedSeen === FORGED_COUNTRY ? "passed through to SQL"
        : forgedSeen !== "" ? "overwritten by the edge's own value"
        : "absent from request.headers";
      out.push({
        id: "S25a",
        title: "a client-supplied cf-ipcountry: refused, overwritten or passed through",
        status: forged.status !== 403 && forgedSeen === FORGED_COUNTRY ? "fail" : "info",
        detail: `RPC returning request.headers, anon key. No client header -> ${plain.status}, cf-ipcountry present (${realCountry !== ""}, ${realCountry.length} chars). Same call carrying cf-ipcountry=${FORGED_COUNTRY} -> ${forged.status}: ${verdict}; the value seen equals the no-header call's value: ${forgedSeen !== "" && forgedSeen === realCountry}. For comparison S22a: a client-supplied cf-connecting-ip -> 403. Status fail would mean a caller can choose the country a geo policy reads; the observed country is not recorded.`,
        measurements: {
          plain_status: plain.status,
          forged_status: forged.status,
          country_present: String(realCountry !== ""),
          forged_reached_sql: String(forgedSeen === FORGED_COUNTRY),
          forged_overwritten: String(forged.status !== 403 && forgedSeen !== "" && forgedSeen !== FORGED_COUNTRY),
          forged_equals_plain: String(forgedSeen !== "" && forgedSeen === realCountry),
        },
      });

      // ---------------- S25d: request.headers inside a storage.objects policy.
      const svc = { apikey: p.service, Authorization: `Bearer ${p.service}` };
      const mkBucket = await httpBody(`${base}/storage/v1/bucket`, { method: "POST", headers: svc, body: { id: BUCKET, name: BUCKET, public: false } });
      const files = ["control.txt", "notnull.txt", "match.txt", "mismatch.txt"];
      const uploads: number[] = [];
      for (const f of files) {
        const r = await fetch(`${base}/storage/v1/object/${BUCKET}/${f}`, {
          method: "POST",
          headers: { ...svc, "Content-Type": "text/plain" },
          body: `s25 ${f}`,
          signal: AbortSignal.timeout(15_000),
        });
        await r.text();
        uploads.push(r.status);
      }
      // One policy at a time; each stage reads an object never fetched before,
      // so a CDN hit from an earlier stage cannot answer for this one
      // (residency-facts: a cached private object is served without
      // re-evaluating the policy).
      const stage = async (using: string, file: string) => {
        const set = await q(ctx, ref, `
drop policy if exists sec25_read on storage.objects;
create policy sec25_read on storage.objects for select to anon using (bucket_id = '${BUCKET}' and (${using}));
`);
        if (!set.ok) return { status: -1, code: `policy: ${set.text.slice(0, 120)}` };
        await sleep(2_000);
        const r = await httpBody(`${base}/storage/v1/object/authenticated/${BUCKET}/${file}`, { key: p.anon });
        return { status: r.status, code: r.status === 200 ? "" : errCode(r.json, r.text) };
      };
      const ipExpr = `coalesce(current_setting('request.headers', true)::json ->> 'cf-connecting-ip', '')`;
      const ctl = await stage("true", "control.txt");
      const notNull = await stage(`current_setting('request.headers', true) is not null and current_setting('request.headers', true) <> ''`, "notnull.txt");
      const match = observedIp ? await stage(`${ipExpr} = '${observedIp.replaceAll("'", "")}'`, "match.txt") : { status: -2, code: "no cf-connecting-ip observed in S25a" };
      const mismatch = await stage(`${ipExpr} = '${TEST_NET}'`, "mismatch.txt");
      const headersInGuc = notNull.status === 200;
      const allowlistWorks = ctl.status === 200 && match.status === 200 && mismatch.status !== 200;
      out.push({
        id: "S25d",
        title: "a cf-connecting-ip allowlist in a storage.objects policy",
        status: ctl.status !== 200 ? "fail" : "info",
        detail: `Private bucket, anon key, GET /storage/v1/object/authenticated, one fresh object per stage. Bucket create -> ${mkBucket.status}, uploads ${uploads.join("/")}. Control policy (bucket only) -> ${ctl.status}. Policy "request.headers is set" -> ${notNull.status}${notNull.code ? ` (${notNull.code})` : ""}. Policy "cf-connecting-ip = the address the S25a RPC saw" -> ${match.status}${match.code ? ` (${match.code})` : ""}. Policy "cf-connecting-ip = ${TEST_NET}" -> ${mismatch.status}${mismatch.code ? ` (${mismatch.code})` : ""}. Storage puts request.headers in the policy GUC: ${headersInGuc}; the PostgREST-style allowlist works on Storage: ${allowlistWorks}.`,
        measurements: {
          bucket_status: mkBucket.status,
          control_status: ctl.status,
          headers_set_status: notNull.status,
          ip_match_status: match.status,
          ip_mismatch_status: mismatch.status,
          headers_in_guc: String(headersInGuc),
          allowlist_works: String(allowlistWorks),
        },
      });
      await q(ctx, ref, "drop policy if exists sec25_read on storage.objects;");

      // ---------------- S25c setup: hook + cron with default grants, proven live.
      const c0 = await q(ctx, ref, `
create or replace function public.${HOOK_FN}(event jsonb) returns jsonb language plpgsql stable as $$
begin
  return jsonb_set(event, '{claims,sec25}', '"hooked"');
end $$;
create extension if not exists pg_cron;
create table if not exists public.sec25_ticks (id bigint generated always as identity primary key, at timestamptz not null default now());
create or replace function public.sec25_tick() returns void language sql as $$ insert into public.sec25_ticks default values $$;
select cron.schedule('sec25', '2 seconds', 'select public.sec25_tick()');
`);
      const hookPatch = await mgmt(ctx, "PATCH", `/projects/${ref}/config/auth`, {
        hook_custom_access_token_enabled: true,
        hook_custom_access_token_uri: `pg-functions://postgres/public/${HOOK_FN}`,
      });
      const email = `s25-${Date.now()}@example.com`;
      const password = `${crypto.randomUUID()}Aa1!`;
      const created = await httpBody(`${base}/auth/v1/admin/users`, { method: "POST", key: p.service, body: { email, password, email_confirm: true } });
      const signIn = () => httpBody(`${base}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: p.anon }, body: { email, password } });
      const hooked = (r: { status: number; json: unknown }) =>
        r.status === 200 && jwtClaims(String((r.json as { access_token?: string } | undefined)?.access_token ?? "")).sec25 === "hooked";
      const live = await waitFor(async () => hooked(await signIn()), 120_000, 5_000);
      const ticks = async () => {
        const r = await q(ctx, ref, "select count(*)::int as n from public.sec25_ticks");
        return Array.isArray(r.json) ? Number((r.json[0] as { n?: number } | undefined)?.n ?? -1) : -1;
      };
      const t0 = await ticks();
      await sleep(20_000);
      const t1 = await ticks();
      out.push({
        id: "S25c0",
        title: "before the revoke: hook adds its claim, cron job ticks (default grants only)",
        status: live.ok && t1 > t0 ? "pass" : "fail",
        detail: `Hook function and cron helper created with no explicit GRANT (setup ${c0.ok ? "ok" : c0.text}). PATCH config/auth hook -> ${hookPatch.status}; user admin-create -> ${created.status}; password sign-in carried the hook's claim after ${live.elapsedS} s (${live.ok}). Cron job on a 2 s schedule: ${t1 - t0} rows in 20 s.`,
        measurements: { hook_patch: hookPatch.status, user_create: created.status, hook_live: String(live.ok), hook_live_s: live.elapsedS, cron_rows_20s_before: t1 - t0 },
      });

      const facts = async () => {
        const r = await q(ctx, ref, `
select (select coalesce(proacl::text, 'null') from pg_proc where proname = '${HOOK_FN}') as hook_acl,
       (select pg_get_userbyid(proowner) from pg_proc where proname = 'sec25_tick') as tick_owner,
       (select username from cron.job where jobname = 'sec25') as job_user`);
        const row = (Array.isArray(r.json) ? r.json[0] : {}) as Record<string, string>;
        return { hookAcl: String(row?.hook_acl ?? "?"), tickOwner: String(row?.tick_owner ?? "?"), jobUser: String(row?.job_user ?? "?") };
      };
      const f0 = await facts();

      // ---------------- S25b stage 0: hint with EXECUTE granted (the default).
      const hint = async () => {
        const typo = await rpc(HINT_TYPO);
        const exact = await rpc(HINT_FN);
        const j = (typo.json ?? {}) as { code?: string; hint?: string };
        return {
          typoStatus: typo.status,
          code: String(j.code ?? ""),
          names: String(j.hint ?? "").includes(HINT_FN),
          hintText: String(j.hint ?? "").slice(0, 120),
          exactStatus: exact.status,
          exactCode: errCode(exact.json, exact.text),
        };
      };
      const h0 = await hint();

      // ---------------- the S21 recipe, verbatim from the write-up.
      const rv = await q(ctx, ref, `
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke execute on all functions in schema public from public;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;
notify pgrst, 'reload schema';
`);
      await sleep(10_000);
      const h1 = await hint();

      // ---------------- S25c after the revoke.
      const afterSignIn = await signIn();
      const t2 = await ticks();
      await sleep(20_000);
      const t3 = await ticks();
      const f1 = await facts();
      const regrant = await q(ctx, ref, `grant execute on function public.${HOOK_FN}(jsonb) to supabase_auth_admin;`);
      const restored = await waitFor(async () => hooked(await signIn()), 60_000, 3_000);
      out.push({
        id: "S25c",
        title: "after the blanket revoke: the hook breaks sign-in until supabase_auth_admin gets EXECUTE; the cron job keeps running",
        status: rv.ok ? "info" : "fail",
        detail: `Read before the revoke: hook proacl ${f0.hookAcl}; sec25_tick owner ${f0.tickOwner}; cron.job username ${f0.jobUser}. S21 recipe applied (${rv.ok ? "ok" : rv.text}); hook proacl after ${f1.hookAcl}. One password sign-in right after -> ${afterSignIn.status} ${errCode(afterSignIn.json, afterSignIn.text)} (claim present: ${hooked(afterSignIn)}). Cron job: ${t3 - t2} rows in the next 20 s. GRANT EXECUTE on the hook to supabase_auth_admin (${regrant.ok ? "ok" : regrant.text}) -> sign-in carried the claim again after ${restored.elapsedS} s (${restored.ok}).`,
        measurements: {
          revoke_ok: String(rv.ok),
          hook_acl_before: f0.hookAcl,
          hook_acl_after: f1.hookAcl,
          tick_owner: f0.tickOwner,
          cron_job_user: f0.jobUser,
          signin_after_revoke: afterSignIn.status,
          signin_after_revoke_code: errCode(afterSignIn.json, afterSignIn.text).slice(0, 80),
          claim_after_revoke: String(hooked(afterSignIn)),
          cron_rows_20s_after: t3 - t2,
          regrant_ok: String(regrant.ok),
          hook_restored: String(restored.ok),
          hook_restored_s: restored.elapsedS,
        },
      });

      // ---------------- S25b stage 2: USAGE on public revoked too.
      const ru = await q(ctx, ref, `
revoke usage on schema public from anon, authenticated;
notify pgrst, 'reload schema';
`);
      await sleep(10_000);
      const usage = async () => {
        const r = await q(ctx, ref, "select has_schema_privilege('anon', 'public', 'USAGE') as anon_usage, (select nspacl::text from pg_namespace where nspname = 'public') as acl");
        const row = (Array.isArray(r.json) ? r.json[0] : {}) as Record<string, unknown>;
        return { anon: String(row?.anon_usage ?? "?"), acl: String(row?.acl ?? "?") };
      };
      const u2 = await usage();
      const h2 = await hint();
      const rp = await q(ctx, ref, `
revoke usage on schema public from public;
notify pgrst, 'reload schema';
`);
      await sleep(10_000);
      const u3 = await usage();
      const h3 = await hint();
      out.push({
        id: "S25b",
        title: "PGRST202 near-miss hint naming a function, before and after the S21 revoke",
        status: "info",
        detail: `Anon key, POST /rpc/${HINT_TYPO} (one transposition from public.${HINT_FN}) and the exact name. Default grants -> typo ${h0.typoStatus} ${h0.code}, hint names the function: ${h0.names}; exact ${h0.exactStatus}. After revoking EXECUTE from PUBLIC/anon/authenticated -> typo ${h1.typoStatus} ${h1.code}, names it: ${h1.names}; exact ${h1.exactStatus} ${h1.exactCode}. After also revoking USAGE on public from anon and authenticated (${ru.ok ? "ok" : ru.text}; anon still has USAGE: ${u2.anon}, nspacl ${u2.acl}) -> typo ${h2.typoStatus} ${h2.code}, names it: ${h2.names}; exact ${h2.exactStatus} ${h2.exactCode}. After revoking USAGE on public from PUBLIC as well (${rp.ok ? "ok" : rp.text}; anon has USAGE: ${u3.anon}, nspacl ${u3.acl}) -> typo ${h3.typoStatus} ${h3.code}, names it: ${h3.names}; exact ${h3.exactStatus} ${h3.exactCode}.`,
        measurements: {
          default_typo_status: h0.typoStatus,
          default_hint_names_fn: String(h0.names),
          default_exact_status: h0.exactStatus,
          revoked_typo_status: h1.typoStatus,
          revoked_hint_names_fn: String(h1.names),
          revoked_exact_status: h1.exactStatus,
          no_usage_typo_status: h2.typoStatus,
          no_usage_hint_names_fn: String(h2.names),
          no_usage_exact_status: h2.exactStatus,
          anon_usage_after_role_revoke: u2.anon,
          anon_usage_after_public_revoke: u3.anon,
          no_public_usage_typo_status: h3.typoStatus,
          no_public_usage_code: h3.code,
          no_public_usage_hint_names_fn: String(h3.names),
          no_public_usage_exact_status: h3.exactStatus,
          no_public_usage_exact_code: h3.exactCode.slice(0, 80),
        },
        evidence: `default hint: ${h0.hintText}\nrevoked hint: ${h1.hintText}\nno-usage hint: ${h2.hintText}\nno-public-usage hint: ${h3.hintText}`,
      });
    } catch (e) {
      out.push({ id: "S25x", title: "S25 aborted", status: "fail", detail: (e as Error).message.slice(0, 300) });
    } finally {
      if (ref) {
        const d = await deleteProject(ctx, ref);
        out.push({
          id: "S25z",
          title: "Teardown",
          status: d.deleteStatus >= 200 && d.deleteStatus < 300 ? "info" : "fail",
          detail: `DELETE ${d.deleteStatus}, gone from GET /projects after ${d.goneS} s`,
          measurements: { delete_status: d.deleteStatus, gone_s: d.goneS },
        });
      }
    }
    return out;
  },
};
export default mod;
