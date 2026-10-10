/**
 * SD04 - Studio and postgres-meta connect to Postgres as `postgres`, not
 * `supabase_admin`.
 *
 * self-hosted/v0.6.0 (2026-06-17) switched both services from the reserved
 * superuser `supabase_admin` to `postgres`. The compose file says so in two
 * places (PG_META_DB_USER, POSTGRES_USER_READ_WRITE); this module asks the
 * database which role the sessions run as.
 *
 *   SD04a  container environment: PG_META_DB_USER on meta and
 *          POSTGRES_USER_READ_WRITE on Studio.
 *   SD04b  the session role through each path, by running a statement that
 *          returns current_user and session_user: direct to postgres-meta
 *          (the gateway's /pg/query route, secret key) and through Studio's
 *          own pg-meta proxy (/api/platform/pg-meta/default/query, dashboard
 *          credentials).
 *   SD04c  pg_stat_activity while a pg_sleep runs on each path: the backend
 *          that holds the statement, its user and application name. This is
 *          the database's own record, independent of what the service
 *          reports.
 *   SD04d  the roles themselves: postgres is not a superuser on this image and
 *          supabase_admin is; and which services still use supabase_admin
 *          (Realtime and Supavisor connect as it, from the compose file).
 *
 * Local vantage; needs `make stack up`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { basic, envOf, http, inspect, jsonOr, rigOf, sleep, sql } from "../lib/rig";

const ID = "SD04";
const JSON_H = { "content-type": "application/json" };

async function sampleDuring(marker: string, fire: () => Promise<unknown>): Promise<string[][]> {
  const p = fire().catch(() => undefined);
  await sleep(1500);
  const rows = await sql(
    `select usename, coalesce(nullif(application_name,''),'(none)'), state from pg_stat_activity ` +
      `where query ilike '%${marker}%' and pid <> pg_backend_pid() and state = 'active'`,
  );
  await p;
  return rows;
}

const mod: TestModule = {
  id: ID,
  title: "Studio and postgres-meta connect as postgres, not supabase_admin",
  where: "local",
  requires: [],

  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = rigOf(ctx);
    if ("skip" in r) return [{ id: ID, title: this.title, status: "skip", detail: r.skip }];
    const rig = r.rig;
    const out: TestResult[] = [];
    const sk = rig.env.SUPABASE_SECRET_KEY ?? "";

    // a - configuration
    const metaEnv = envOf(await inspect("supabase-meta"));
    const studioEnv = envOf(await inspect("supabase-studio"));
    out.push({
      id: `${ID}a`,
      title: "container environment names postgres for meta and Studio",
      status: metaEnv.PG_META_DB_USER === "postgres" && studioEnv.POSTGRES_USER_READ_WRITE === "postgres" ? "pass" : "fail",
      detail: `meta PG_META_DB_USER=${metaEnv.PG_META_DB_USER ?? "unset"}; studio POSTGRES_USER_READ_WRITE=${studioEnv.POSTGRES_USER_READ_WRITE ?? "unset"}`,
      measurements: {
        meta_db_user: metaEnv.PG_META_DB_USER ?? "unset",
        studio_read_write_user: studioEnv.POSTGRES_USER_READ_WRITE ?? "unset",
      },
    });

    // b - session role through each path
    const q = '{"query":"select current_user as cu, session_user as su"}';
    const viaMeta = await http(rig, "/pg/query", { method: "POST", headers: { ...JSON_H, apikey: sk }, body: q });
    const viaStudio = await http(rig, "/api/platform/pg-meta/default/query", { method: "POST", headers: { ...JSON_H, ...basic(rig) }, body: q });
    const m = jsonOr(viaMeta.body)?.[0] ?? {};
    const s = jsonOr(viaStudio.body)?.[0] ?? {};
    out.push({
      id: `${ID}b`,
      title: "current_user and session_user are postgres through both paths",
      status: m.cu === "postgres" && m.su === "postgres" && s.cu === "postgres" && s.su === "postgres" ? "pass" : "fail",
      detail: `via /pg/query: HTTP ${viaMeta.status}, current_user ${m.cu}, session_user ${m.su}; via Studio /api/platform/pg-meta: HTTP ${viaStudio.status}, current_user ${s.cu}, session_user ${s.su}`,
      measurements: {
        meta_path_status: viaMeta.status,
        meta_path_current_user: String(m.cu ?? "none"),
        meta_path_session_user: String(m.su ?? "none"),
        studio_path_status: viaStudio.status,
        studio_path_current_user: String(s.cu ?? "none"),
        studio_path_session_user: String(s.su ?? "none"),
      },
    });

    // c - the database's own view
    const metaRows = await sampleDuring("pg_sleep(4)", () =>
      http(rig, "/pg/query", { method: "POST", headers: { ...JSON_H, apikey: sk }, body: '{"query":"select pg_sleep(4)"}' }),
    );
    const studioRows = await sampleDuring("pg_sleep(5)", () =>
      http(rig, "/api/platform/pg-meta/default/query", { method: "POST", headers: { ...JSON_H, ...basic(rig) }, body: '{"query":"select pg_sleep(5)"}' }),
    );
    const fmt = (rows: string[][]) => rows.map((x) => `${x[0]}/${x[1]}`).join(",") || "no active backend found";
    const allPostgres = (rows: string[][]) => rows.length > 0 && rows.every((x) => x[0] === "postgres");
    out.push({
      id: `${ID}c`,
      title: "pg_stat_activity: the backend running the statement belongs to postgres on both paths",
      status: allPostgres(metaRows) && allPostgres(studioRows) ? "pass" : "fail",
      detail: `while select pg_sleep(4) ran via /pg/query: ${fmt(metaRows)}; while select pg_sleep(5) ran via Studio: ${fmt(studioRows)} (usename/application_name of active backends whose query text contains the marker)`,
      measurements: {
        meta_path_backend: fmt(metaRows),
        studio_path_backend: fmt(studioRows),
      },
    });

    // d - the roles
    const roles = await sql("select rolname, rolsuper::text from pg_roles where rolname in ('postgres','supabase_admin') order by 1");
    const sup = Object.fromEntries(roles.map((x) => [x[0]!, x[1]!]));
    const users = await sql("select distinct usename from pg_stat_activity where usename is not null order by 1");
    const adminApps = await sql("select distinct coalesce(nullif(application_name,''),'(none)') from pg_stat_activity where usename = 'supabase_admin' order by 1");
    out.push({
      id: `${ID}d`,
      title: "postgres is not a superuser here; supabase_admin is and other services still use it",
      status: sup["postgres"] === "false" && sup["supabase_admin"] === "true" ? "pass" : "fail",
      detail: `rolsuper: postgres ${sup["postgres"]}, supabase_admin ${sup["supabase_admin"]}; users with live sessions: ${users.map((x) => x[0]).join(", ")}; supabase_admin application names: ${adminApps.map((x) => x[0]).join(", ")}`,
      measurements: {
        postgres_rolsuper: sup["postgres"] ?? "none",
        supabase_admin_rolsuper: sup["supabase_admin"] ?? "none",
        session_users: users.map((x) => x[0]).join(","),
        supabase_admin_apps: adminApps.map((x) => x[0]).join(","),
      },
    });
    return out;
  },
};
export default mod;
