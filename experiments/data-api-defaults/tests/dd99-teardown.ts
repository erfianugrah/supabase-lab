/**
 * DD99 - delete the shared DD project and wait until GET /projects stops
 * listing it. Sorts last in the destructive tier, so it runs after DD01-DD04.
 * If the run was started with --only DD01 (or any subset), include DD99 or run
 * `bun lib/cleanup.ts --delete`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { currentProject, teardownProject } from "../lib/project.js";

const mod: TestModule = {
  id: "DD99",
  title: "Teardown: delete the shared project",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!currentProject()) return [{ id: "DD99", title: "DD99", status: "skip", detail: "no project was created in this process" }];
    const r = await teardownProject(ctx);
    return [
      {
        id: "DD99",
        title: "DD99: project deleted and gone from the listing",
        status: r.deleteStatus >= 200 && r.deleteStatus < 300 && r.goneS >= 0 ? "pass" : "fail",
        detail: `DELETE ${r.deleteStatus}; absent from GET /projects after ${r.goneS}s`,
        measurements: { delete_status: r.deleteStatus, gone_from_listing_s: r.goneS },
      },
    ];
  },
};
export default mod;
