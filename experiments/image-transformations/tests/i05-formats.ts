/**
 * I05 - format matrix. SVG pass-through (W19 saw this on the drill pair;
 * re-pinning here), GIF and BMP handling, and Accept-header content
 * negotiation incl. whether Vary: Accept keeps webp/jpeg variants apart in
 * the edge cache. Mostly info: there is no single correct value for GIF
 * frame handling; the point is to record what the platform does.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { storageBase, probe } from "../lib";

const mod: TestModule = {
  id: "I05",
  title: "Format matrix",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const B = storageBase(ctx);
    const out: TestResult[] = [];

    const svg = await probe(`${B}/render/image/public/pub/vector.svg?width=50`, undefined, true);
    const svgBody = svg.body?.toString("utf8") ?? "";
    out.push({
      id: "I05-svg",
      title: "SVG passes through unchanged",
      status: svg.status === 200 && svgBody.includes("<svg") ? "pass" : "info",
      measurements: { status: svg.status, ct: svg.contentType, bytes: svg.bytes },
    });

    const gif = await probe(`${B}/render/image/public/pub/tiny.gif?width=1`);
    out.push({
      id: "I05-gif",
      title: "GIF transform behavior",
      status: "info",
      measurements: { status: gif.status, ct: gif.contentType, bytes: gif.bytes },
    });

    const bmp = await probe(`${B}/render/image/public/pub/small.bmp?width=32`);
    out.push({
      id: "I05-bmp",
      title: "BMP transform behavior",
      status: "info",
      measurements: { status: bmp.status, ct: bmp.contentType, bytes: bmp.bytes },
    });

    const webp = await probe(`${B}/render/image/public/pub/small.png?width=200`, {
      headers: { Accept: "image/webp,image/*" },
    });
    const jpeg = await probe(`${B}/render/image/public/pub/small.png?width=200`, {
      headers: { Accept: "image/jpeg" },
    });
    out.push({
      id: "I05-accept-negotiation",
      title: "Accept-header negotiation + Vary",
      status: "info",
      detail: "if Vary lacks Accept, webp and jpeg variants can collide at one cache key",
      measurements: {
        webp_ct: webp.contentType,
        webp_vary: webp.vary || "(none)",
        jpeg_ct: jpeg.contentType,
        jpeg_vary: jpeg.vary || "(none)",
      },
    });

    return out;
  },
};
export default mod;
