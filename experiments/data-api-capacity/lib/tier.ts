/**
 * Reads shared by DC13-DC15: what the Data API pool is at the project's
 * current size, from four places that can disagree (the Management API's
 * `db_pool`, the metrics endpoint's `pgrst_db_pool_max`, the mid-burst count
 * of `authenticator` backends in PgSleep, `max_connections`), and
 * pg_stat_activity totals by role.
 *
 * The metrics payload is a snapshot that refreshes rarely (DC05: changed once
 * in 100 s of 1 s scrapes), so the pool max is read as a series over a
 * window and every distinct value is kept with its time.
 */
import type { Ctx } from "../../../harness/src/types.js";
import { authenticatorCounts, burst, fmtCounts, postgrestConfig, sleep, sql, type BurstResult, type DcProject } from "./dc.js";
import { scrapeMetrics } from "./metrics.js";

export interface PoolMaxSeries {
  /** "t+<s>:<max>" for each change, first scrape included. */
  changes: string;
  first: number;
  last: number;
  scrapes: number;
  cpus: number;
}

export async function poolMaxSeries(p: DcProject, windowS: number, everyS = 5): Promise<PoolMaxSeries> {
  const t0 = Date.now();
  const seen: string[] = [];
  let prev = Number.NaN;
  let first = -1;
  let last = -1;
  let scrapes = 0;
  let cpus = -1;
  while (Date.now() - t0 < windowS * 1000) {
    const r = await scrapeMetrics(p, 8_000);
    if (r.s) {
      scrapes++;
      if (first < 0) first = r.s.max;
      last = r.s.max;
      if (r.s.cpus > 0) cpus = r.s.cpus;
      if (r.s.max !== prev) seen.push(`t+${Math.round((Date.now() - t0) / 1000)}:${r.s.max}`);
      prev = r.s.max;
    }
    await sleep(everyS * 1000);
  }
  return { changes: seen.join(" ") || "none", first, last, scrapes, cpus };
}

export interface RoleCounts {
  /** "usename/application_name:n" for client backends, by count descending. */
  byRoleApp: string;
  /** usename -> count of client backends. */
  byRole: Record<string, number>;
  clients: number;
  maxConnections: number;
}

export async function backendsByRole(ctx: Ctx, ref: string): Promise<RoleCounts | null> {
  const r = await sql(
    ctx,
    ref,
    `select coalesce(usename, '-') as u, coalesce(nullif(application_name, ''), '-') as a, count(*)::int as n,
            current_setting('max_connections')::int as mc
       from pg_stat_activity where backend_type = 'client backend' group by 1, 2 order by 3 desc`,
    20_000,
  );
  if (!r.rows) return null;
  const byRole: Record<string, number> = {};
  let clients = 0;
  let mc = -1;
  const parts: string[] = [];
  for (const row of r.rows) {
    const n = Number(row.n);
    byRole[String(row.u)] = (byRole[String(row.u)] ?? 0) + n;
    clients += n;
    mc = Number(row.mc);
    parts.push(`${row.u}/${row.a}:${n}`);
  }
  if (mc < 0) {
    const m = await sql(ctx, ref, "select current_setting('max_connections')::int as mc", 20_000);
    mc = Number(m.rows?.[0]?.mc ?? -1);
  }
  return { byRoleApp: parts.join(" "), byRole, clients, maxConnections: mc };
}

export interface PoolReading {
  dbPool: string;
  acqTimeout: string;
  maxConnections: number;
  metrics: PoolMaxSeries;
  bursts: BurstResult[];
  /** mid-burst `authenticator` backends in PgSleep, per burst */
  pools: number[];
  idleAuthenticator: number;
}

/**
 * The pool at the current size: GET /postgrest, then `n` bursts of `k`
 * concurrent 12 s sleeps (mid-burst PgSleep count at 6 s, as DC01) while the
 * metrics endpoint is scraped for `metricsS` seconds alongside.
 */
export async function readPool(ctx: Ctx, p: DcProject, k: number, n = 2, metricsS = 90): Promise<PoolReading> {
  const cfg = await postgrestConfig(ctx, p.ref);
  const idle = await authenticatorCounts(ctx, p.ref);
  const mP = poolMaxSeries(p, metricsS);
  const bursts: BurstResult[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) await sleep(10_000);
    bursts.push(await burst(ctx, p, k, 12, 6));
  }
  const metrics = await mP;
  return {
    dbPool: cfg.dbPool,
    acqTimeout: cfg.acqTimeout,
    maxConnections: idle?.maxConnections ?? bursts[0]?.mid?.maxConnections ?? -1,
    metrics,
    bursts,
    pools: bursts.map((b) => b.mid?.sleeping ?? -1),
    idleAuthenticator: idle?.total ?? -1,
  };
}

export function poolColumns(r: PoolReading): Record<string, number | string> {
  const m: Record<string, number | string> = {
    config_db_pool: r.dbPool,
    config_acquisition_timeout: r.acqTimeout,
    max_connections: r.maxConnections,
    idle_authenticator_backends: r.idleAuthenticator,
    pgrst_db_pool_max_first: r.metrics.first,
    pgrst_db_pool_max_last: r.metrics.last,
    pgrst_db_pool_max_changes: r.metrics.changes,
    metrics_scrapes: r.metrics.scrapes,
    node_cpus: r.metrics.cpus,
  };
  r.bursts.forEach((b, i) => {
    m[`burst${i + 1}_k`] = b.k;
    m[`burst${i + 1}_mid_pgsleep`] = b.mid?.sleeping ?? -1;
    m[`burst${i + 1}_mid_authenticator_total`] = b.mid?.total ?? -1;
    m[`burst${i + 1}_mid_client_backends`] = b.mid?.clients ?? -1;
    m[`burst${i + 1}_statuses`] = fmtCounts(b.byStatus);
    m[`burst${i + 1}_codes`] = fmtCounts(b.byCode) || "none";
  });
  return m;
}

export const poolLine = (r: PoolReading) =>
  `db_pool ${r.dbPool}; max_connections ${r.maxConnections}; pgrst_db_pool_max ${r.metrics.changes}; mid-burst PgSleep ${r.pools.join(" / ")} (k ${r.bursts.map((b) => b.k).join("/")}); ` +
  `outcomes ${r.bursts.map((b) => fmtCounts(b.byStatus)).join(" | ")}`;
