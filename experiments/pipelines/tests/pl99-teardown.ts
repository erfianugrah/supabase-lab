/**
 * PL99 - delete the shared source project and the local stack, then confirm no
 * project with the lab's name prefix is left in the organisation. The id sorts
 * last on purpose: the fixture is created by whichever PL module runs first
 * and every other module needs it alive.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { NAME_PREFIX, teardownFixture } from "../lib/fixture.js";
import { sleep } from "../lib/stack.js";

const mod: TestModule = {
  id: "PL99",
  title: "PL99 - teardown",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const t = await teardownFixture(ctx);
    let left: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await mgmt(ctx, "GET", "/projects");
      const arr = Array.isArray(r.json) ? (r.json as Array<{ name?: string; status?: string }>) : [];
      left = arr.filter((p) => p.name?.startsWith(NAME_PREFIX)).map((p) => `${p.status}`);
      if (left.length === 0) break;
      await sleep(5000);
    }
    return [
      {
        id: "PL99",
        title: "PL99: project deleted, none with the lab prefix remain",
        status: t.deleted !== false && left.length === 0 ? "pass" : "fail",
        detail: `DELETE ${t.status || "n/a (no fixture state)"}; projects with the prefix left: ${left.length}`,
        measurements: { delete_http: t.status, prefixed_projects_left: left.length },
      },
    ];
  },
};

export default mod;
