/**
 * I02 - which URL surfaces actually transform. The integration trap this
 * pins: params appended to /object/* URLs are silently ignored (full
 * original, 200, no error); only the /render/image/* surfaces transform.
 * Prior ad-hoc probe (2026-08-18) found exactly this; this module makes it
 * reproducible.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { storageBase, sign, probe, FIXTURES } from "../lib";

const mod: TestModule = {
  id: "I02",
  title: "URL surfaces",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const B = storageBase(ctx);
    const origBytes = FIXTURES.small.make().length;
    const out: TestResult[] = [];

    const render = await probe(`${B}/render/image/public/pub/small.png?width=200&height=200`);
    out.push({
      id: "I02-render-public",
      title: "render/image/public transforms without auth",
      status: render.status === 200 && render.bytes < origBytes ? "pass" : "fail",
      measurements: { status: render.status, bytes: render.bytes, orig_bytes: origBytes, ct: render.contentType },
    });

    const objPublic = await probe(`${B}/object/public/pub/small.png?width=200&height=200`);
    out.push({
      id: "I02-object-public",
      title: "object/public silently ignores transform params",
      status: objPublic.status === 200 && objPublic.bytes === origBytes ? "pass" : "fail",
      detail: "documents the silent-ignore trap: 200 + full original, no error",
      measurements: { status: objPublic.status, bytes: objPublic.bytes, orig_bytes: origBytes },
    });

    const signedPlain = await sign(ctx, "priv/small.png", 600);
    const objSign = await probe(`https://${ctx.ref}.supabase.co/storage/v1${signedPlain}&width=200&height=200`);
    out.push({
      id: "I02-object-sign",
      title: "object/sign ignores appended transform params",
      status: objSign.status === 200 && objSign.bytes === origBytes ? "pass" : "fail",
      measurements: { status: objSign.status, bytes: objSign.bytes, orig_bytes: origBytes },
    });

    const signedTransform = await sign(ctx, "priv/small.png", 600, { width: 200, height: 200 });
    const renderSign = await probe(`https://${ctx.ref}.supabase.co/storage/v1${signedTransform}`);
    const isRenderSurface = signedTransform.includes("/render/image/sign/");
    out.push({
      id: "I02-render-sign",
      title: "sign with transform embeds it in a render/image/sign URL",
      status: isRenderSurface && renderSign.status === 200 && renderSign.bytes < origBytes ? "pass" : "fail",
      measurements: {
        render_surface: isRenderSurface ? "yes" : "no",
        status: renderSign.status,
        bytes: renderSign.bytes,
      },
    });

    const privPublic = await probe(`${B}/render/image/public/priv/small.png?width=200`);
    out.push({
      id: "I02-priv-via-public",
      title: "private bucket via public render surface is blocked",
      status: privPublic.status === 400 || privPublic.status === 403 ? "pass" : "fail",
      measurements: { status: privPublic.status },
    });

    return out;
  },
};
export default mod;
