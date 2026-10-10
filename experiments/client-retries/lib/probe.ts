/**
 * Client-side helpers shared by the CR modules: build a supabase-js client
 * pointed at the fault proxy, time one call, and summarise what the proxy saw.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import sbPkg from "@supabase/supabase-js/package.json" with { type: "json" };
import { gaps, retryCounts, type FaultProxy, type Seen } from "./faultproxy";

export const SB_VERSION: string = (sbPkg as { version?: string }).version ?? "unknown";

export type ClientOpts = Parameters<typeof createClient>[2];

/** A client with no session persistence, so nothing outside the proxy log changes between cases. */
export function client(url: string, key: string, opts: ClientOpts = {}): SupabaseClient {
  return createClient<any, "public">(url, key, {
    ...opts,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, ...(opts?.auth ?? {}) },
  });
}

export interface Outcome {
  ok: boolean;
  /** HTTP status supabase-js reported (0 for a network error or abort). */
  status: number;
  /** PostgREST error code, or the JS error name for a client-side failure. */
  code: string;
  message: string;
  /** supabase-js rejected instead of resolving with `error` (throwOnError or an unhandled path). */
  threw: boolean;
  elapsedMs: number;
}

interface Resp {
  error: { code?: string; message?: string; name?: string; details?: string } | null;
  status: number;
}

export async function timed(fn: () => PromiseLike<Resp>): Promise<Outcome> {
  const t0 = performance.now();
  try {
    const r = await fn();
    return {
      ok: r.error === null,
      status: r.status,
      code: r.error?.code ?? (r.error ? (r.error.name ?? "error") : ""),
      message: (r.error?.message ?? "").slice(0, 80),
      threw: false,
      elapsedMs: Math.round(performance.now() - t0),
    };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return {
      ok: false,
      status: 0,
      code: err?.name ?? "throw",
      message: (err?.message ?? String(e)).slice(0, 80),
      threw: true,
      elapsedMs: Math.round(performance.now() - t0),
    };
  }
}

export interface Wire {
  /** requests that reached the proxy for the governed paths */
  wire: number;
  /** distinct client-level attempts: distinct X-Retry-Count values (absent counts as 0) */
  attempts: number;
  retryCounts: string;
  gapsMs: string;
}

/** Summarise governed requests. `wire` can exceed `attempts` when the runtime re-sends a request itself. */
export function wire(proxy: FaultProxy): Wire {
  const rows: Seen[] = proxy.governed();
  const distinct = new Set(rows.map((r) => r.retryCount ?? "0"));
  return { wire: rows.length, attempts: distinct.size, retryCounts: retryCounts(rows), gapsMs: gaps(rows).join(",") };
}

/** Flatten an Outcome + Wire into harness measurement keys under a prefix. */
export function flat(prefix: string, o: Outcome, w: Wire): Record<string, number | string> {
  return {
    [`${prefix}_attempts`]: w.attempts,
    [`${prefix}_wire`]: w.wire,
    [`${prefix}_rc`]: w.retryCounts,
    [`${prefix}_gaps_ms`]: w.gapsMs || "-",
    [`${prefix}_ok`]: o.ok ? 1 : 0,
    [`${prefix}_status`]: o.status,
    [`${prefix}_code`]: o.code || "-",
    [`${prefix}_elapsed_ms`]: o.elapsedMs,
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
