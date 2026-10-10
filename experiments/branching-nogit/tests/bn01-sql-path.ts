/**
 * BN01 - branching without git, change written through the dashboard SQL path.
 *
 * The 2026-05-04 blog states that every schema change made in the SQL Editor
 * or Table Editor on a branch is tracked and merged (pg-delta, alpha). MS15
 * (medium-serverless) saw `POST /merge` answer 201 and apply nothing after
 * `prisma db push`. This module repeats the MS15 shape with the change
 * written through `POST /projects/{branch_ref}/database/query`, the SQL route
 * a PAT can reach (the dashboard's own routes refuse a PAT; BA06).
 *
 * One Pro-org parent, one git-less branch (no `git_branch`), seven statements
 * on the branch (table, RLS, policy, privilege narrowing, function, column and
 * index on a baseline table), `GET /diff` in three variants, `POST /merge`,
 * then a 240 s poll of the parent. Rows:
 *
 *   BN01a  parent project and baseline table (written through the SQL path)
 *   BN01b  branch create, time to healthy, when the parent's schema arrives
 *   BN01c  change set on the branch; the branch holds it; the parent does not
 *   BN01d  /diff default, pgdelta=true, pgdelta=false (which objects appear)
 *   BN01e  /merge; what reached the parent; parent migration history
 *   BN01f  teardown (branch, then parent)
 *
 * Not settled: the dashboard's own SQL editor and Table Editor routes (a PAT
 * cannot call them, so whether Studio records a migration row that the
 * Management API path does not is untested), data seeding, persistent
 * branches. DESTRUCTIVE and BILLABLE (branch compute per hour; bounded,
 * deleted in `finally`).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { runScenario } from "../lib/scenario";

const mod: TestModule = {
  id: "BN01",
  title: "Git-less branch: change via the SQL path, diff, merge, what reaches the parent",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    return runScenario(ctx, { id: "BN01", title: mod.title, path: "query" });
  },
};
export default mod;
