/**
 * UI99 - delete the shared project and wait until GET /projects stops listing
 * it. Sorts last in the destructive tier. A project reused through
 * PVLAB_UI_REF is left alone; `make clean DELETE=1` removes leftovers by
 * name prefix if a run died before this.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { currentProject, teardownProject } from "../lib/ui.js";

const mod: TestModule = {
  id: "UI99",
  title: "Teardown: delete the shared project",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!currentProject()) return [{ id: "UI99", title: "UI99", status: "skip", detail: "no project was created in this process" }];
    if (process.env.PVLAB_UI_KEEP === "1") return [{ id: "UI99", title: "UI99", status: "skip", detail: "PVLAB_UI_KEEP=1: project left running" }];
    const r = await teardownProject(ctx);
    if (r.reused) return [{ id: "UI99", title: "UI99", status: "skip", detail: "project came from PVLAB_UI_REF; not deleted" }];
    return [
      {
        id: "UI99",
        title: "UI99: project deleted and gone from the listing",
        status: r.deleteStatus >= 200 && r.deleteStatus < 300 && r.goneS >= 0 ? "pass" : "fail",
        detail: `DELETE ${r.deleteStatus}; absent from GET /projects after ${r.goneS} s`,
        measurements: { delete_status: r.deleteStatus, gone_from_listing_s: r.goneS },
      },
    ];
  },
};
export default mod;
