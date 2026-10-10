/**
 * A lab-controlled, standards-shaped OpenID Connect issuer.
 *
 * Unlike identity-transfer's Keycloak-shaped worker (no issuer check, reads
 * userinfo), this one is what a `custom:` OIDC provider expects: a discovery
 * document, a JWKS, an authorization endpoint that honours state / nonce /
 * PKCE, and a token endpoint that returns a signed RS256 ID token whose
 * iss / aud / nonce the Auth server checks.
 *
 * Stateless. The test appends `persona=<base64url JSON>` to the authorize URL
 * the Auth server redirected it to; the persona and every authorize parameter
 * ride back inside the `code` (base64url JSON), so /token needs no store.
 *
 *   persona.sub / email / email_verified / name   identity claims
 *   persona.aud                                    overrides the aud claim
 *   persona.omit_nonce                             leave nonce out of the ID token
 *   persona.claims                                 extra ID-token claims
 *
 * The ID token carries two diagnostic claims so a test can read, from the
 * identity the Auth server stored, what the Auth server sent here:
 *   pvlab_pkce  "none" (no code_challenge on authorize) | "S256-verified"
 *   pvlab_auth  "basic" | "post" (how the client secret was presented)
 *
 * The private key arrives as the SIGNING_JWK variable, generated per run by
 * the test and discarded with the Worker. This is a lab fixture: it mints any
 * identity asked of it.
 */
export interface Env {
  SIGNING_JWK: string;
  PUBLIC_JWK: string;
  CLIENT_SECRET?: string;
}

interface Persona {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  aud?: string;
  omit_nonce?: boolean;
  claims?: Record<string, unknown>;
}

interface Code {
  persona: Persona;
  client_id: string;
  redirect_uri: string;
  nonce?: string;
  cc?: string;
  ccm?: string;
}

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};
const b64uDecode = (s: string): string => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

function parse<T>(s: string | null): T | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(b64uDecode(s)) as T;
  } catch {
    return undefined;
  }
}

async function sign(env: Env, payload: Record<string, unknown>): Promise<string> {
  const jwk = JSON.parse(env.SIGNING_JWK) as JsonWebKey & { kid: string };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })));
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}

function basicCreds(req: Request): { id: string; secret: string } | undefined {
  const h = req.headers.get("authorization") ?? "";
  if (!/^basic /i.test(h)) return undefined;
  const [id, ...rest] = atob(h.slice(6)).split(":");
  return { id: decodeURIComponent(id ?? ""), secret: decodeURIComponent(rest.join(":")) };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const base = `${url.protocol}//${url.host}`;

    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
        jwks_uri: `${base}/jwks.json`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "email", "profile"],
        claims_supported: ["sub", "email", "email_verified", "name"],
      });
    }

    if (url.pathname === "/jwks.json") {
      return json({ keys: [JSON.parse(env.PUBLIC_JWK)] }, 200, { "cache-control": "no-store" });
    }

    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const persona = parse<Persona>(url.searchParams.get("persona"));
      if (!redirectUri) return json({ error: "invalid_request", error_description: "redirect_uri required" }, 400);
      if (!persona?.sub) return json({ error: "invalid_request", error_description: "persona (base64url JSON with sub) required" }, 400);
      const code: Code = {
        persona,
        client_id: url.searchParams.get("client_id") ?? "",
        redirect_uri: redirectUri,
        nonce: url.searchParams.get("nonce") ?? undefined,
        cc: url.searchParams.get("code_challenge") ?? undefined,
        ccm: url.searchParams.get("code_challenge_method") ?? undefined,
      };
      const back = new URL(redirectUri);
      back.searchParams.set("code", b64u(enc.encode(JSON.stringify(code))));
      const state = url.searchParams.get("state");
      if (state) back.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: back.toString(), "cache-control": "no-store" } });
    }

    if (url.pathname === "/token") {
      if (req.method !== "POST") return json({ error: "invalid_request" }, 405);
      const form = new URLSearchParams(await req.text());
      const basic = basicCreds(req);
      const clientId = basic?.id ?? form.get("client_id") ?? "";
      const secret = basic?.secret ?? form.get("client_secret") ?? "";
      if (env.CLIENT_SECRET && secret !== env.CLIENT_SECRET) return json({ error: "invalid_client" }, 401);
      const code = parse<Code>(form.get("code"));
      if (form.get("grant_type") !== "authorization_code" || !code?.persona?.sub) {
        return json({ error: "invalid_grant", error_description: "code is not one this issuer minted" }, 400);
      }
      if (form.get("redirect_uri") !== code.redirect_uri) {
        return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
      }
      let pkce = "none";
      if (code.cc) {
        const verifier = form.get("code_verifier");
        if (!verifier) return json({ error: "invalid_grant", error_description: "code_verifier required" }, 400);
        const want = b64u(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
        if (want !== code.cc) return json({ error: "invalid_grant", error_description: "code_verifier mismatch" }, 400);
        pkce = `${code.ccm ?? "?"}-verified`;
      }
      const now = Math.floor(Date.now() / 1000);
      const p = code.persona;
      const claims: Record<string, unknown> = {
        iss: base,
        sub: p.sub,
        aud: p.aud ?? (clientId || code.client_id),
        iat: now,
        exp: now + 600,
        pvlab_pkce: pkce,
        pvlab_auth: basic ? "basic" : "post",
      };
      if (code.nonce && !p.omit_nonce) claims.nonce = code.nonce;
      if (p.email !== undefined) claims.email = p.email;
      if (p.email_verified !== undefined) claims.email_verified = p.email_verified;
      if (p.name) claims.name = p.name;
      Object.assign(claims, p.claims ?? {});
      const idToken = await sign(env, claims);
      return json({
        access_token: form.get("code"),
        token_type: "Bearer",
        expires_in: 600,
        scope: "openid email profile",
        id_token: idToken,
      });
    }

    if (url.pathname === "/userinfo") {
      const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const code = parse<Code>(auth);
      if (!code?.persona?.sub) return json({ error: "invalid_token" }, 401);
      const p = code.persona;
      const out: Record<string, unknown> = { sub: p.sub };
      if (p.email !== undefined) out.email = p.email;
      if (p.email_verified !== undefined) out.email_verified = p.email_verified;
      if (p.name) out.name = p.name;
      return json(out);
    }

    return json({ error: "not_found" }, 404);
  },
};
