/**
 * HS02 - Past the content-type, does Storage behave like a static host? The
 * features a Pages/Netlify user relies on without thinking about them.
 *
 * Side: managed Storage, the `site` bucket HS01 populated (re-ensured here so
 * HS02 runs alone). Browser-shaped GETs on <ref>.supabase.co.
 *
 *   HS02a  bucket root `/object/public/site/` - is index.html served?
 *   HS02b  directory `/object/public/site/about/` - is about/index.html served?
 *   HS02c  extensionless `/object/public/site/about` - clean URLs?
 *   HS02d  missing path - status and content-type (an SPA fallback or a
 *          custom 404 page needs this to be configurable; it is recorded)
 *   HS02e  cache headers: the object was uploaded with max-age=3600; what
 *          cache-control is served, and does a second GET hit the CDN?
 *   HS02f  redeploy visibility: overwrite assets/app.css with new bytes, poll
 *          the public URL every 2 s up to 120 s for the new body. A static
 *          host swaps a deploy atomically; this measures how long a stale
 *          asset keeps being served. image-transformations I06 found render
 *          variants stale up to 60 s; this is the plain object path.
 *
 * Not settled by this module: atomic multi-file deploys (Storage has no
 * deploy unit to test - each object is its own write), redirects/rewrites
 * config (no such surface exists in the Storage API to probe).
 *
 * DESTRUCTIVE: overwrites assets/app.css; restores the original bytes at the end.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { FIXTURES, cols, ensureSite, probe, publicUrl, serviceKey, uploadObject } from "../lib/site";

const mod: TestModule = {
  id: "HS02",
  title: "Storage: static-host mechanics (index, clean URLs, 404, cache, redeploy)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "HS02", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    await ensureSite(ctx);

    const served = (s: Awaited<ReturnType<typeof probe>>) =>
      `HTTP ${s.status} "${s.contentType}" ${s.bytes} B${s.location ? ` -> ${s.location}` : ""} "${s.bodyHead.slice(0, 60)}"`;
    const indexServed = (s: Awaited<ReturnType<typeof probe>>) => s.status === 200 && s.bodyHead.includes("<!doctype html");

    for (const [id, title, path] of [
      ["HS02a", "Bucket root serves index.html", ""],
      ["HS02b", "Directory path serves its index.html", "about/"],
      ["HS02c", "Extensionless path serves about/index.html", "about"],
    ] as const) {
      const s = await probe(publicUrl(ctx, path));
      out.push({ id, title, status: "info", detail: served(s), measurements: { ...cols("get", s), index_served: indexServed(s) ? 1 : 0 } });
    }

    const missing = await probe(publicUrl(ctx, "no/such/route"));
    out.push({
      id: "HS02d",
      title: "Missing path: status and body (SPA fallback / custom 404)",
      status: "info",
      detail: served(missing),
      measurements: cols("missing", missing),
    });

    const first = await probe(publicUrl(ctx, "assets/app.css"));
    const second = await probe(publicUrl(ctx, "assets/app.css"));
    out.push({
      id: "HS02e",
      title: "Cache-Control served for an object uploaded with max-age=3600; CDN on repeat",
      status: "info",
      detail: `cache-control "${first.cacheControl}"; cf-cache-status ${first.cfCache || "none"} then ${second.cfCache || "none"}`,
      measurements: { cache_control: first.cacheControl || "none", cf_first: first.cfCache || "none", cf_second: second.cfCache || "none" },
    });

    // ---- HS02f: redeploy visibility ----
    const css = FIXTURES.find((f) => f.key === "css")!;
    const svc = await serviceKey(ctx);
    const marker = `/* pvlab-v2 ${Date.now()} */`;
    const v2 = new TextEncoder().encode(`${marker}\nbody{font-family:serif}\n`);
    try {
      const up = await uploadObject(ctx, svc, css.path, v2, css.contentType);
      const t0 = Date.now();
      let seenMs = -1;
      let polls = 0;
      let staleCf = "";
      while (Date.now() - t0 < 120_000) {
        polls++;
        // Fresh query string each poll would bypass the cache key and measure
        // nothing; the URL a browser holds is the plain one.
        const s = await probe(publicUrl(ctx, css.path));
        if (s.bodyHead.includes("pvlab-v2")) {
          seenMs = Date.now() - t0;
          break;
        }
        staleCf = s.cfCache;
        await Bun.sleep(2_000);
      }
      out.push({
        id: "HS02f",
        title: "Overwritten asset: time until the public URL serves the new bytes",
        status: up !== 200 && up !== 201 ? "fail" : "info",
        detail:
          seenMs >= 0
            ? `new bytes after ${seenMs} ms (${polls} polls)`
            : `still stale at 120 s (${polls} polls, last cf-cache-status ${staleCf || "none"})`,
        measurements: { upload_status: up, visible_ms: seenMs, polls, stale_cf: staleCf || "none" },
      });
    } finally {
      await uploadObject(ctx, svc, css.path, css.body, css.contentType);
    }
    return out;
  },
};
export default mod;
