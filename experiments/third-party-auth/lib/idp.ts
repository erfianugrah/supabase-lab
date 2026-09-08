/**
 * A self-contained external identity provider for the TPA modules: generate an
 * ES256 key in-process, mint JWTs with it, and the plumbing to publish its
 * JWKS and register it as a Supabase third-party auth issuer. No container -
 * the point is to prove Supabase trusts an issuer that is NOT its own GoTrue,
 * and an in-process signer is exactly such an issuer.
 *
 * Signing is Web Crypto ECDSA P-256 / SHA-256, which returns the raw R||S
 * signature JWS ES256 wants (the repo already uses crypto.subtle for keygen -
 * no `jose` dependency). Registration is POST /config/auth/third-party-auth
 * {jwks_url}, delete is the mirror, both read from self-hosted-auth SH06.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";
import { deployViaApi, invokeWhenLive } from "../../edge-function-limits/lib/ef";

function b64url(input: Uint8Array | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface Idp {
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
  kid: string;
}

/** A fresh ES256 issuer key. The public half becomes the JWKS Supabase trusts. */
export async function generateIdp(): Promise<Idp> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const kid = crypto.randomUUID();
  const publicJwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, alg: "ES256", kid, key_ops: ["verify"], use: "sig" };
  return { privateKey: pair.privateKey, publicJwk, kid };
}

export interface Claims {
  sub: string;
  iss: string;
  role?: string;
  aud?: string;
  ttlSeconds?: number;
  extra?: Record<string, unknown>;
}

/** Mint an ES256 JWT signed by the IdP - the token an external provider hands a client. */
export async function mint(idp: Idp, c: Claims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT", kid: idp.kid };
  const payload = {
    iss: c.iss,
    sub: c.sub,
    aud: c.aud ?? "authenticated",
    role: c.role ?? "authenticated",
    iat: now,
    exp: now + (c.ttlSeconds ?? 3600),
    ...(c.extra ?? {}),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, idp.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

/** Publish the JWKS from an Edge Function on the project; returns its URL once live. */
export async function publishJwks(ctx: Ctx, slug: string, publicJwk: Record<string, unknown>): Promise<{ url: string; ok: boolean; status: number }> {
  const jwks = JSON.stringify({ keys: [publicJwk] });
  const src = `Deno.serve(() => new Response(${JSON.stringify(jwks)}, { headers: { "Content-Type": "application/json" } }));\n`;
  const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: src }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
  const url = `https://${ctx.apiHost}/functions/v1/${slug}`;
  if (dep.status >= 300) return { url, ok: false, status: dep.status };
  const served = await invokeWhenLive(ctx, slug, 90_000);
  return { url, ok: served.status === 200, status: served.status };
}

export async function registerTpa(ctx: Ctx, jwksUrl: string): Promise<{ status: number; id: string; body: string }> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/config/auth/third-party-auth`, { jwks_url: jwksUrl });
  const j = (r.json ?? {}) as { id?: string };
  return { status: r.status, id: j.id ?? "", body: r.text.slice(0, 300) };
}

export async function deleteTpa(ctx: Ctx, id: string): Promise<number> {
  const r = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/config/auth/third-party-auth/${id}`).catch(() => ({ status: 0 }));
  return r.status;
}

export interface HttpResult {
  status: number;
  json: unknown;
  text: string;
  code: string;
}

/** GET against the project API with an apikey and optional bearer token. */
export async function apiGet(ctx: Ctx, path: string, apikey: string, bearer?: string): Promise<HttpResult> {
  const res = await fetch(`https://${ctx.apiHost}${path}`, {
    headers: { apikey, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => ({ status: 0, text: async () => String(e), headers: new Headers() }) as unknown as Response);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const code = (json && typeof json === "object" ? String((json as Record<string, unknown>).code ?? (json as Record<string, unknown>).error_code ?? "") : "") || "";
  return { status: res.status, json, text: text.slice(0, 300), code };
}

/** Managed GoTrue password grant - proof native Auth still issues tokens under TPA. */
export async function passwordGrant(ctx: Ctx, apikey: string, email: string, password: string): Promise<{ status: number; token: string }> {
  const res = await fetch(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) return { status: 0, token: "" };
  const j = (await res.json().catch(() => ({}))) as { access_token?: string };
  return { status: res.status, token: j.access_token ?? "" };
}

export async function adminCreateUser(ctx: Ctx, serviceKey: string, email: string, password: string): Promise<number> {
  const res = await fetch(`https://${ctx.apiHost}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  }).catch(() => ({ status: 0 }) as Response);
  return res.status;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
