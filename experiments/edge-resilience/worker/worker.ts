/**
 * edge-resilience-drill worker - two jobs:
 *
 * 1. Lab JWT issuer's public face: serves the JWKS at /.well-known/jwks.json
 *    so the drill project's third-party-auth integration can resolve our kid.
 *
 * 2. Cache drill: GETs to /rest/v1/w_probe are proxied to UPSTREAM and cached
 *    (keyed on the full incoming URL). On origin 5xx or an unreachable origin
 *    the last good response is served with x-drill-cache: stale. The OUTAGE
 *    var reroutes origin fetches at an unroutable address to simulate the
 *    origin being down without touching the project.
 *
 * Outage simulation targets a TEST-NET unroutable IP rather than pausing the
 * project: pause/resume takes minutes and perturbs every path, while the
 * thing being measured is the WORKER's behaviour when the origin fails.
 */
export interface Env {
  UPSTREAM: string;
  JWKS_JSON: string;
  OUTAGE: string;
  EDGE_URL: string;
}

const CACHEABLE = /^\/rest\/v1\/w_probe/;
// 192.0.2.1 is TEST-NET-1 (RFC 5737) - guaranteed unroutable, so fetch fails
// fast and deterministically.
const BLACKHOLE = "https://192.0.2.1";

function withTag(r: Response, tag: string): Response {
  const n = new Response(r.body, r);
  n.headers.set("x-drill-cache", tag);
  return n;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/.well-known/jwks.json" || url.pathname === "/jwks.json") {
      return new Response(JSON.stringify({ keys: [JSON.parse(env.JWKS_JSON)] }), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
      });
    }

    // Everything non-cacheable (or non-GET) proxies straight through, so the
    // worker doubles as a plain gateway for control probes.
    if (req.method !== "GET" || !CACHEABLE.test(url.pathname)) {
      return fetch(new Request(`${env.UPSTREAM}${url.pathname}${url.search}`, req));
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { headers: req.headers });

    const hit = await cache.match(cacheKey);
    if (hit) return withTag(hit, "HIT");

    const originBase = env.OUTAGE === "true" ? BLACKHOLE : env.UPSTREAM;
    let origin: Response;
    try {
      origin = await fetch(new Request(`${originBase}${url.pathname}${url.search}`, req));
    } catch {
      const stale = await cache.match(cacheKey);
      return stale
        ? withTag(stale, "STALE")
        : new Response(JSON.stringify({ error: "origin unreachable, cache empty" }), {
            status: 503,
            headers: { "content-type": "application/json", "x-drill-cache": "EMPTY" },
          });
    }

    if (origin.status >= 500) {
      const stale = await cache.match(cacheKey);
      if (stale) return withTag(stale, "STALE");
      return withTag(origin, "ERROR");
    }

    if (origin.ok) {
      // Consume origin exactly once into `tagged`, then clone for the cache:
      // handing the same body stream to two Responses throws "disturbed".
      const tagged = withTag(origin, "MISS");
      const toCache = tagged.clone();
      // The Cache API refuses to store a response carrying Set-Cookie, and the
      // Supabase gateway's Cloudflare front sets __cf_bm on EVERY response -
      // without this delete a cache proxy silently never caches. Strip it.
      toCache.headers.delete("set-cookie");
      toCache.headers.set("cache-control", "public, max-age=86400");
      ctx.waitUntil(cache.put(cacheKey, toCache));
      return tagged;
    }
    return withTag(origin, "PASS");
  },
};
