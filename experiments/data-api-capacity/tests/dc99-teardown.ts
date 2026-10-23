/**
 * DC99 - delete the shared DC project and wait until GET /projects stops
 * listing it. Sorts last in the destructive tier, so it runs after DC01-DC03.
 * A project reused through PVLAB_DC_REF is left alone. If a run died before
 * this, `make clean DELETE=1` removes leftovers by name prefix.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { currentProject, teardownProject } from "../lib/dc.js";

const mod: TestModule = {
  id: "DC99",
  title: "Teardown: delete the shared project",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!currentProject()) return [{ id: "DC99", title: "DC99", status: "skip", detail: "no project was created in this process" }];
    const r = await teardownProject(ctx);
    if (r.reused) return [{ id: "DC99", title: "DC99", status: "skip", detail: "project came from PVLAB_DC_REF; not deleted" }];
    return [
      {
        id: "DC99",
        title: "DC99: project deleted and gone from the listing",
        status: r.deleteStatus >= 200 && r.deleteStatus < 300 && r.goneS >= 0 ? "pass" : "fail",
        detail: `DELETE ${r.deleteStatus}; absent from GET /projects after ${r.goneS} s`,
        measurements: { delete_status: r.deleteStatus, gone_from_listing_s: r.goneS },
      },
    ];
  },
};
export default mod;
