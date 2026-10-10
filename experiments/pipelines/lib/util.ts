import type { Ctx } from "../../../harness/src/types.js";
import { mgmtBase } from "../../../harness/src/mgmt.js";

export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] ?? NaN;
}

export const round = (n: number, d = 0) => (Number.isFinite(n) ? Number(n.toFixed(d)) : -1);

/** Host root of the control plane (the `/platform/...` routes sit beside `/v1`). */
export function controlOrigin(ctx: Ctx): string {
  return new URL(mgmtBase(ctx)).origin;
}

/** A GET with the PAT, no `/v1` prefix; HTML interstitials are reported, not parsed. */
export async function rawGet(
  ctx: Ctx,
  url: string,
): Promise<{ status: number; text: string; json?: unknown; ct: string }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${ctx.pat}` },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, text, json, ct };
}

/** Milliseconds to a bounded, ASCII-safe label for `measurements`. */
export const lbl = (s: string, n = 120) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, n);
