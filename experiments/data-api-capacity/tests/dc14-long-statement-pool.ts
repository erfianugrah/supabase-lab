/**
 * DC14 - When Data API requests run statements of a few seconds, does a
 * larger `db_pool` help, and does it matter whether the statement waits
 * (pg_sleep) or computes (CPU)?
 *
 * Reasoned, not measured before this module: a request that waits holds a
 * connection and no CPU, so a pool sized to the concurrent requests should
 * turn queueing (504 PGRST003) into 200s; a request that computes holds a
 * core as well, so past the core count a larger pool only shares the cores
 * among more statements (longer latency, no more throughput). Competing
 * hypothesis: the pool is the limit for both kinds on 2XL at these rates.
 *
 * On the project's current size (DC13 leaves it at 2XL), arms in order:
 * `db_pool` as found (unset), then each PVLAB_DC14_POOLS value (default
 * 140,200) PATCHed and the restart waited for. Per arm and kind:
 *   burst x1.5 and x3   K concurrent requests (K = 1.5 and 3 x the arm's pool)
 *   open loop           PVLAB_DC14_RATE_SLEEP (40) or _CPU (4) requests per
 *                       second for PVLAB_DC14_OPEN_S (120) s, sent on schedule
 *                       whether or not earlier ones answered
 * Kinds: `sleep` = dc_sleep_xl(PVLAB_DC14_S, default 3); `cpu` =
 * dc14_cpu(n), a plpgsql loop of sqrt additions with n calibrated in DC14a to
 * take PVLAB_DC14_S seconds alone. Both carry `set statement_timeout = '180s'`.
 * Requests use the legacy service_role key from this lab's Mac (project in
 * ap-southeast-1; the vantage RTT is recorded in DC14a). Recorded: outcomes by
 * status/code, latency p50/p95 (all answers and the 200s), client backends by
 * role sampled every ~3 s (max per role, max total vs max_connections),
 * authenticator backends active on CPU (wait_event null), node CPU from the
 * metrics endpoint where two scrapes differ.
 *
 * DESTRUCTIVE: creates or reuses the shared project (lib/dc.ts); PATCHes
 * PostgREST config; DC99 deletes the project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, fmtCounts, patchPostgrest, postgrestConfig, redact, rpc, skipWithoutPro, sleep, sql, waitRestart, type DcProject, type RpcResult } from "../lib/dc.js";
import { scrapeMetrics, type PoolScrape } from "../lib/metrics.js";

const POOLS = (process.env.PVLAB_DC14_POOLS || "140,200").split(",").filter(Boolean).map(Number);
const STMT_S = Number(process.env.PVLAB_DC14_S || 3);
const RATE = { sleep: Number(process.env.PVLAB_DC14_RATE_SLEEP || 40), cpu: Number(process.env.PVLAB_DC14_RATE_CPU || 4) };
const OPEN_S = Number(process.env.PVLAB_DC14_OPEN_S || 120);
const KINDS = (process.env.PVLAB_DC14_KINDS || "sleep,cpu").split(",") as Kind[];
const MULTS = (process.env.PVLAB_DC14_MULTS || "1.5,3").split(",").map(Number);
const CLIENT_TIMEOUT_MS = 240_000;
type Kind = "sleep" | "cpu";

const CPU_SQL = `
create or replace function public.dc14_cpu(n bigint) returns double precision
  language plpgsql set statement_timeout = '180s' as $$
  declare x double precision := 0; i bigint;
  begin for i in 1..n loop x := x + sqrt(i::double precision); end loop; return x; end $$;
create or replace function public.dc14_cpu_ms(n bigint) returns double precision
  language plpgsql set statement_timeout = '180s' as $$
  declare t0 timestamptz := clock_timestamp(); x double precision;
  begin x := public.dc14_cpu(n); return extract(epoch from clock_timestamp() - t0) * 1000; end $$;
grant execute on function public.dc14_cpu(bigint), public.dc14_cpu_ms(bigint) to anon, authenticated, service_role;
notify pgrst, 'reload schema';`;

const pct = (xs: number[], q: number) => {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

interface Act {
  t: number;
  byRole: Record<string, number>;
  total: number;
  authActive: number;
  authCpu: number;
}

async function actSample(ctx: Ctx, ref: string): Promise<Act | null> {
  const r = await sql(
    ctx,
    ref,
    `select coalesce(usename, '-') as u, count(*)::int as n,
            count(*) filter (where state = 'active')::int as active,
            count(*) filter (where state = 'active' and wait_event is null)::int as cpu
       from pg_stat_activity where backend_type = 'client backend' group by 1`,
    15_000,
  );
  if (!r.rows) return null;
  const byRole: Record<string, number> = {};
  let total = 0;
  let authActive = 0;
  let authCpu = 0;
  for (const row of r.rows) {
    byRole[String(row.u)] = Number(row.n);
    total += Number(row.n);
    if (row.u === "authenticator") {
      authActive = Number(row.active);
      authCpu = Number(row.cpu);
    }
  }
  return { t: Date.now(), byRole, total, authActive, authCpu };
}

interface Load {
  results: RpcResult[];
  wallMs: number;
  acts: Act[];
  scrapes: PoolScrape[];
}

/** Run `fire` while sampling pg_stat_activity (~3 s) and the metrics endpoint (~5 s). */
async function observed(ctx: Ctx, p: DcProject, fire: () => Promise<RpcResult[]>): Promise<Load> {
  const acts: Act[] = [];
  const scrapes: PoolScrape[] = [];
  let stop = false;
  const aLoop = (async () => {
    await sleep(2_000);
    while (!stop) {
      const a = await actSample(ctx, p.ref);
      if (a) acts.push(a);
      await sleep(3_000);
    }
  })();
  const mLoop = (async () => {
    while (!stop) {
      const m = await scrapeMetrics(p, 8_000);
      if (m.s) scrapes.push(m.s);
      await sleep(5_000);
    }
  })();
  const t0 = Date.now();
  const results = await fire();
  const wallMs = Date.now() - t0;
  stop = true;
  await Promise.all([aLoop, mLoop]);
  return { results, wallMs, acts, scrapes };
}

function call(p: DcProject, kind: Kind, cpuN: number): Promise<RpcResult> {
  return kind === "sleep"
    ? rpc(p.host, "dc_sleep_xl", { s: STMT_S }, p.keys.service, p.keys.service, CLIENT_TIMEOUT_MS)
    : rpc(p.host, "dc14_cpu", { n: cpuN }, p.keys.service, p.keys.service, CLIENT_TIMEOUT_MS);
}

function row(id: string, title: string, l: Load, maxConn: number, extra: Record<string, number | string>): TestResult {
  const by: Record<string, number> = {};
  for (const r of l.results) {
    const k = `${r.status}${r.code ? `/${r.code}` : ""}`;
    by[k] = (by[k] ?? 0) + 1;
  }
  const all = l.results.map((r) => r.ms);
  const ok = l.results.filter((r) => r.status === 200).map((r) => r.ms);
  const roles: Record<string, number> = {};
  for (const a of l.acts) for (const [u, n] of Object.entries(a.byRole)) roles[u] = Math.max(roles[u] ?? 0, n);
  const totalMax = l.acts.length ? Math.max(...l.acts.map((a) => a.total)) : -1;
  const authCpuMax = l.acts.length ? Math.max(...l.acts.map((a) => a.authCpu)) : -1;
  const authActiveMax = l.acts.length ? Math.max(...l.acts.map((a) => a.authActive)) : -1;
  // node CPU between the first and last scrape that differ (the payload is a stale snapshot, DC05)
  const distinct = l.scrapes.filter((s, i, arr) => i === 0 || s.busy !== arr[i - 1]!.busy);
  const f = distinct[0];
  const z = distinct[distinct.length - 1];
  const db = f && z ? z.busy - f.busy : 0;
  const di = f && z ? z.idle - f.idle : 0;
  const cpuPct = db + di > 0 ? Math.round((1000 * db) / (db + di)) / 10 : -1;
  const cpuSpanS = f && z ? Math.round((z.t - f.t) / 1000) : -1;
  const other = l.results.find((r) => r.status !== 200);
  const ok200 = by["200"] ?? 0;
  return {
    id,
    title,
    status: "info",
    detail:
      `${fmtCounts(by)} in ${Math.round(l.wallMs / 1000)} s; p50/p95 all ${pct(all, 0.5)}/${pct(all, 0.95)} ms, 200s ${pct(ok, 0.5)}/${pct(ok, 0.95)} ms; ` +
      `backends max ${totalMax}/${maxConn} (authenticator ${roles.authenticator ?? 0}, on CPU ${authCpuMax}); node CPU ${cpuPct} % over ${cpuSpanS} s`,
    measurements: {
      ...extra,
      requests: l.results.length,
      outcomes: fmtCounts(by),
      ok_200: ok200,
      pgrst003: l.results.filter((r) => r.code === "PGRST003").length,
      pgrst002: l.results.filter((r) => r.code === "PGRST002").length,
      timeout_57014: l.results.filter((r) => r.code === "57014").length,
      client_errors: l.results.filter((r) => r.status === 0).length,
      wall_s: Math.round(l.wallMs / 1000),
      ok_per_s: Math.round((10 * ok200) / (l.wallMs / 1000)) / 10,
      p50_ms: pct(all, 0.5),
      p95_ms: pct(all, 0.95),
      ok_p50_ms: pct(ok, 0.5),
      ok_p95_ms: pct(ok, 0.95),
      ok_max_ms: ok.length ? Math.max(...ok) : -1,
      backends_max_total: totalMax,
      max_connections: maxConn,
      backends_max_by_role: fmtCounts(roles),
      authenticator_active_max: authActiveMax,
      authenticator_on_cpu_max: authCpuMax,
      act_samples: l.acts.length,
      node_cpu_pct: cpuPct,
      node_cpu_span_s: cpuSpanS,
      metric_scrapes: l.scrapes.length,
      metric_pool_tuples: [...new Set(l.scrapes.map((s) => `${s.waiting}/${s.available}/${s.max}`))].join(",").slice(0, 300),
    },
    evidence: other ? redact(`${other.status} ${other.code} ${other.body || other.message}`) : undefined,
  };
}

const mod: TestModule = {
  id: "DC14",
  title: "Statements of a few seconds (sleep vs CPU) against db_pool unset/140/200",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC14");
    if (skip) return skip;
    const out: TestResult[] = [];
    const put = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id}: ${r.detail ?? ""}`.slice(0, 500));
    };
    try {
      const p = await ensureProject(ctx);
      const setup = await sql(ctx, p.ref, CPU_SQL);
      if (setup.error) throw new Error(`cpu setup: ${setup.error}`);
      await sleep(3_000);

      // DC14a: calibrate n so one dc14_cpu(n) takes STMT_S alone; vantage RTT.
      let n = 1_000_000;
      const cal: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await sql(ctx, p.ref, `select public.dc14_cpu_ms(${n}) as ms`, 120_000);
        const ms = Number(r.rows?.[0]?.ms ?? -1);
        cal.push(`${n}:${Math.round(ms)}`);
        if (ms <= 0) throw new Error(`calibration: ${r.error ?? "no row"}`);
        if (Math.abs(ms - STMT_S * 1000) < STMT_S * 100) break;
        n = Math.round((n * STMT_S * 1000) / ms);
      }
      const check: number[] = [];
      for (let i = 0; i < 3; i++) check.push(Number((await sql(ctx, p.ref, `select public.dc14_cpu_ms(${n}) as ms`, 120_000)).rows?.[0]?.ms ?? -1));
      const viaApi: number[] = [];
      for (let i = 0; i < 2; i++) viaApi.push((await call(p, "cpu", n)).ms);
      const pings: number[] = [];
      for (let i = 0; i < 5; i++) pings.push((await rpc(p.host, "dc_ping", {}, p.keys.anon, p.keys.anon, 10_000)).ms);
      const mc = Number((await sql(ctx, p.ref, "select current_setting('max_connections')::int as m")).rows?.[0]?.m ?? -1);
      const m0 = await scrapeMetrics(p);
      const cfg0 = await postgrestConfig(ctx, p.ref);
      put({
        id: "DC14a",
        title: "Setup: CPU function calibration, vantage, size",
        status: "info",
        detail: `n ${n} (steps ${cal.join(" ")}); alone in SQL ${check.map(Math.round).join("/")} ms, through the Data API ${viaApi.join("/")} ms; dc_ping ${pings.join("/")} ms; max_connections ${mc}; node CPUs ${m0.s?.cpus ?? -1}; db_pool ${cfg0.dbPool}; pool max ${m0.s?.max ?? -1}`,
        measurements: {
          cpu_n: n,
          calibration_steps: cal.join(" "),
          cpu_alone_ms: check.map(Math.round).join("/"),
          cpu_via_data_api_ms: viaApi.join("/"),
          ping_ms: pings.join("/"),
          max_connections: mc,
          node_cpus: m0.s?.cpus ?? -1,
          db_pool: cfg0.dbPool,
          pool_max: m0.s?.max ?? -1,
          stmt_s: STMT_S,
          rate_sleep: RATE.sleep,
          rate_cpu: RATE.cpu,
          open_s: OPEN_S,
        },
      });

      const arms: { label: string; pool: number | null }[] = [{ label: "unset", pool: null }, ...POOLS.map((x) => ({ label: String(x), pool: x }))];
      for (const arm of arms) {
        let effPool = arm.pool ?? (m0.s?.max && m0.s.max > 0 ? m0.s.max : 70);
        let patchInfo: Record<string, number | string> = {};
        if (arm.pool !== null) {
          const t0 = Date.now();
          const pr = await patchPostgrest(ctx, p.ref, { db_pool: arm.pool });
          const rs = await waitRestart(ctx, p.ref, t0);
          const cfg = await postgrestConfig(ctx, p.ref);
          patchInfo = { patch_status: pr.status, restart_delay_s: rs.delayS, db_pool_readback: cfg.dbPool };
          if (pr.status >= 300) {
            put({ id: `DC14-${arm.label}`, title: `PATCH db_pool ${arm.pool}`, status: "fail", detail: redact(`${pr.status} ${pr.text}`) });
            continue;
          }
          await sleep(15_000);
          effPool = arm.pool;
        }
        for (const kind of KINDS) {
          for (const mult of MULTS) {
            const k = Math.round(effPool * mult);
            const l = await observed(ctx, p, () => Promise.all(Array.from({ length: k }, () => call(p, kind, n))));
            put(row(`DC14b-${arm.label}-${kind}-x${mult}`, `db_pool ${arm.label}, ${kind} ${STMT_S} s: burst of ${k} (${mult} x ${effPool})`, l, mc, { db_pool: arm.label, kind, burst_k: k, ...patchInfo }));
            await sleep(15_000);
          }
          const rate = RATE[kind];
          const l = await observed(ctx, p, async () => {
            const ps: Promise<RpcResult>[] = [];
            const t0 = Date.now();
            const total = Math.round(rate * OPEN_S);
            for (let i = 0; i < total; i++) {
              const due = t0 + (i * 1000) / rate;
              const w = due - Date.now();
              if (w > 0) await sleep(w);
              ps.push(call(p, kind, n));
            }
            return Promise.all(ps);
          });
          put(row(`DC14c-${arm.label}-${kind}`, `db_pool ${arm.label}, ${kind} ${STMT_S} s: open loop ${rate}/s for ${OPEN_S} s`, l, mc, { db_pool: arm.label, kind, rate_per_s: rate, open_s: OPEN_S, ...patchInfo }));
          await sleep(20_000);
        }
      }
    } catch (e) {
      put({ id: "DC14", title: this.title, status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
