/**
 * NL99 - delete every project this process created (reused ones are left).
 * Include it in ONLY or the project keeps running; `make clean` lists
 * leftovers by name prefix.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { createdProjects, deleteProject } from "../lib/nl.js";

const mod: TestModule = {
  id: "NL99",
  title: "teardown: delete the projects this run created",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ps = createdProjects();
    if (ps.length === 0) return [{ id: "NL99", title: this.title, status: "skip", detail: "no project created in this process" }];
    const out: TestResult[] = [];
    for (const p of ps) {
      const d = await deleteProject(ctx, p.ref);
      console.error(`[NL99] delete ${p.size} ${p.ref}: HTTP ${d.deleteStatus}, gone after ${d.goneS}s`);
      out.push({
        id: `NL99-${p.size}`,
        title: `teardown: ${p.size} project deleted and gone from the listing`,
        status: d.deleteStatus < 300 && d.goneS >= 0 ? "pass" : "fail",
        detail: `DELETE ${d.deleteStatus}; absent from GET /projects after ${d.goneS} s`,
        measurements: { delete_status: d.deleteStatus, gone_from_listing_s: d.goneS },
      });
    }
    return out;
  },
};
export default mod;
