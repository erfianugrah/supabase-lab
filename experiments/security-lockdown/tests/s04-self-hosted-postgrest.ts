/**
 * S04 - Supabase as database only: your own PostgREST.
 *
 * The honest answer for the Data API. Proxying the managed endpoint gates
 * nothing (iap-lockdown L11). So: turn the managed Data API OFF and run your
 * own PostgREST against the same Postgres, where you control the config -
 * including db-pre-request, the IP filter that does NOT fire on hosted (L09).
 *
 *   S04a - managed Data API off (db_schema wedge): managed REST is dark.
 *   S04b - self-hosted PostgREST (make postgrest-up) serves the data the
 *          managed endpoint no longer will.
 *   S04c - the db-pre-request IP filter on the self-hosted PostgREST REJECTS
 *          a spoofed x-forwarded-for (PT403) while an allowed request serves.
 *          The exact control the managed tier cannot give.
 *
 * Needs make postgrest-up first (PVLAB_ENDPOINT_SELFHOSTED_POSTGREST);
 * self-skips otherwise. DESTRUCTIVE: wedges managed PostgREST + creates
 * objects; restores in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http, sql, waitFor } from "../lib/sec.js";

const T = "sec_own";

async function getPostgrest(ctx: Ctx) {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/postgrest`);
  return r.json as { db_schema?: string };
}

const mod: TestModule = {
  id: "S04",
  title: "Supabase-as-database: self-hosted PostgREST + db-pre-request IP filter",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const own = ctx.endpoints["selfhosted_postgrest"];
    if (!own) return [{ id: "S04", title: this.title, status: "skip", detail: "no self-hosted PostgREST endpoint - run `make postgrest-up` first" }];
    const keys = await fetchKeys(ctx);
    const results: TestResult[] = [];
    const baseline = await getPostgrest(ctx);

    try {
      // Fixture + the pre-request IP filter (PT403 maps to HTTP 403).
      await sql(ctx, `
create table if not exists public.${T} (id bigint generated always as identity primary key, note text);
truncate public.${T};
insert into public.${T} (note) values ('own-a'), ('own-b');
grant usage on schema public to anon;
grant select on public.${T} to anon;
-- IP-ban (blocklist) style. Blocking one
-- test IP keeps the filter out of the way of the S05 rate-limit path (whose
-- nginx-forwarded private IP is not on the blocklist). The container depends
-- on this function for its whole life (PGRST_DB_PRE_REQUEST), so it is NOT
-- dropped mid-run; the project teardown removes it.
create or replace function public.sec_ip_filter() returns void language plpgsql as $$
declare xff text := current_setting('request.headers', true)::json ->> 'x-forwarded-for';
begin
  if xff is not null and xff like '%203.0.113.9%' then
    raise sqlstate 'PT403' using message = 'ip banned: ' || xff;
  end if;
end$$;
grant execute on function public.sec_ip_filter() to anon;
notify pgrst, 'reload schema';
`);

      // S04a - managed Data API off.
      await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/postgrest`, { db_schema: "" });
      const managedDark = await waitFor(async () => (await http(`https://${ctx.apiHost}/rest/v1/${T}?select=id`, { key: keys.anonJwt })).status === 503, 120_000);
      const managed = await http(`https://${ctx.apiHost}/rest/v1/${T}?select=id`, { key: keys.anonJwt });
      results.push({
        id: "S04a",
        title: "managed Data API is dark",
        status: managed.status === 503 ? "pass" : "fail",
        detail: `managed REST -> ${managed.status} ${managed.code} (in ${managedDark.elapsedS}s)`,
        measurements: { managed_status: managed.status },
      });

      // S04b - self-hosted PostgREST serves the same data.
      const ownReady = await waitFor(async () => (await http(`${own}/${T}?select=id`)).status === 200, 60_000);
      const ownRead = await http(`${own}/${T}?select=id`);
      results.push({
        id: "S04b",
        title: "self-hosted PostgREST serves the data the managed endpoint will not",
        status: ownRead.status === 200 ? "pass" : "fail",
        detail: `self-hosted ${own}/${T} -> ${ownRead.status} (ready in ${ownReady.elapsedS}s). Supabase = database; the REST surface is yours.`,
        measurements: { own_status: ownRead.status },
      });

      // S04c - the IP filter rejects a spoofed x-forwarded-for.
      const spoofed = await http(`${own}/${T}?select=id`, { headers: { "x-forwarded-for": "203.0.113.9" } });
      const allowed = await http(`${own}/${T}?select=id`);
      results.push({
        id: "S04c",
        title: "db-pre-request IP filter rejects a disallowed IP (the control managed cannot give)",
        status: spoofed.status === 403 && allowed.status === 200 ? "pass" : "fail",
        detail: `spoofed x-forwarded-for=203.0.113.9 -> ${spoofed.status} ${spoofed.code}; allowed -> ${allowed.status}. The db-pre-request x-forwarded-for filter, working because we own the PostgREST config (it does NOT fire on hosted - see iap-lockdown L09).`,
        measurements: { spoofed_status: spoofed.status, allowed_status: allowed.status },
      });
    } catch (e) {
      results.push({ id: "S04err", title: "S04 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/postgrest`, { db_schema: baseline.db_schema }).catch(() => {});
      // Do NOT drop sec_ip_filter: the self-hosted PostgREST references it for
      // its whole life. Only the table is per-module. The function goes with
      // the project at teardown.
      await sql(ctx, `drop table if exists public.${T} cascade;`).catch(() => {});
    }
    return results;
  },
};
export default mod;
