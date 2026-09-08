/**
 * Auth-endpoint plumbing for the AR modules: hit GoTrue's public endpoints with
 * the anon key, find the 429 boundary of a burst, and read/patch the auth
 * config. GoTrue's rate limiter is a per-IP token bucket (capacity 30) on most
 * endpoints; a burst from one IP trips it and returns 429 with retry-after.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";

export interface AuthResp {
  status: number;
  body: string;
  retryAfter: string;
  contentType: string;
}

async function post(ctx: Ctx, path: string, body: unknown, extraHeaders: Record<string, string> = {}, timeoutMs = 15_000): Promise<AuthResp> {
  const res = await fetch(`https://${ctx.apiHost}${path}`, {
    method: "POST",
    headers: { apikey: ctx.anonKey ?? "", "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e) => {
    throw new Error(`fetch ${path}: ${e instanceof Error ? e.message : String(e)}`);
  });
  const bodyText = (await res.text()).slice(0, 200);
  return {
    status: res.status,
    body: bodyText,
    retryAfter: res.headers.get("retry-after") ?? "none",
    contentType: res.headers.get("content-type") ?? "",
  };
}

export interface BurstResult {
  sent: number;
  firstBlockAt: number; // 1-indexed request where 429 first appeared, 0 if never
  status429: boolean;
  retryAfter: string;
  body: string;
  statuses: Record<string, number>; // histogram of status codes seen
}

/**
 * Fire `max` sequential requests through `make`, stopping at the first 429.
 * Sequential, not parallel: the point is where the bucket empties, and a
 * parallel flood makes "which request tripped it" unreadable.
 */
export async function burstUntil429(make: (i: number) => Promise<AuthResp>, max: number): Promise<BurstResult> {
  const statuses: Record<string, number> = {};
  let firstBlockAt = 0;
  let retryAfter = "none";
  let body = "";
  let sent = 0;
  for (let i = 1; i <= max; i++) {
    sent = i;
    const r = await make(i);
    statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
    if (r.status === 429) {
      firstBlockAt = i;
      retryAfter = r.retryAfter;
      body = r.body;
      break;
    }
  }
  return { sent, firstBlockAt, status429: firstBlockAt > 0, retryAfter, body, statuses };
}

/** Anonymous sign-in: POST /auth/v1/signup with no email/phone. Per-IP limited. */
export function anonSignin(ctx: Ctx, forwardedFor?: string, secretKey?: string) {
  return (_i: number) =>
    post(
      ctx,
      "/auth/v1/signup",
      {},
      forwardedFor && secretKey ? { apikey: secretKey, "Sb-Forwarded-For": forwardedFor } : {},
    );
}

/** Email signup with a distinct address each call - exercises the email-send cap on built-in SMTP. */
export function emailSignup(ctx: Ctx) {
  return (i: number) => post(ctx, "/auth/v1/signup", { email: `ar.${Date.now()}.${i}@example.com`, password: "supabase-lab-test-password" });
}

/** Read the auth config (Management API). */
export async function getAuthConfig(ctx: Ctx): Promise<Record<string, unknown>> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
  return (r.json as Record<string, unknown>) ?? {};
}

export async function patchAuthConfig(ctx: Ctx, patch: Record<string, unknown>): Promise<number> {
  const r = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, patch);
  return r.status;
}

/** Admin-create a confirmed user (service key). Hashes with bcrypt, sends no email. */
export async function adminCreateUser(ctx: Ctx, serviceKey: string, email: string, password: string): Promise<{ status: number; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`https://${ctx.apiHost}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  }).catch(() => ({ status: 0 }) as Response);
  return { status: res.status, ms: Math.round(performance.now() - t0) };
}

/** Delete every user whose email starts with `prefix`, via the admin API. Best effort. */
export async function deleteUsersByPrefix(ctx: Ctx, serviceKey: string, prefix: string): Promise<number> {
  const res = await fetch(`https://${ctx.apiHost}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).catch(() => null);
  if (!res || res.status >= 300) return 0;
  const j = (await res.json().catch(() => ({}))) as { users?: { id: string; email?: string; is_anonymous?: boolean }[] };
  const victims = (j.users ?? []).filter((u) => (prefix === "" ? u.is_anonymous : (u.email ?? "").startsWith(prefix)));
  let deleted = 0;
  for (const u of victims) {
    const d = await fetch(`https://${ctx.apiHost}/auth/v1/admin/users/${u.id}`, {
      method: "DELETE",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    }).catch(() => null);
    if (d && d.status < 300) deleted++;
  }
  return deleted;
}

/** Sleep, without depending on the Bun global so a module type-checks standalone. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll GET /auth/v1/settings until `external.anonymous_users` is true, so a
 * burst does not race the config PATCH's propagation (identity-transfer
 * measured ~4s; a fresh enable can take longer). Returns whether it settled.
 */
export async function waitAnonEnabled(ctx: Ctx, budgetMs = 30_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const r = await fetch(`https://${ctx.apiHost}/auth/v1/settings`, { headers: { apikey: ctx.anonKey ?? "" } }).catch(() => null);
    if (r && r.status === 200) {
      const j = (await r.json().catch(() => ({}))) as { external?: { anonymous_users?: boolean } };
      if (j.external?.anonymous_users === true) return true;
    }
    await sleep(3_000);
  }
  return false;
}

/** Percentiles of a latency sample, rounded to ms. */
export function pctl(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return Math.round(s[idx] ?? 0);
}
