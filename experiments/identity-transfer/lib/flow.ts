/**
 * The pieces IT01-IT03 share: driving the managed project's Keycloak slot from
 * the lab issuer worker, and following the browser flow by hand.
 *
 * The Keycloak slot is the vantage because `external_keycloak_url` is a
 * per-project setting, the Auth server appends
 * /protocol/openid-connect/{auth,token,userinfo} to it and performs no issuer
 * check. The account-resolution code every case here exercises
 * (internal/models/linking.go, internal/api/external.go) runs after every
 * provider, Apple included.
 */
import type { Ctx } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

/** Auth config keys every module in this experiment reads and restores. */
export const CONFIG_KEYS = [
  "external_keycloak_enabled",
  "external_keycloak_client_id",
  "external_keycloak_secret",
  "external_keycloak_url",
  "site_url",
] as const;

export const SITE_URL = "http://localhost:3000/pvlab-callback";
export const SETTLE_BUDGET_MS = 120_000;

export interface Persona {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  /** Extra userinfo claims - these reach the provider's custom-claims map. */
  claims?: Record<string, unknown>;
}

export interface SignIn {
  /** HTTP status of the Auth server's /authorize hop. */
  authorizeStatus: number;
  /** HTTP status of the Auth server's /callback hop. */
  callbackStatus: number;
  userId?: string;
  email?: string;
  /** Verbatim error and error_description the callback redirected with, if any. */
  error?: string;
  errorCode?: string;
  errorDescription?: string;
  /** Where the callback sent the browser (host + path, no tokens). */
  landed?: string;
}

export const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

export function jwtPayload(token: string): Record<string, unknown> {
  try {
    const p = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The full browser flow with redirects followed by hand: Auth server
 * /authorize -> issuer /auth (persona appended) -> Auth server /callback ->
 * site_url with tokens or an error in the fragment/query.
 */
export async function signIn(ctx: Ctx, apikey: string, persona: Persona): Promise<SignIn> {
  const base = `https://${ctx.apiHost}/auth/v1`;
  const r1 = await fetch(`${base}/authorize?provider=keycloak`, {
    headers: { apikey },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const issuerAuth = r1.headers.get("location");
  if (r1.status !== 302 || !issuerAuth) {
    const body = (await r1.text()).slice(0, 300);
    return { authorizeStatus: r1.status, callbackStatus: -1, error: `authorize did not redirect: ${body}` };
  }
  const u = new URL(issuerAuth);
  u.searchParams.set("persona", b64url(JSON.stringify(persona)));
  const r2 = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const callback = r2.headers.get("location");
  if (r2.status !== 302 || !callback) {
    return { authorizeStatus: r1.status, callbackStatus: -1, error: `issuer did not redirect: HTTP ${r2.status}` };
  }
  const r3 = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const landing = r3.headers.get("location");
  if (!landing) {
    const body = (await r3.text()).slice(0, 300);
    return { authorizeStatus: r1.status, callbackStatus: r3.status, error: `callback did not redirect: ${body}` };
  }
  const l = new URL(landing);
  const frag = new URLSearchParams(l.hash.replace(/^#/, ""));
  const q = l.searchParams;
  const pick = (k: string) => frag.get(k) ?? q.get(k) ?? undefined;
  const out: SignIn = { authorizeStatus: r1.status, callbackStatus: r3.status, landed: `${l.host}${l.pathname}` };
  const access = pick("access_token");
  if (access) {
    const p = jwtPayload(access);
    out.userId = typeof p.sub === "string" ? p.sub : undefined;
    out.email = typeof p.email === "string" ? p.email : undefined;
  } else {
    out.error = pick("error");
    out.errorCode = pick("error_code");
    out.errorDescription = pick("error_description");
  }
  return out;
}

export const note = (s: SignIn) =>
  s.userId ? `user ${s.userId.slice(0, 8)}... email ${s.email}` : `no session: error=${s.error ?? "-"} code=${s.errorCode ?? "-"} "${s.errorDescription ?? ""}"`;

export interface Settled {
  patchStatus: number;
  settled: boolean;
  settleS: number;
  reads: number;
  /** Last /auth/v1/settings body, for evidence when it never settled. */
  lastBody: string;
}

/**
 * PATCH the auth config, then poll /auth/v1/settings until the Keycloak slot
 * reports enabled. The config API returns before the Auth server has the new
 * config, so a sign-in issued straight after the PATCH races it.
 */
export async function pointAtIssuer(ctx: Ctx, apikey: string, issuer: string, extra: Record<string, unknown> = {}): Promise<Settled> {
  const t0 = Date.now();
  const patch = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, {
    external_keycloak_enabled: true,
    external_keycloak_client_id: "pvlab-issuer",
    external_keycloak_secret: "unused. the lab issuer ignores client auth",
    external_keycloak_url: issuer,
    site_url: SITE_URL,
    ...extra,
  });
  let settled = false;
  let reads = 0;
  let lastBody = "";
  while (Date.now() - t0 < SETTLE_BUDGET_MS) {
    reads++;
    const s = await fetch(`https://${ctx.apiHost}/auth/v1/settings`, { headers: { apikey }, signal: AbortSignal.timeout(15_000) });
    lastBody = await s.text();
    try {
      const j = JSON.parse(lastBody) as { external?: Record<string, boolean> };
      if (j.external?.keycloak === true) {
        settled = true;
        break;
      }
    } catch {
      // not JSON yet
    }
    await Bun.sleep(3_000);
  }
  return { patchStatus: patch.status, settled, settleS: Math.round((Date.now() - t0) / 1000), reads, lastBody };
}
