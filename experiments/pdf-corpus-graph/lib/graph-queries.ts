/**
 * Plain-SQL traversal queries over corpus.entities/corpus.edges, factored out
 * so G04 (recursive-CTE baseline) and G07 (pgrouting) run the EXACT same
 * query text against the SAME graph. Any latency difference between them is
 * then a difference in the graph engine, not in what got asked.
 */
export const SEED_ID = 1;

/** Bounded BFS neighbourhood expansion from SEED_ID, `depth` hops. */
export function neighbourhoodQuery(depth: number): string {
  return `with recursive nbhd as (
    select target_id as id, 1 as depth from corpus.edges where source_id = ${SEED_ID}
    union
    select e.target_id, n.depth + 1
    from nbhd n join corpus.edges e on e.source_id = n.id
    where n.depth < ${depth}
  )
  select count(*) from nbhd`;
}

/** Two-hop co-occurrence: entities reachable via a shared intermediate node. */
export const COOCCURRENCE_QUERY = `select count(*) from (
  select distinct e2.target_id
  from corpus.edges e1
  join corpus.edges e2 on e1.target_id = e2.source_id
  where e1.source_id = ${SEED_ID}
) t`;

/**
 * The inner edge SQL every pgrouting call site needs. pgrouting requires
 * exactly `id`, `source`, `target`, `cost` - corpus.edges has `source_id`/
 * `target_id`, so this is the aliasing subquery GUIDE.md calls for, defined
 * once rather than re-typed at every pgr_* call.
 */
export const PGROUTING_EDGE_SQL =
  "select id, source_id as source, target_id as target, cost from corpus.edges";
