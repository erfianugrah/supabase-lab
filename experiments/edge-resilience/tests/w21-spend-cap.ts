/**
 * W21 - spend cap trip behavior (Pro-only feature; runs in the Pro org).
 *
 * The spend cap is a Pro-plan org feature and cannot be toggled via the
 * Management API, so this module drives the actual boundary: it provisions
 * a fresh project in the Pro org (ErfiCorp), uploads 105 distinct images,
 * and requests a render transformation for each - the Pro quota is 100
 * distinct origin-image transformations per billing cycle per org. With the
 * cap on, the documented behavior is "further usage of that item is
 * disallowed until the next billing cycle" - what the API actually answers
 * at #101 is the measurement: status code, body, whether the disallow is
 * synchronous, and whether already-transformed origins still serve.
 *
 * Cost: a Nano project for ~10 minutes (covered by the org's $10 compute
 * credits) and zero overage - the cap being ON is precisely what makes the
 * drill free. Side effect: the org's transform quota is spent for the rest
 * of the billing cycle (the org has no production projects; noted here
 * because it is the one consequence that outlives the cleanup).
 *
 * requires: ["pat"]. destructive: true (provisions and deletes a project;
 * trips the org transform quota). where: "local" - drives everything via
 * the Management + Storage APIs.
 */
import type { TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

let PRO_ORG = ""; // from PVLAB_ORG_PRO via ctx.orgs.pro; set in run() (Pro plan - spend cap is Pro-only)
const REGION = "ap-southeast-2";
const IMAGES = 105; // 100 included origin-image transforms + 5 past the boundary
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/* 1x1 PNG with a distinct tEXt chunk per index, so every file is a
 * distinct origin image (the quota counts distinct origins). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function makePng(i: number): Uint8Array {
  const base = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
  const text = new TextEncoder().encode(`w21\0img-${i}`);
  const chunk = new Uint8Array(4 + 4 + text.length + 4);
  chunk.set(u32(text.length), 0);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(text, 8);
  chunk.set(u32(crc32(chunk.subarray(4, 8 + text.length))), 8 + text.length);
  const out = new Uint8Array(base.length + chunk.length);
  out.set(base.subarray(0, base.length - 12), 0); // everything before IEND
  out.set(chunk, base.length - 12);
  out.set(base.subarray(base.length - 12), base.length - 12 + chunk.length); // IEND last
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mod: TestModule = {
  id: "W21",
  title: "spend cap trip behavior (transform quota boundary)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx): Promise<TestResult> {
    PRO_ORG = ctx.orgs.pro ?? "";
    if (!PRO_ORG) return { id: "W21", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" };
    const evidence: string[] = [];
    const measurements: Record<string, number | string> = {};
    let ref = "";
    try {
      // 1. Provision a project in the Pro org.
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `w21-spend-cap-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      if (create.status !== 201) {
        return { id: "W21", title: this.title, status: "fail", detail: `project create: HTTP ${create.status}: ${create.text.slice(0, 300)}` };
      }
      ref = (create.json as { ref?: string } | undefined)?.ref ?? "";
      if (!ref) {
        return { id: "W21", title: this.title, status: "fail", detail: `project create returned no ref: ${create.text.slice(0, 300)}` };
      }
      let status = "";
      for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        status = (p.json as { status?: string } | undefined)?.status ?? "";
      }
      measurements["provision_s"] = Math.round((Date.now() - t0) / 1000);
      if (status !== "ACTIVE_HEALTHY") {
        return { id: "W21", title: this.title, status: "fail", detail: `project not healthy after 15 min (status=${status})`, measurements };
      }

      // 2. API keys.
      const keys = await mgmt(ctx, "GET", `/projects/${ref}/api-keys`);
      const anon = (keys.json as Array<{ name: string; api_key: string }>).find((k) => k.name === "anon")?.api_key;
      const service = (keys.json as Array<{ name: string; api_key: string }>).find((k) => k.name === "service_role")?.api_key;
      if (!anon || !service) {
        return { id: "W21", title: this.title, status: "fail", detail: "api-keys missing anon/service_role", measurements };
      }
      const base = `https://${ref}.supabase.co/storage/v1`;
      const svcHeaders = { Authorization: `Bearer ${service}`, apikey: service };

      // Storage's tenant config lags ACTIVE_HEALTHY on fresh projects
      // (TenantNotFound until the storage service provisions the tenant).
      let tenantReady = false;
      for (let i = 0; i < 30 && !tenantReady; i++) {
        const probe = await fetch(`${base}/bucket`, { headers: svcHeaders, signal: AbortSignal.timeout(15_000) });
        tenantReady = probe.status !== 400 && probe.status !== 404;
        if (!tenantReady) await sleep(10_000);
      }
      if (!tenantReady) {
        return { id: "W21", title: this.title, status: "fail", detail: "storage tenant not ready after 5 min", measurements };
      }

      // 4. Public bucket + 105 distinct uploads. A fresh project's storage
      // pool is contended (429 SlowDown) - retry with backoff.
      let bucket: Response | null = null;
      for (let i = 0; i < 10 && !bucket?.ok; i++) {
        if (i > 0) await sleep(15_000);
        bucket = await fetch(`${base}/bucket`, {
          method: "POST",
          headers: { ...svcHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ id: "w21", name: "w21", public: true }),
          signal: AbortSignal.timeout(30_000),
        });
      }
      if (!bucket?.ok) {
        return { id: "W21", title: this.title, status: "fail", detail: `bucket create: HTTP ${bucket?.status}: ${(await bucket!.text()).slice(0, 300)}`, measurements };
      }
      for (let i = 1; i <= IMAGES; i++) {
        const up = await fetch(`${base}/object/w21/img-${i}.png`, {
          method: "POST",
          headers: { ...svcHeaders, "Content-Type": "image/png", "x-upsert": "true" },
          body: makePng(i).slice().buffer,
          signal: AbortSignal.timeout(30_000),
        });
        if (!up.ok) {
          return { id: "W21", title: this.title, status: "fail", detail: `upload img-${i}: HTTP ${up.status}: ${(await up.text()).slice(0, 200)}`, measurements };
        }
      }
      evidence.push(`uploaded ${IMAGES} distinct images to public bucket w21`);

      // 5. Render each image once; record the status per index.
      const statuses: Array<{ i: number; status: number; body?: string }> = [];
      for (let i = 1; i <= IMAGES; i++) {
        const r = await fetch(`${base}/render/image/public/w21/img-${i}.png?width=32`, {
          headers: { apikey: anon },
          signal: AbortSignal.timeout(30_000),
        });
        const entry: { i: number; status: number; body?: string } = { i, status: r.status };
        if (r.status !== 200) entry.body = (await r.text()).slice(0, 400);
        else await r.arrayBuffer(); // consume
        statuses.push(entry);
      }
      const firstFail = statuses.find((s) => s.status !== 200);
      const okCount = statuses.filter((s) => s.status === 200).length;
      measurements["renders_ok"] = okCount;
      measurements["boundary_index"] = firstFail ? firstFail.i : "none";
      if (firstFail) {
        measurements["first_fail_status"] = firstFail.status;
        evidence.push(`first non-200 at image #${firstFail.i}: HTTP ${firstFail.status} ${firstFail.body ?? ""}`);
      } else {
        evidence.push(`all ${IMAGES} renders returned 200 - no synchronous disallow at quota+${IMAGES - 100}`);
      }

      // 6. Re-check the boundary image after 30s (is enforcement lagging?),
      // and re-render an already-transformed origin past the boundary.
      if (firstFail) {
        await sleep(30_000);
        const recheck = await fetch(`${base}/render/image/public/w21/img-${firstFail.i}.png?width=32`, {
          headers: { apikey: anon },
          signal: AbortSignal.timeout(30_000),
        });
        measurements["boundary_recheck_status"] = recheck.status;
        evidence.push(`re-check of #${firstFail.i} after 30s: HTTP ${recheck.status}`);
        await recheck.arrayBuffer();
      }
      const existing = await fetch(`${base}/render/image/public/w21/img-1.png?width=32`, {
        headers: { apikey: anon },
        signal: AbortSignal.timeout(30_000),
      });
      measurements["existing_render_post_cap"] = existing.status;
      evidence.push(`re-render of already-transformed img-1: HTTP ${existing.status}`);
      await existing.arrayBuffer();

      const detail = firstFail
        ? `cap boundary at transform #${firstFail.i}: HTTP ${firstFail.status} after ${okCount} ok; already-transformed origins still serve (HTTP ${measurements["existing_render_post_cap"]})`
        : `no synchronous enforcement at quota+${IMAGES - 100}: all renders 200; disallow (if any) is not immediate`;
      return {
        id: "W21",
        title: this.title,
        status: "pass",
        detail,
        measurements,
        evidence: evidence.join("\n"),
      };
    } finally {
      if (ref) {
        const del = await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
        evidence.push(`project ${ref} delete: HTTP ${del?.status ?? "error"}`);
      }
    }
  },
};
export default mod;
