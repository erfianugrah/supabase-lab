/**
 * One Management API client for every experiment.
 *
 * Three experiments had hand-rolled their own copy of this before it moved
 * here, each with slightly different timeout and parse behaviour, which makes
 * "the API returned something odd" mean something different per test.
 *
 * The parse half is deliberately not `res.json()`. The consolidation run found
 * that api.supabase.com answers aggressive polling with a Cloudflare HTML
 * interstitial rather than a JSON 429, so a client that assumes JSON throws a
 * parse error and the caller records a test bug where the truth is "you were
 * throttled". `classifyBody` makes that distinction explicit and is unit
 * tested, because it is the piece that turns a retryable condition into a
 * misleading failure when it is wrong.
 */
import type { Ctx } from "./types";

export const MGMT_BASE = "https://api.supabase.com/v1";

export interface MgmtResponse {
  status: number;
  text: string;
  json?: Record<string, unknown> | unknown[];
  /** Body was an HTML challenge/interstitial, not an API response. */
  throttled: boolean;
}

/**
 * Pure body classification, split out so the throttle case is testable
 * without a network.
 */
export function classifyBody(
  contentType: string | null,
  text: string,
): Pick<MgmtResponse, "json" | "throttled"> {
  const ct = (contentType ?? "").toLowerCase();
  const looksHtml = ct.includes("text/html") || /^\s*<(?:!doctype|html)/i.test(text);
  if (looksHtml) return { throttled: true };
  try {
    return { json: JSON.parse(text) as Record<string, unknown> | unknown[], throttled: false };
  } catch {
    return { throttled: false };
  }
}

export async function mgmt(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30000,
): Promise<MgmtResponse> {
  const res = await fetch(`${MGMT_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.pat}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, text, ...classifyBody(res.headers.get("content-type"), text) };
}
