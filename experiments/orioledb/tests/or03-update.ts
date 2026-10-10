/**
 * OR03 - the redundant-writes UPDATE cases on hosted heap and OrioleDB tables.
 *
 * Plain UPDATE from a batch table, the WHERE guard, and
 * `suppress_redundant_updates_trigger()` (plus the plain upsert with that
 * trigger) - statements imported from experiments/redundant-writes/lib/cases.ts.
 * Same targets, counters and caveats as OR02. Result id
 * `OR03-<target>-<rows>-<case>`.
 *
 * DESTRUCTIVE on the pair only.
 *
 * Not settled: see OR02. Whether the built-in suppress trigger works on an
 * OrioleDB table is exactly what the trigger cases measure (a failing
 * statement is recorded as a fail with its error text).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { UPDATE_CASES } from "../../redundant-writes/lib/cases";
import { runMatrix } from "../lib/matrix";
import { skipWithoutOrg } from "../lib/pair";

const ID = "OR03";

const mod: TestModule = {
  id: ID,
  title: "UPDATE of unchanged rows on heap and OrioleDB tables (hosted)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skipped = skipWithoutOrg(ctx, ID, this.title);
    if (skipped) return skipped;
    return runMatrix(ctx, ID, this.title, UPDATE_CASES);
  },
};

export default mod;
