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

/** Like http() but keeps the body, for row counts and error messages. */
export async function httpBody(
  url: string,
  opts: { method?: string; key?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; text: string; json: unknown; ms: number }> {
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
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let json: unknown = undefined;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, text, json, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { status: 0, text: `ERR:${e instanceof Error ? e.message : String(e)}`, json: undefined, ms: Math.round(performance.now() - t0) };
  }
}

/** Short error code/message from a PostgREST/GoTrue JSON body. */
export function errCode(json: unknown, text: string): string {
  if (json && typeof json === "object") {
    const j = json as Record<string, unknown>;
    // GoTrue puts a NUMERIC http code in `code` and the name in `error_code`;
    // PostgREST puts the SQLSTATE-ish string in `code`. Prefer the named field.
    const code = typeof j.code === "string" ? j.code : undefined;
    const name = j.error_code ?? code;
    const msg = j.msg ?? j.message ?? j.error ?? j.hint;
    return [name, msg].filter((x) => x !== undefined && x !== "").map(String).join(": ").slice(0, 160);
  }
  return text.trim().slice(0, 80);
}
