/**
 * I10 - the billing counter sensor. The origin-image count is only visible
 * on the dashboard usage page; the platform API that backs it rejects PATs
 * (401, confirmed in the privatelink-aws experiment for other /platform
 * routes). With a dashboard user JWT in PVLAB_PLATFORM_JWT this module
 * renders a known number of distinct origins and reads the usage endpoint,
 * closing the loop on "a GET on a render surface increments the counter".
 *
 * Without the JWT it self-skips with a reason - the correlation stays
 * doc-cited-not-tested rather than asserted.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { storageBase, probe } from "../lib";

const mod: TestModule = {
  id: "I10",
  title: "Billing counter sensor",
  where: "local",
  requires: ["pat", "org"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const jwt = process.env.PVLAB_PLATFORM_JWT;
    if (!jwt) {
      return [{
        id: "I10",
        title: "Billing counter sensor",
        status: "skip",
        detail: "PVLAB_PLATFORM_JWT unset - the usage endpoint rejects PATs; supply a dashboard user token to run this sensor",
      }];
    }
    const org = ctx.orgSlugs[0];
    const out: TestResult[] = [];

    const usageUrl = `https://api.supabase.com/platform/organizations/${org}/usage`;
    const before = await fetch(usageUrl, { headers: { Authorization: `Bearer ${jwt}` } });
    const beforeText = await before.text();
    out.push({
      id: "I10-usage-endpoint",
      title: "platform usage endpoint reachable with user JWT",
      status: before.status === 200 ? "pass" : "fail",
      measurements: { status: before.status },
      evidence: beforeText.slice(0, 400),
    });
    if (before.status !== 200) return out;

    // render 3 distinct origins (small, big-12mp, tiny.gif) - fixtures the
    // earlier modules may already have rendered this cycle, so a delta of 0
    // is also interpretable: it means the counter dedupes per cycle.
    const B = storageBase(ctx);
    for (const p of ["small.png", "big-12mp.png", "tiny.gif"]) {
      await probe(`${B}/render/image/public/pub/${p}?width=111`);
    }
    out.push({
      id: "I10-render-burst",
      title: "Rendered 3 distinct origins",
      status: "info",
      detail: "usage counters aggregate with delay; re-read the endpoint later and diff",
    });

    const after = await fetch(usageUrl, { headers: { Authorization: `Bearer ${jwt}` } });
    const afterText = await after.text();
    out.push({
      id: "I10-usage-after",
      title: "usage read after burst",
      status: "info",
      measurements: { status: after.status },
      evidence: afterText.slice(0, 400),
    });
    return out;
  },
};
export default mod;
