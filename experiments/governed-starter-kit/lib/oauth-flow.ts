/**
 * The OAuth 2.1 code flow an MCP client runs against the project's own
 * authorization server, driven headless: discovery from the resource server,
 * dynamic client registration, authorize with PKCE, the consent step a person
 * would click (approved through the same API the consent page calls), and the
 * token exchange. Same flow as byo-oauth O03, which registered its clients
 * through the admin API; this one registers them the way an MCP client does.
 */
import { createHash, randomBytes } from "node:crypto";

export const REDIRECT = "http://localhost:54321/callback";

export interface Http {
  status: number;
  text: string;
  headers: Headers;
}

export async function http(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Http> {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

export function json<T = Record<string, unknown>>(r: Http): T | undefined {
  try {
    return JSON.parse(r.text) as T;
  } catch {
    return undefined;
  }
}

export interface Discovery {
  challengeStatus: number;
  wwwAuthenticate: string;
  resourceMetadataUrl: string;
  resourceMetadata?: { resource?: string; authorization_servers?: string[]; [k: string]: unknown };
  asMetadataUrl: string;
  asMetadata?: Record<string, unknown>;
}

/** Unauthenticated call -> 401 challenge -> protected-resource metadata -> authorization-server metadata. */
export async function discover(mcpUrl: string): Promise<Discovery> {
  const ch = await http(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const www = ch.headers.get("www-authenticate") ?? "";
  const rm = /resource_metadata="([^"]+)"/.exec(www)?.[1] ?? "";
  const out: Discovery = { challengeStatus: ch.status, wwwAuthenticate: www, resourceMetadataUrl: rm, asMetadataUrl: "" };
  if (!rm) return out;
  const prm = await http(rm);
  out.resourceMetadata = json(prm);
  const as = out.resourceMetadata?.authorization_servers?.[0];
  if (!as) return out;
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    const u = as.replace(/\/$/, "") + p;
    const r = await http(u);
    if (r.status === 200) {
      out.asMetadataUrl = u;
      out.asMetadata = json(r);
      break;
    }
  }
  return out;
}

export interface Registered {
  clientId: string;
  status: number;
  body?: Record<string, unknown>;
}

export async function registerClient(registrationEndpoint: string, name: string): Promise<Registered> {
  const r = await http(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = json(r);
  return { clientId: String(body?.client_id ?? ""), status: r.status, body };
}

export interface FlowOut {
  token?: string;
  tokenStatus: number;
  consentStatus: number;
  detail?: string;
}

/** Run authorize -> consent -> token for one user and one registered client. */
export async function authorize(opts: {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  authBase: string; // https://<ref>.supabase.co/auth/v1
  publishableKey: string;
  userToken: string;
  clientId: string;
  resource?: string;
  scope?: string;
}): Promise<FlowOut> {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
  });
  if (opts.resource) q.set("resource", opts.resource);
  if (opts.scope) q.set("scope", opts.scope);
  const hdr = { apikey: opts.publishableKey, Authorization: `Bearer ${opts.userToken}` };
  const az = await http(`${opts.authorizationEndpoint}?${q.toString()}`, { headers: hdr });
  const hay = `${az.text} ${az.headers.get("location") ?? ""}`;
  const aid = /authorization_id=([A-Za-z0-9_-]+)/.exec(hay)?.[1];
  if (!aid) return { tokenStatus: 0, consentStatus: az.status, detail: `authorize ${az.status}: ${az.text.slice(0, 200)}` };
  await http(`${opts.authBase}/oauth/authorizations/${aid}`, { headers: hdr }); // binds the user to the request
  const consent = await http(`${opts.authBase}/oauth/authorizations/${aid}/consent`, {
    method: "POST",
    headers: { ...hdr, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve" }),
  });
  const code = /[?&]code=([A-Za-z0-9._~-]+)/.exec(consent.text)?.[1];
  if (!code) return { tokenStatus: 0, consentStatus: consent.status, detail: `consent ${consent.status}: ${consent.text.slice(0, 200)}` };
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: opts.clientId,
    code_verifier: verifier,
  });
  if (opts.resource) form.set("resource", opts.resource);
  const tok = await http(opts.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const access = json<{ access_token?: string }>(tok)?.access_token;
  return { token: access, tokenStatus: tok.status, consentStatus: consent.status, detail: access ? undefined : `token ${tok.status}: ${tok.text.slice(0, 200)}` };
}
