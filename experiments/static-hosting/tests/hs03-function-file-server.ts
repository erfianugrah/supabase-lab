/**
 * HS03 - Can an Edge Function serve the same static site, and what does the
 * HTML rewrite cover?
 *
 * Side: managed Edge Functions on the lab project, one function
 * (`pvlab-hs-site`, verify_jwt=false) deployed through the Management API with
 * the fixture inlined. Every request is browser-shaped (no apikey). EF06a in
 * edge-function-limits already measured the basic rewrite (GET text/html ->
 * text/plain, POST unchanged); this module asks the site-shaped questions.
 *
 *   HS03-deploy    deploy status + the landed read
 *   HS03-<key>     one row per fixture, GET on <ref>.supabase.co/functions/v1/:
 *                  served vs set content-type. html rows pass when NOT served
 *                  as text/html (limits page: "GET requests that return
 *                  text/html will be rewritten to text/plain"); others info.
 *   HS03-root      mount root with a trailing slash -> index.html, served how?
 *   HS03-head      HEAD index.html - info: the rewrite is documented for GET,
 *                  and a HEAD has no body to render (2026-10-06: text/html kept,
 *                  without the CSP/nosniff headers the GET carries)
 *   HS03-post      POST index.html - EF06a saw text/html kept; re-measured
 *   HS03-ct-upper  `TEXT/HTML` set by the handler - does the rewrite match
 *                  case-insensitively, as MIME types are?
 *   HS03-ct-nosp   `text/html;charset=utf-8` (no space)
 *   HS03-fnhost    index.html on <ref>.functions.supabase.co/<slug>/
 *   HS03-missing   unknown path -> the handler's own 404 (the function, not the
 *                  platform, decides fallback - recorded to show that)
 *
 * The two ct- rows probe the robustness of an anti-phishing control. If either
 * comes back text/html, treat it as a security report for the platform team
 * before anything about it is published - not as a hosting workaround.
 *
 * Not settled by this module: CLI/static_files deploys (needs Docker; EF06d2
 * covered it), custom domains (HS04), whether a browser executes the XHTML/SVG.
 *
 * DESTRUCTIVE: deploys `pvlab-hs-site`; deleted in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { functionPresent } from "../../../harness/src/platform";
import { FIXTURES, FN_SLUG, cols, deleteFileServer, deployFileServer, fnUrl, isHtmlType, probe, whenLive } from "../lib/site";

const mod: TestModule = {
  id: "HS03",
  title: "Edge Function as a static file server: served content-types and the HTML rewrite",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "HS03", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    try {
      const dep = await deployFileServer(ctx);
      const landed = await functionPresent(ctx, FN_SLUG);
      const first = await whenLive(fnUrl(ctx, "/robots.txt"));
      out.push({
        id: "HS03-deploy",
        title: "File-server function deployed and answering",
        status: dep.status < 300 && landed.present && first.status === 200 ? "pass" : "fail",
        detail: `deploy HTTP ${dep.status}${dep.error ? ` "${dep.error}"` : ""}; landed ${landed.present} v${landed.version ?? "?"}; first GET ${first.status}`,
        measurements: { deploy_status: dep.status, landed: landed.present ? 1 : 0, first_get: first.status },
      });
      if (first.status !== 200) return out;

      const htmlRow = (id: string, title: string, s: Awaited<ReturnType<typeof probe>>, extra: Record<string, string | number> = {}): TestResult => ({
        id,
        title,
        status: s.status !== 200 ? "fail" : isHtmlType(s.contentType) ? "fail" : "pass",
        detail: `HTTP ${s.status} "${s.contentType}"${s.error ? `; ${s.error}` : ""}`,
        measurements: { ...extra, ...cols("fn", s) },
      });

      for (const f of FIXTURES) {
        const s = await probe(fnUrl(ctx, `/${f.path}`));
        const isHtml = f.key === "html" || f.key === "html_nested";
        if (isHtml) {
          out.push(htmlRow(`HS03-${f.key}`, `${f.path} (set ${f.contentType}) via function GET`, s, { set: f.contentType }));
        } else {
          out.push({
            id: `HS03-${f.key}`,
            title: `${f.path} (set ${f.contentType}) via function GET`,
            status: s.status === 200 ? "info" : "fail",
            detail: `HTTP ${s.status} set "${f.contentType}" -> served "${s.contentType}"`,
            measurements: { set: f.contentType, ...cols("fn", s) },
          });
        }
      }

      const root = await probe(fnUrl(ctx, "/"));
      out.push({ ...htmlRow("HS03-root", "Mount root with trailing slash -> index.html", root), status: root.status === 200 ? (isHtmlType(root.contentType) ? "fail" : "pass") : "info" });

      const head = await probe(fnUrl(ctx, "/index.html"), { method: "HEAD" });
      out.push({ ...htmlRow("HS03-head", "HEAD index.html (no body; rewrite is GET-only)", head), status: head.status === 200 ? "info" : "fail" });

      const post = await probe(fnUrl(ctx, "/index.html"), { method: "POST", body: "{}" });
      out.push({
        id: "HS03-post",
        title: "POST index.html (EF06a: rewrite is GET-only)",
        status: "info",
        detail: `HTTP ${post.status} "${post.contentType}"`,
        measurements: cols("fn", post),
      });

      for (const [id, ct] of [
        ["HS03-ct-upper", "TEXT/HTML"],
        ["HS03-ct-nosp", "text/html;charset=utf-8"],
      ] as const) {
        const s = await probe(fnUrl(ctx, `/index.html?ct=${encodeURIComponent(ct)}`));
        out.push(htmlRow(id, `Handler sets "${ct}"`, s, { set: ct }));
      }

      const fnHost = await probe(`https://${ctx.ref}.functions.supabase.co/${FN_SLUG}/index.html`);
      out.push({ ...htmlRow("HS03-fnhost", "index.html via <ref>.functions.supabase.co", fnHost), status: fnHost.status === 200 ? (isHtmlType(fnHost.contentType) ? "fail" : "pass") : "info" });

      const missing = await probe(fnUrl(ctx, "/no/such/route"));
      out.push({
        id: "HS03-missing",
        title: "Unknown path -> the handler's own 404",
        status: "info",
        detail: `HTTP ${missing.status} "${missing.contentType}" "${missing.bodyHead}"`,
        measurements: cols("missing", missing),
      });
    } finally {
      const del = await deleteFileServer(ctx);
      ctx.log(`HS03 cleanup: DELETE ${FN_SLUG} -> ${del}`);
    }
    return out;
  },
};
export default mod;
