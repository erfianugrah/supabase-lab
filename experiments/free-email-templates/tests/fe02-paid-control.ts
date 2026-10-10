/**
 * FE02 - paid-org control for FE01.
 *
 * The same create / baseline / non-template write / default-SMTP template
 * sweep (lib/phases.ts a..d) on a Pro-org project, so a refusal on the free
 * org can be told apart from "this endpoint rejects template writes on any
 * new project". One short-lived project (a few minutes), deleted in finally.
 *
 * Needs PVLAB_ORG_PRO.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { runPhases } from "../lib/phases.js";

const mod: TestModule = {
  id: "FE02",
  title: "Pro org control: template writes on default SMTP",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "FE02", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    return runPhases(ctx, { org, prefix: "FE02", label: "a Pro org", full: false });
  },
};
export default mod;
