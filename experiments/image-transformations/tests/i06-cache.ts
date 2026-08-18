/**
 * I06 - edge cache behavior. Cold vs warm latency, cf-cache-status on the
 * warm hit, junk-param normalization, HEAD support, and Smart CDN
 * invalidation: overwrite the object, re-render the same variant, and the
 * bytes must change. The overwrite step mutates fixture state but stays
 * non-destructive - re-running I01 resets it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { storageBase, probe, upload, pngFlat } from "../lib";

const mod: TestModule = {
  id: "I06",
  title: "Edge cache",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const B = storageBase(ctx);
    const variant = `${B}/render/image/public/pub/small.png?width=260&height=260`;
    const out: TestResult[] = [];

    const cold = await probe(variant);
    const warm = await probe(variant);
    out.push({
      id: "I06-cold-warm",
      title: "repeat render served from edge cache",
      status: warm.cfCacheStatus === "HIT" ? "pass" : "info",
      measurements: {
        cold_ms: cold.timeMs,
        warm_ms: warm.timeMs,
        warm_cf: warm.cfCacheStatus || "(none)",
        same_bytes: cold.bytes === warm.bytes ? "yes" : "no",
      },
    });

    const junk = await probe(`${variant}&pvlab_bust=${Date.now()}`);
    out.push({
      id: "I06-junk-no-bust",
      title: "junk query param does not bust the cache",
      status: junk.bytes === warm.bytes ? "pass" : "info",
      measurements: { warm_bytes: warm.bytes, junk_bytes: junk.bytes, junk_cf: junk.cfCacheStatus || "(none)" },
    });

    const head = await probe(variant, { method: "HEAD" });
    out.push({
      id: "I06-head",
      title: "HEAD on a render URL",
      status: head.status === 200 ? "pass" : "info",
      measurements: { status: head.status },
    });

    // Invalidation: overwrite small.png with a different color, re-render the
    // same variant, compare bytes against the pre-overwrite render.
    const before = await probe(variant);
    const upStatus = await upload(ctx, "pub", "small.png", pngFlat(1200, 800, [200, 60, 60]), "image/png");
    // give the invalidation a moment to propagate, then poll briefly
    const t0 = performance.now();
    let after = await probe(variant);
    // 20 x 3s = 60s window: invalidation may propagate, don't call it stale on a 15s sample
    for (let i = 0; i < 20 && after.bytes === before.bytes; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      after = await probe(variant);
    }
    const invalidateMs = after.bytes !== before.bytes ? Math.round(performance.now() - t0) : -1;
    out.push({
      id: "I06-invalidation",
      title: "object overwrite invalidates cached variants",
      status: after.bytes !== before.bytes ? "pass" : "fail",
      detail: "fail = Smart CDN serves stale renders after overwrite",
      measurements: {
        upload_status: upStatus,
        before_bytes: before.bytes,
        after_bytes: after.bytes,
        after_cf: after.cfCacheStatus || "(none)",
        invalidate_ms: invalidateMs,
      },
    });

    // restore the canonical fixture for later modules
    await upload(ctx, "pub", "small.png", pngFlat(1200, 800, [70, 130, 180]), "image/png");

    return out;
  },
};
export default mod;
