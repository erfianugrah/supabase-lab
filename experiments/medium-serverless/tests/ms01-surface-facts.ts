/**
 * MS01 - what a fresh Medium project in Sydney presents to an IPv4-only client,
 * before anything is changed.
 *
 * Side: managed project, Team org, Medium, ap-southeast-2. Key: PAT for the
 * platform reads, `postgres` password for the socket probes. Rows:
 *
 *   MS01a  platform facts: Postgres version, max_connections, the `postgres`
 *          role's attributes (BYPASSRLS decides whether FORCE RLS could ever
 *          bind an ORM connecting as it), the logging GUCs that decide what
 *          query text reaches the logs.
 *   MS01b  the two pooler configs as the API reports them: Supavisor
 *          (host, tenant user, pool size, client cap) and the dedicated
 *          PgBouncer (pool_mode, pool size, max_client_conn, wait timeout).
 *   MS01c  add-ons selected vs available (ipv4, pitr, compute), health per
 *          service including `pg_bouncer`, DNS A/AAAA for the database host.
 *   MS01d  reachability from THIS vantage (IPv4-only) of every Postgres path,
 *          with the verbatim connect error: shared 5432/6543, dedicated 6543
 *          as `postgres` AND as `postgres.<ref>`, direct 5432.
 *
 * Nothing here asserts; every row is `info`. It is the control the rest of the
 * battery is read against, and MS01d in particular is what MS02 then changes.
 * Not settled by this module: the PgBouncer BINARY version - the admin console
 * is not exposed to tenants, so prepared-statement support is measured by
 * behaviour (pooler-semantics S01) rather than read.
 */
import { sql } from "../../../harness/src/platform";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  addons,
  dedicatedTarget,
  directTarget,
  dnsRecords,
  health,
  pgOnce,
  pgbouncerConfig,
  primaryPooler,
  sharedTargets,
} from "../lib/setup";

const mod: TestModule = {
  id: "MS01",
  title: "Medium in Sydney: platform facts, pooler configs, add-ons, reachability from IPv4",
  where: "local",
  requires: ["pat", "db"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];

    // MS01a - platform facts through the query endpoint (runs as postgres).
    const proj = await mgmt(ctx, "GET", `/projects/${ctx.ref}`);
    const pj = (proj.json ?? {}) as { region?: string; status?: string; database?: { version?: string; postgres_engine?: string; release_channel?: string } };
    const ver = await sql(ctx, "select version() as v, current_setting('server_version') as sv, current_setting('max_connections') as mc");
    const role = await sql(ctx, "select rolname, rolsuper, rolbypassrls, rolreplication from pg_roles where rolname in ('postgres','service_role','authenticator','anon','authenticated') order by 1");
    const gucs = await sql(
      ctx,
      "select name, setting from pg_settings where name in ('log_statement','log_min_duration_statement','log_min_error_statement','log_error_verbosity','log_parameter_max_length_on_error','statement_timeout','idle_in_transaction_session_timeout','idle_session_timeout','shared_buffers','work_mem','effective_cache_size') order by 1",
    );
    const roleCfg = await sql(ctx, "select rolname, array_to_string(rolconfig, ' | ') as cfg from pg_roles where rolconfig is not null order by 1");
    const v = ver.rows[0] ?? {};
    out.push({
      id: "MS01a",
      title: "platform facts: version, max_connections, role attributes, logging GUCs",
      status: ver.status < 300 ? "info" : "fail",
      detail: ver.status < 300 ? `Postgres ${String(v.sv)} on ${pj.region ?? "?"}, max_connections ${String(v.mc)}, status ${pj.status ?? "?"}` : `query endpoint HTTP ${ver.status}: ${ver.error}`,
      measurements: {
        server_version: String(v.sv ?? ""),
        max_connections: String(v.mc ?? ""),
        postgres_engine: String(pj.database?.postgres_engine ?? ""),
        release_channel: String(pj.database?.release_channel ?? ""),
        postgres_bypassrls: String(role.rows.find((r) => r.rolname === "postgres")?.rolbypassrls ?? ""),
        service_role_bypassrls: String(role.rows.find((r) => r.rolname === "service_role")?.rolbypassrls ?? ""),
        log_statement: String(gucs.rows.find((r) => r.name === "log_statement")?.setting ?? ""),
        log_min_duration_statement: String(gucs.rows.find((r) => r.name === "log_min_duration_statement")?.setting ?? ""),
        log_min_error_statement: String(gucs.rows.find((r) => r.name === "log_min_error_statement")?.setting ?? ""),
        idle_in_transaction_session_timeout: String(gucs.rows.find((r) => r.name === "idle_in_transaction_session_timeout")?.setting ?? ""),
      },
      evidence: [String(v.v ?? ""), "roles: " + JSON.stringify(role.rows), "gucs: " + JSON.stringify(gucs.rows), "role configs: " + JSON.stringify(roleCfg.rows)].join("\n"),
    });

    // MS01b - the two pooler configs.
    const sv = await primaryPooler(ctx);
    const pgb = await pgbouncerConfig(ctx);
    const { connection_string: _c1, connectionString: _c2, ...svSafe } = (sv ?? {}) as Record<string, unknown>;
    const { connection_string: _c3, ...pgbSafe } = pgb.cfg;
    out.push({
      id: "MS01b",
      title: "pooler configs: Supavisor (shared) and PgBouncer (dedicated) as the API reports them",
      status: sv && pgb.status === 200 ? "info" : "fail",
      detail: sv
        ? `shared ${sv.db_host} user ${sv.db_user} pool ${sv.default_pool_size ?? "?"} clients ${sv.max_client_conn ?? "?"}; dedicated ${pgb.cfg.pool_mode ?? "?"} pool ${pgb.cfg.default_pool_size ?? "?"} clients ${pgb.cfg.max_client_conn ?? "?"} (pgbouncer GET ${pgb.status})`
        : `pooler config unreadable`,
      measurements: {
        shared_host: sv?.db_host ?? "",
        shared_user: sv?.db_user ?? "",
        shared_default_pool_size: sv?.default_pool_size ?? "null",
        shared_max_client_conn: sv?.max_client_conn ?? "null",
        pgb_pool_mode: String(pgb.cfg.pool_mode ?? ""),
        pgb_default_pool_size: pgb.cfg.default_pool_size ?? "",
        pgb_max_client_conn: pgb.cfg.max_client_conn ?? "",
        pgb_query_wait_timeout: pgb.cfg.query_wait_timeout ?? "",
        pgb_server_lifetime: pgb.cfg.server_lifetime ?? "",
        pgb_server_idle_timeout: pgb.cfg.server_idle_timeout ?? "",
      },
      evidence: JSON.stringify({ supavisor: svSafe, pgbouncer: pgbSafe }, null, 1),
    });

    // MS01c - add-ons, health, DNS.
    const ad = await addons(ctx);
    const h = await health(ctx, ["auth", "db", "pooler", "realtime", "rest", "storage", "pg_bouncer"]);
    const dns = await dnsRecords(ctx.phzHost);
    out.push({
      id: "MS01c",
      title: "add-ons, per-service health, DNS records for the database host",
      status: "info",
      detail: `selected [${ad.selected.map((a) => a.variant).join(",") || "none"}], available [${ad.available.join(",")}]; A=${dns.a.length} AAAA=${dns.aaaa.length}; health ${Object.entries(h).map(([k, s]) => `${k}=${s}`).join(" ")}`,
      measurements: {
        addons_selected: ad.selected.map((a) => a.variant).join(",") || "none",
        addons_available: ad.available.join(","),
        dns_a_count: dns.a.length,
        dns_aaaa_count: dns.aaaa.length,
        ...Object.fromEntries(Object.entries(h).map(([k, s]) => [`health_${k}`, s])),
      },
    });

    // MS01d - reachability from this vantage, verbatim errors.
    const targets = [directTarget(ctx), dedicatedTarget(ctx)];
    if (sv) {
      const s = sharedTargets(sv);
      targets.push(s.session, s.txn);
    }
    const m: Record<string, string | number> = {};
    const ev: string[] = [];
    for (const t of targets) {
      const r = await pgOnce(t, ctx.dbPassword);
      // Key names must not carry the username: the tenant shape embeds the
      // project ref, which the evidence redactor does not scan in keys.
      m[`${t.name}_as_${t.user.startsWith("postgres.") ? "tenant_user" : t.user}`] = r.ok ? `ok ${r.ms}ms` : "refused";
      ev.push(`${t.name} ${t.host}:${t.port} as ${t.user}: ${r.ok ? `ok in ${r.ms}ms` : r.error}`);
    }
    // The dedicated pooler with the Supavisor-shaped username - does PgBouncer take it?
    const ded = dedicatedTarget(ctx);
    const alt = await pgOnce(ded, ctx.dbPassword, sv?.db_user ?? `postgres.${ctx.ref}`);
    m.dedicated_6543_as_tenant_user = alt.ok ? `ok ${alt.ms}ms` : "refused";
    ev.push(`dedicated_6543 as ${sv?.db_user ?? `postgres.${ctx.ref}`}: ${alt.ok ? `ok in ${alt.ms}ms` : alt.error}`);
    out.push({
      id: "MS01d",
      title: "reachability of every Postgres path from an IPv4-only vantage (before the IPv4 add-on)",
      status: "info",
      detail: ev.map((l) => l.replace(/^(\S+) \S+ /, "$1 ")).join("; ").slice(0, 400),
      measurements: m,
      evidence: ev.join("\n"),
    });

    return out;
  },
};
export default mod;
