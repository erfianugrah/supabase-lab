/**
 * BN02 - the same merge with two write paths on one branch.
 *
 * BN01 writes the change through `POST /projects/{branch_ref}/database/query`.
 * This module writes object set `q` that way and an identical set `m` through
 * `POST /projects/{branch_ref}/database/migrations` (the call that records a
 * row in `supabase_migrations.schema_migrations`), then merges once. The pair
 * separates "the merge applies the branch's schema difference" from "the
 * merge applies the branch's migration history": both sets are in the diff and
 * only one is in the history. Rows as BN01 (a..f); BN02c/d/e carry `q_*` and
 * `m_*` columns.
 *
 * Not settled: the `migration_version` merge body field, merging a branch
 * whose history conflicts with the parent's, edge functions.
 * DESTRUCTIVE and BILLABLE (bounded, deleted in `finally`).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { runScenario } from "../lib/scenario";

const mod: TestModule = {
  id: "BN02",
  title: "Git-less branch: SQL-path set and migration-endpoint set merged together",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    return runScenario(ctx, { id: "BN02", title: mod.title, path: "mixed" });
  },
};
export default mod;
