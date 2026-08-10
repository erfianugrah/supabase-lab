/**
 * G04 - entity-graph neighbourhood traversal via plain SQL, indexed vs not.
 *
 * "Who is connected to whom" over a relational edge table is a recursive-CTE
 * question, not a graph-database one - this measures exactly that, on a
 * generated synthetic graph (default 100000 entities / 400000 edges,
 * overridable via PVLAB_G04_ENTITIES / PVLAB_G04_EDGES).
 *
 * THE INDEX IS THE FINDING, NOT A FOOTNOTE. Postgres does not automatically
 * index a foreign-key REFERENCING column (only the referenced side), so
 * corpus.edges(source_id)/(target_id) start unindexed. This test measures
 * the SAME four queries before and after adding those indexes and reports
 * both numbers - reporting only the fast (indexed) one would hide a real
 * design decision a reader of this report has to make on their own schema.
 *
 * Every query goes through `medianExecMs` (server-side EXPLAIN ANALYZE time,
 * median of warm runs) except the index BUILD itself, which has no
 * EXPLAIN ANALYZE equivalent for DDL - that one is deliberately timed with
 * client wall-clock around a single CREATE INDEX statement, noted as such.
 *
 * Idempotent: the graph is only (re)generated when the current row counts
 * don't match the requested size: a run with the same parameters reuses the
 * existing graph instead of re-truncating and reloading it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { neighbourhoodQuery, COOCCURRENCE_QUERY } from "../lib/graph-queries";
import { instanceSize, medianExecMs, q, scalar } from "../lib/pg";
import { ensureEntityGraphTables } from "../lib/schema";

const DEFAULT_ENTITIES = 100_000;
const DEFAULT_EDGES = 400_000;
const SOURCE_IDX = "corpus.edges_source_id_idx";
const TARGET_IDX = "corpus.edges_target_id_idx";

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

async function loadGraph(ctx: Ctx, entities: number, edges: number): Promise<{ reused: boolean; detail: string }> {
  const curEntities = Number((await scalar(ctx, "select count(*) from corpus.entities")) ?? 0);
  const curEdges = Number((await scalar(ctx, "select count(*) from corpus.edges")) ?? 0);
  if (curEntities === entities && curEdges === edges) {
    return { reused: true, detail: `reused existing graph (${entities} entities, ${edges} edges)` };
  }

  const trunc = await q(ctx, "truncate table corpus.edges, corpus.entities restart identity cascade", 120);
  if (!trunc.ok) return { reused: false, detail: `truncate failed: ${trunc.raw.slice(0, 300)}` };

  const insertEntities = await q(
    ctx,
    `insert into corpus.entities (name, kind)
     select 'entity-' || g, 'synthetic' from generate_series(1, ${entities}) g`,
    600,
  );
  if (!insertEntities.ok) return { reused: false, detail: `entity load failed: ${insertEntities.raw.slice(0, 300)}` };

  const insertEdges = await q(
    ctx,
    `insert into corpus.edges (source_id, target_id, cost)
     select
       (1 + floor(random() * ${entities}))::bigint,
       (1 + floor(random() * ${entities}))::bigint,
       (1 + random() * 9)
     from generate_series(1, ${edges}) g`,
    600,
  );
  if (!insertEdges.ok) return { reused: false, detail: `edge load failed: ${insertEdges.raw.slice(0, 300)}` };

  return { reused: false, detail: `loaded a fresh graph (${entities} entities, ${edges} edges)` };
}

async function dropIndexes(ctx: Ctx): Promise<void> {
  await q(ctx, `drop index if exists ${SOURCE_IDX}`, 60);
  await q(ctx, `drop index if exists ${TARGET_IDX}`, 60);
}

/** Client wall-clock around one DDL statement - EXPLAIN ANALYZE has no
 * equivalent for CREATE INDEX, so this is the only way to time a build. */
async function createIndexesTimed(ctx: Ctx): Promise<number | null> {
  const t0 = performance.now();
  const r1 = await q(ctx, `create index if not exists edges_source_id_idx on corpus.edges (source_id)`, 300);
  const r2 = await q(ctx, `create index if not exists edges_target_id_idx on corpus.edges (target_id)`, 300);
  if (!r1.ok || !r2.ok) return null;
  return performance.now() - t0;
}

function msOrNote(r: { ms: number | null }): number | string {
  return r.ms ?? "no result (query failed or timed out)";
}

const mod: TestModule = {
  id: "G04",
  title: "Entity-graph neighbourhood traversal via recursive CTEs, indexed vs not",
  where: "local",
  requires: ["pooler"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ensured = await ensureEntityGraphTables(ctx);
    if (!ensured.ok) {
      return [
        {
          id: "G04",
          title: mod.title,
          status: "fail",
          detail: "could not create corpus.entities/corpus.edges",
          evidence: ensured.raw.slice(0, 1000),
        },
      ];
    }

    const entities = envInt("PVLAB_G04_ENTITIES", DEFAULT_ENTITIES);
    const edges = envInt("PVLAB_G04_EDGES", DEFAULT_EDGES);
    const load = await loadGraph(ctx, entities, edges);
    if (!load.reused && load.detail.includes("failed")) {
      return [
        {
          id: "G04",
          title: mod.title,
          status: "fail",
          detail: load.detail,
          measurements: { instance_size: instanceSize(), entities, edges },
        },
      ];
    }

    await dropIndexes(ctx);
    const baseline = {
      depth1: await medianExecMs(ctx, neighbourhoodQuery(1)),
      depth2: await medianExecMs(ctx, neighbourhoodQuery(2)),
      depth3: await medianExecMs(ctx, neighbourhoodQuery(3)),
      cooc: await medianExecMs(ctx, COOCCURRENCE_QUERY),
    };

    const buildMs = await createIndexesTimed(ctx);
    const indexed = {
      depth1: await medianExecMs(ctx, neighbourhoodQuery(1)),
      depth2: await medianExecMs(ctx, neighbourhoodQuery(2)),
      depth3: await medianExecMs(ctx, neighbourhoodQuery(3)),
      cooc: await medianExecMs(ctx, COOCCURRENCE_QUERY),
    };

    const measurements: Record<string, number | string> = {
      instance_size: instanceSize(),
      entities,
      edges,
      graph_load: load.reused ? "reused" : "loaded",
      index_present_baseline: "no",
      index_present_after_build: "yes",
      index_build_ms: buildMs != null ? Math.round(buildMs) : "failed",
      depth1_no_index_ms: msOrNote(baseline.depth1),
      depth2_no_index_ms: msOrNote(baseline.depth2),
      depth3_no_index_ms: msOrNote(baseline.depth3),
      cooccurrence_no_index_ms: msOrNote(baseline.cooc),
      depth1_indexed_ms: msOrNote(indexed.depth1),
      depth2_indexed_ms: msOrNote(indexed.depth2),
      depth3_indexed_ms: msOrNote(indexed.depth3),
      cooccurrence_indexed_ms: msOrNote(indexed.cooc),
    };

    return [
      {
        id: "G04",
        title: mod.title,
        status: "info",
        detail:
          `${load.detail}; depth-3 neighbourhood: ${msOrNote(baseline.depth3)}ms unindexed vs ` +
          `${msOrNote(indexed.depth3)}ms with an index on edges(source_id, target_id)`,
        measurements,
      },
    ];
  },
};

export default mod;
