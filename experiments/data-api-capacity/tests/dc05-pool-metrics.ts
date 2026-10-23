/**
 * DC05 - What do the `pgrst_db_pool_*` series on the project's metrics
 * endpoint count, how often do they change, and how long after a `db_pool`
 * PATCH do they show the new size?
 *
 * Why: DC04 read the same waiting/available pair in two consecutive 40 s
 * steps, read "available 1 of 30" with seven idle `authenticator` backends,
 * and read each arm's pool max as the PREVIOUS arm's `db_pool`. Anyone
 * reading these series during an incident needs to know which of these is
 * the metric and which is the scrape.
 *
 * Ground truth is pg_stat_activity: `authenticator` backends in total, in
 * PgSleep (checked out by a held request), and idle. PostgREST's pool
 * metrics are hasql-pool's; the competing readings for "available" are
 * (a) open idle connections, (b) max minus checked-out connections.
 *
 *   DC05a  cadence: 1 s scrapes for 100 s (five 20 s steps) while the number of held requests
 *          steps 0 -> 5 -> 15 -> 25 -> 0 every 20 s (dc_sleep_xl holds),
 *          pg_stat_activity read every 2 s; how many distinct pool tuples
 *          the scrapes saw, the median gap between changes, and the lag from
 *          a step to the first scrape that moved. Response cache headers.
 *   DC05b  semantics: hold 10, then 40 (above the Small pool of 30) for 30 s
 *          each; mid-hold, five scrapes and pg_stat_activity side by side.
 *   DC05c  PATCH lag: `db_pool` 20, then 30; seconds from each PATCH to the
 *          "Starting PostgREST" line and to the first scrape reading the new
 *          pool max (1 s scrapes, up to 180 s).
 *
 * DESTRUCTIVE: uses the shared project (lib/dc.ts) and PATCHes its PostgREST
 * config; DC99 deletes it. Run on Small (`PVLAB_DC_SIZE`, default small).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, fmtCounts, patchPostgrest, redact, REGION, rpc, skipWithoutPro, sleep, sql, waitRestart, type DcProject } from "../lib/dc.js";
import { scrapeMetrics, type PoolScrape } from "../lib/metrics.js";

interface Truth {
  t: number;
  total: number;
  sleeping: number;
  idle: number;
}

async function truth(ctx: Ctx, ref: string): Promise<Truth | null> {
  const r = await sql(
    ctx,
    ref,
    `select count(*)::int as total,
            count(*) filter (where wait_event = 'PgSleep')::int as sleeping,
            count(*) filter (where state = 'idle')::int as idle
       from pg_stat_activity where usename = 'authenticator'`,
    15_000,
  );
  const row = r.rows?.[0];
  return row ? { t: Date.now(), total: Number(row.total), sleeping: Number(row.sleeping), idle: Number(row.idle) } : null;
}

/** Fire `k` holds of `holdS` seconds; resolves when they all answer. */
function hold(p: DcProject, k: number, holdS: number): Promise<string> {
  return Promise.all(Array.from({ length: k }, () => rpc(p.host, "dc_sleep_xl", { s: holdS }, p.keys.service, p.keys.service, (holdS + 90) * 1000))).then((rs) => {
    const c: Record<string, number> = {};
    for (const r of rs) c[`${r.status}${r.code ? `/${r.code}` : ""}`] = (c[`${r.status}${r.code ? `/${r.code}` : ""}`] ?? 0) + 1;
    return fmtCounts(c);
  });
}

const tuple = (s: PoolScrape) => `${s.waiting}/${s.available}/${s.max}`;
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : -1);

/** Scrape every `everyMs` until `stop()` returns true. */
async function scrapeLoop(p: DcProject, everyMs: number, stop: () => boolean): Promise<{ samples: PoolScrape[]; failed: number; headers: string }> {
  const samples: PoolScrape[] = [];
  let failed = 0;
  let headers = "";
  while (!stop()) {
    const t0 = Date.now();
    const r = await scrapeMetrics(p, 5_000);
    if (r.s) samples.push(r.s);
    else failed++;
    if (!headers) headers = r.cacheHeaders;
    const wait = everyMs - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  return { samples, failed, headers };
}

const mod: TestModule = {
  id: "DC05",
  title: "PostgREST pool metrics: what they count, how often they change, PATCH lag",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC05");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);

      // DC05a - cadence under a stepped hold.
      {
        const steps = [0, 5, 15, 25, 0];
        const stepS = 20;
        const t0 = Date.now();
        let done = false;
        const loopP = scrapeLoop(p, 1_000, () => done);
        const truths: Truth[] = [];
        const truthP = (async () => {
          while (!done) {
            const tr = await truth(ctx, p.ref);
            if (tr) truths.push(tr);
            await sleep(2_000);
          }
        })();
        const holds: Promise<string>[] = [];
        const stepStarts: number[] = [];
        for (const k of steps) {
          stepStarts.push(Date.now());
          if (k > 0) holds.push(hold(p, k, stepS - 2));
          await sleep(stepS * 1000);
        }
        done = true;
        const { samples, failed, headers } = await loopP;
        await truthP;
        await Promise.all(holds);

        const changes: number[] = [];
        for (let i = 1; i < samples.length; i++) if (tuple(samples[i]!) !== tuple(samples[i - 1]!)) changes.push(samples[i]!.t);
        const gaps = changes.slice(1).map((t, i) => Math.round((t - changes[i]!) / 100) / 10);
        // Lag from each step start (after the first) to the first scrape whose tuple differs from the one before the step.
        const lags = stepStarts.slice(1).map((st) => {
          const before = [...samples].reverse().find((s) => s.t < st);
          const moved = samples.find((s) => s.t >= st && before && tuple(s) !== tuple(before));
          return moved ? Math.round((moved.t - st) / 100) / 10 : -1;
        });
        const distinct = new Set(samples.map(tuple)).size;
        const series = samples.map((s) => `${Math.round((s.t - t0) / 1000)}s:${tuple(s)}`).join(" ");
        const truthSeries = truths.map((x) => `${Math.round((x.t - t0) / 1000)}s:${x.total}/${x.sleeping}/${x.idle}`).join(" ");
        out.push({
          id: "DC05a",
          title: "Cadence: distinct pool readings and the gap between changes under a stepped hold (0,5,15,25,0 every 20 s)",
          status: samples.length > 0 ? "info" : "fail",
          detail: `${samples.length} scrapes (${failed} failed), ${distinct} distinct waiting/available/max tuples, ${changes.length} changes; median gap between changes ${med(gaps)} s; lag from each step to the first moved scrape ${lags.join(", ")} s; headers ${headers || "none"}`,
          measurements: {
            project_region_requested: REGION,
            scrapes: samples.length,
            scrapes_failed: failed,
            distinct_tuples: distinct,
            changes: changes.length,
            change_gap_s_median: med(gaps),
            change_gaps_s: gaps.join(","),
            step_lags_s: lags.join(","),
            cache_headers: headers || "none",
          },
          evidence: `scrapes (t:waiting/available/max): ${series}\npg_stat_activity authenticator (t:total/sleeping/idle): ${truthSeries}`,
        });
      }

      // DC05b - semantics: metric vs pg_stat_activity at two hold levels.
      for (const k of [10, 40]) {
        const holdS = 30;
        const hp = hold(p, k, holdS);
        await sleep(12_000);
        const rows: string[] = [];
        let last: PoolScrape | null = null;
        let tr: Truth | null = null;
        for (let i = 0; i < 5; i++) {
          const r = await scrapeMetrics(p);
          if (r.s) {
            last = r.s;
            rows.push(tuple(r.s));
          }
          if (i === 2) tr = await truth(ctx, p.ref);
          await sleep(1_500);
        }
        const outcomes = await hp;
        const readings = {
          a_open_idle: tr ? tr.total - tr.sleeping : -1,
          b_max_minus_checked_out: last && tr ? last.max - tr.sleeping : -1,
        };
        out.push({
          id: "DC05b",
          title: `Semantics with ${k} requests held (pool 30)`,
          status: last && tr ? "info" : "fail",
          detail: `scrapes waiting/available/max ${rows.join(" ")}; pg_stat_activity authenticator total ${tr?.total ?? -1}, in PgSleep ${tr?.sleeping ?? -1}, idle ${tr?.idle ?? -1}; available if it meant open-idle ${readings.a_open_idle}, if max-minus-checked-out ${readings.b_max_minus_checked_out}; requests queued beyond the pool ${Math.max(0, k - (last?.max ?? 0))}; holds ${outcomes}`,
          measurements: {
            held: k,
            metric_waiting: last?.waiting ?? -1,
            metric_available: last?.available ?? -1,
            metric_max: last?.max ?? -1,
            pg_total: tr?.total ?? -1,
            pg_sleeping: tr?.sleeping ?? -1,
            pg_idle: tr?.idle ?? -1,
            if_open_idle: readings.a_open_idle,
            if_max_minus_checked_out: readings.b_max_minus_checked_out,
            hold_outcomes: outcomes,
          },
        });
        await sleep(10_000);
      }

      // DC05c - PATCH lag for the pool max.
      for (const pool of [20, 30]) {
        const t0 = Date.now();
        const patch = await patchPostgrest(ctx, p.ref, { db_pool: pool });
        const restartP = waitRestart(ctx, p.ref, t0, 300);
        let seenS = -1;
        let polls = 0;
        while (Date.now() - t0 < 180_000) {
          const r = await scrapeMetrics(p, 5_000);
          polls++;
          if (r.s && r.s.max === pool) {
            seenS = Math.round((Date.now() - t0) / 100) / 10;
            break;
          }
          await sleep(1_000);
        }
        // Prompt PostgREST to open connections so a lazily-updated gauge has a reason to move.
        if (seenS < 0) await rpc(p.host, "dc_ping", {}, p.keys.anon, p.keys.anon, 10_000);
        const rs = await restartP;
        out.push({
          id: "DC05c",
          title: `PATCH db_pool ${pool}: time to the restart line and to the metric`,
          status: patch.status < 300 ? "info" : "fail",
          detail: `PATCH ${patch.status}; restart line ${rs.delayS} s after; pgrst_db_pool_max read ${pool} after ${seenS} s (${polls} scrapes, -1 = not within 180 s)`,
          measurements: { db_pool_set: pool, patch_status: patch.status, restart_delay_s: rs.delayS, metric_seen_s: seenS, scrapes: polls },
        });
        await sleep(15_000);
      }
    } catch (e) {
      out.push({ id: "DC05", title: "DC05", status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
