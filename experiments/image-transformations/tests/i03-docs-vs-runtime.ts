/**
 * I03 - documented parameter bounds vs runtime behavior. Docs say width and
 * height must be integers 1-2500; the ad-hoc probe found 2501 accepted, a
 * silent clamp at 3000, width=0 treated as identity, and junk params ignored.
 * Docs: https://supabase.com/docs/guides/storage/serving/image-transformations
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { storageBase, probe } from "../lib";

const mod: TestModule = {
  id: "I03",
  title: "Docs vs runtime: parameter bounds",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const B = storageBase(ctx);
    const img = `${B}/render/image/public/pub/big-12mp.png`;
    const out: TestResult[] = [];

    const w2501 = await probe(`${img}?width=2501`);
    out.push({
      id: "I03-width-2501",
      title: "width=2501 accepted (docs say max 2500)",
      status: w2501.status === 200 ? "fail" : "pass",
      detail: "fail here means the documented 1-2500 bound is wrong at runtime",
      measurements: { status: w2501.status, bytes: w2501.bytes },
    });

    const w3000 = await probe(`${img}?width=3000`);
    const w3001 = await probe(`${img}?width=3001`);
    const w5000 = await probe(`${img}?width=5000`);
    out.push({
      id: "I03-clamp-3000",
      title: "requests above 3000 silently clamp (no error)",
      status:
        w3000.status === 200 && w3001.status === 200 && w5000.status === 200 &&
        w3001.bytes === w3000.bytes && w5000.bytes === w3000.bytes
          ? "pass"
          : "info",
      measurements: { w3000: w3000.bytes, w3001: w3001.bytes, w5000: w5000.bytes },
    });

    const w0 = await probe(`${B}/render/image/public/pub/small.png?width=0`);
    const noParams = await probe(`${B}/render/image/public/pub/small.png`);
    out.push({
      id: "I03-width-zero",
      title: "width=0 treated as identity, not rejected",
      status: w0.status === 200 ? "pass" : "info",
      measurements: { w0_status: w0.status, w0_bytes: w0.bytes, noparams_bytes: noParams.bytes },
    });

    const wAbc = await probe(`${img}?width=abc`);
    out.push({
      id: "I03-width-abc",
      title: "width=abc rejected 400",
      status: wAbc.status === 400 ? "pass" : "fail",
      measurements: { status: wAbc.status },
    });

    const clean = await probe(`${B}/render/image/public/pub/small.png?width=200&height=200`);
    const junk = await probe(`${B}/render/image/public/pub/small.png?width=200&height=200&pvlab_junk=1`);
    out.push({
      id: "I03-junk-param",
      title: "unknown params ignored (same bytes)",
      status: junk.status === 200 && junk.bytes === clean.bytes ? "pass" : "info",
      measurements: { clean_bytes: clean.bytes, junk_bytes: junk.bytes },
    });

    return out;
  },
};
export default mod;
