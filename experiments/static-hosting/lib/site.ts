/**
 * Shared plumbing for the static-hosting experiment: the site fixture, the
 * header capture every row records, and the Storage / Edge Functions setup.
 *
 * Every probe is BROWSER-SHAPED: no `apikey`, no `Authorization`. A static
 * host is reached by someone typing a URL, so a response that needs a key is
 * not a website, whatever its content-type.
 *
 * The fixture covers the file types a built static site ships (Astro/Vite
 * output), plus the two XML types a browser renders as an active document
 * (XHTML, SVG). The rewrite the docs describe is for `text/html`; whether it
 * covers those two is part of what HS01 and HS03 record.
 */
import type { Ctx } from "../../../harness/src/types";
import { fetchKeys } from "../../../harness/src/platform";
import { mgmt, mgmtBase } from "../../../harness/src/mgmt";

export const BUCKET = "site";
export const FN_SLUG = "pvlab-hs-site";

export interface Fixture {
  key: string;
  path: string;
  contentType: string;
  body: Uint8Array;
}

const enc = (s: string) => new TextEncoder().encode(s);

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>pvlab static</title>
<link rel="stylesheet" href="assets/app.css"></head>
<body><h1>pvlab static-hosting</h1><script src="assets/app.js"></script></body></html>
`;

// 1x1 transparent PNG.
const PNG = Uint8Array.from(
  Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  ),
);

// Smallest valid wasm module: magic + version.
const WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

export const FIXTURES: Fixture[] = [
  { key: "html", path: "index.html", contentType: "text/html; charset=utf-8", body: enc(HTML) },
  { key: "html_nested", path: "about/index.html", contentType: "text/html; charset=utf-8", body: enc(HTML.replace("pvlab static-hosting", "about")) },
  { key: "xhtml", path: "page.xhtml", contentType: "application/xhtml+xml", body: enc(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>xhtml</p></body></html>\n`) },
  { key: "svg", path: "icon.svg", contentType: "image/svg+xml", body: enc(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>\n`) },
  { key: "css", path: "assets/app.css", contentType: "text/css", body: enc("body{font-family:sans-serif}\n") },
  { key: "js", path: "assets/app.js", contentType: "text/javascript", body: enc("document.title='pvlab-js-ran';\n") },
  { key: "mjs", path: "assets/app.mjs", contentType: "text/javascript", body: enc("export const x = 1;\n") },
  { key: "json", path: "data.json", contentType: "application/json", body: enc(`{"ok":true}\n`) },
  { key: "xml", path: "feed.xml", contentType: "application/xml", body: enc(`<?xml version="1.0"?><rss version="2.0"><channel><title>pvlab</title></channel></rss>\n`) },
  { key: "manifest", path: "manifest.webmanifest", contentType: "application/manifest+json", body: enc(`{"name":"pvlab"}\n`) },
  { key: "wasm", path: "app.wasm", contentType: "application/wasm", body: WASM },
  { key: "txt", path: "robots.txt", contentType: "text/plain", body: enc("User-agent: *\n") },
  { key: "png", path: "img.png", contentType: "image/png", body: PNG },
];

/** What a browser would act on, captured from one response. */
export interface Served {
  status: number;
  contentType: string;
  disposition: string;
  nosniff: string;
  csp: string;
  cacheControl: string;
  cfCache: string;
  location: string;
  bytes: number;
  bodyHead: string;
  error?: string;
}

export async function probe(url: string, init: RequestInit = {}): Promise<Served> {
  try {
    const res = await fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(30_000) });
    const buf = new Uint8Array(await res.arrayBuffer());
    const h = (n: string) => res.headers.get(n) ?? "";
    return {
      status: res.status,
      contentType: h("content-type"),
      disposition: h("content-disposition"),
      nosniff: h("x-content-type-options"),
      csp: h("content-security-policy"),
      cacheControl: h("cache-control"),
      cfCache: h("cf-cache-status"),
      location: h("location"),
      bytes: buf.length,
      bodyHead: new TextDecoder().decode(buf.slice(0, 80)).replace(/\s+/g, " "),
    };
  } catch (e) {
    return {
      status: 0, contentType: "", disposition: "", nosniff: "", csp: "", cacheControl: "", cfCache: "",
      location: "", bytes: 0, bodyHead: "", error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    };
  }
}

/** Flatten a Served into report columns under a prefix. */
export function cols(prefix: string, s: Served): Record<string, string | number> {
  return {
    [`${prefix}_status`]: s.status,
    [`${prefix}_ct`]: s.contentType || "none",
    [`${prefix}_disposition`]: s.disposition || "none",
    [`${prefix}_nosniff`]: s.nosniff || "none",
    [`${prefix}_csp`]: s.csp || "none",
  };
}

export const isHtmlType = (ct: string) => /^\s*text\/html/i.test(ct);

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const storageBase = (ctx: Ctx) => `https://${ctx.apiHost}/storage/v1`;

/** The public object URL on the project hostname, the documented shape. */
export const publicUrl = (ctx: Ctx, path: string, bucket = BUCKET) => `${storageBase(ctx)}/object/public/${bucket}/${path}`;

async function retry(fn: () => Promise<number>, ok: (s: number) => boolean, attempts = 6): Promise<number> {
  let s = 0;
  for (let i = 0; i < attempts; i++) {
    s = await fn().catch(() => 0);
    if (ok(s)) return s;
    // Fresh-project Storage answers TenantNotFound, then 429 SlowDown, for
    // the first minutes after ACTIVE_HEALTHY (edge-resilience W21).
    await Bun.sleep(10_000);
  }
  return s;
}

export async function serviceKey(ctx: Ctx): Promise<string> {
  return ctx.serviceKey ?? (await fetchKeys(ctx)).service;
}

/** A public bucket, created if absent. */
export async function ensureBucket(ctx: Ctx, svc: string, bucket: string): Promise<number> {
  const auth = { Authorization: `Bearer ${svc}`, apikey: svc };
  return retry(async () => {
    const got = await fetch(`${storageBase(ctx)}/bucket/${bucket}`, { headers: auth });
    if (got.status === 200) return 200;
    const r = await fetch(`${storageBase(ctx)}/bucket`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ id: bucket, name: bucket, public: true }),
    });
    return r.status;
  }, (s) => s === 200 || s === 201);
}

/** Public `site` bucket + every fixture uploaded with its declared content-type. Idempotent. */
export async function ensureSite(ctx: Ctx): Promise<{ bucket: number; uploads: Record<string, number> }> {
  const svc = await serviceKey(ctx);
  const bucket = await ensureBucket(ctx, svc, BUCKET);
  const uploads: Record<string, number> = {};
  for (const f of FIXTURES) uploads[f.key] = await uploadObject(ctx, svc, f.path, f.body, f.contentType);
  return { bucket, uploads };
}

export async function uploadObject(
  ctx: Ctx,
  svc: string,
  path: string,
  body: Uint8Array,
  contentType: string,
  cacheControl = "3600",
  bucket = BUCKET,
): Promise<number> {
  return retry(async () => {
    const r = await fetch(`${storageBase(ctx)}/object/${bucket}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${svc}`,
        apikey: svc,
        "Content-Type": contentType,
        "cache-control": `max-age=${cacheControl}`,
        "x-upsert": "true",
      },
      body: body as BodyInit,
    });
    return r.status;
  }, (s) => s === 200 || s === 201);
}

export async function signedUrl(ctx: Ctx, svc: string, path: string): Promise<string> {
  const r = await fetch(`${storageBase(ctx)}/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${svc}`, apikey: svc, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  const j = (await r.json().catch(() => ({}))) as { signedURL?: string };
  return j.signedURL ? `${storageBase(ctx)}${j.signedURL}` : "";
}

// ---------------------------------------------------------------------------
// Edge Function file server
// ---------------------------------------------------------------------------

export type FileTable = Record<string, { ct: string; body: Uint8Array }>;

export const fixtureTable = (): FileTable =>
  Object.fromEntries(FIXTURES.map((f) => [f.path, { ct: f.contentType, body: f.body }]));

/**
 * A file server with the files inlined (base64), so it deploys through the
 * API path with no Docker and no static_files. It strips the mount prefix,
 * routes a trailing slash to index.html, falls back to 404.html when the
 * table has one (what Pages does for an Astro build), and otherwise answers a
 * plain 404. `?ct=` overrides the content-type so HS03 can vary only the header.
 */
export function fileServerSource(files: FileTable, slug: string): string {
  const table = Object.fromEntries(
    Object.entries(files).map(([p, f]) => [p, { ct: f.ct, b64: Buffer.from(f.body).toString("base64") }]),
  );
  return `const FILES: Record<string, { ct: string; b64: string }> = ${JSON.stringify(table)};
const dec = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
Deno.serve((req) => {
  const u = new URL(req.url);
  let p = u.pathname.replace(/^\\/(functions\\/v1\\/)?${slug}/, "").replace(/^\\//, "");
  if (p === "" || p.endsWith("/")) p += "index.html";
  let f = FILES[p];
  let status = 200;
  if (!f && FILES["404.html"]) { f = FILES["404.html"]; status = 404; }
  if (!f) return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  const ct = u.searchParams.get("ct") ?? f.ct;
  return new Response(req.method === "HEAD" ? null : dec(f.b64), { status, headers: { "Content-Type": ct, "Cache-Control": "public, max-age=60" } });
});
`;
}

/** The documented function URL on the project hostname. */
export const fnUrl = (ctx: Ctx, path = "", slug = FN_SLUG) => `https://${ctx.apiHost}/functions/v1/${slug}${path}`;

/** API-path deploy (server-side bundling, 5 MB ceiling). */
export async function deployFileServer(
  ctx: Ctx,
  files: FileTable = fixtureTable(),
  slug = FN_SLUG,
): Promise<{ status: number; error: string; sourceBytes: number }> {
  const src = fileServerSource(files, slug);
  const form = new FormData();
  form.append("file", new Blob([src]), "index.ts");
  form.append("metadata", JSON.stringify({ entrypoint_path: "index.ts", name: slug, verify_jwt: false }));
  const res = await fetch(`${mgmtBase(ctx)}/projects/${ctx.ref}/functions/deploy?slug=${slug}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.pat}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  return { status: res.status, error: res.status >= 300 ? text.slice(0, 300) : "", sourceBytes: src.length };
}

export async function deleteFileServer(ctx: Ctx, slug = FN_SLUG): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const r = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/functions/${slug}`).catch(() => ({ status: 0 }));
    if (r.status < 300 || r.status === 404) return r.status;
    await Bun.sleep(r.status === 429 ? 15_000 : 2_000);
  }
  return -1;
}

// ---------------------------------------------------------------------------
// A real build (site/dist-*)
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain",
  xml: "application/xml",
  webmanifest: "application/manifest+json",
};

export const mimeFor = (path: string) => MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Every file under a build directory, keyed by path relative to it. Empty if the build is absent. */
export async function readDist(dir: string): Promise<FileTable> {
  const out: FileTable = {};
  const glob = new Bun.Glob("**/*");
  try {
    for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
      out[rel] = { ct: mimeFor(rel), body: new Uint8Array(await Bun.file(`${dir}/${rel}`).arrayBuffer()) };
    }
  } catch {
    return {};
  }
  return out;
}

/** Poll until the fresh deploy stops answering 404 (propagation takes ~10 s). */
export async function whenLive(url: string, budgetMs = 90_000): Promise<Served> {
  const t0 = Date.now();
  let s = await probe(url);
  while (Date.now() - t0 < budgetMs && (s.status === 404 || s.status === 0)) {
    await Bun.sleep(5_000);
    s = await probe(url);
  }
  return s;
}

/** The two HS06 Workers, by origin; HS07 deletes them by these names. */
export const WORKERS = { storage: "pvlab-hs-front-storage", fn: "pvlab-hs-front-fn" } as const;
