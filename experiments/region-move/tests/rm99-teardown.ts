/**
 * RM99 - delete every project the region-move modules recorded, then confirm
 * no project named with the experiment's prefix is left in the account. The id
 * sorts last on purpose: RM01 and RM02 share the pair.
 */
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { deleteProject, NAME_PREFIX, recorded, sleep } from "../lib/projects.js";

const mod: TestModule = {
  id: "RM99",
  title: "RM99 - teardown",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const deleted: string[] = [];
    for (const p of Object.values(await recorded())) {
      deleted.push(`${p.role}:${await deleteProject(ctx, p)}`);
    }
    let left: string[] = [];
    for (let i = 0; i < 24; i++) {
      const r = await mgmt(ctx, "GET", "/projects");
      const arr = Array.isArray(r.json) ? (r.json as Array<{ name?: string; status?: string }>) : [];
      left = arr.filter((p) => p.name?.startsWith(NAME_PREFIX)).map((p) => `${p.name}:${p.status}`);
      if (left.length === 0) break;
      await sleep(5000);
    }
    return [
      {
        id: "RM99",
        title: "RM99 - teardown",
        status: left.length === 0 ? "pass" : "fail",
        detail: left.length === 0 ? `deleted ${deleted.join(", ") || "nothing recorded"}; none left` : `left: ${left.join(", ")}`,
      },
    ];
  },
};

export default mod;
