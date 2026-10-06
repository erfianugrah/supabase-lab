/**
 * HS01 - What content-type does Storage serve each file type of a static site
 * with, against the type it was uploaded with?
 *
 * Side: managed Storage, one public bucket (`site`) on the lab project. Every
 * GET is browser-shaped (no apikey, no Authorization). Uploads use the
 * service_role key with the declared content-type on the request.
 *
 *   HS01-setup     bucket + 13 fixtures uploaded (status per fixture)
 *   HS01-<key>     one row per fixture, public URL on <ref>.supabase.co:
 *                  recorded mimetype (storage.objects.metadata) vs served
 *                  content-type, content-disposition, nosniff, CSP.
 *                  The html row passes when it is NOT served as text/html -
 *                  the quickstart: "For security, HTML files are returned as
 *                  plain text." Every other row is info.
 *   HS01-host      index.html on <ref>.storage.supabase.co (the Storage
 *                  hostname tls-surface found) - same rewrite there?
 *   HS01-signed    index.html through a signed URL - same rewrite?
 *
 * Not settled by this module: whether a browser executes anything. This
 * records headers; a type a browser sniffs or renders is inferred from them.
 * Custom-domain behaviour is HS04.
 *
 * DESTRUCTIVE: creates the `site` bucket and its objects; they stay until the
 * project is destroyed (HS02 and HS04 read them).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { sql } from "../../../harness/src/platform";
import { BUCKET, FIXTURES, cols, ensureSite, isHtmlType, probe, publicUrl, serviceKey, signedUrl } from "../lib/site";

const mod: TestModule = {
  id: "HS01",
  title: "Storage: served content-type per static-site file type",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "HS01", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];

    const setup = await ensureSite(ctx);
    const setupOk = [200, 201].includes(setup.bucket) && Object.values(setup.uploads).every((s) => s === 200 || s === 201);
    out.push({
      id: "HS01-setup",
      title: "Public bucket + fixtures uploaded with declared content-types",
      status: setupOk ? "pass" : "fail",
      measurements: { bucket: setup.bucket, ...Object.fromEntries(Object.entries(setup.uploads).map(([k, v]) => [`up_${k}`, v])) },
    });
    if (!setupOk) return out;

    const meta = await sql(
      ctx,
      `select name, metadata->>'mimetype' as mimetype from storage.objects where bucket_id = '${BUCKET}'`,
    );
    const recorded = new Map(meta.rows.map((r) => [String(r.name), String(r.mimetype ?? "")]));

    for (const f of FIXTURES) {
      const s = await probe(publicUrl(ctx, f.path));
      const isHtml = f.key === "html" || f.key === "html_nested";
      const servedHtml = isHtmlType(s.contentType);
      out.push({
        id: `HS01-${f.key}`,
        title: `${f.path} (uploaded ${f.contentType}) via public URL`,
        status: s.status !== 200 ? "fail" : isHtml ? (servedHtml ? "fail" : "pass") : "info",
        detail: `HTTP ${s.status}; recorded "${recorded.get(f.path) ?? "?"}" -> served "${s.contentType}"${s.disposition ? `; disposition "${s.disposition}"` : ""}${s.error ? `; ${s.error}` : ""}`,
        measurements: { declared: f.contentType, recorded: recorded.get(f.path) ?? "absent", ...cols("pub", s), bytes: s.bytes },
      });
    }

    const altHost = await probe(`https://${ctx.ref}.storage.supabase.co/storage/v1/object/public/${BUCKET}/index.html`);
    out.push({
      id: "HS01-host",
      title: "index.html via the <ref>.storage.supabase.co hostname",
      status: altHost.status === 200 ? (isHtmlType(altHost.contentType) ? "fail" : "pass") : "info",
      detail: `HTTP ${altHost.status} "${altHost.contentType}"${altHost.error ? `; ${altHost.error}` : ""}`,
      measurements: cols("storagehost", altHost),
    });

    const svc = await serviceKey(ctx);
    const signed = await signedUrl(ctx, svc, "index.html");
    const sg = signed ? await probe(signed) : undefined;
    out.push({
      id: "HS01-signed",
      title: "index.html via a signed URL",
      status: !sg ? "fail" : sg.status === 200 ? (isHtmlType(sg.contentType) ? "fail" : "pass") : "fail",
      detail: sg ? `HTTP ${sg.status} "${sg.contentType}"` : "sign call returned no signedURL",
      measurements: sg ? cols("signed", sg) : { signed_status: 0 },
    });
    return out;
  },
};
export default mod;
