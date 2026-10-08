/**
 * RW02 - how much write work does an upsert of unchanged rows cause, and how
 * much does each guard remove?
 *
 * Per target x size (RW_SIZES) x case, RW_REPS fresh fixtures (lib/rig.ts
 * buildFixture: t with N rows, a batch src with the same N ids, vacuumed and
 * analysed, autovacuum off on both), then one measured statement (lib/rig.ts
 * measure). Cases (lib/cases.ts, SQL verbatim there):
 *   upsert_plain_identical        INSERT ... ON CONFLICT (id) DO UPDATE, every row unchanged
 *   upsert_guarded_identical      + WHERE (t.a, t.b) IS DISTINCT FROM (excluded.a, excluded.b)
 *   upsert_guarded_1pct           same guard, 1% of batch rows changed
 *   upsert_prefiltered_identical  anti-join the batch against t first, guard kept
 *   upsert_prefiltered_1pct       same, 1% changed
 *   merge_guarded_identical       MERGE ... WHEN MATCHED AND (...) IS DISTINCT FROM (...)
 *   merge_guarded_1pct            same, 1% changed
 *
 * Measured per rep: new row versions (xmin = statement xid) and rows locked
 * only (xmax = statement xid), counted inside the transaction; statement WAL
 * records / full-page images / bytes from EXPLAIN (ANALYZE, WAL); LSN diff
 * across the transaction; shared buffers dirtied and written; n_tup_upd,
 * n_tup_hot_upd and n_dead_tup deltas from a new connection after a forced
 * flush; heap and index size; and the WAL and time of a manual VACUUM after.
 * A CHECKPOINT precedes every statement (worst case for full-page images, the
 * same for every case).
 *
 * DESTRUCTIVE on the rig only (drops and recreates public.t / public.src).
 *
 * Not settled by this module: what any of this costs on a hosted disk (IOPS
 * or throughput budget, gp3 vs io2), concurrency (two writers upserting the
 * same rows), tables with secondary indexes or TOASTed columns, or batches
 * sent from a client as VALUES/unnest rather than read from a table.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { UPSERT_CASES } from "../lib/cases";
import { runMatrix } from "../lib/matrix";

const ID = "RW02";

const mod: TestModule = {
  id: ID,
  title: "Upsert of unchanged rows: plain vs guarded vs pre-filtered vs MERGE",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    return runMatrix(ctx, ID, this.title, UPSERT_CASES);
  },
};

export default mod;
