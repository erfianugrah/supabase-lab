/**
 * AV99 - delete the shared AV project and wait until GET /projects stops
 * listing it. Sorts last in the destructive tier, so it runs after AV01-AV03.
 * A run started with a subset of modules must include AV99, or use
 * `make clean DELETE=1`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { currentProject, teardownProject } from "../../data-api-defaults/lib/project.js";

const mod: TestModule = {
  id: "AV99",
  title: "Teardown: delete the shared project",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!currentProject()) return [{ id: "AV99", title: "AV99", status: "skip", detail: "no project was created in this process" }];
    const r = await teardownProject(ctx);
    return [
      {
        id: "AV99",
        title: "AV99: project deleted and gone from the listing",
        status: r.deleteStatus >= 200 && r.deleteStatus < 300 && r.goneS >= 0 ? "pass" : "fail",
        detail: `DELETE ${r.deleteStatus}; absent from GET /projects after ${r.goneS}s`,
        measurements: { delete_status: r.deleteStatus, gone_from_listing_s: r.goneS },
      },
    ];
  },
};
export default mod;
