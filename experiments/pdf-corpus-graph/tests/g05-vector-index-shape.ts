/**
 * G05 - vector index shape: HNSW vs IVFFLAT build/size/latency, vector vs
 * halfvec storage.
 *
 * SYNTHETIC VECTORS, STATED EXPLICITLY (GUIDE.md permits this): vector
 * STORAGE cost and index behaviour are independent of the vector's values, so
 * this loads corpus.chunks with `random()`-generated 1536-dimension vectors
 * rather than calling an embedding API. What synthetic vectors CANNOT
 * support is any recall/quality claim - this test measures storage, build
 * time, index size and query latency ONLY, never "did it find the right
 * neighbour".
 *
 * GENERATING ONE DISTINCT VECTOR PER ROW IS NOT THE OBVIOUS QUERY. A scalar
 * subquery with no correlation to the outer row (e.g. a plain
 * `(select array_agg(random()) from generate_series(1,1536))` used as a
 * SELECT-list expression) is an uncorrelated subquery, and Postgres is free
 * to evaluate it ONCE and reuse the result for every row, regardless of
 * `random()` being volatile - the "run once" behaviour is about plan shape
 * (InitPlan), not about volatility. `cross join lateral` forces per-row
 * evaluation, which is the only way to get 30000 actually-different rows
 * here rather than one vector repeated 30000 times.
 *
 * Two SEPARATE tables (chunks: vector(1536), chunks_halfvec: halfvec(1536))
 * rather than two columns on one table, because `pg_table_size` reports
 * whole-relation size and there is no clean way to attribute a fraction of
 * one heap to one column.
 *
 * Index build time has no EXPLAIN ANALYZE equivalent (DDL, not a query), so
 * it is timed with client wall-clock around a single CREATE INDEX statement -
 * called out explicitly, same as G04's index build.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { instanceSize, medianExecMs, q, scalar } from "../lib/pg";
import { ensureChunkTables, relationTableBytes } from "../lib/schema";

const DEFAULT_CHUNKS = 30_000;
const HNSW_IDX = "chunks_embedding_hnsw_idx";
const IVFFLAT_IDX = "chunks_embedding_ivfflat_idx";
const ANN_QUERY = `select id from corpus.chunks
  order by embedding <-> (select embedding from corpus.chunks limit 1)
  limit 10`;

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

async function loadChunks(ctx: Ctx, n: number): Promise<{ reused: boolean; detail: string }> {
  const cur = Number((await scalar(ctx, "select count(*) from corpus.chunks")) ?? 0);
  if (cur === n) return { reused: true, detail: `reused existing ${n} synthetic chunks` };

  const truncOk1 = await q(ctx, "truncate table corpus.chunks", 60);
  const truncOk2 = await q(ctx, "truncate table corpus.chunks_halfvec", 60);
  if (!truncOk1.ok || !truncOk2.ok) return { reused: false, detail: "truncate failed before reload" };

  const insertVec = await q(
    ctx,
    `insert into corpus.chunks (content, embedding)
     select 'chunk ' || g.i, v.embedding
     from generate_series(1, ${n}) as g(i)
     cross join lateral (
       select array_agg(random())::vector(1536) as embedding from generate_series(1, 1536)
     ) as v`,
    900,
  );
  if (!insertVec.ok) return { reused: false, detail: `vector load failed: ${insertVec.raw.slice(0, 300)}` };

  const insertHalf = await q(
    ctx,
    `insert into corpus.chunks_halfvec (content, embedding)
     select 'chunk ' || g.i, v.embedding
     from generate_series(1, ${n}) as g(i)
     cross join lateral (
       select array_agg(random())::halfvec(1536) as embedding from generate_series(1, 1536)
     ) as v`,
    900,
  );
  if (!insertHalf.ok) return { reused: false, detail: `halfvec load failed: ${insertHalf.raw.slice(0, 300)}` };

  return { reused: false, detail: `loaded ${n} fresh synthetic chunks into both tables` };
}

async function dropAnnIndexes(ctx: Ctx): Promise<void> {
  await q(ctx, `drop index if exists corpus.${HNSW_IDX}`, 60);
  await q(ctx, `drop index if exists corpus.${IVFFLAT_IDX}`, 60);
}

async function buildIndexTimed(ctx: Ctx, sql: string): Promise<number | null> {
  const t0 = performance.now();
  const r = await q(ctx, sql, 1200);
  return r.ok ? performance.now() - t0 : null;
}

async function indexBytes(ctx: Ctx, indexName: string): Promise<number | null> {
  const n = await scalar(ctx, `select pg_relation_size('corpus.${indexName}')`);
  return n == null ? null : Number(n);
}

const mod: TestModule = {
  id: "G05",
  title: "Vector index shape: HNSW vs IVFFLAT, vector vs halfvec storage",
  where: "local",
  requires: ["pooler"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ensured = await ensureChunkTables(ctx);
    if (!ensured.ok) {
      return [
        {
          id: "G05",
          title: mod.title,
          status: "fail",
          detail: "could not create corpus.chunks / corpus.chunks_halfvec (is pgvector available?)",
          evidence: ensured.raw.slice(0, 1000),
        },
      ];
    }

    const n = envInt("PVLAB_G05_CHUNKS", DEFAULT_CHUNKS);
    const load = await loadChunks(ctx, n);
    if (!load.reused && load.detail.includes("failed")) {
      return [
        {
          id: "G05",
          title: mod.title,
          status: "fail",
          detail: load.detail,
          measurements: { instance_size: instanceSize(), chunks: n },
        },
      ];
    }

    // Storage: base table + TOAST only, excluding any index, so the
    // comparison is about the storage TYPE, not about which index sits on top.
    const vectorBytes = await relationTableBytes(ctx, "corpus.chunks");
    const halfvecBytes = await relationTableBytes(ctx, "corpus.chunks_halfvec");

    await dropAnnIndexes(ctx);

    const hnswBuildMs = await buildIndexTimed(
      ctx,
      `create index ${HNSW_IDX} on corpus.chunks using hnsw (embedding vector_l2_ops)`,
    );
    const hnswBytes = await indexBytes(ctx, HNSW_IDX);
    const hnswLatency = await medianExecMs(ctx, ANN_QUERY);
    await q(ctx, `drop index if exists corpus.${HNSW_IDX}`, 60);

    // lists=100 is a fixed round number, not tuned for recall - recall is out
    // of scope for synthetic vectors (see the module comment), so there is
    // nothing to tune it against.
    const ivfflatBuildMs = await buildIndexTimed(
      ctx,
      `create index ${IVFFLAT_IDX} on corpus.chunks using ivfflat (embedding vector_l2_ops) with (lists = 100)`,
    );
    const ivfflatBytes = await indexBytes(ctx, IVFFLAT_IDX);
    const ivfflatLatency = await medianExecMs(ctx, ANN_QUERY);

    const measurements: Record<string, number | string> = {
      instance_size: instanceSize(),
      chunks: n,
      dimensions: 1536,
      load: load.reused ? "reused" : "loaded",
      vector_table_bytes: vectorBytes ?? -1,
      halfvec_table_bytes: halfvecBytes ?? -1,
      halfvec_vs_vector_ratio:
        vectorBytes && halfvecBytes ? Number((halfvecBytes / vectorBytes).toFixed(4)) : "unknown",
      hnsw_build_ms: hnswBuildMs != null ? Math.round(hnswBuildMs) : "failed",
      hnsw_index_bytes: hnswBytes ?? -1,
      hnsw_query_ms: hnswLatency.ms ?? "no result (query failed or timed out)",
      ivfflat_lists: 100,
      ivfflat_build_ms: ivfflatBuildMs != null ? Math.round(ivfflatBuildMs) : "failed",
      ivfflat_index_bytes: ivfflatBytes ?? -1,
      ivfflat_query_ms: ivfflatLatency.ms ?? "no result (query failed or timed out)",
    };

    return [
      {
        id: "G05",
        title: mod.title,
        status: "info",
        detail:
          `${load.detail}; halfvec table is ${measurements.halfvec_vs_vector_ratio}x the vector table's size; ` +
          `HNSW build ${measurements.hnsw_build_ms}ms/${hnswBytes ?? "?"}B/${measurements.hnsw_query_ms}ms query, ` +
          `IVFFLAT build ${measurements.ivfflat_build_ms}ms/${ivfflatBytes ?? "?"}B/${measurements.ivfflat_query_ms}ms query`,
        measurements,
      },
    ];
  },
};

export default mod;
