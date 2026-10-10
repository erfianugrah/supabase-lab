/**
 * OR02 - the redundant-writes upsert cases on hosted projects: a heap table in
 * a heap project, a heap table in an OrioleDB project, and a `USING orioledb`
 * table in the same OrioleDB project.
 *
 * Statements are the ones experiments/redundant-writes runs locally
 * (imported from its lib/cases.ts): plain `INSERT ... ON CONFLICT DO UPDATE`,
 * the `IS DISTINCT FROM` guard, the pre-filtered batch, guarded MERGE;
 * identical batch and 1% changed. Result id `OR02-<target>-<rows>-<case>`;
 * target is `oriole_oriole`, `oriole_heap` or `heap_heap`.
 *
 * Per rep: statement WAL records / full-page images / bytes (EXPLAIN (ANALYZE,
 * WAL)), LSN diff across the transaction, buffers, execution time, row
 * versions by xmin (heap tables only), n_tup_upd and n_dead_tup deltas from a
 * new connection after a forced flush, relation and index size, and what a
 * manual VACUUM (VERBOSE) then does to the table. OR_REPS fixtures (default
 * 3); the 1,000,000-row size runs four of the cases.
 *
 * DESTRUCTIVE on the pair only (drops and recreates public.t / public.src).
 *
 * Not settled: hosted disk behaviour at the project's IO budget, concurrency,
 * secondary indexes, TOAST, a checkpoint landing mid-rep (wal_fpi records it
 * per rep), and anything about a compute size other than OR_SIZE.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { UPSERT_CASES } from "../../redundant-writes/lib/cases";
import { runMatrix } from "../lib/matrix";
import { skipWithoutOrg } from "../lib/pair";

const ID = "OR02";

const mod: TestModule = {
  id: ID,
  title: "Upsert of unchanged rows on heap and OrioleDB tables (hosted)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skipped = skipWithoutOrg(ctx, ID, this.title);
    if (skipped) return skipped;
    return runMatrix(ctx, ID, this.title, UPSERT_CASES);
  },
};

export default mod;
