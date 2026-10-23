/**
 * DC04 - Does the Data API (PostgREST) queue requests for a pool connection
 * while pool slots are free once request RATE, not request duration, is high?
 *
 * The pattern in question: `pgrst_db_pool_waiting` high while
 * `pgrst_db_pool_available` is well above 0, `pgrst_db_pool_timeouts_total`
 * flat, and PostgREST's Postgres connections mostly idle, under a high rate
 * of short requests. Candidate explanations: PostgREST GC pressure, or
 * PostgREST running out of CPU before Postgres does. DC01/DC02 only ever
 * held the pool FULL with long sleeps; this module drives short requests at
 * rising concurrency instead.
 *
 * Competing hypotheses, and what separates them:
 *   - Postgres is the bottleneck: authenticator backends mostly `active`,
 *     node CPU near 100 %, and `waiting` rises only once `available` is 0.
 *   - PostgREST itself is the bottleneck (CPU, GC, scheduler): `waiting` rises
 *     while `available` stays well above 0, backends idle, timeouts flat.
 *   - The client (this Mac) is the bottleneck: throughput flattens with node
 *     CPU low and `waiting` near 0; the client load average is recorded.
 *
 *   DC04a  `/customer/v1/privileged/metrics`: which pgrst_* series exist.
 *   DC04b  starting size: closed-loop `oha` steps of GET /rest/v1/dc_items?id=eq.N
 *          (anon key) at PVLAB_DC04_STEPS concurrency for PVLAB_DC04_STEP_S
 *          each; per step the throughput, latency percentiles, statuses, the
 *          pool series sampled every 3 s, node CPU, and pg_stat_activity
 *          states of `authenticator` read mid-step.
 *   DC04c  resize to PVLAB_DC04_BIG (default ci_4xlarge, `none` skips) and
 *          the same sweep.
 *   DC04d  on the big size, `db_pool` PATCHed to each PVLAB_DC04_POOLS value
 *          (default 20,150,250: a pool small enough to force waiters, and two
 *          sizes a 16-core project might run) and the
 *          top step repeated.
 *
 * Not settled here: GHCRTS (not a customer setting), traffic mixes other
 * than one indexed point read, vantages other than one Singapore client.
 *
 * DESTRUCTIVE: creates the shared project (lib/dc.ts), resizes it, PATCHes
 * PostgREST config; DC99 deletes it.
 */
import { spawn } from "node:child_process";
import { loadavg } from "node:os";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, patchPostgrest, postgrestConfig, redact, resize, skipWithoutPro, sleep, sql, waitRestart, type DcProject } from "../lib/dc.js";

const STEPS = (process.env.PVLAB_DC04_STEPS || "16,32,64,128,256,512,1024").split(",").map(Number);
const BIG_STEPS = (process.env.PVLAB_DC04_BIG_STEPS || "64,128,256,512,1024,1536,2048").split(",").map(Number);
const STEP_S = Number(process.env.PVLAB_DC04_STEP_S || 40);
const BIG = process.env.PVLAB_DC04_BIG || "ci_4xlarge";
const POOLS = (process.env.PVLAB_DC04_POOLS || "20,150,250").split(",").filter(Boolean).map(Number);

const ITEMS_SQL = `
create table if not exists public.dc_items (id int primary key, payload text not null);
insert into public.dc_items select g, md5(g::text) from generate_series(1, 100000) g on conflict do nothing;
grant select on public.dc_items to anon, authenticated, service_role;
notify pgrst, 'reload schema';`;

interface Scrape {
  t: number;
  waiting: number;
  available: number;
  max: number;
  timeouts: number;
  busy: number;
  idle: number;
}

async function scrape(p: DcProject): Promise<{ s: Scrape | null; names: string[]; status: number }> {
  const auth = Buffer.from(`service_role:${p.keys.service}`).toString("base64");
  try {
    const res = await fetch(`https://${p.host}/customer/v1/privileged/metrics`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { s: null, names: [], status: res.status };
    const text = await res.text();
    const s: Scrape = { t: Date.now(), waiting: -1, available: -1, max: -1, timeouts: -1, busy: 0, idle: 0 };
    const names = new Set<string>();
    const add = (k: "waiting" | "available" | "max" | "timeouts", v: number) => (s[k] = (s[k] < 0 ? 0 : s[k]) + v);
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const name = line.split(/[{ ]/)[0] ?? "";
      const v = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (name.startsWith("pgrst_")) names.add(name);
      if (name === "pgrst_db_pool_waiting") add("waiting", v);
      else if (name === "pgrst_db_pool_available") add("available", v);
      else if (name === "pgrst_db_pool_max") add("max", v);
      else if (name === "pgrst_db_pool_timeouts_total") add("timeouts", v);
      else if (name === "node_cpu_seconds_total") {
        if (line.includes('mode="idle"')) s.idle += v;
        else if (!line.includes('mode="steal"') && !line.includes('mode="guest')) s.busy += v;
      }
    }
    return { s, names: [...names].sort(), status: res.status };
  } catch (e) {
    return { s: null, names: [], status: 0 };
  }
}

interface Oha {
  rps: number;
  successRate: number;
  p50: number;
  p95: number;
  p99: number;
  statuses: string;
  errors: string;
  raw: string;
}

function runOha(url: string, headers: Record<string, string>, c: number, durS: number): Promise<Oha> {
  const args = ["-c", String(c), "-z", `${durS}s`, "--no-tui", "--output-format", "json", "-w"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  args.push(url);
  return new Promise((resolve) => {
    const child = spawn("oha", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("close", () => {
      try {
        const j = JSON.parse(out) as {
          summary: { requestsPerSec: number; successRate: number };
          latencyPercentiles: Record<string, number | null>;
          statusCodeDistribution?: Record<string, number>;
          errorDistribution?: Record<string, number>;
        };
        const ms = (k: string) => Math.round(Number(j.latencyPercentiles[k] ?? -0.001) * 1000);
        const fmt = (o?: Record<string, number>) =>
          Object.entries(o ?? {})
            .sort()
            .map(([k, v]) => `${k}:${v}`)
            .join(" ");
        resolve({
          rps: Math.round(j.summary.requestsPerSec),
          successRate: Math.round(j.summary.successRate * 1000) / 1000,
          p50: ms("p50"),
          p95: ms("p95"),
          p99: ms("p99"),
          statuses: fmt(j.statusCodeDistribution) || "none",
          errors: fmt(j.errorDistribution).slice(0, 300) || "none",
          raw: "",
        });
      } catch {
        resolve({ rps: -1, successRate: 0, p50: -1, p95: -1, p99: -1, statuses: "none", errors: "oha output unparsed", raw: (err || out).slice(0, 300) });
      }
    });
  });
}

async function backendStates(ctx: Ctx, ref: string): Promise<string> {
  const r = await sql(
    ctx,
    ref,
    `select coalesce(string_agg(state || ':' || n, ' ' order by state), 'none') as s
       from (select coalesce(state, 'null') as state, count(*) as n from pg_stat_activity where usename = 'authenticator' group by 1) x`,
    20_000,
  );
  return String(r.rows?.[0]?.s ?? `error ${r.error ?? r.status}`);
}

interface StepRow {
  c: number;
  oha: Oha;
  waitingMax: number;
  waitingMed: number;
  availableAtWaitingMax: number;
  availableMin: number;
  poolMax: number;
  timeoutsDelta: number;
  cpuPct: number;
  backends: string;
  scrapes: number;
  clientLoad1: number;
}

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : -1);

async function step(ctx: Ctx, p: DcProject, c: number): Promise<StepRow> {
  const url = `https://${p.host}/rest/v1/dc_items?id=eq.4242&select=id,payload`;
  const headers = { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` };
  const samples: Scrape[] = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const r = await scrape(p);
      if (r.s) samples.push(r.s);
      await sleep(3_000);
    }
  })();
  const ohaP = runOha(url, headers, c, STEP_S);
  await sleep((STEP_S / 2) * 1000);
  const backends = await backendStates(ctx, p.ref);
  const clientLoad1 = Math.round(loadavg()[0]! * 10) / 10;
  const oha = await ohaP;
  stop = true;
  await loop;
  // Drop the first sample (taken before load ramps) when there are enough.
  const s = samples.length > 3 ? samples.slice(1) : samples;
  const withW = s.filter((x) => x.waiting >= 0);
  const top = withW.reduce<Scrape | null>((a, b) => (!a || b.waiting > a.waiting ? b : a), null);
  const first = s[0];
  const last = s[s.length - 1];
  const db = first && last ? last.busy - first.busy : 0;
  const di = first && last ? last.idle - first.idle : 0;
  return {
    c,
    oha,
    waitingMax: top?.waiting ?? -1,
    waitingMed: med(withW.map((x) => x.waiting)),
    availableAtWaitingMax: top?.available ?? -1,
    availableMin: withW.length ? Math.min(...withW.map((x) => x.available)) : -1,
    poolMax: top?.max ?? -1,
    timeoutsDelta: first && last && first.timeouts >= 0 ? last.timeouts - first.timeouts : -1,
    cpuPct: db + di > 0 ? Math.round((1000 * db) / (db + di)) / 10 : -1,
    backends,
    scrapes: s.length,
    clientLoad1,
  };
}

/** The field signature: requests waiting for the pool while a good share of the pool is free and nothing timed out. */
const signature = (r: StepRow) => r.waitingMax >= 20 && r.availableAtWaitingMax >= Math.max(5, r.poolMax * 0.2) && r.timeoutsDelta === 0;

function stepResult(id: string, label: string, r: StepRow): TestResult {
  return {
    id,
    title: `${label}: c=${r.c}`,
    status: "info",
    detail:
      `${r.oha.rps} req/s, p50 ${r.oha.p50} ms, p95 ${r.oha.p95} ms, p99 ${r.oha.p99} ms, success ${r.oha.successRate}; ` +
      `waiting max ${r.waitingMax} (available then ${r.availableAtWaitingMax} of ${r.poolMax}), median ${r.waitingMed}; ` +
      `timeouts +${r.timeoutsDelta}; node CPU ${r.cpuPct} %; authenticator ${r.backends}; signature ${signature(r) ? "YES" : "no"}`,
    measurements: {
      concurrency: r.c,
      rps: r.oha.rps,
      p50_ms: r.oha.p50,
      p95_ms: r.oha.p95,
      p99_ms: r.oha.p99,
      success_rate: r.oha.successRate,
      statuses: r.oha.statuses,
      client_errors: r.oha.errors,
      pool_waiting_max: r.waitingMax,
      pool_waiting_median: r.waitingMed,
      pool_available_at_waiting_max: r.availableAtWaitingMax,
      pool_available_min: r.availableMin,
      pool_max: r.poolMax,
      pool_timeouts_delta: r.timeoutsDelta,
      node_cpu_pct: r.cpuPct,
      authenticator_states_mid: r.backends,
      metric_scrapes: r.scrapes,
      client_load1: r.clientLoad1,
      signature: signature(r) ? "yes" : "no",
    },
    evidence: r.oha.raw ? redact(r.oha.raw) : undefined,
  };
}

async function sweep(ctx: Ctx, p: DcProject, id: string, label: string, steps: number[], out: TestResult[]): Promise<StepRow[]> {
  const rows: StepRow[] = [];
  for (const c of steps) {
    const r = await step(ctx, p, c);
    rows.push(r);
    out.push(stepResult(id, label, r));
    ctx.log(`${id} c=${c}: ${r.oha.rps} rps p50 ${r.oha.p50} p99 ${r.oha.p99} waiting ${r.waitingMax}/${r.availableAtWaitingMax} avail of ${r.poolMax} cpu ${r.cpuPct}% ${r.backends}`);
    // A step that mostly failed says the next one will too; stop climbing.
    if (r.oha.successRate < 0.5) break;
    await sleep(10_000);
  }
  return rows;
}

const mod: TestModule = {
  id: "DC04",
  title: "Data API under request RATE: does it queue for the pool while slots are free?",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC04");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      ctx.log(`DC04: project ready in ${Math.round(p.createMs / 1000)} s (${p.pgVersion})`);
      const setup = await sql(ctx, p.ref, ITEMS_SQL, 120_000);
      if (setup.error) throw new Error(`items setup: ${setup.error}`);
      for (let i = 0; i < 30; i++) {
        const r = await fetch(`https://${p.host}/rest/v1/dc_items?id=eq.1`, { headers: { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` } });
        if (r.status === 200) break;
        await sleep(2_000);
      }

      const m = await scrape(p);
      const cfg = await postgrestConfig(ctx, p.ref);
      const mc = await sql(ctx, p.ref, "select current_setting('max_connections')::int as m, (select application_name from pg_stat_activity where usename = 'authenticator' limit 1) as app");
      out.push({
        id: "DC04a",
        title: "Metrics endpoint: PostgREST series exposed",
        status: m.s && m.s.waiting >= 0 ? "info" : "fail",
        detail: `HTTP ${m.status}; ${m.names.length} pgrst_* series; pool max ${m.s?.max ?? -1}; db_pool ${cfg.dbPool}; max_connections ${mc.rows?.[0]?.m ?? "?"}; ${mc.rows?.[0]?.app ?? "?"}`,
        measurements: { metrics_status: m.status, pgrst_series: m.names.join(","), pool_max: m.s?.max ?? -1, db_pool: cfg.dbPool, max_connections: String(mc.rows?.[0]?.m ?? ""), postgrest_app: String(mc.rows?.[0]?.app ?? ""), pg_version: p.pgVersion },
      });

      await sweep(ctx, p, "DC04b", `start size (${process.env.PVLAB_DC_SIZE || "small"})`, STEPS, out);

      if (BIG !== "none") {
        const before = await sql(ctx, p.ref, "select current_setting('max_connections')::int as m");
        const fromMax = Number(before.rows?.[0]?.m ?? -1);
        const rz = await resize(ctx, p, BIG, -1, 25 * 60_000, 60, fromMax);
        const cfgBig = await postgrestConfig(ctx, p.ref);
        const mBig = await scrape(p);
        out.push({
          id: "DC04c",
          title: `Resize to ${BIG}`,
          status: rz.settledS >= 0 ? "info" : "fail",
          detail: `PATCH ${rz.status}; settled ${rz.settledS} s; max_connections ${fromMax} -> ${rz.maxConn}; db_pool ${cfgBig.dbPool}; pool max ${mBig.s?.max ?? -1}; ${rz.text}`,
          measurements: { resize_status: rz.status, settled_s: rz.settledS, max_connections: rz.maxConn, db_pool: cfgBig.dbPool, pool_max: mBig.s?.max ?? -1 },
        });
        if (rz.settledS < 0) return out;
        const rows = await sweep(ctx, p, "DC04c", BIG, BIG_STEPS, out);

        const top = rows.reduce((a, b) => (b.oha.successRate >= 0.5 && b.c > a.c ? b : a), rows[0]!);
        for (const pool of POOLS) {
          const t0 = Date.now();
          const patch = await patchPostgrest(ctx, p.ref, { db_pool: pool });
          const rs = await waitRestart(ctx, p.ref, t0);
          await sleep(15_000);
          const r = await step(ctx, p, top.c);
          const res = stepResult("DC04d", `${BIG}, db_pool ${pool} (PATCH ${patch.status}, restart ${rs.delayS} s)`, r);
          res.measurements = { ...res.measurements, db_pool_set: pool, patch_status: patch.status, restart_delay_s: rs.delayS };
          out.push(res);
          ctx.log(`DC04d pool ${pool}: ${r.oha.rps} rps waiting ${r.waitingMax}/${r.availableAtWaitingMax} of ${r.poolMax}`);
        }
      }
    } catch (e) {
      out.push({ id: "DC04", title: "DC04", status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
