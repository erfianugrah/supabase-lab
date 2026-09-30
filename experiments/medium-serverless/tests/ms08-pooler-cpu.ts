/**
 * MS08 - what the dedicated pooler costs the Medium instance, as CPU, against
 * the same load through the shared pooler.
 *
 * The docs say the dedicated pooler "uses more of your project's compute
 * resources" and give no number. There is no per-process view of the
 * instance, so this is a DIFFERENTIAL: identical pgbench select-only load
 * through each pooler, with the instance's CPU read from the project's
 * Prometheus metrics endpoint (`/customer/v1/privileged/metrics`, Basic auth
 * `service_role:<key>`) every 5 s. PgBouncer runs on the instance; Supavisor
 * does not; the CPU delta between the two runs at comparable tps is the
 * pooler's share, plus whatever throughput difference it buys. Rows:
 *
 *   MS08a  idle baseline: CPU busy % over 30 s with no load.
 *   MS08b  shared pooler 6543: tps, p-latency from pgbench, CPU busy % over
 *          the run, memory available delta.
 *   MS08c  dedicated pooler 6543: the same.
 *
 * pgbench tables are created (scale 10, ~160 MB) on the direct path if
 * absent, which pooler-semantics S02 also needs. DESTRUCTIVE: sustained load
 * and a schema change. Not settled: per-process attribution, and behaviour
 * above the pool size (MS09 covers the client ceiling).
 */
import { $ } from "bun";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { dedicatedTarget, directTarget, errText, pgClient, primaryPooler, sharedTargets, sleep, type PgTarget } from "../lib/setup";

const CLIENTS = Number(process.env.PVLAB_CPU_CLIENTS ?? 16);
const JOBS = 4;
const TIME_S = Number(process.env.PVLAB_CPU_TIME_S ?? 60);
const SCRAPE_MS = 5000;
const IDLE_S = 30;

interface CpuSample {
  t: number;
  busy: number;
  idle: number;
  memAvail: number | null;
  poolerMetrics: number;
}

async function scrape(ctx: Ctx): Promise<CpuSample | null> {
  const auth = Buffer.from(`service_role:${ctx.serviceKey ?? ""}`).toString("base64");
  try {
    const res = await fetch(`https://${ctx.apiHost}/customer/v1/privileged/metrics`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const text = await res.text();
    let busy = 0;
    let idle = 0;
    let memAvail: number | null = null;
    let poolerMetrics = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("node_cpu_seconds_total")) {
        const v = Number(line.slice(line.lastIndexOf(" ") + 1));
        if (line.includes('mode="idle"')) idle += v;
        else busy += v;
      } else if (line.startsWith("node_memory_MemAvailable_bytes")) memAvail = Number(line.slice(line.lastIndexOf(" ") + 1));
      else if (/^(pgbouncer|supavisor)_/i.test(line)) poolerMetrics++;
    }
    return { t: Date.now(), busy, idle, memAvail, poolerMetrics };
  } catch {
    return null;
  }
}

function cpuPct(a: CpuSample, b: CpuSample): number {
  const db = b.busy - a.busy;
  const di = b.idle - a.idle;
  return db + di > 0 ? Math.round((1000 * db) / (db + di)) / 10 : 0;
}

async function withScrapes<T>(ctx: Ctx, fn: () => Promise<T>): Promise<{ result: T; first: CpuSample | null; last: CpuSample | null; n: number }> {
  const samples: CpuSample[] = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const s = await scrape(ctx);
      if (s) samples.push(s);
      await sleep(SCRAPE_MS);
    }
  })();
  const result = await fn();
  stop = true;
  await loop;
  const final = await scrape(ctx);
  if (final) samples.push(final);
  return { result, first: samples[0] ?? null, last: samples[samples.length - 1] ?? null, n: samples.length };
}

function url(t: PgTarget, pw: string): string {
  return `postgres://${encodeURIComponent(t.user)}:${encodeURIComponent(pw)}@${t.host}:${t.port}/postgres`;
}

async function bench(t: PgTarget, pw: string): Promise<{ tps: number | null; lat: number | null; stderr: string }> {
  const p = await $`pgbench -n -S -c ${CLIENTS} -j ${JOBS} -T ${TIME_S} ${url(t, pw)}`.env({ ...process.env, PGSSLMODE: "require", PGCONNECT_TIMEOUT: "15" }).quiet().nothrow();
  const out = p.stdout.toString() + p.stderr.toString();
  const tps = /tps = ([0-9.]+)/.exec(out);
  const lat = /latency average = ([0-9.]+) ms/.exec(out);
  return { tps: tps ? Number(tps[1]) : null, lat: lat ? Number(lat[1]) : null, stderr: p.stderr.toString().trim().split("\n").slice(-3).join(" | ") };
}

const mod: TestModule = {
  id: "MS08",
  title: "Dedicated vs shared pooler under equal load: tps and the instance's CPU",
  where: "local",
  requires: ["pat", "db", "pgbench"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.serviceKey) return [{ id: "MS08", title: mod.title, status: "skip", detail: "no service key for the metrics endpoint (SUPABASE_SERVICE_ROLE_KEY)" }];
    const sv = await primaryPooler(ctx);
    if (!sv) return [{ id: "MS08", title: mod.title, status: "skip", detail: "pooler config unreadable" }];
    const shared = sharedTargets(sv).txn;
    const ded = dedicatedTarget(ctx);
    const direct = directTarget(ctx);
    const pw = ctx.dbPassword;

    // pgbench tables on the direct path (needs IPv4 add-on from here).
    {
      const c = pgClient(direct, pw, 10_000);
      try {
        await c.connect();
        const r = await c.query<{ t: string | null }>("select to_regclass('public.pgbench_accounts')::text as t");
        if (!r.rows[0]?.t) {
          ctx.log("pgbench -i -s 10 on direct 5432");
          const init = await $`pgbench -i -s 10 ${url(direct, pw)}`.env({ ...process.env, PGSSLMODE: "require" }).quiet().nothrow();
          if (init.exitCode !== 0) return [{ id: "MS08", title: mod.title, status: "fail", detail: `pgbench -i failed: ${init.stderr.toString().slice(-200)}` }];
        }
      } catch (e) {
        return [{ id: "MS08", title: mod.title, status: "skip", detail: `direct 5432 unreachable for pgbench init: ${errText(e)}` }];
      } finally {
        await c.end().catch(() => {});
      }
    }

    const probe = await scrape(ctx);
    if (!probe) return [{ id: "MS08", title: mod.title, status: "fail", detail: "metrics endpoint did not answer with Basic service_role auth" }];

    const out: TestResult[] = [];
    const idle = await withScrapes(ctx, () => sleep(IDLE_S * 1000));
    const idlePct = idle.first && idle.last ? cpuPct(idle.first, idle.last) : null;
    out.push({
      id: "MS08a",
      title: `idle baseline: instance CPU busy % over ${IDLE_S}s`,
      status: "info",
      detail: `cpu busy ${idlePct ?? "?"}% (${idle.n} scrapes); ${probe.poolerMetrics} pooler-named metric lines exposed`,
      measurements: { cpu_busy_pct: idlePct ?? "n/a", scrapes: idle.n, pooler_metric_lines: probe.poolerMetrics },
    });

    for (const [id, label, t] of [["MS08b", "shared pooler 6543", shared], ["MS08c", "dedicated pooler 6543", ded]] as [string, string, PgTarget][]) {
      await sleep(15_000); // let the previous run's CPU settle
      const run = await withScrapes(ctx, () => bench(t, pw));
      const pct = run.first && run.last ? cpuPct(run.first, run.last) : null;
      const memDelta = run.first?.memAvail != null && run.last?.memAvail != null ? Math.round((run.first.memAvail - run.last.memAvail) / 1048576) : null;
      out.push({
        id,
        title: `${label}: pgbench -S ${CLIENTS} clients ${TIME_S}s, and the instance's CPU while it ran`,
        status: run.result.tps === null ? "fail" : "info",
        detail: run.result.tps === null ? `pgbench produced no tps line: ${run.result.stderr}` : `${run.result.tps} tps, avg latency ${run.result.lat} ms, cpu busy ${pct}% (idle baseline ${idlePct}%), MemAvailable delta ${memDelta} MiB`,
        measurements: { path: label, tps: run.result.tps ?? "n/a", latency_avg_ms: run.result.lat ?? "n/a", cpu_busy_pct: pct ?? "n/a", cpu_over_idle_pct: pct !== null && idlePct !== null ? Math.round((pct - idlePct) * 10) / 10 : "n/a", mem_avail_delta_mib: memDelta ?? "n/a", clients: CLIENTS, time_s: TIME_S, scrapes: run.n },
        evidence: run.result.stderr,
      });
    }
    return out;
  },
};
export default mod;
