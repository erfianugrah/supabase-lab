/**
 * G10 - traversal under concurrency: the depth-3 neighbourhood at load.
 *
 * Every latency measured so far (G04, G07) is single-query and uncontended.
 * On a 2 vCPU instance that is the least representative case for a production
 * deployment serving multiple concurrent users.
 *
 * This runs G04's depth-3 neighbourhood query at concurrency 1, 4, 16 and 64
 * against the ALREADY-LOADED graph (100000 entities / 400000 edges - reused,
 * not reloaded). Records p50 and p95 at each level, plus errors and pooler
 * saturation, with instance_size on every row.
 *
 * A knee is the finding; there is no correct value. Each concurrent query is
 * timed server-side via EXPLAIN ANALYZE to separate the database's work from
 * the pooler's queueing.
 *
 * Idempotent: the graph is reused from G04. If not present, this skips.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { neighbourhoodQuery } from "../lib/graph-queries";
import { instanceSize, q, scalar } from "../lib/pg";

const CONCURRENCY_LEVELS = [1, 4, 16, 64];
const DEPTH_3_SQL = neighbourhoodQuery(3);

/** Run one EXPLAIN ANALYZE and extract Execution Time. Returns ms or null. */
async function singleExecMs(ctx: Ctx): Promise<{ ms: number | null; error: string | null }> {
  const r = await q(ctx, `explain (analyze, format json) ${DEPTH_3_SQL}`, 120);
  if (!r.ok) return { ms: null, error: r.raw.slice(0, 200) };
  const m = r.raw.match(/"Execution Time":\s*([0-9.]+)/);
  if (!m) return { ms: null, error: "no Execution Time in EXPLAIN output" };
  const ms = Number(m[1]);
  if (Number.isNaN(ms)) return { ms: null, error: "invalid Execution Time value" };
  return { ms, error: null };
}

/** Fire N concurrent EXPLAIN ANALYZE queries and collect timings. */
async function concurrentTimings(
  ctx: Ctx,
  concurrency: number,
): Promise<{ ok: number; errors: number; times: number[]; errorDetails: string[] }> {
  const promises = Array.from({ length: concurrency }, () => singleExecMs(ctx));
  const results = await Promise.all(promises);
  const times: number[] = [];
  const errorDetails: string[] = [];
  let okCount = 0;
  let errCount = 0;
  for (const r of results) {
    if (r.ms != null) {
      times.push(r.ms);
      okCount++;
    } else {
      errCount++;
      if (r.error) errorDetails.push(r.error.slice(0, 80));
    }
  }
  return { ok: okCount, errors: errCount, times, errorDetails };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const vLo = sorted[lo] as number;
  const vHi = sorted[hi] as number;
  if (lo === hi) return vLo;
  return Math.round(((vLo + vHi) / 2) * 100) / 100;
}

const mod: TestModule = {
  id: "G10",
  title: "Traversal under concurrency: depth-3 neighbourhood at 1/4/16/64 concurrent queries",
  where: "local",
  requires: ["pooler"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const entityCount = Number((await scalar(ctx, "select count(*) from corpus.entities")) ?? 0);
    const edgeCount = Number((await scalar(ctx, "select count(*) from corpus.edges")) ?? 0);

    if (entityCount === 0 || edgeCount === 0) {
      return [{
        id: "G10",
        title: mod.title,
        status: "skip",
        detail: "corpus.entities/corpus.edges are empty - run G04 first to load the entity graph",
      }];
    }

    const targetEntities = 100_000;
    const targetEdges = 400_000;
    const graphMatches = entityCount === targetEntities && edgeCount === targetEdges;

    const results: TestResult[] = [];
    const allTimes: number[] = [];
    let totalErrors = 0;

    // Single warm-up execution before any concurrency batch: primes the
    // buffer cache so the concurrency numbers measure contention, not
    // cold-disk penalty (same rationale as medianExecMs's discard).
    await singleExecMs(ctx);

    for (let i = 0; i < CONCURRENCY_LEVELS.length; i++) {
      const c = CONCURRENCY_LEVELS[i] as number;
      const subId = `G10${String.fromCharCode(97 + i)}`; // G10a, G10b, G10c, G10d
      const r = await concurrentTimings(ctx, c);
      const sorted = [...r.times].sort((a, b) => a - b);
      const p50 = percentile(sorted, 50);
      const p95 = percentile(sorted, 95);
      allTimes.push(...r.times);
      totalErrors += r.errors;

      results.push({
        id: subId,
        title: `Concurrency ${c}: depth-3 neighbourhood traversal`,
        status: r.errors > 0 && r.ok === 0 ? "fail" : "info",
        detail: r.errors > 0
          ? `${r.ok} ok, ${r.errors} errors at concurrency ${c}. ` +
            `p50=${p50 ?? "N/A"}ms, p95=${p95 ?? "N/A"}ms. ` +
            `Errors: ${r.errorDetails.slice(0, 3).join("; ") || "none captured"}`
          : `${r.ok} ok, ${r.errors} errors at concurrency ${c}. ` +
            `p50=${p50 ?? "N/A"}ms, p95=${p95 ?? "N/A"}ms`,
        measurements: {
          instance_size: instanceSize(),
          concurrency: c,
          queries_ok: r.ok,
          queries_errors: r.errors,
          p50_ms: p50 ?? "N/A",
          p95_ms: p95 ?? "N/A",
          min_ms: sorted.length > 0 ? (sorted[0] as number) : "N/A",
          max_ms: sorted.length > 0 ? (sorted[sorted.length - 1] as number) : "N/A",
          entities: entityCount,
          edges: edgeCount,
          graph_reused: String(graphMatches),
        },
      });
    }

    // Aggregate: knee detection. If there's a clear inflection point across
    // concurrency levels, that's the finding. Record p50 ratio at each step.
    const aggSorted = [...allTimes].sort((a, b) => a - b);
    const aggP50 = percentile(aggSorted, 50);
    const aggP95 = percentile(aggSorted, 95);

    results.unshift({
      id: "G10",
      title: mod.title,
      status: "info",
      detail:
        `Graph: ${entityCount} entities / ${edgeCount} edges ${graphMatches ? "(matches G04 baseline)" : "(different from G04 baseline - check)"}. ` +
        `Aggregate across all concurrency levels: p50=${aggP50 ?? "N/A"}ms, p95=${aggP95 ?? "N/A"}ms, ` +
        `${totalErrors} errors in ${CONCURRENCY_LEVELS.reduce((a, b) => a + b, 0)} total queries. ` +
        `The knee (if any) is visible in the per-concurrency-level p50/p95 above. ` +
        `instance_size=${instanceSize()}.`,
      measurements: {
        instance_size: instanceSize(),
        entities: entityCount,
        edges: edgeCount,
        graph_matches_baseline: String(graphMatches),
        aggregate_p50_ms: aggP50 ?? "N/A",
        aggregate_p95_ms: aggP95 ?? "N/A",
        total_queries: CONCURRENCY_LEVELS.reduce((a, b) => a + b, 0),
        total_errors: totalErrors,
        concurrency_levels: CONCURRENCY_LEVELS.join(","),
      },
    });

    return results;
  },
};

export default mod;