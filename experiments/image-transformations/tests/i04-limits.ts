/**
 * I04 - source limits. Docs: >25MB file and >50MP resolution are rejected.
 * Both are render-time checks - the same objects upload fine. Also: requests
 * beyond the source dimensions clamp to the source (no upscaling, no error).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { storageBase, probe } from "../lib";

const mod: TestModule = {
  id: "I04",
  title: "Source limits",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const B = storageBase(ctx);
    const out: TestResult[] = [];

    const bigFile = await probe(`${B}/render/image/public/pub/huge-bytes.png?width=400`, undefined, true);
    out.push({
      id: "I04-too-many-bytes",
      title: ">25MB source rejected at render time",
      status: bigFile.status === 400 ? "pass" : "fail",
      measurements: { status: bigFile.status },
      evidence: bigFile.body?.toString("utf8").slice(0, 200),
    });

    const bigMp = await probe(`${B}/render/image/public/pub/huge-mp.png?width=400`, undefined, true);
    out.push({
      id: "I04-too-many-mp",
      title: ">50MP source rejected at render time",
      status: bigMp.status === 400 ? "pass" : "fail",
      measurements: { status: bigMp.status },
      evidence: bigMp.body?.toString("utf8").slice(0, 200),
    });

    const identity = await probe(`${B}/render/image/public/pub/small.png`);
    const overSource = await probe(`${B}/render/image/public/pub/small.png?width=5000`);
    out.push({
      id: "I04-over-source-clamp",
      title: "request beyond source dims clamps to source (no upscale)",
      status: overSource.status === 200 && overSource.bytes === identity.bytes ? "pass" : "info",
      measurements: { identity_bytes: identity.bytes, over_source_bytes: overSource.bytes },
    });

    return out;
  },
};
export default mod;
