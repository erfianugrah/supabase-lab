/**
 * CB99 - delete the project this process created (a reused one is left).
 * Include it in ONLY or the project keeps running; `make clean` lists
 * leftovers by name prefix.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { createdProject, deleteProject } from "../lib/cb.js";

const mod: TestModule = {
  id: "CB99",
  title: "teardown: delete the project this run created",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const p = createdProject();
    if (!p) return [{ id: "CB99", title: this.title, status: "skip", detail: "no project created in this process" }];
    const d = await deleteProject(ctx, p.ref);
    console.error(`[CB99] delete ${p.ref}: HTTP ${d.deleteStatus}, gone after ${d.goneS}s`);
    return [
      {
        id: "CB99",
        title: "teardown: project deleted and gone from the listing",
        status: d.deleteStatus < 300 && d.goneS >= 0 ? "pass" : "fail",
        detail: `DELETE ${d.deleteStatus}; absent from GET /projects after ${d.goneS} s`,
        measurements: { delete_status: d.deleteStatus, gone_from_listing_s: d.goneS },
      },
    ];
  },
};
export default mod;
