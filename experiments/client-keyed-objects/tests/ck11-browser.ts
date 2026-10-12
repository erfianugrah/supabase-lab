/**
 * CK11 - Does the same client, bundled for the browser, work from a page:
 * CORS preflights, an S3 multipart upload (which needs part ETags), and
 * ranged decrypting reads through a signed URL?
 *
 * SIDE: each target, from headless Chromium in the Playwright container
 * (mcr.microsoft.com/playwright:v1.64.0-noble; page origin
 * http://localhost:4173 inside the container), as the primary tenant's
 * editor. The page gets the same directory as every other client; the
 * driver forwards localhost:<port> in the container to the host for the
 * self-hosted gateway and the key service.
 *
 *   preflight.<surface>  Node-side OPTIONS with Origin + Access-Control-Request-*
 *                        against the S3 endpoint (PUT with x-amz-* headers),
 *                        a signed URL and /object/authenticated (GET with
 *                        Range): status, allow-origin, expose-headers
 *   page.upload          64 MiB S3 multipart from the page, 8 parts;
 *                        `upload_etag_source` says whether ETags came from the
 *                        UploadPart header or the ListParts fallback
 *   page.read.<path>     3 ranged reads per path equal the page's plaintext
 *   page.signed_get_readable_headers  response headers JS can read
 *
 * Pass = upload ok (by either ETag source) and signed-URL reads 3/3. A
 * missing `ETag` exposure is recorded as a finding, not a failure, because the
 * client's ListParts fallback is part of the design.
 * Not settled: other browsers; a page served from a real https origin.
 * DESTRUCTIVE: uploads a 64 MiB object per target.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { CLIENT_DIR, credsFor, directory, errMsg, http, loadRun, loadState, row, scrub, sh, signIn } from "../lib/ckrun";

const IMAGE = "mcr.microsoft.com/playwright:v1.64.0-noble";
const ORIGIN = "http://localhost:4173";

async function preflight(url: string, method: string, headers: string) {
  const r = await http(url, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": method, "access-control-request-headers": headers } });
  const h = r.headers;
  return `${r.status} allow-origin=${h["access-control-allow-origin"] ?? "-"} expose=${h["access-control-expose-headers"] ?? "-"} allow-headers=${(h["access-control-allow-headers"] ?? "-").slice(0, 60)}`;
}

const mod: TestModule = {
  id: "CK11",
  title: "Browser: CORS, S3 multipart from the page, ranged reads via signed URL",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK11", title: this.title, status: "skip", detail: l.skip }];
    const out: TestResult[] = [];
    const work = join(l.run.dir, "browser");
    mkdirSync(work, { recursive: true });
    const b = await sh(["bun", "build", "browser/entry.ts", "--target=browser", "--outfile", join(work, "bundle.js")], { cwd: CLIENT_DIR });
    if (b.code) return l.targets.map((t) => row("CK11", t, this.title, "fail", `bundle build failed: ${b.err.slice(0, 200)}`));
    // The page uses the same directory as every other client; the driver
    // forwards the self-hosted gateway and key service ports into the container.
    const dir = directory(l);
    const forwards = [new URL(l.run.keysvc.url).port, ...l.targets.filter((t) => t.kind === "compose").map((t) => new URL(t.client.url).port)].map(Number);
    const cfgs: Record<string, unknown> = {};
    for (const t of l.targets) {
      const st = loadState(l.run, t.name);
      cfgs[t.name] = { directory: dir, creds: credsFor(l, "editor"), tenant: st.tenants.primary, record: st.records.primary, sizeMiB: 64 };
    }
    writeFileSync(join(work, "browser-cfg.json"), JSON.stringify({ forwards, targets: cfgs }));
    const run = await sh(["docker", "run", "--rm", "--add-host", "host.docker.internal:host-gateway", "-v", `${CLIENT_DIR}:/app:ro`, "-v", `${work}:/work:ro`, IMAGE, "node", "/app/browser/driver.mjs"], {
      timeoutMs: 1_800_000,
    });
    // The config carries passwords and keys: delete it as soon as the page is done.
    writeFileSync(join(work, "browser-cfg.json"), "{}");
    let page: Record<string, Record<string, unknown>> = {};
    try {
      page = JSON.parse(run.out.trim().split("\n").at(-1) ?? "{}");
    } catch {
      /* reported below */
    }
    for (const t of l.targets) {
      const m: Record<string, string | number> = {};
      try {
        const st = loadState(l.run, t.name);
        const tok = (await signIn(t, st.users.owner.email, st.users.owner.password)).j.access_token as string;
        const key = `${st.tenants.primary}/${st.assets.mid?.id ?? "x"}/data`;
        const sign = await http(`${t.client.url}/storage/v1/object/sign/${t.client.bucket}/${key}`, {
          method: "POST",
          headers: { apikey: t.client.anonKey, authorization: `Bearer ${tok}`, "content-type": "application/json" },
          body: JSON.stringify({ expiresIn: 60 }),
        });
        const signed = `${t.client.url}/storage/v1${JSON.parse(sign.body).signedURL ?? ""}`;
        m["preflight.s3_put"] = await preflight(`${t.client.s3.endpoint}/${t.client.bucket}/${key}?partNumber=1&uploadId=x`, "PUT", "authorization,x-amz-date,x-amz-content-sha256,x-amz-security-token,content-type");
        m["preflight.signed_url_get"] = await preflight(signed, "GET", "range");
        m["preflight.authenticated_get"] = await preflight(`${t.client.url}/storage/v1/object/authenticated/${t.client.bucket}/${key}`, "GET", "range,authorization,apikey");
        m["preflight.keysvc_post"] = await preflight(`${l.run.keysvc.url}/wrap`, "POST", "authorization,content-type");
        const p = page[t.name];
        if (!p) {
          out.push(row("CK11", t, this.title, "fail", `no page result: ${scrub(l, (run.err || run.out).slice(-300))}`, m));
          continue;
        }
        for (const [k, v] of Object.entries(p)) m[`page.${k}`] = scrub(l, Array.isArray(v) ? v.join(" | ") : String(v));
        const ok = p.upload === "ok" && String(p["read.signed-url"]).startsWith("3/3");
        out.push(
          row(
            "CK11",
            t,
            this.title,
            ok ? "pass" : "fail",
            ok
              ? `page upload ok (ETags from ${p.upload_etag_source}), signed-URL ranged reads 3/3; readable headers: ${p.signed_get_readable_headers}`
              : `page: signin ${p.signin}, upload ${scrub(l, String(p.upload))}, signed-url ${p["read.signed-url"]}`,
            m,
          ),
        );
      } catch (e) {
        out.push(row("CK11", t, this.title, "fail", `threw: ${scrub(l, errMsg(e))}`, m));
      }
    }
    return out;
  },
};
export default mod;
