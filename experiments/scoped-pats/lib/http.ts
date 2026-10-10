/**
 * Management API client for the scoped-PAT modules.
 *
 * harness/src/mgmt.ts uses the ctx token and drops response headers; this
 * module needs both (a different bearer token per call, and x-ratelimit-*
 * headers), so it wraps the same `classifyBody` and adds three things:
 *
 *  - a real User-Agent (Cloudflare answers a bare client with 403 `error code:
 *    1010`, which reads exactly like a scope refusal),
 *  - a minimum gap between calls, because the docs state 120 requests per
 *    minute "per user, per project or organization, per endpoint" (Management
 *    API introduction page); whether other traffic under the same user draws
 *    on the same counter is not measured here,
 *  - 429 handling that honours retry-after.
 *
 * Nothing here logs or returns a bearer token.
 */
import { classifyBody } from "../../../harness/src/mgmt.js";

export const BASE = process.env.SUPABASE_MGMT_BASE_URL ?? "https://api.supabase.com/v1";
const ORIGIN = new URL(BASE).origin;
const UA = "pvlab-scoped-pats/1.0";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Resp {
  status: number;
  text: string;
  json?: Record<string, unknown> | unknown[];
  headers: Headers;
  throttled: boolean;
  retried429: number;
}

let lastCall = 0;
const MIN_GAP_MS = Number(process.env.PVLAB_SP_MIN_GAP_MS ?? 1500);

export async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  opts: { origin?: boolean; timeoutMs?: number } = {},
): Promise<Resp> {
  const url = `${opts.origin ? ORIGIN : BASE}${path}`;
  let retried = 0;
  for (;;) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": UA,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    const cls = classifyBody(res.headers.get("content-type"), text);
    if ((res.status === 429 || cls.throttled) && retried < 3) {
      retried++;
      const ra = Number(res.headers.get("retry-after") ?? "");
      await sleep(Math.min(Math.max(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15_000, 5_000), 65_000));
      continue;
    }
    return { status: res.status, text, headers: res.headers, retried429: retried, ...cls };
  }
}

/** Strip anything shaped like a project ref before text reaches a result. */
export const scrub = (s: string, n = 240) => s.replace(/[a-z]{20}/g, "<ref>").slice(0, n);

export interface Denial {
  /** 403 whose body carries a `missing_permissions` array. */
  denied: boolean;
  missing: string[];
  keys: string[];
}

export function denial(r: Pick<Resp, "status" | "json">): Denial {
  const j = r.json && !Array.isArray(r.json) ? r.json : undefined;
  const mp = j?.missing_permissions;
  const missing = Array.isArray(mp) ? mp.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [];
  return { denied: r.status === 403 && Array.isArray(mp), missing, keys: j ? Object.keys(j).sort() : [] };
}

export function outcome(r: Resp): string {
  const d = denial(r);
  if (d.denied) return "denied";
  if (r.status >= 200 && r.status < 300) return "ok";
  if (r.status === 401) return "401";
  if (r.status === 403) return "403-other";
  return `other-${r.status}`;
}
