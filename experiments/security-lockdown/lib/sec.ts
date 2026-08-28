/**
 * Shared helpers for experiments/security-lockdown. Self-contained (does not
 * import from a sibling experiment).
 */
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

export interface Probe {
  status: number;
  code: string;
  ms: number;
}

export async function http(
  url: string,
  opts: { method?: string; key?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Probe> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.key ? { apikey: opts.key, Authorization: `Bearer ${opts.key}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    let code = "";
    try {
      const j = JSON.parse(text);
      code = String(j.code ?? j.message ?? j.error ?? "").slice(0, 80);
    } catch {
      code = text.trim().slice(0, 60);
    }
    return { status: res.status, code, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { status: 0, code: `ERR:${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`, ms: Math.round(performance.now() - t0) };
  }
}

/** Write-capable SQL via the Management query endpoint. Returns rows. */
export async function sql(ctx: Ctx, query: string): Promise<unknown[]> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query });
  if (r.status >= 300) throw new Error(`sql http ${r.status}: ${r.text.slice(0, 300)}`);
  return Array.isArray(r.json) ? (r.json as unknown[]) : [];
}

export async function fetchKeys(ctx: Ctx): Promise<{ anonJwt: string; serviceJwt: string }> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=true`);
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`api-keys http ${r.status}`);
  const rows = r.json as { name: string; api_key?: string }[];
  const by = (n: string) => rows.find((k) => k.name === n)?.api_key ?? "";
  return { anonJwt: by("anon"), serviceJwt: by("service_role") };
}

export async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, pollMs = 3000): Promise<{ ok: boolean; elapsedS: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return { ok: true, elapsedS: Math.round((Date.now() - t0) / 1000) };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, elapsedS: Math.round((Date.now() - t0) / 1000) };
}
