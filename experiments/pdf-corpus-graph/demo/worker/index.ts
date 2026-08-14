/**
 * pggraph worker: static assets plus a caching reverse proxy for the read RPCs.
 *
 * WHY A SCRIPT EXISTS AT ALL. The worker was assets-only until 2026-08-14:
 * every data call went browser -> PostgREST. Two properties made that the
 * wrong shape for a demo on disposable infrastructure:
 *
 *   1. The corpus is read-mostly and identical for every visitor, so every
 *      repeated query is a needless round trip to a database in
 *      ap-southeast-2. The edge cache answers in single-digit ms.
 *   2. The backing project gets destroyed between engagements. With the read
 *      path cached at the edge, the demo keeps answering from the last good
 *      responses while the origin is gone - STALE beats DOWN.
 *
 * HOW. PostgREST reads are POSTs, which HTTP caches will not touch, so the
 * cache key is synthetic: rpc path + body hash + a version constant. Stored
 * responses carry a long max-age plus an x-cached-at stamp; freshness is
 * decided here against CACHE_TTL_MS, and any origin failure (network or
 * status) falls back to the stored response regardless of age. Bump
 * CACHE_VERSION when the corpus is re-seeded - TTL expiry alone would
 * eventually converge, but a demo should not wait for it.
 *
 * x-pggraph-cache on every RPC response reports HIT / MISS / STALE so the
 * behaviour is observable from curl without opening a dashboard.
 */

export interface Env {
  ASSETS: Fetcher;
  ORIGIN: string;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h; see header comment
const CACHE_VERSION = "2026-08-14"; // bump on corpus re-seed
const STORE_MAX_AGE_S = 7 * 24 * 3600; // storage horizon, not freshness

function withMark(res: Response, mark: string): Response {
  const out = new Response(res.body, res);
  out.headers.set("x-pggraph-cache", mark);
  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/rest/")) {
      return env.ASSETS.fetch(request);
    }

    const body = request.method === "POST" ? await request.text() : "";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = new Request(
      `https://pggraph.cache/${CACHE_VERSION}${url.pathname}?h=${hash}`,
    );

    const cached = await caches.default.match(key);
    if (cached) {
      const at = Number(cached.headers.get("x-cached-at") ?? "0");
      if (Date.now() - at < CACHE_TTL_MS) {
        return withMark(cached, "HIT");
      }
    }

    let origin: Response;
    try {
      const headers = new Headers();
      for (const h of ["apikey", "content-type", "content-profile", "accept-profile"]) {
        const v = request.headers.get(h);
        if (v) headers.set(h, v);
      }
      origin = await fetch(`${env.ORIGIN}${url.pathname}`, {
        method: request.method,
        headers,
        body: request.method === "POST" ? body : null,
      });
    } catch {
      if (cached) return withMark(cached, "STALE");
      return new Response("origin unreachable and nothing cached", { status: 502 });
    }

    if (!origin.ok) {
      if (cached) return withMark(cached, "STALE");
      return origin;
    }

    // The Cache API rejects put() of any response carrying Set-Cookie (spec
    // behavior, and Cloudflare's edge adds __cf_bm to every response), so the
    // stored copy is header-stripped. Without this the put throws inside
    // waitUntil and every request is a permanent MISS - measured 2026-08-14.
    const store = new Response(origin.clone().body, origin);
    store.headers.delete("set-cookie");
    store.headers.set("Cache-Control", `public, max-age=${STORE_MAX_AGE_S}`);
    store.headers.set("x-cached-at", String(Date.now()));
    ctx.waitUntil(caches.default.put(key, store));
    return withMark(origin, "MISS");
  },
} satisfies ExportedHandler<Env>;
