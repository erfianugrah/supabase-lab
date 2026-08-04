/**
 * Shared mechanics for the key-rotation experiment.
 *
 * Lives outside `tests/` on purpose: the registry generator imports every
 * `.ts` under an experiment's tests directory as a default-exported
 * TestModule, so a helper file dropped in there becomes an `undefined` entry
 * in the registry array.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";

export const PASSWORD = "LabPassword123!";

// ---- Management API helpers (via harness mgmt) ----

export async function keys(ctx: Ctx, ref: string): Promise<{ anon?: string; service?: string }> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const arr = Array.isArray(r.json) ? (r.json as Record<string, string>[]) : [];
  const pick = (name: string) => arr.find((k) => k.name === name)?.api_key;
  return { anon: pick("anon"), service: pick("service_role") };
}

/**
 * Per-service readiness. The aggregate project status flipping to
 * ACTIVE_HEALTHY does not mean auth and rest will answer.
 */
export async function waitReady(ctx: Ctx, ref: string, budgetMs = 300000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs) {
    const r = await mgmt(
      ctx,
      "GET",
      `/projects/${ref}/health?services=auth&services=rest&services=db`,
    );
    const arr = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
    if (arr.length >= 3 && arr.every((s) => s.status === "ACTIVE_HEALTHY")) return true;
    await new Promise((x) => setTimeout(x, 5000));
  }
  return false;
}

// ---- Third-party auth on the spoke (Management API) ----

export interface TpaIntegration {
  id: string;
  oidc_issuer_url?: string;
  jwks_url?: string;
  resolved_jwks?: unknown;
  resolved_at?: string;
  type?: string;
  [key: string]: unknown;
}

export async function listTpa(ctx: Ctx, ref: string): Promise<TpaIntegration[]> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/auth/third-party-auth`);
  return Array.isArray(r.json) ? (r.json as TpaIntegration[]) : [];
}

export async function clearTpa(ctx: Ctx, ref: string): Promise<void> {
  for (const t of await listTpa(ctx, ref)) {
    await mgmt(ctx, "DELETE", `/projects/${ref}/config/auth/third-party-auth/${t.id}`);
  }
}

// ---- Hub GoTrue admin API (signing keys + users) ----

export interface SigningKey {
  id: string;
  kid: string;
  status: string;
  created_at?: string;
  [key: string]: unknown;
}

async function authAdmin(
  host: string,
  serviceKey: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: Record<string, unknown> | unknown[]; text: string }> {
  const res = await fetch(`https://${host}/auth/v1/admin${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json: Record<string, unknown> | unknown[] = {};
  try {
    json = JSON.parse(text) as Record<string, unknown> | unknown[];
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

export async function listSigningKeys(
  host: string,
  serviceKey: string,
): Promise<SigningKey[]> {
  const r = await authAdmin(host, serviceKey, "/signing-keys");
  return Array.isArray(r.json) ? (r.json as SigningKey[]) : [];
}

export async function createSigningKey(
  host: string,
  serviceKey: string,
): Promise<{ status: number; json: Record<string, unknown> | unknown[]; text: string }> {
  return authAdmin(host, serviceKey, "/signing-keys", { method: "POST" });
}

export async function patchSigningKey(
  host: string,
  serviceKey: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | unknown[]; text: string }> {
  return authAdmin(host, serviceKey, `/signing-keys/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ---- Auth users on the hub ----

export async function adminCreate(
  host: string,
  serviceKey: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | unknown[]; text: string }> {
  // First admin write on a fresh project can 500 even after health goes green.
  let r = await authAdmin(host, serviceKey, "/admin/users", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (r.status >= 500) {
    await new Promise((x) => setTimeout(x, 12000));
    r = await authAdmin(host, serviceKey, "/admin/users", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  return r;
}

export async function login(
  host: string,
  anonKey: string,
  email: string,
  password = PASSWORD,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`https://${host}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

/** Decode a JWT payload (unverified). */
export function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Decode a JWT header (unverified) to get the kid. */
export function jwtHeader(token: string): Record<string, unknown> {
  const part = token.split(".")[0];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---- JWKS (public, no auth) ----

export interface JwksResult {
  status: number;
  kids: string[];
  count: number;
  body: unknown;
}

export async function fetchJwks(host: string): Promise<JwksResult> {
  const res = await fetch(`https://${host}/auth/v1/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const keys = (body && typeof body === "object" && "keys" in body
    ? (body as Record<string, unknown[]>).keys
    : []) ?? [];
  const kids = (Array.isArray(keys) ? keys.map((k) => String((k as Record<string, unknown>).kid ?? "?")) : []);
  return { status: res.status, kids, count: kids.length, body };
}

// ---- PostgREST probe on the spoke ----

export interface RestProbe {
  status: number;
  code?: string;
  text: string;
}

export async function restProbe(
  host: string,
  anonKey: string,
  bearer: string,
): Promise<RestProbe> {
  // Probe the root /rest/v1/ which always returns something parseable
  // even without a real table. A missing table returns [] and 200; a bad
  // token returns a JSON error object with a code.
  const res = await fetch(`https://${host}/rest/v1/`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let code: string | undefined;
  try {
    const j = JSON.parse(text);
    if (!Array.isArray(j) && typeof j === "object" && j !== null && "code" in j) {
      code = String((j as Record<string, unknown>).code);
    }
  } catch {
    /* non-json */
  }
  return { status: res.status, code, text };
}

// ---- Key status lookup ----

/**
 * Look up a key's current status by kid. Returns undefined if the kid is
 * not found in the signing keys list.
 */
export function keyStatus(keys: SigningKey[], kid: string): string | undefined {
  return keys.find((k) => k.kid === kid)?.status;
}

// ---- Token extraction from login response ----

export function accessToken(login: { json: Record<string, unknown> }): string | undefined {
  return typeof login.json.access_token === "string" ? login.json.access_token : undefined;
}