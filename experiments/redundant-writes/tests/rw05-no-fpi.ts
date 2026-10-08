/**
 * RW05 - RW02's and RW03's cases again, with the CHECKPOINT moved from right
 * before the statement to right before the fixture build.
 *
 * RW02/RW03 measure the first write to each page after a checkpoint, where
 * Postgres logs a full-page image of every page it touches (full_page_writes
 * = on on all three servers, RW01). That makes WAL depend on how many PAGES a
 * statement touches as much as on how many ROWS it changes. Here the fixture
 * is written after the checkpoint, so its pages are already logged in the
 * current cycle and the statement writes (almost) no full-page images: the
 * WAL left is the per-row cost. A statement on a real server lands somewhere
 * between the two regimes, depending on where in the checkpoint cycle it runs.
 * The wal_fpi column says how close each rep got to zero.
 *
 * Same fixture and measurement otherwise (lib/rig.ts).
 *
 * DESTRUCTIVE on the rig only.
 *
 * Not settled by this module: a timed checkpoint (checkpoint_timeout = 5min on
 * all three servers) starting during a rep would bring full-page images back
 * for that rep; nothing prevents it, and the range shows it if it happened.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { UPDATE_CASES, UPSERT_CASES } from "../lib/cases";
import { runMatrix } from "../lib/matrix";

const ID = "RW05";

const mod: TestModule = {
  id: ID,
  title: "RW02 + RW03 cases with pages already WAL-logged this checkpoint cycle (no full-page images)",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    return runMatrix(ctx, ID, this.title, [...UPSERT_CASES, ...UPDATE_CASES], { checkpointBefore: false });
  },
};

export default mod;
