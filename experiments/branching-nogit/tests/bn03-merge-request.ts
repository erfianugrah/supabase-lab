/**
 * BN03 - the BN01 change with the API half of the dashboard's merge-request
 * step before the merge.
 *
 * The dashboard guide says a merge needs a merge request first. The Management
 * API exposes `PATCH /branches/{ref} {request_review: true}` (sets
 * `review_requested_at`). This module runs the BN01 scenario with that call
 * between the writes and the diff, to test whether a review request changes
 * what the merge applies. Rows as BN01 (a..f); BN03c also records the PATCH
 * status and whether `review_requested_at` is set on the parent's branch list.
 *
 * Not settled: the dashboard's merge-request UI itself (not reachable with a
 * PAT), approval by a second member.
 * DESTRUCTIVE and BILLABLE (bounded, deleted in `finally`).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { runScenario } from "../lib/scenario";

const mod: TestModule = {
  id: "BN03",
  title: "Git-less branch: SQL-path change with request_review before merge",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    return runScenario(ctx, { id: "BN03", title: mod.title, path: "query", requestReview: true });
  },
};
export default mod;
