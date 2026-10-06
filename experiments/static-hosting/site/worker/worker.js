/**
 * A static-site front for a Supabase origin, on a hostname you own. HS06 deploys
 * it twice, differing only in the ORIGIN var:
 *
 *   Storage:   https://<ref>.supabase.co/storage/v1/object/public/<bucket>
 *   Function:  https://<custom domain>/functions/v1/<slug>
 *
 * What it adds over either origin is everything HS02 found Storage lacks:
 * `/` and `/dir/` map to index.html, a miss serves the site's 404.html with a
 * 404, and the content-type comes from the extension. The sandbox CSP and the
 * attachment disposition the origin adds are dropped - on this hostname the
 * site's owner, not the platform, is answerable for what the HTML does.
 */
const TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  webmanifest: "application/manifest+json",
};

const typeFor = (path) => TYPES[path.split(".").pop().toLowerCase()] ?? "application/octet-stream";

async function origin(env, path) {
  return fetch(`${env.ORIGIN}${path}`, { cf: { cacheEverything: true, cacheTtl: 60 } });
}

function respond(upstream, path, status) {
  const h = new Headers();
  h.set("content-type", typeFor(path));
  h.set("cache-control", path.includes("/_astro/") ? "public, max-age=31536000, immutable" : "public, max-age=60");
  h.set("x-content-type-options", "nosniff");
  h.set("x-pvlab-origin", upstream.headers.get("content-type") ?? "");
  return new Response(upstream.body, { status, headers: h });
}

export default {
  async fetch(req, env) {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.includes("..")) return new Response("bad path", { status: 400 });
    if (path.endsWith("/")) path += "index.html";
    let up = await origin(env, path);
    // Clean URLs: /about -> /about/ (a redirect, so relative links resolve).
    if (!up.ok && !path.split("/").pop().includes(".")) {
      const dir = await origin(env, `${path}/index.html`);
      if (dir.ok) return Response.redirect(new URL(`${path}/`, req.url).toString(), 308);
    }
    if (up.ok) return respond(up, path, 200);
    // Storage answers a missing object with HTTP 400 and "statusCode":"404"
    // in the body (HS02d); any non-2xx is a miss here.
    const nf = await origin(env, "/404.html");
    if (nf.ok) return respond(nf, "/404.html", 404);
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  },
};
