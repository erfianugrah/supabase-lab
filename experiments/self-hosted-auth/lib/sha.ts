/**
 * Shared helpers for experiments/self-hosted-auth.
 *
 * Two GoTrue instances front ONE auth schema in this experiment: the managed
 * one at https://<ref>.supabase.co/auth/v1 and a self-hosted one the Makefile
 * starts (PVLAB_ENDPOINT_SELFHOSTED_GOTRUE, connecting as `postgres` through
 * the session pooler with search_path=auth). Every helper takes the base URL
 * so the same probe runs against either side, and the report reads as pairs.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";

export interface Probe {
  status: number;
  json: Record<string, unknown>;
  text: string;
  ms: number;
}

export async function http(
  url: string,
  opts: { method?: string; key?: string; bearer?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<Probe> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.key ? { apikey: opts.key } : {}),
        ...(opts.bearer ?? opts.key ? { Authorization: `Bearer ${opts.bearer ?? opts.key}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.status, json, text, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { status: 0, json: {}, text: `ERR:${e instanceof Error ? e.message : String(e)}`, ms: Math.round(performance.now() - t0) };
  }
}

/** The platform's own error label from a GoTrue or PostgREST body, verbatim. */
export function codeOf(p: Probe): string {
  const j = p.json;
  return String(j.error_code ?? j.code ?? j.msg ?? j.message ?? j.error ?? "").slice(0, 120);
}

export interface Keys {
  anon: string;
  service: string;
}

export async function fetchKeys(ctx: Ctx): Promise<Keys> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=true`);
  const rows = Array.isArray(r.json) ? (r.json as { name?: string; api_key?: string }[]) : [];
  const by = (n: string) => rows.find((k) => k.name === n)?.api_key ?? "";
  const anon = by("anon");
  const service = by("service_role");
  if (!anon || !service) throw new Error(`legacy anon/service_role keys absent (api-keys HTTP ${r.status})`);
  return { anon, service };
}

/** Management query endpoint - SQL as `postgres` without a DB socket. */
export async function sql(ctx: Ctx, query: string): Promise<{ status: number; rows: Record<string, unknown>[]; error: string }> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query });
  const rows = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
  const error = r.status >= 300 ? String((r.json as Record<string, unknown> | undefined)?.message ?? r.text).slice(0, 300) : "";
  return { status: r.status, rows, error };
}

// ---------------------------------------------------------------------------
// JWT inspection (no verification - the platform does that; we read shape)
// ---------------------------------------------------------------------------

function b64url(s: string): string {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}

export interface JwtShape {
  alg: string;
  kid: string;
  iss: string;
  aud: string;
  role: string;
  sub: string;
  ttlS: number;
  sessionId: string;
}

export function jwtShape(token: string): JwtShape | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const h = JSON.parse(b64url(parts[0]!)) as Record<string, unknown>;
    const c = JSON.parse(b64url(parts[1]!)) as Record<string, unknown>;
    return {
      alg: String(h.alg ?? ""),
      kid: String(h.kid ?? ""),
      iss: String(c.iss ?? ""),
      aud: String(c.aud ?? ""),
      role: String(c.role ?? ""),
      sub: String(c.sub ?? ""),
      ttlS: Number(c.exp ?? 0) - Number(c.iat ?? 0),
      sessionId: String(c.session_id ?? ""),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// GoTrue calls, parameterised by base URL
// ---------------------------------------------------------------------------

export interface Session {
  accessToken: string;
  refreshToken: string;
  status: number;
  code: string;
}

export async function adminCreate(base: string, keys: Keys, email: string, password: string): Promise<{ status: number; id: string; code: string }> {
  const r = await http(`${base}/admin/users`, {
    method: "POST",
    key: keys.service,
    body: { email, password, email_confirm: true },
  });
  return { status: r.status, id: String(r.json.id ?? ""), code: codeOf(r) };
}

export async function passwordGrant(base: string, keys: Keys, email: string, password: string): Promise<Session> {
  const r = await http(`${base}/token?grant_type=password`, { method: "POST", key: keys.anon, body: { email, password } });
  return {
    accessToken: String(r.json.access_token ?? ""),
    refreshToken: String(r.json.refresh_token ?? ""),
    status: r.status,
    code: r.status >= 300 ? codeOf(r) : "",
  };
}

export async function refreshGrant(base: string, keys: Keys, refreshToken: string): Promise<Session> {
  const r = await http(`${base}/token?grant_type=refresh_token`, { method: "POST", key: keys.anon, body: { refresh_token: refreshToken } });
  return {
    accessToken: String(r.json.access_token ?? ""),
    refreshToken: String(r.json.refresh_token ?? ""),
    status: r.status,
    code: r.status >= 300 ? codeOf(r) : "",
  };
}

/** GET /user with a bearer: does THIS GoTrue verify THAT token. */
export async function whoami(base: string, keys: Keys, accessToken: string): Promise<{ status: number; code: string }> {
  const r = await http(`${base}/user`, { key: keys.anon, bearer: accessToken });
  return { status: r.status, code: r.status >= 300 ? codeOf(r) : "" };
}

export async function adminHasEmail(base: string, keys: Keys, email: string): Promise<{ status: number; present: boolean }> {
  const r = await http(`${base}/admin/users?page=1&per_page=100`, { key: keys.service });
  const users = Array.isArray(r.json.users) ? (r.json.users as { email?: string }[]) : [];
  return { status: r.status, present: users.some((u) => u.email === email) };
}

export async function adminDelete(base: string, keys: Keys, id: string): Promise<number> {
  const r = await http(`${base}/admin/users/${id}`, { method: "DELETE", key: keys.service });
  return r.status;
}

export const managedAuth = (ctx: Ctx) => `https://${ctx.apiHost}/auth/v1`;
export const selfHosted = (ctx: Ctx) => ctx.endpoints["selfhosted_gotrue"] ?? "";

export const PROBE_TABLE = "sha_probe";

/** A table only `authenticated` may read: the PostgREST-side trust probe. */
export async function ensureProbeTable(ctx: Ctx): Promise<void> {
  const r = await sql(
    ctx,
    `create table if not exists public.${PROBE_TABLE}(id int primary key);
insert into public.${PROBE_TABLE} values (1) on conflict do nothing;
alter table public.${PROBE_TABLE} enable row level security;
drop policy if exists p on public.${PROBE_TABLE};
create policy p on public.${PROBE_TABLE} for select to authenticated using (true);
grant select on public.${PROBE_TABLE} to authenticated, anon;
notify pgrst, 'reload schema';`,
  );
  if (r.status >= 300) throw new Error(`probe table: ${r.error}`);
}

/** Read the authenticated-only table with a token: 200 + a row means PostgREST accepted the token AND its role claim. */
export async function restRead(ctx: Ctx, keys: Keys, accessToken: string): Promise<{ status: number; rows: number; code: string }> {
  const r = await http(`https://${ctx.apiHost}/rest/v1/${PROBE_TABLE}?select=id`, { key: keys.anon, bearer: accessToken });
  const arr = Array.isArray(r.json) ? (r.json as unknown[]) : Array.isArray(JSON.parse(r.text || "[]")) ? (JSON.parse(r.text) as unknown[]) : [];
  return { status: r.status, rows: arr.length, code: r.status >= 300 ? codeOf(r) : "" };
}

export const randomEmail = (tag: string) => `sha.${tag}.${Date.now()}@example.com`;
export const randomPassword = () => `Pvlab-${crypto.randomUUID().slice(0, 12)}!A1`;
