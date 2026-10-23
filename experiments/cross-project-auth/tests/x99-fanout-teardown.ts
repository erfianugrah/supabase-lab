/**
 * X99 - delete both fan-out projects and wait until GET /projects stops
 * listing them. Sorts last in the destructive tier. If a run was started with
 * a subset in --only, include X99 or run `make fanout-clean DELETE=1`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { createdRefs, teardownPair } from "../lib/fanout.js";

const mod: TestModule = {
  id: "X99",
  title: "Teardown: delete both fan-out projects",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!createdRefs().length) return [{ id: "X99", title: this.title, status: "skip", detail: "no project was created in this process" }];
    const r = await teardownPair(ctx);
    const ok = Object.values(r.deleted).every((s) => s >= 200 && s < 300) && r.goneS >= 0;
    return [
      {
        id: "X99",
        title: "Both projects deleted and gone from the listing",
        status: ok ? "pass" : "fail",
        detail: `DELETE ${JSON.stringify(r.deleted)}; absent from GET /projects after ${r.goneS} s`,
        measurements: { delete_status: JSON.stringify(r.deleted), gone_from_listing_s: r.goneS },
      },
    ];
  },
};
export default mod;
