/**
 * G07 - pgrouting on a generic (non-geospatial) entity graph.
 *
 * G01 found pgrouting 3.4.1 available in the managed extension catalogue -
 * that is a graph-ALGORITHM library over relational edge tables, not a
 * property-graph store, and the whole evaluation turns on that distinction
 * actually holding up when there is no geometry anywhere near the data. This
 * installs pgrouting (recording what it drags in - GUIDE.md and G01 both
 * flag its hard postgis dependency as a real adoption cost, not a footnote),
 * then runs pgr_dijkstra, pgr_connectedComponents and pgr_bridges against the
 * SAME graph G04 built, with zero geometry columns anywhere in it.
 *
 * IF AN ALGORITHM DOES NOT RUN ON A NON-GEOSPATIAL GRAPH, THAT IS THE
 * FINDING. This test does not retry with a workaround or fall back to a
 * "close enough" query - a `q()` failure is recorded verbatim as evidence
 * that the specific call did not work on this shape of data, per the
 * cardinal rule: assert that the probe ran, never assert what it found.
 *
 * THE ALIASING SUBQUERY IS THE COLUMN-SHAPE CONSTRAINT MADE CONCRETE.
 * pgrouting's functions require exactly `id`, `source`, `target`, `cost` in
 * the inner edge SQL; corpus.edges uses source_id/target_id (see
 * sql/corpus-entities-edges.sql for why). `PGROUTING_EDGE_SQL` in
 * lib/graph-queries.ts is that aliasing subquery, paid once per call site.
 * bigint node ids are likewise not optional: corpus.entities.id is a
 * bigserial specifically because pgrouting requires it, confirmed here by
 * reading the actual column type back from information_schema rather than
 * assuming the schema file did the right thing.
 *
 * COMPARISON TO G04 IS APPROXIMATE, AND SAID SO. pgr_dijkstra answers a
 * different question (shortest path between two specific nodes) than G04's
 * bounded neighbourhood expansion (all nodes within N hops) - the latency
 * numbers sit side by side in the same result for a reader's convenience,
 * not as a claim that they measure the same operation.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { neighbourhoodQuery, PGROUTING_EDGE_SQL } from "../lib/graph-queries";
import { instanceSize, medianExecMs, q, scalar } from "../lib/pg";

async function installPgrouting(ctx: Ctx): Promise<{ ok: boolean; pulledIn: string[]; detail: string }> {
  const before = await q(ctx, "select extname from pg_extension order by extname");
  const install = await q(ctx, "create extension if not exists pgrouting", 120);
  if (!install.ok) {
    return { ok: false, pulledIn: [], detail: `create extension pgrouting failed: ${install.raw.slice(0, 300)}` };
  }
  const after = await q(ctx, "select extname, extversion from pg_extension order by extname");
  const beforeSet = new Set(before.ok ? before.rows.map((r) => r[0]) : []);
  const pulledIn = after.ok
    ? after.rows.filter((r) => !beforeSet.has(r[0])).map((r) => `${r[0]}@${r[1]}`)
    : [];
  return { ok: true, pulledIn, detail: "installed (or already present)" };
}

async function nodeIdColumnTypes(ctx: Ctx): Promise<Record<string, string>> {
  const r = await q(
    ctx,
    `select table_name, column_name, data_type
     from information_schema.columns
     where table_schema = 'corpus' and table_name in ('entities', 'edges')
       and column_name in ('id', 'source_id', 'target_id')
     order by table_name, column_name`,
  );
  const out: Record<string, string> = {};
  if (r.ok) for (const [table, col, dtype] of r.rows) out[`${table}.${col}`] = dtype ?? "unknown";
  return out;
}

const mod: TestModule = {
  id: "G07",
  title: "pgrouting algorithms on a plain (non-geospatial) entity graph",
  where: "local",
  requires: ["pooler"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const entityCount = Number((await scalar(ctx, "select count(*) from corpus.entities")) ?? 0);
    const edgeCount = Number((await scalar(ctx, "select count(*) from corpus.edges")) ?? 0);
    if (entityCount === 0 || edgeCount === 0) {
      return [
        {
          id: "G07",
          title: mod.title,
          status: "skip",
          detail: "corpus.entities/corpus.edges are empty - run G04 first to load the entity graph",
        },
      ];
    }

    const install = await installPgrouting(ctx);
    if (!install.ok) {
      return [
        {
          id: "G07",
          title: mod.title,
          status: "info",
          detail: install.detail,
          measurements: { instance_size: instanceSize(), install: "failed" },
        },
      ];
    }

    const columnTypes = await nodeIdColumnTypes(ctx);
    const targetId = Math.min(1000, entityCount);

    const results: TestResult[] = [
      {
        id: "G07-install",
        title: "pgrouting install: extension footprint",
        status: "info",
        detail: `pulled in: ${install.pulledIn.join(", ") || "nothing new (already installed)"}`,
        measurements: {
          instance_size: instanceSize(),
          pulled_in: install.pulledIn.join(",") || "none",
          entities_id_type: columnTypes["entities.id"] ?? "unknown",
          edges_source_id_type: columnTypes["edges.source_id"] ?? "unknown",
          edges_target_id_type: columnTypes["edges.target_id"] ?? "unknown",
        },
      },
    ];

    // pgr_dijkstra - shortest connection path between two specific nodes.
    const dijkstraSql = `select count(*) from pgr_dijkstra('${PGROUTING_EDGE_SQL}', 1::bigint, ${targetId}::bigint, directed => true)`;
    const dijkstra = await medianExecMs(ctx, dijkstraSql);
    const g04Depth3 = await medianExecMs(ctx, neighbourhoodQuery(3));
    results.push({
      id: "G07-dijkstra",
      title: "pgr_dijkstra: shortest path, node 1 -> node " + targetId,
      status: dijkstra.ms != null ? "info" : "fail",
      detail:
        dijkstra.ms != null
          ? `${dijkstra.ms}ms via pgr_dijkstra vs ${g04Depth3.ms ?? "no result"}ms for G04's depth-3 ` +
            "bounded-neighbourhood recursive CTE (different question - side by side for scale, not equivalence)"
          : `pgr_dijkstra did not return a usable result: ${dijkstra.raw.slice(0, 400)}`,
      measurements: {
        instance_size: instanceSize(),
        dijkstra_ms: dijkstra.ms ?? "no result (see evidence)",
        g04_depth3_ms: g04Depth3.ms ?? "no result",
        target_id: targetId,
      },
      evidence: dijkstra.raw.slice(0, 1500),
    });

    // pgr_connectedComponents - clustering over the whole graph.
    const componentsSql = `select component, count(*) from pgr_connectedComponents('${PGROUTING_EDGE_SQL}') group by component order by count(*) desc limit 5`;
    const components = await q(ctx, componentsSql, 300);
    const componentsTimed = await medianExecMs(
      ctx,
      `select count(distinct component) from pgr_connectedComponents('${PGROUTING_EDGE_SQL}')`,
    );
    results.push({
      id: "G07-connected-components",
      title: "pgr_connectedComponents: clustering over the full entity graph",
      status: components.ok ? "info" : "fail",
      detail: components.ok
        ? `ran successfully; largest components: ${components.rows.map((r) => `${r[0]}:${r[1]}`).join(", ")}`
        : `pgr_connectedComponents failed: ${components.raw.slice(0, 400)}`,
      measurements: {
        instance_size: instanceSize(),
        components_query_ms: componentsTimed.ms ?? "no result (see evidence)",
      },
      evidence: components.raw.slice(0, 1500),
    });

    // pgr_bridges - critical single links, the "what breaks the graph" question.
    const bridgesSql = `select count(*) from pgr_bridges('${PGROUTING_EDGE_SQL}')`;
    const bridgesTimed = await medianExecMs(ctx, bridgesSql);
    const bridgesRaw = await q(ctx, bridgesSql, 300);
    results.push({
      id: "G07-bridges",
      title: "pgr_bridges: critical single links (brokers/critical-link question)",
      status: bridgesTimed.ms != null ? "info" : "fail",
      detail:
        bridgesTimed.ms != null
          ? `ran successfully in ${bridgesTimed.ms}ms; bridge count: ${bridgesRaw.ok ? bridgesRaw.rows[0]?.[0] : "unknown"}`
          : `pgr_bridges did not return a usable result: ${bridgesTimed.raw.slice(0, 400)}`,
      measurements: {
        instance_size: instanceSize(),
        bridges_query_ms: bridgesTimed.ms ?? "no result (see evidence)",
        bridge_count: bridgesRaw.ok ? (bridgesRaw.rows[0]?.[0] ?? "unknown") : "unknown",
      },
      evidence: bridgesTimed.raw.slice(0, 1500),
    });

    return results;
  },
};

export default mod;
