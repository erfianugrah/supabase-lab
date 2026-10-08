/**
 * Offline tests for the channel API fan-out: `make bff-test`
 * (deno test --no-remote). No imports beyond fanout.ts, so nothing is
 * downloaded; fetch is a fake that honours the AbortSignal the way the real
 * one does, and the cache is an in-memory Map.
 */
import { type Cache, type CacheEntry, type CacheWrite, cacheTtl, type Endpoint, fanOut, parseControls } from "./fanout.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq<T>(got: T, want: T, msg: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg}: got ${g}, want ${w}`);
}

interface Route {
  delayMs?: number;
  status?: number;
  body?: unknown;
  raw?: string;
  cacheControl?: string;
  /** Reject like a refused connection. */
  netError?: boolean;
}

/** A fetch that answers per endpoint after a delay, and rejects with AbortError when aborted. */
function fakeFetch(routes: Partial<Record<Endpoint, Route>>, seen: URL[] = [], sent: Headers[] = []): typeof fetch {
  return ((input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(url);
    sent.push(new Headers(init?.headers));
    const endpoint = url.pathname.split("/").pop() as Endpoint;
    const r = routes[endpoint] ?? {};
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        if (r.netError) return reject(new TypeError("connection refused"));
        const headers = new Headers({ "content-type": "application/json" });
        if (r.cacheControl) headers.set("cache-control", r.cacheControl);
        resolve(new Response(r.raw ?? JSON.stringify(r.body ?? { endpoint }), { status: r.status ?? 200, headers }));
      }, r.delayMs ?? 5);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;
}

class MemCache implements Cache {
  store = new Map<Endpoint, { body: unknown; expires: number; at: number }>();
  gets = 0;
  puts: CacheWrite[][] = [];
  failGet = false;
  failPut = false;
  get(endpoints: Endpoint[]): Promise<CacheEntry[]> {
    this.gets++;
    if (this.failGet) return Promise.reject(new Error("cache down"));
    const now = Date.now();
    return Promise.resolve(
      endpoints
        .map((e) => [e, this.store.get(e)] as const)
        .filter(([, v]) => v && v.expires > now)
        .map(([e, v]) => ({ endpoint: e, body: v!.body, age_s: Math.floor((now - v!.at) / 1000) })),
    );
  }
  put(entries: CacheWrite[]): Promise<void> {
    if (this.failPut) return Promise.reject(new Error("cache read-only"));
    this.puts.push(entries);
    for (const w of entries) this.store.set(w.endpoint, { body: w.body, expires: Date.now() + w.ttl_s * 1000, at: Date.now() });
    return Promise.resolve();
  }
}

const base = (over: Partial<Parameters<typeof fanOut>[0]> = {}): Parameters<typeof fanOut>[0] => ({
  baseUrl: "http://upstream.test/upstream-mock/",
  apiKey: "k",
  userId: "u1",
  timeoutMs: 150,
  controls: parseControls(new URLSearchParams()),
  ...over,
});

Deno.test("cacheTtl reads max-age and honours no-store / no-cache", () => {
  eq(cacheTtl("private, max-age=300"), 300, "max-age");
  eq(cacheTtl("max-age=0"), 0, "zero");
  eq(cacheTtl("no-store"), 0, "no-store");
  eq(cacheTtl("max-age=60, no-cache"), 0, "no-cache wins");
  eq(cacheTtl("max-age=999999"), 3600, "clamped");
  eq(cacheTtl(null), 0, "absent");
  eq(cacheTtl("s-maxage=30"), 0, "only max-age counts");
});

Deno.test("parseControls keeps known endpoints only", () => {
  const c = parseControls(new URLSearchParams("fail=offers,bogus&slow=points&refresh=1"));
  eq([...c.fail], ["offers"], "fail");
  eq([...c.slow], ["points"], "slow");
  eq(c.refresh, true, "refresh");
});

Deno.test("all upstreams ok: parallel, not partial, headers sent", async () => {
  const seen: URL[] = [];
  const sent: Headers[] = [];
  const t0 = Date.now();
  const r = await fanOut(base({ fetch: fakeFetch({ profile: { delayMs: 60 }, orders: { delayMs: 60 }, offers: { delayMs: 60 }, points: { delayMs: 60 } }, seen, sent) }));
  const wall = Date.now() - t0;
  eq(r.partial, false, "partial");
  eq(Object.keys(r.data), ["profile", "orders", "offers", "points"], "keys");
  for (const e of ["profile", "orders", "offers", "points"] as Endpoint[]) {
    eq(r.upstreams[e].status, "ok", `${e} status`);
    eq((r.data[e] as { endpoint: string }).endpoint, e, `${e} body`);
  }
  // Four 60 ms calls in parallel finish well under their 240 ms sum.
  assert(wall < 200, `wall ${wall} ms suggests the calls ran in series`);
  eq(seen.map((u) => u.pathname).sort(), ["/upstream-mock/offers", "/upstream-mock/orders", "/upstream-mock/points", "/upstream-mock/profile"], "paths");
  eq(sent.map((h) => `${h.get("x-api-key")}/${h.get("x-user-id")}`), ["k/u1", "k/u1", "k/u1", "k/u1"], "api key and user id on every call");
});

Deno.test("one slow upstream is cut at the timeout, the rest are returned (partial)", async () => {
  const t0 = Date.now();
  const r = await fanOut(base({ timeoutMs: 100, fetch: fakeFetch({ points: { delayMs: 2000 } }) }));
  const wall = Date.now() - t0;
  eq(r.partial, true, "partial");
  eq(r.upstreams.points.status, "timeout", "points status");
  eq(r.data.points, null, "points data");
  eq(r.upstreams.profile.status, "ok", "profile ok");
  assert(r.upstreams.points.ms >= 95 && r.upstreams.points.ms < 400, `points ms ${r.upstreams.points.ms}`);
  assert(wall < 400, `wall ${wall} ms: the slow call was not aborted`);
});

Deno.test("http error, network error and non-JSON body each degrade to partial", async () => {
  const r = await fanOut(base({
    fetch: fakeFetch({
      offers: { status: 503, body: { error: "down" } },
      orders: { netError: true },
      points: { raw: "<html>gateway</html>" },
    }),
  }));
  eq(r.partial, true, "partial");
  eq(r.upstreams.offers.status, "error", "offers");
  eq(r.upstreams.offers.http, 503, "offers http");
  eq(r.upstreams.orders.status, "error", "orders");
  assert(String(r.upstreams.orders.error).includes("connection refused"), "orders error text");
  eq(r.upstreams.points.error, "upstream body is not JSON", "points");
  eq(r.upstreams.profile.status, "ok", "profile still ok");
  eq(r.data.offers, null, "offers data");
});

Deno.test("demo controls are forwarded as mode=fail / mode=slow", async () => {
  const seen: URL[] = [];
  await fanOut(base({ controls: parseControls(new URLSearchParams("fail=offers&slow=points")), fetch: fakeFetch({}, seen) }));
  const mode = (e: string) => seen.find((u) => u.pathname.endsWith(`/${e}`))?.searchParams.get("mode") ?? null;
  eq(mode("offers"), "fail", "offers");
  eq(mode("points"), "slow", "points");
  eq(mode("profile"), null, "profile");
});

Deno.test("cacheable responses are stored and served on the next call", async () => {
  const cache = new MemCache();
  const routes: Partial<Record<Endpoint, Route>> = {
    profile: { cacheControl: "private, max-age=300" },
    offers: { cacheControl: "private, max-age=60" },
    orders: { cacheControl: "no-store" },
  };
  const first = await fanOut(base({ cache, fetch: fakeFetch(routes) }));
  eq(first.cache.read, "miss", "first read");
  eq(first.cache.write, "ok", "first write");
  eq(cache.puts[0].map((w) => `${w.endpoint}:${w.ttl_s}`).sort(), ["offers:60", "profile:300"], "stored");

  const seen: URL[] = [];
  const second = await fanOut(base({ cache, fetch: fakeFetch(routes, seen) }));
  eq(second.cache.read, "hit", "second read");
  eq(second.upstreams.profile.source, "cache", "profile from cache");
  eq(second.upstreams.offers.source, "cache", "offers from cache");
  eq(second.upstreams.orders.source, "upstream", "orders live");
  eq(seen.map((u) => u.pathname.split("/").pop()).sort(), ["orders", "points"], "only uncacheable endpoints called");
  eq(second.partial, false, "not partial");
  eq(second.cache.write, "none", "nothing new to store");
});

Deno.test("refresh=1 and forced fail/slow bypass the cache read", async () => {
  const cache = new MemCache();
  const routes: Partial<Record<Endpoint, Route>> = { profile: { cacheControl: "max-age=300" }, offers: { cacheControl: "max-age=300" } };
  await fanOut(base({ cache, fetch: fakeFetch(routes) }));

  const r1 = await fanOut(base({ cache, controls: parseControls(new URLSearchParams("refresh=1")), fetch: fakeFetch(routes) }));
  eq(r1.cache.read, "skipped", "refresh skips read");
  eq(r1.upstreams.profile.source, "upstream", "profile live on refresh");

  const seen: URL[] = [];
  const r2 = await fanOut(base({ cache, controls: parseControls(new URLSearchParams("fail=offers")), fetch: fakeFetch({ ...routes, offers: { status: 500 } }, seen) }));
  eq(r2.upstreams.profile.source, "cache", "profile still cached");
  eq(r2.upstreams.offers.status, "error", "offers forced failure is not masked by the cache");
  eq(r2.partial, true, "partial");
});

Deno.test("failed responses are never cached", async () => {
  const cache = new MemCache();
  await fanOut(base({ cache, fetch: fakeFetch({ profile: { status: 500, cacheControl: "max-age=300" } }) }));
  eq(cache.store.has("profile"), false, "500 not stored");
});

Deno.test("a broken cache costs latency, not the response", async () => {
  const cache = new MemCache();
  cache.failGet = true;
  cache.failPut = true;
  const r = await fanOut(base({ cache, fetch: fakeFetch({ profile: { cacheControl: "max-age=300" } }) }));
  eq(r.cache.read, "error", "read error reported");
  eq(r.cache.write, "error", "write error reported");
  eq(r.partial, false, "all upstreams still answered");
  eq(r.upstreams.profile.status, "ok", "profile ok");
});

Deno.test("every upstream down: partial, all data null", async () => {
  const r = await fanOut(base({ timeoutMs: 50, fetch: fakeFetch({ profile: { status: 502 }, orders: { status: 502 }, offers: { delayMs: 1000 }, points: { netError: true } }) }));
  eq(r.partial, true, "partial");
  eq(Object.values(r.data), [null, null, null, null], "data");
  eq(Object.values(r.upstreams).every((u) => u.status !== "ok"), true, "no ok");
});
