export interface Env {
  UPSTREAM: string;
  JWKS_JSON: string;
  OUTAGE: string;
  FAILOVER_PRIMARY?: string;
  FAILOVER_STANDBY?: string;
  HOLD_MS?: string;
  ROUTE_TABLE?: string; // W25: JSON {"tenant": "https://<base>"} tenant->origin map
}

const CACHEABLE = /^\/rest\/v1\/w_probe/;
const TENANT = /^\/t\/([^/]+)\/rest\/v1\//;
const BLACKHOLE = "https://192.0.2.1";

function withTag(r: Response, tag: string, originStr?: string): Response {
  const n = new Response(r.body, r);
  n.headers.set("x-drill-cache", tag);
  if (originStr) n.headers.set("x-drill-origin", originStr);
  return n;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const urlObj = new URL(req.url);

    if (urlObj.pathname === "/.well-known/jwks.json" || urlObj.pathname === "/jwks.json") {
      return new Response(JSON.stringify({ keys: [JSON.parse(env.JWKS_JSON)] }), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
      });
    }

    // W25 tenant routing mode: /t/<tenant>/rest/v1/* looks the tenant up in
    // ROUTE_TABLE and proxies there; an unknown tenant is the eject
    // signature, a dead origin is the stale-route signature. Every response
    // carries x-drill-tenant so tenant isolation is measurable.
    const tenantMatch = urlObj.pathname.match(TENANT);
    if (tenantMatch) {
      const tenant = tenantMatch[1]!;
      const table = env.ROUTE_TABLE ? (JSON.parse(env.ROUTE_TABLE) as Record<string, string>) : {};
      const base = table[tenant];
      const tag = (r: Response, originStr?: string) => {
        const n = withTag(r, "ROUTE", originStr);
        n.headers.set("x-drill-tenant", tenant);
        return n;
      };
      if (!base) {
        return tag(new Response(JSON.stringify({ error: "tenant ejected" }), { status: 404 }), "ejected");
      }
      // Strip the /t/<tenant> prefix before the origin fetch, and drop
      // _-prefixed drill params (PostgREST 400s on unknown params - the
      // W24 lesson; the tenant router is a plain proxy, no cache key).
      const originUrl = new URL(urlObj);
      for (const key of [...originUrl.searchParams.keys()]) {
        if (key.startsWith("_")) originUrl.searchParams.delete(key);
      }
      const originPath = originUrl.pathname.replace(/^\/t\/[^/]+/, "");
      try {
        const origin = await fetch(new Request(`${base}${originPath}${originUrl.search}`, req));
        if (origin.status >= 500 || origin.status === 403) {
          return tag(new Response(JSON.stringify({ error: "origin failed", upstream: origin.status }), { status: 502 }), `${tenant}->dead`);
        }
        return tag(origin, tenant);
      } catch {
        return tag(new Response(JSON.stringify({ error: "origin unreachable" }), { status: 502 }), `${tenant}->dead`);
      }
    }

    if (req.method !== "GET" || !CACHEABLE.test(urlObj.pathname)) {
      return fetch(new Request(`${env.UPSTREAM}${urlObj.pathname}${urlObj.search}`, req));
    }

    const cache = caches.default;
    const cacheKey = new Request(req.url, { headers: req.headers });
    const failureKey = new Request(new URL("https://worker/last-failure", req.url).toString());
    const primaryUrl = env.FAILOVER_PRIMARY || env.UPSTREAM;
    const standby = env.FAILOVER_STANDBY;
    const holdMs = env.HOLD_MS ? parseInt(env.HOLD_MS) : 0;

    // Failover mode is a different drill: no cache-first (HITs carry no
    // origin information and would mask the failover entirely).
    const failoverMode = !!standby;
    if (!failoverMode) {
      const hit = await cache.match(cacheKey);
      if (hit) return withTag(hit, "HIT");
    }

    let origin: Response;
    let originTag = "primary";
    const originBase = env.OUTAGE === "true" ? BLACKHOLE : primaryUrl;
    // Drill cache-busters (?_w24=...) must not reach PostgREST - it treats
    // unknown params as column filters and 400s. Strip _-prefixed params from
    // the origin URL; the cacheKey above keeps the full URL so busting works.
    const originUrl = new URL(urlObj);
    for (const key of [...originUrl.searchParams.keys()]) {
      if (key.startsWith("_")) originUrl.searchParams.delete(key);
    }
    const originFetch = (base: string) =>
      fetch(new Request(`${base}${originUrl.pathname}${originUrl.search}`, req));
    // CF Workers wraps TCP failures to unroutable addresses as a 403
    // RESPONSE (W04 finding) - so 5xx, 403, and (under OUTAGE) any non-ok
    // status all mean the origin failed.
    const isFailure = (r: Response) =>
      r.status >= 500 || r.status === 403 || (env.OUTAGE === "true" && !r.ok);

    let lastFailureTime = 0;
    const lastFailResp = await cache.match(failureKey);
    if (lastFailResp) {
      try {
        lastFailureTime = parseFloat(await lastFailResp.text());
      } catch {}
    }

    // If still inside the hold window from a previous failover, serve standby
    // even before trying primary.
    if (standby && holdMs > 0 && Date.now() - lastFailureTime < holdMs) {
      try {
        origin = await originFetch(standby);
        if (isFailure(origin)) throw new Error(`standby HTTP ${origin.status}`);
        originTag = "standby";
      } catch (e) {
        // standby also failed - fall through to primary attempt below
        originTag = "primary";
        origin = await originFetch(originBase);
      }
    } else {
      try {
        origin = await originFetch(originBase);

        if (isFailure(origin)) throw new Error(`HTTP ${origin.status}`);
      } catch {
        if (standby) {
          const now = Date.now();
          ctx.waitUntil(cache.put(failureKey, new Response(now.toString())));
          origin = await originFetch(standby);
          originTag = "standby";
        } else {
          const stale = await cache.match(cacheKey);
          return stale
            ? withTag(stale, "STALE")
            : new Response(JSON.stringify({ error: "origin unreachable, cache empty" }), {
                status: 503,
                headers: { "content-type": "application/json", "x-drill-cache": "EMPTY" },
              });
        }
      }
    }

    if (origin.ok) {
      const finalTagged = withTag(origin, "MISS", originTag);
      const toCache = finalTagged.clone();
      toCache.headers.delete("set-cookie");
      toCache.headers.set("cache-control", "public, max-age=86400");
      ctx.waitUntil(cache.put(cacheKey, toCache));
      return finalTagged;
    }
    return withTag(origin, "PASS", originTag);
  },
};
