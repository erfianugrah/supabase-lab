/**
 * L06 - Storage lockdown.
 *
 * The inventory's storage rows under the private-bucket lever:
 *
 *   L06a - flip the public bucket private (PUT /storage/v1/bucket/{id}
 *          { public: false } via the service key), re-inventory anon: the
 *          public object URL should 400/403/404.
 *   L06b - the escape hatch: a signed URL (POST /storage/v1/object/sign/...)
 *          minted with the service key should still serve the object.
 *
 * DESTRUCTIVE: flips bucket visibility; restores public:true in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys, http, inventory, toMeasurements, waitFor, BUCKET_PUBLIC } from "../lib/inventory.js";

const OBJECT = "hello.txt";

const mod: TestModule = {
  id: "L06",
  title: "Storage lockdown: private bucket, signed-URL escape hatch",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const base = `https://${ctx.apiHost}`;
    const results: TestResult[] = [];

    // Baseline: anon can read the public object.
    const pubBefore = await http(`${base}/storage/v1/object/public/${BUCKET_PUBLIC}/${OBJECT}`, { key: keys.anonJwt });
    results.push({
      id: "L06a",
      title: "baseline: anon reads the public object",
      status: pubBefore.status === 200 ? "pass" : "info",
      detail: `public object = ${pubBefore.status} ${pubBefore.code}`,
      measurements: { public_object_before: `${pubBefore.status}` },
    });

    try {
      const flip = await http(`${base}/storage/v1/bucket/${BUCKET_PUBLIC}`, {
        method: "PUT",
        key: keys.serviceJwt,
        body: { id: BUCKET_PUBLIC, name: BUCKET_PUBLIC, public: false },
      });
      results.push({
        id: "L06b",
        title: "PUT bucket public=false",
        status: flip.status === 200 ? "pass" : "fail",
        measurements: { patch_status: flip.status },
        evidence: flip.status === 200 ? undefined : `${flip.status} ${flip.code}`,
      });
      if (flip.status !== 200) return results;

      const locked = await waitFor(async () => {
        const r = await http(`${base}/storage/v1/object/public/${BUCKET_PUBLIC}/${OBJECT}`, { key: keys.anonJwt });
        return r.status >= 400;
      }, 60_000);
      const inv = await inventory(ctx, keys.anonJwt, "");
      const pubRow = inv.find((r) => r.surface === "storage_public_object");
      results.push({
        id: "L06c",
        title: "private bucket: anon public URL refused",
        status: locked.ok && pubRow && pubRow.status >= 400 ? "pass" : "fail",
        detail: `after ${locked.elapsedS}s public object = ${pubRow?.status} ${pubRow?.code}`,
        measurements: toMeasurements(inv, "bucket_private"),
      });

      // Escape hatch: a service-key signed URL still serves. Need the JSON
      // body ({ signedURL }), so this uses raw fetch rather than the Probe
      // helper (which only keeps the status + a code string).
      let signedStatus = 0;
      const signRaw = await fetch(`${base}/storage/v1/object/sign/${BUCKET_PUBLIC}/${OBJECT}`, {
        method: "POST",
        headers: { apikey: keys.serviceJwt, Authorization: `Bearer ${keys.serviceJwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 60 }),
      });
      if (signRaw.status === 200) {
        const j = (await signRaw.json()) as { signedURL?: string };
        const signedUrl = j.signedURL ? `${base}/storage/v1${j.signedURL}` : "";
        if (signedUrl) {
          const got = await fetch(signedUrl, { signal: AbortSignal.timeout(10_000) });
          signedStatus = got.status;
        }
      }
      results.push({
        id: "L06d",
        title: "signed URL still serves the object in a private bucket",
        status: signedStatus === 200 ? "pass" : "fail",
        detail: `signed-URL GET = ${signedStatus} (the read path a locked-down customer keeps)`,
        measurements: { signed_url_status: signedStatus },
      });
    } finally {
      const back = await http(`${base}/storage/v1/bucket/${BUCKET_PUBLIC}`, {
        method: "PUT",
        key: keys.serviceJwt,
        body: { id: BUCKET_PUBLIC, name: BUCKET_PUBLIC, public: true },
      });
      results.push({
        id: "L06z",
        title: "restore bucket public=true",
        status: back.status === 200 ? "pass" : "fail",
        detail: back.status === 200 ? "restored" : `restore HTTP ${back.status} ${back.code} - BUCKET LEFT PRIVATE`,
        measurements: { restore_status: back.status },
      });
    }
    return results;
  },
};
export default mod;
