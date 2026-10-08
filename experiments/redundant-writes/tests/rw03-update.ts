/**
 * RW03 - a plain UPDATE that sets every row to the value it already holds,
 * against the same UPDATE with a WHERE guard, and with the built-in
 * suppress_redundant_updates_trigger() installed. Also the plain upsert with
 * that trigger, since BEFORE UPDATE row triggers fire on the ON CONFLICT DO
 * UPDATE path too.
 *
 * Same fixture and measurement as RW02 (lib/rig.ts). The trigger is created on
 * the measuring connection before the checkpoint, so its DDL is not counted.
 * Whether suppress_redundant_updates_trigger exists is checked per server
 * (to_regproc) and the case skips with a reason if not.
 *
 * DESTRUCTIVE on the rig only.
 *
 * Not settled by this module: trigger cost on a table that already has other
 * BEFORE UPDATE triggers, and anything hosted.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { UPDATE_CASES } from "../lib/cases";
import { runMatrix } from "../lib/matrix";

const ID = "RW03";

const mod: TestModule = {
  id: ID,
  title: "UPDATE of unchanged rows: plain vs WHERE guard vs suppress_redundant_updates_trigger",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    return runMatrix(ctx, ID, this.title, UPDATE_CASES);
  },
};

export default mod;
