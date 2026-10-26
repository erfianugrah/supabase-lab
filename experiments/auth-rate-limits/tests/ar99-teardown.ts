/**
 * AR99 - delete the project AR05/AR06 created in this process and wait until
 * GET /projects stops listing it. A project reused through PVLAB_AR_REF is
 * deleted only with PVLAB_AR_DELETE_REUSED=1; `make clean DELETE=1` removes
 * leftovers by name prefix.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { currentProject, ensureProject, teardownProject } from "../lib/ar-project.js";

const mod: TestModule = {
  id: "AR99",
  title: "Teardown: delete the AR05/AR06 project",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!currentProject() && process.env.PVLAB_AR_REF && process.env.PVLAB_AR_DELETE_REUSED) await ensureProject(ctx).catch(() => null);
    if (!currentProject()) return [{ id: "AR99", title: "AR99", status: "skip", detail: "no project was created in this process" }];
    const r = await teardownProject(ctx);
    if (r.reused && r.deleteStatus === 0) return [{ id: "AR99", title: "AR99", status: "skip", detail: "project came from PVLAB_AR_REF; not deleted" }];
    return [
      {
        id: "AR99",
        title: "AR99: project deleted and gone from the listing",
        status: r.deleteStatus >= 200 && r.deleteStatus < 300 && r.goneS >= 0 ? "pass" : "fail",
        detail: `DELETE ${r.deleteStatus}; absent from GET /projects after ${r.goneS} s`,
        measurements: { delete_status: r.deleteStatus, gone_from_listing_s: r.goneS },
      },
    ];
  },
};
export default mod;
