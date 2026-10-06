/**
 * HS05 - What does a visitor actually see when a real Astro build is hosted on
 * Supabase, next to the same build on an ordinary static server?
 *
 * The site is site/ (Astro 7 static output, Tailwind, a self-hosted font, an
 * SVG asset, one React island that calls the project's Auth health endpoint
 * with the anon key) - the shape of the corpus-graph demo. `make site` builds
 * it once per host, because each host mounts it under a different base path:
 *
 *   dist-root     base "/"                              -> local control
 *   dist-storage  base "/storage/v1/object/public/astro" -> bucket `astro`
 *   dist-fn       base "/functions/v1/pvlab-hs-astro"    -> function `pvlab-hs-astro`
 *
 * Each copy is loaded in headless Chromium (site/browser-check.ts, a
 * subprocess) with no key and no extension, as a visitor would. Rows:
 *
 *   HS05-control  Bun static server on localhost serving dist-root. MUST pass
 *                 (rendered, island hydrated, font applied, About reachable),
 *                 or the build or the checker is broken and the other rows
 *                 mean nothing.
 *   HS05-storage  the build in a public bucket, loaded at .../astro/index.html
 *   HS05-storage-root  the same bucket loaded at .../astro/ (the URL a
 *                 visitor would type, and what the nav "home" link points at)
 *   HS05-fn       the build served by an Edge Function, loaded at its mount root
 *   HS05-domain-fn       the function through PVLAB_ENDPOINT_CUSTOM_DOMAIN
 *                        (the documented exception to the rewrite; HS04 brings
 *                        it up). Expected to render. Skipped without a domain.
 *   HS05-domain-storage  the bucket through the same custom domain. The docs
 *                        name the exception for Functions only; info.
 *   The browser is pinned to 1.1.1.1's answer for the custom name.
 *
 * Supabase rows pass when the page does NOT render, matching the docs (Storage
 * quickstart: HTML "returned as plain text"; Functions limits: GET text/html
 * "rewritten to text/plain" without a custom domain). A rendered page there is
 * a measured disagreement and fails. Screenshots go to $PVLAB_SHOTS
 * (default evidence/screens).
 *
 * Not settled by this module: performance, caching, deploy atomicity (HS02),
 * or any browser other than Chromium.
 *
 * DESTRUCTIVE: creates bucket `astro` and its objects (left for the project's
 * destroy), deploys `pvlab-hs-astro` (deleted in finally unless
 * PVLAB_KEEP_DEPLOYED=1, so the URLs can be opened after the run).
 */
import { mkdir } from "node:fs/promises";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { functionPresent } from "../../../harness/src/platform";
import { browserCheck, row } from "../lib/browser";
import { publicIp } from "../lib/cfdns";
import {
  type FileTable,
  deleteFileServer,
  deployFileServer,
  ensureBucket,
  fnUrl,
  publicUrl,
  readDist,
  serviceKey,
  uploadObject,
  whenLive,
} from "../lib/site";

const BUCKET = "astro";
const SLUG = "pvlab-hs-astro";

/** The positive control: what Pages/Netlify do for an Astro build, in 15 lines. */
function serveLocal(files: FileTable): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      let p = decodeURIComponent(new URL(req.url).pathname).replace(/^\//, "");
      if (p === "" || p.endsWith("/")) p += "index.html";
      const f = files[p] ?? files[`${p}/index.html`];
      if (f) return new Response(f.body as BodyInit, { headers: { "Content-Type": f.ct } });
      const nf = files["404.html"];
      return new Response((nf?.body ?? "not found") as BodyInit, { status: 404, headers: { "Content-Type": nf?.ct ?? "text/plain" } });
    },
  });
  return { url: `http://localhost:${server.port}/`, stop: () => server.stop(true) };
}

const mod: TestModule = {
  id: "HS05",
  title: "A real Astro build on Storage and Edge Functions, loaded in a browser",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "HS05", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const [root, storage, fn] = await Promise.all([readDist("site/dist-root"), readDist("site/dist-storage"), readDist("site/dist-fn")]);
    const missing = Object.entries({ "dist-root": root, "dist-storage": storage, "dist-fn": fn })
      .filter(([, t]) => !t["index.html"])
      .map(([k]) => k);
    if (missing.length) return [{ id: "HS05", title: this.title, status: "skip", detail: `no build in site/${missing.join(", site/")} - run 'make site' first` }];

    const shots = process.env.PVLAB_SHOTS || "evidence/screens";
    await mkdir(shots, { recursive: true });
    const out: TestResult[] = [];

    // ---- control ----
    const local = serveLocal(root);
    try {
      const shot = `${shots}/hs05-control.png`;
      out.push(row("HS05-control", "Control: the same build on a plain static server (localhost)", await browserCheck(local.url, shot), true, shot));
    } finally {
      local.stop();
    }
    if (out[0]?.status !== "pass") {
      out[0]!.detail = `CONTROL FAILED - Supabase rows not run. ${out[0]!.detail ?? ""}`;
      return out;
    }

    // ---- Storage ----
    const svc = await serviceKey(ctx);
    const bucketStatus = await ensureBucket(ctx, svc, BUCKET);
    const ups = await Promise.all(Object.entries(storage).map(([p, f]) => uploadObject(ctx, svc, p, f.body, f.ct, "60", BUCKET)));
    const upFailed = ups.filter((s) => s !== 200 && s !== 201).length;
    out.push({
      id: "HS05-storage-setup",
      title: `Upload dist-storage (${Object.keys(storage).length} files) to public bucket \`${BUCKET}\``,
      status: [200, 201].includes(bucketStatus) && upFailed === 0 ? "pass" : "fail",
      measurements: { bucket: bucketStatus, files: ups.length, failed: upFailed },
    });
    for (const [id, path, title] of [
      ["HS05-storage", "index.html", "Storage: .../astro/index.html in a browser"],
      ["HS05-storage-root", "", "Storage: .../astro/ (the URL a visitor types) in a browser"],
    ] as const) {
      const shot = `${shots}/${id.toLowerCase()}.png`;
      out.push(row(id, title, await browserCheck(publicUrl(ctx, path, BUCKET), shot), false, shot));
    }

    // ---- Edge Function ----
    try {
      const dep = await deployFileServer(ctx, fn, SLUG);
      const landed = await functionPresent(ctx, SLUG);
      const live = await whenLive(fnUrl(ctx, "/", SLUG));
      out.push({
        id: "HS05-fn-setup",
        title: `Deploy dist-fn as function \`${SLUG}\` (files inlined, API path)`,
        status: dep.status < 300 && landed.present && live.status === 200 ? "pass" : "fail",
        detail: `deploy HTTP ${dep.status}${dep.error ? ` "${dep.error}"` : ""}; source ${dep.sourceBytes} B; first GET ${live.status} "${live.contentType}"`,
        measurements: { deploy_status: dep.status, source_bytes: dep.sourceBytes, first_get: live.status },
      });
      if (live.status === 200) {
        const shot = `${shots}/hs05-fn.png`;
        out.push(row("HS05-fn", "Edge Function: mount root in a browser", await browserCheck(fnUrl(ctx, "/", SLUG), shot), false, shot));
        const domain = ctx.endpoints.custom_domain;
        if (domain) {
          const ip = await publicIp(domain);
          const pin = ip ? `${domain}=${ip}` : undefined;
          for (const [id, path, title, expectRender] of [
            ["HS05-domain-fn", `/functions/v1/${SLUG}/`, "Edge Function via custom domain (documented exception)", true],
            ["HS05-domain-storage", `/storage/v1/object/public/${BUCKET}/index.html`, "Storage via custom domain (exception documented for Functions only)", false],
          ] as const) {
            const shot = `${shots}/${id.toLowerCase()}.png`;
            const r = row(id, title, await browserCheck(`https://${domain}${path}`, shot, pin), expectRender, shot);
            if (id === "HS05-domain-storage") r.status = "info";
            out.push(r);
          }
        } else {
          out.push({ id: "HS05-domain", title: "Custom domain", status: "skip", detail: "no PVLAB_ENDPOINT_CUSTOM_DOMAIN (HS04 brings one up)" });
        }
      }
    } finally {
      if (process.env.PVLAB_KEEP_DEPLOYED === "1") ctx.log(`HS05: leaving ${SLUG} deployed (PVLAB_KEEP_DEPLOYED=1)`);
      else ctx.log(`HS05 cleanup: DELETE ${SLUG} -> ${await deleteFileServer(ctx, SLUG)}`);
    }
    return out;
  },
};
export default mod;
