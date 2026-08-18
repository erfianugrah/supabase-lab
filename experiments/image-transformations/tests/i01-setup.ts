/**
 * I01 - fixture setup. Creates the pub/priv buckets and uploads the generated
 * fixtures. Idempotent (bucket 409 tolerated, uploads overwrite). Everything
 * later in the battery depends on this module having run in the same run.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { ensureBucket, upload, FIXTURES } from "../lib";

const mod: TestModule = {
  id: "I01",
  title: "Setup: buckets and fixtures",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];

    const pubStatus = await ensureBucket(ctx, "pub", true);
    const privStatus = await ensureBucket(ctx, "priv", false);
    out.push({
      id: "I01-buckets",
      title: "Create pub + priv buckets",
      status: [200, 201, 409].includes(pubStatus) && [200, 201, 409].includes(privStatus) ? "pass" : "fail",
      measurements: { pub: pubStatus, priv: privStatus },
    });

    const measurements: Record<string, number | string> = {};
    let allOk = true;
    for (const [key, f] of Object.entries(FIXTURES)) {
      const body = f.make();
      const status = await upload(ctx, "pub", f.path, body, f.contentType);
      measurements[`${key}_status`] = status;
      measurements[`${key}_bytes`] = body.length;
      if (![200, 201].includes(status)) allOk = false;
    }
    // small.png also lives in priv for the signed/RLS probes
    const privUp = await upload(ctx, "priv", "small.png", FIXTURES.small.make(), "image/png");
    measurements.priv_small_status = privUp;
    if (![200, 201].includes(privUp)) allOk = false;

    out.push({
      id: "I01-fixtures",
      title: "Upload fixtures to pub (+ small.png to priv)",
      status: allOk ? "pass" : "fail",
      measurements,
    });
    return out;
  },
};
export default mod;
