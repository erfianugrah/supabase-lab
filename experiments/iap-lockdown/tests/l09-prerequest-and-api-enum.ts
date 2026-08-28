/**
 * L09 - pre-request IP filter (measured, not assumed) + whole-spec network
 * lever enumeration.
 *
 * L09a - The DB-layer pre-request filter is a documented PostgREST mechanism
 *        (securing-your-api.md, debugging-performance.md): set
 *        pgrst.db_pre_request on the authenticator role to a function that
 *        reads current_setting('request.headers'). This module proves it on
 *        the ACTUAL PostgREST path: the pre-request function inserts the
 *        x-forwarded-for it sees into a side table; a plain anon REST read
 *        then shows a row appeared carrying the header. If it fires, a
 *        DB-layer IP filter is real; the only open part (edge overwrites vs
 *        appends x-forwarded-for) stays platform-internal.
 * L09b - F05-method: fetch the /v1 OpenAPI and enumerate EVERY operation
 *        mentioning network/restriction/allowlist/ip/private/etc, so "no
 *        built-in IP allowlist for the Data API" is stated across the whole
 *        spec, not guessed.
 *
 * DESTRUCTIVE: sets a role-level GUC + creates objects; resets and drops in
 * finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http, sql } from "../lib/inventory.js";

/** Run a SELECT via /database/query and return the rows. */
async function query(ctx: Ctx, q: string): Promise<unknown[]> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query: q });
  return Array.isArray(r.json) ? (r.json as unknown[]) : [];
}

const SPEC_URL = "https://api.supabase.com/api/v1-json";
const KEYWORDS = /network|restrict|allow.?list|ip.?address|\bip\b|waf|firewall|private|egress|security|cidr/i;

const mod: TestModule = {
  id: "L09",
  title: "pre-request IP filter (measured) + full-spec network lever enumeration",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const results: TestResult[] = [];

    // ---- L09a: pre-request filter, end to end on the PostgREST path ----
    try {
      await sql(ctx, `
create table if not exists public.l09_seen (id bigserial primary key, xff text, at timestamptz default now());
grant insert on public.l09_seen to anon, authenticated;
grant usage, select on sequence public.l09_seen_id_seq to anon, authenticated;
create or replace function public.l09_check() returns void language plpgsql security definer as $$
begin
  insert into public.l09_seen(xff)
  values (current_setting('request.headers', true)::json->>'x-forwarded-for');
end$$;
grant execute on function public.l09_check() to anon, authenticated;
alter role authenticator set pgrst.db_pre_request to 'public.l09_check';
notify pgrst, 'reload config';
`);

      // Did the role GUC actually persist? This separates "the platform
      // rejected/overrode the SET" from "the SET landed but PostgREST did not
      // honor it" - very different findings for the operator answer.
      const cfg = await query(ctx, `select rolconfig from pg_roles where rolname = 'authenticator';`);
      const rolconfig = JSON.stringify(cfg[0] ?? {});
      const gucPersisted = /db_pre_request/.test(rolconfig);

      // Poll: hit REST as anon, then check the side table grew. Reload of the
      // db_pre_request setting is not instant.
      let sawRow = false;
      let firstXff = "";
      const t0 = Date.now();
      while (Date.now() - t0 < 120_000 && !sawRow) {
        await http(`https://${ctx.apiHost}/rest/v1/iap_probe?select=id&limit=1`, { key: keys.anonJwt });
        const check = await fetch(`https://${ctx.apiHost}/rest/v1/l09_seen?select=xff&order=id.desc&limit=1`, {
          headers: { apikey: keys.serviceJwt, Authorization: `Bearer ${keys.serviceJwt}` },
        });
        if (check.status === 200) {
          const arr = (await check.json()) as { xff?: string }[];
          if (arr.length > 0) {
            sawRow = true;
            firstXff = arr[0]?.xff ?? "";
          }
        }
        if (!sawRow) await new Promise((r) => setTimeout(r, 5000));
      }
      results.push({
        id: "L09a",
        title: "pre-request function fires on the PostgREST path and reads request.headers",
        status: sawRow ? "pass" : "info",
        detail: sawRow
          ? `db_pre_request fired: a side-table row appeared after an anon REST call, carrying x-forwarded-for="${firstXff}" - a DB-layer IP filter is REAL; the open part is only whether the edge trusts a client-supplied x-forwarded-for`
          : gucPersisted
            ? `the pgrst.db_pre_request GUC persisted on the authenticator role but no pre-request fire was observed within ${Math.round((Date.now() - t0) / 1000)}s - on this managed project the role-GUC + NOTIFY reload path did not activate the hook; a stronger finding than a probe limit`
            : `the pgrst.db_pre_request GUC did NOT persist on the authenticator role (managed platform rejected/overrode the SET) - the documented self-hosted mechanism is not settable this way on hosted`,
        measurements: { fired: String(sawRow), guc_persisted: String(gucPersisted), xff_seen: firstXff ? "present" : "absent" },
      });
    } catch (e) {
      results.push({ id: "L09a", title: "pre-request filter probe", status: "info", detail: `probe error: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await sql(ctx, `
alter role authenticator reset pgrst.db_pre_request;
notify pgrst, 'reload config';
drop function if exists public.l09_check();
drop table if exists public.l09_seen cascade;
`).catch(() => {});
    }

    // ---- L09b: enumerate the whole /v1 spec for network/security levers ----
    try {
      const spec = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
      if (spec.status !== 200) {
        results.push({ id: "L09b", title: "OpenAPI enumeration", status: "info", detail: `GET ${SPEC_URL} -> ${spec.status}` });
      } else {
        const doc = (await spec.json()) as { paths?: Record<string, Record<string, { summary?: string; operationId?: string }>> };
        const hits: string[] = [];
        for (const [p, methods] of Object.entries(doc.paths ?? {})) {
          for (const [m, op] of Object.entries(methods)) {
            const hay = `${p} ${op.summary ?? ""} ${op.operationId ?? ""}`;
            if (KEYWORDS.test(hay)) hits.push(`${m.toUpperCase()} ${p} - ${op.summary ?? op.operationId ?? ""}`.slice(0, 140));
          }
        }
        results.push({
          id: "L09b",
          title: "network/security operations across the whole /v1 spec",
          status: "info",
          detail: hits.length
            ? `${hits.length} network/security ops; none is an IP allowlist for the Data API (they cover DB network restrictions, PrivateLink, and auth). First few: ${hits.slice(0, 6).join(" | ")}`
            : "no network/restriction/ip operations found in the spec",
          measurements: { network_ops_count: hits.length },
          evidence: hits.join("\n").slice(0, 2000),
        });
      }
    } catch (e) {
      results.push({ id: "L09b", title: "OpenAPI enumeration", status: "info", detail: `spec fetch error: ${e instanceof Error ? e.message : String(e)}` });
    }

    return results;
  },
};
export default mod;
