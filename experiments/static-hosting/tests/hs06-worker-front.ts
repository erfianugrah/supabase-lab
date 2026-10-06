/**
 * HS06 - What it takes for a Supabase-hosted site to look like production: a
 * clean root URL on your own hostname, with Supabase as the origin.
 *
 * HS05 showed the custom domain renders HTML only under
 * /functions/v1/<slug>/; the gateway answers `/` with 404 "requested path is
 * invalid" and has no routing config. So a Cloudflare Worker (site/worker/
 * worker.js) on a hostname in your own zone maps `/` to the origin. Two
 * origins, one Worker script, the same root-base Astro build (dist-root):
 *
 *   HS06-setup     dist-root uploaded to bucket `astro-root`; dist-root
 *                  deployed as function `pvlab-hs-root`; both Workers deployed
 *                  with wrangler as Workers Custom Domains (DNS + cert managed
 *                  by Cloudflare)
 *   HS06-storage   https://<PVLAB_ENDPOINT_SITE_STORAGE>/ in Chromium - the
 *                  Worker in front of Storage (no Supabase custom domain)
 *   HS06-fn        https://<PVLAB_ENDPOINT_SITE_FN>/ in Chromium - the Worker in
 *                  front of the function via PVLAB_ENDPOINT_CUSTOM_DOMAIN
 *   HS06-paths     per host: /about -> 308 whose Location is /about/ (recorded
 *                  since 2026-10-06; the first run kept only the status), a miss
 *                  -> 404 with the site's 404 page (curl pinned to 1.1.1.1's answer)
 *
 * Both browser rows are expected to render. The function row is also the
 * check on whether the custom domain still does anything once a Worker is in
 * front: the Worker sets the content-type itself either way.
 *
 * DESTRUCTIVE and left up for viewing: the bucket, the function and both
 * Workers. HS07 deletes the Workers. Self-skips without the endpoints or
 * Cloudflare credentials (CLOUDFLARE_API_KEY, CLOUDFLARE_EMAIL,
 * CLOUDFLARE_ACCOUNT_ID - the key trio wrangler logs in with).
 */
import { mkdir } from "node:fs/promises";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { browserCheck, row } from "../lib/browser";
import { cfAvailable, pinnedGet, publicIp } from "../lib/cfdns";
import { WORKERS, deployFileServer, ensureBucket, fnUrl, readDist, serviceKey, storageBase, uploadObject, whenLive } from "../lib/site";

const BUCKET = "astro-root";
const SLUG = "pvlab-hs-root";

async function wranglerDeploy(name: string, domain: string, vars: Record<string, string>): Promise<{ code: number; tail: string }> {
  const args = ["wrangler", "deploy", "worker/worker.js", "--name", name, "--compatibility-date", "2026-09-01", "--domain", domain];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  const proc = Bun.spawn(["bunx", ...args], { cwd: "site", stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, tail: (o + e).trim().split("\n").slice(-3).join(" | ").slice(0, 300) };
}

/** Poll until the new hostname answers 200 through 1.1.1.1's address. */
async function serving(host: string, budgetMs = 5 * 60_000): Promise<{ ip: string; s: number; status: number }> {
  const t0 = Date.now();
  let ip = "";
  let status = 0;
  while (Date.now() - t0 < budgetMs) {
    ip = await publicIp(host);
    if (ip) {
      status = (await pinnedGet(host, ip, "/")).status;
      if (status === 200) break;
    }
    await Bun.sleep(10_000);
  }
  return { ip, s: Math.round((Date.now() - t0) / 1000), status };
}

const mod: TestModule = {
  id: "HS06",
  title: "Production-shaped: a Worker on your own hostname in front of Storage / the function",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const siteStorage = ctx.endpoints.site_storage;
    const siteFn = ctx.endpoints.site_fn;
    const domain = ctx.endpoints.custom_domain;
    if (!ctx.ref || !siteStorage) return [{ id: "HS06", title: this.title, status: "skip", detail: "no PVLAB_ENDPOINT_SITE_STORAGE" }];
    if (!cfAvailable() || !process.env.CLOUDFLARE_ACCOUNT_ID) return [{ id: "HS06", title: this.title, status: "skip", detail: "Cloudflare key trio not in the environment" }];
    const root = await readDist("site/dist-root");
    if (!root["index.html"]) return [{ id: "HS06", title: this.title, status: "skip", detail: "no site/dist-root - run 'make site'" }];
    const shots = process.env.PVLAB_SHOTS || "evidence/screens";
    await mkdir(shots, { recursive: true });
    const out: TestResult[] = [];

    // ---- origins ----
    const svc = await serviceKey(ctx);
    const bucket = await ensureBucket(ctx, svc, BUCKET);
    const ups = await Promise.all(Object.entries(root).map(([p, f]) => uploadObject(ctx, svc, p, f.body, f.ct, "60", BUCKET)));
    const upFailed = ups.filter((s) => s !== 200 && s !== 201).length;
    const dep = siteFn && domain ? await deployFileServer(ctx, root, SLUG) : { status: 0, error: "no PVLAB_ENDPOINT_SITE_FN / custom domain", sourceBytes: 0 };
    const fnLive = dep.status && dep.status < 300 ? (await whenLive(fnUrl(ctx, "/", SLUG))).status : 0;

    // ---- Workers ----
    const ws = await wranglerDeploy(WORKERS.storage, siteStorage, { ORIGIN: `${storageBase(ctx)}/object/public/${BUCKET}` });
    const wf = siteFn && domain ? await wranglerDeploy(WORKERS.fn, siteFn, { ORIGIN: `https://${domain}/functions/v1/${SLUG}` }) : { code: -1, tail: "skipped" };
    out.push({
      id: "HS06-setup",
      title: "Origins (bucket astro-root, function pvlab-hs-root) and both Workers deployed",
      status: [200, 201].includes(bucket) && upFailed === 0 && ws.code === 0 && (wf.code === 0 || wf.code === -1) ? "pass" : "fail",
      detail: `bucket ${bucket}, ${ups.length} files (${upFailed} failed); function deploy ${dep.status} first GET ${fnLive}; worker storage exit ${ws.code}; worker fn exit ${wf.code}${ws.code ? ` "${ws.tail}"` : ""}${wf.code > 0 ? ` "${wf.tail}"` : ""}`,
      measurements: { bucket, files: ups.length, upload_failed: upFailed, fn_deploy: dep.status, fn_first_get: fnLive, worker_storage_exit: ws.code, worker_fn_exit: wf.code },
    });

    // ---- browser + paths, per host ----
    for (const [id, host, title] of [
      ["HS06-storage", siteStorage, "Worker -> Storage, root URL in a browser"],
      ["HS06-fn", siteFn, "Worker -> function via custom domain, root URL in a browser"],
    ] as const) {
      if (!host || (id === "HS06-fn" && wf.code !== 0)) {
        out.push({ id, title, status: "skip", detail: "not deployed" });
        continue;
      }
      const sv = await serving(host);
      if (sv.status !== 200) {
        out.push({ id, title, status: "fail", detail: `hostname not serving after ${sv.s}s (last ${sv.status}, ip ${sv.ip || "none"})` });
        continue;
      }
      const shot = `${shots}/${id.toLowerCase()}.png`;
      const r = row(id, title, await browserCheck(`https://${host}/`, shot, `${host}=${sv.ip}`), true, shot);
      r.measurements = { ...r.measurements, serving_after_s: sv.s };
      out.push(r);

      const about = await pinnedGet(host, sv.ip, "/about");
      const miss = await pinnedGet(host, sv.ip, "/no/such/page");
      out.push({
        id: `${id}-paths`,
        title: `${host}: clean URL redirect and 404 page`,
        status:
          about.status === 308 && new URL(about.location || "x:").pathname === "/about/" && miss.status === 404 && /text\/html/.test(miss.contentType)
            ? "pass"
            : "fail",
        detail: `/about -> ${about.status} ${about.location || "(no Location)"}; /no/such/page -> ${miss.status} "${miss.contentType}"`,
        measurements: { about: about.status, about_location: about.location || "none", miss: miss.status, miss_ct: miss.contentType || "none" },
      });
    }
    return out;
  },
};
export default mod;
