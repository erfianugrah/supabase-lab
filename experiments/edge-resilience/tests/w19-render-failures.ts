/**
 * W19 - imgproxy render-path failure modes.
 *
 * Tests the behavior of the Supabase storage image transformation/render path.
 * Checks if valid, corrupt, and SVG files behave as a user would expect (transform vs fallback).
 *
 * Pass criteria: all six outcomes (3 render, 3 plain) recorded verbatim.
 * Any measured behavior passes.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "W19",
  title: "imgproxy render-path failure modes",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const bucket = "w19-drill";
    const measurements: Record<string, string | number> = {};
    const apiHost = ctx.apiHost;
    const anonKey = ctx.anonKey!;
    const serviceKey = ctx.serviceKey!;

    // 1x1 transparent PNG (Base64)
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const pngBuffer = Buffer.from(pngBase64, "base64");

    const objects = [
      { name: "valid.png", content: pngBuffer },
      { name: "corrupt.png", content: Buffer.from("this is not a png file content", "utf8") },
      { name: "image.svg", content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="red"/></svg>', "utf8") },
    ];

    const cleanup = async () => {
      // Primary cleanup
      await fetch(`https://${apiHost}/storage/v1/bucket/${bucket}/empty`, {
        method: "POST",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      }).catch(() => {});
      await fetch(`https://${apiHost}/storage/v1/bucket/${bucket}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      }).catch(() => {});
    };

    try {
      // 1. Idempotent setup (W10 pattern)
      // Empty + Delete if exists
      await fetch(`https://${apiHost}/storage/v1/bucket/${bucket}/empty`, {
        method: "POST",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      }).catch(() => {});
      await fetch(`https://${apiHost}/storage/v1/bucket/${bucket}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      }).catch(() => {});

      // Create bucket (public)
      const createRes = await fetch(`https://${apiHost}/storage/v1/bucket`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ id: bucket, name: bucket, public: true }),
        signal: AbortSignal.timeout(30_000),
      });
      measurements["create_bucket_status"] = createRes.status;
      if (!createRes.ok) {
        const err = await createRes.text();
        throw new Error(`create bucket failed: ${createRes.status} ${err}`);
      }

      // Upload objects
      for (const obj of objects) {
        const uploadRes = await fetch(
          `https://${apiHost}/storage/v1/object/${bucket}/${obj.name}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
            },
            body: obj.content,
            signal: AbortSignal.timeout(30_000),
          },
        );
        measurements[`upload_${obj.name}_status`] = uploadRes.status;
        if (!uploadRes.ok) {
          const err = await uploadRes.text();
          throw new Error(`upload ${obj.name} failed: ${uploadRes.status} ${err}`);
        }
      }

      // 2. Probing
      for (const obj of objects) {
        const name = obj.name;
        // Case A: Render path
        const renderUrl = `https://${apiHost}/storage/v1/render/image/public/${bucket}/${name}?width=32`;
        const renderRes = await fetch(renderUrl, {
          headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
          signal: AbortSignal.timeout(30_000),
        });
        measurements[`render_${name}_status`] = renderRes.status;
        const renderBody = await renderRes.text().catch(() => "");
        measurements[`render_${name}_body`] = renderBody.slice(0, 200);

        // Case B: Plain URL
        const plainUrl = `https://${apiHost}/storage/v1/object/public/${bucket}/${name}`;
        const plainRes = await fetch(plainUrl, {
          headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
          signal: AbortSignal.timeout(30_000),
        });
        measurements[`plain_${name}_status`] = plainRes.status;
        const plainBody = await plainRes.text().catch(() => "");
        measurements[`plain_${name}_body`] = plainBody.slice(0, 200);
      }

      return {
        id: "W19",
        title: this.title,
        status: "pass",
        detail: "All six outcomes (3 render, 3 plain) recorded.",
        measurements,
      };
    } catch (e: any) {
      return {
        id: "W19",
        title: this.title,
        status: "fail",
        detail: e.message,
        measurements,
      };
    } finally {
      await cleanup();
    }
  },
};

export default mod;
