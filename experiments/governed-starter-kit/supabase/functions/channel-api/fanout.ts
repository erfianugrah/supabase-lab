/**
 * The channel API's fan-out, with no Supabase or network dependency of its
 * own: fetch, the clock and the cache are passed in, so fanout.test.ts runs
 * it offline.
 *
 * One screen request -> one call per upstream endpoint, all in parallel, each
 * with its own deadline (an AbortController per call, so a slow upstream is
 * cut off and its socket released rather than left running). Whatever has
 * answered by then is returned; anything that failed or timed out is null in
 * `data`, has its reason in `upstreams`, and sets `partial: true`. No
 * retries: a retry inside a per-call budget only moves the timeout, and the
 * app can re-request the screen.
 *
 * Caching follows the upstream's own Cache-Control: a response with
 * `max-age=N` (and no no-store / no-cache) is stored for N seconds, keyed by
 * user and endpoint; anything else is fetched every time. The BFF does not
 * decide what is cacheable - the system that owns the data does.
 */

export const ENDPOINTS = ["profile", "orders", "offers", "points"] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

/** Upper bound on any TTL the upstream asks for. */
export const MAX_TTL_S = 3600;

export interface CacheEntry {
  endpoint: Endpoint;
  body: unknown;
  /** Seconds since the entry was stored. */
  age_s: number;
}

export interface CacheWrite {
  endpoint: Endpoint;
  body: unknown;
  ttl_s: number;
}

/** Storage for cacheable upstream responses, already scoped to one user. */
export interface Cache {
  get(endpoints: Endpoint[]): Promise<CacheEntry[]>;
  put(entries: CacheWrite[]): Promise<void>;
}

/** Demo knobs passed through to the mock upstream (see index.ts). */
export interface Controls {
  fail: Set<Endpoint>;
  slow: Set<Endpoint>;
  /** Skip the cache read (responses are still stored). */
  refresh: boolean;
}

export interface FanOutOptions {
  baseUrl: string;
  apiKey: string;
  userId: string;
  timeoutMs: number;
  controls: Controls;
  cache?: Cache;
  fetch?: typeof fetch;
  now?: () => number;
}

export type UpstreamStatus = "ok" | "error" | "timeout";

export interface UpstreamReport {
  status: UpstreamStatus;
  source: "cache" | "upstream";
  ms: number;
  http?: number;
  /** Seconds the response may be cached for (0 = not cacheable). */
  ttl_s?: number;
  /** Cache hits only: how old the stored response is. */
  age_s?: number;
  error?: string;
}

export interface Aggregate {
  partial: boolean;
  total_ms: number;
  timeout_ms: number;
  cache: { read: "hit" | "miss" | "skipped" | "error" | "off"; read_ms: number; write: "ok" | "none" | "error" | "off"; write_ms: number; error?: string };
  data: Record<Endpoint, unknown>;
  upstreams: Record<Endpoint, UpstreamReport>;
}

/** Seconds to cache a response for, from its Cache-Control header. */
export function cacheTtl(header: string | null): number {
  if (!header) return 0;
  const parts = header.toLowerCase().split(",").map((p) => p.trim());
  if (parts.includes("no-store") || parts.includes("no-cache")) return 0;
  const m = parts.map((p) => /^max-age=(\d+)$/.exec(p)).find(Boolean);
  if (!m) return 0;
  return Math.min(Number(m[1]), MAX_TTL_S);
}

/** `?fail=offers,points&slow=orders&refresh=1` -> Controls. Unknown names are ignored. */
export function parseControls(params: URLSearchParams): Controls {
  const set = (name: string) =>
    new Set(
      (params.get(name) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is Endpoint => (ENDPOINTS as readonly string[]).includes(s)),
    );
  return { fail: set("fail"), slow: set("slow"), refresh: params.get("refresh") === "1" };
}

interface Outcome {
  endpoint: Endpoint;
  report: UpstreamReport;
  body: unknown;
}

async function callOne(o: FanOutOptions, endpoint: Endpoint): Promise<Outcome> {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const url = new URL(`${o.baseUrl.replace(/\/+$/, "")}/${endpoint}`);
  if (o.controls.fail.has(endpoint)) url.searchParams.set("mode", "fail");
  else if (o.controls.slow.has(endpoint)) url.searchParams.set("mode", "slow");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs);
  const t0 = now();
  try {
    const r = await f(url, {
      headers: { "x-api-key": o.apiKey, "x-user-id": o.userId, accept: "application/json" },
      signal: ac.signal,
    });
    // The body read is inside the same deadline: a slow body is a slow upstream.
    const text = await r.text();
    const ms = now() - t0;
    if (!r.ok) {
      return { endpoint, body: null, report: { status: "error", source: "upstream", ms, http: r.status, error: `upstream http ${r.status}` } };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { endpoint, body: null, report: { status: "error", source: "upstream", ms, http: r.status, error: "upstream body is not JSON" } };
    }
    const ttl = cacheTtl(r.headers.get("cache-control"));
    return { endpoint, body, report: { status: "ok", source: "upstream", ms, http: r.status, ttl_s: ttl } };
  } catch (e) {
    const ms = now() - t0;
    if (ac.signal.aborted) {
      return { endpoint, body: null, report: { status: "timeout", source: "upstream", ms, error: `no answer within ${o.timeoutMs} ms` } };
    }
    return { endpoint, body: null, report: { status: "error", source: "upstream", ms, error: String((e as Error)?.message ?? e).slice(0, 200) } };
  } finally {
    clearTimeout(timer);
  }
}

export async function fanOut(o: FanOutOptions): Promise<Aggregate> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const data = {} as Record<Endpoint, unknown>;
  const upstreams = {} as Record<Endpoint, UpstreamReport>;
  const cacheInfo: Aggregate["cache"] = { read: o.cache ? "miss" : "off", read_ms: 0, write: o.cache ? "none" : "off", write_ms: 0 };

  // Forced fail/slow endpoints always go upstream, so the demo knobs are not
  // hidden by a cache hit.
  const readable = ENDPOINTS.filter((e) => !o.controls.fail.has(e) && !o.controls.slow.has(e));
  const hits = new Map<Endpoint, CacheEntry>();
  if (o.cache && o.controls.refresh) {
    cacheInfo.read = "skipped";
  } else if (o.cache && readable.length) {
    const c0 = now();
    try {
      for (const entry of await o.cache.get(readable)) {
        if (readable.includes(entry.endpoint)) hits.set(entry.endpoint, entry);
      }
      cacheInfo.read = hits.size ? "hit" : "miss";
    } catch (e) {
      // A broken cache is a slower response, not a failed one.
      cacheInfo.read = "error";
      cacheInfo.error = String((e as Error)?.message ?? e).slice(0, 200);
    }
    cacheInfo.read_ms = now() - c0;
  }
  for (const [endpoint, entry] of hits) {
    data[endpoint] = entry.body;
    upstreams[endpoint] = { status: "ok", source: "cache", ms: 0, age_s: entry.age_s };
  }

  const misses = ENDPOINTS.filter((e) => !hits.has(e));
  const outcomes = await Promise.all(misses.map((e) => callOne(o, e)));
  const writes: CacheWrite[] = [];
  for (const out of outcomes) {
    data[out.endpoint] = out.body;
    upstreams[out.endpoint] = out.report;
    if (out.report.status === "ok" && (out.report.ttl_s ?? 0) > 0) {
      writes.push({ endpoint: out.endpoint, body: out.body, ttl_s: out.report.ttl_s! });
    }
  }

  if (o.cache && writes.length) {
    const w0 = now();
    try {
      await o.cache.put(writes);
      cacheInfo.write = "ok";
    } catch (e) {
      cacheInfo.write = "error";
      cacheInfo.error = String((e as Error)?.message ?? e).slice(0, 200);
    }
    cacheInfo.write_ms = now() - w0;
  }

  // Key order fixed for readability in the demo.
  const ordered = <T>(r: Record<Endpoint, T>) => Object.fromEntries(ENDPOINTS.map((e) => [e, r[e]])) as Record<Endpoint, T>;
  return {
    partial: ENDPOINTS.some((e) => upstreams[e].status !== "ok"),
    total_ms: now() - t0,
    timeout_ms: o.timeoutMs,
    cache: cacheInfo,
    data: ordered(data),
    upstreams: ordered(upstreams),
  };
}
