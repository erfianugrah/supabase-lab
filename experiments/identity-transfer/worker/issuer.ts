/**
 * A lab-controlled OpenID Connect issuer shaped like a Keycloak realm.
 *
 * The managed Auth server's Keycloak provider takes a base URL and appends
 * /protocol/openid-connect/{auth,token,userinfo}; it performs no issuer check
 * and reads sub, email and email_verified from userinfo. That makes it a
 * social-provider slot a lab can drive with arbitrary identities. This worker
 * is stateless: the test appends `persona=<base64url JSON>` to the authorize
 * URL the Auth server redirected it to, the persona rides back as the `code`,
 * becomes the access token at /token, and is decoded again at /userinfo.
 *
 * Nothing here is a real identity provider; it exists to hand the Auth server
 * the subject and email the test chose.
 */
export interface Env {}

interface Persona {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

const b64urlDecode = (s: string): string => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

function decodePersona(token: string | null): Persona | undefined {
  if (!token) return undefined;
  try {
    const p = JSON.parse(b64urlDecode(token)) as Persona;
    return typeof p.sub === "string" && p.sub ? p : undefined;
  } catch {
    return undefined;
  }
}

export default {
  async fetch(req: Request, _env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/.well-known/openid-configuration") {
      const base = `${url.protocol}//${url.host}`;
      return json({
        issuer: base,
        authorization_endpoint: `${base}/protocol/openid-connect/auth`,
        token_endpoint: `${base}/protocol/openid-connect/token`,
        userinfo_endpoint: `${base}/protocol/openid-connect/userinfo`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
      });
    }

    if (path === "/protocol/openid-connect/auth") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") ?? "";
      const persona = url.searchParams.get("persona");
      if (!redirectUri) return json({ error: "invalid_request", error_description: "redirect_uri required" }, 400);
      if (!decodePersona(persona)) return json({ error: "invalid_request", error_description: "persona (base64url JSON with sub) required" }, 400);
      const back = new URL(redirectUri);
      back.searchParams.set("code", persona!);
      if (state) back.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: back.toString(), "cache-control": "no-store" } });
    }

    if (path === "/protocol/openid-connect/token") {
      if (req.method !== "POST") return json({ error: "invalid_request" }, 405);
      const form = new URLSearchParams(await req.text());
      const code = form.get("code");
      if (form.get("grant_type") !== "authorization_code" || !decodePersona(code)) {
        return json({ error: "invalid_grant", error_description: "code is not a persona" }, 400);
      }
      return json({ access_token: code, token_type: "Bearer", expires_in: 3600, scope: "openid email profile" });
    }

    if (path === "/protocol/openid-connect/userinfo") {
      const auth = req.headers.get("authorization") ?? "";
      const persona = decodePersona(auth.replace(/^Bearer\s+/i, "") || null);
      if (!persona) return json({ error: "invalid_token" }, 401, { "www-authenticate": 'Bearer error="invalid_token"' });
      const out: Record<string, unknown> = { sub: persona.sub, preferred_username: persona.sub };
      if (persona.email !== undefined) out.email = persona.email;
      if (persona.email_verified !== undefined) out.email_verified = persona.email_verified;
      if (persona.name) out.name = persona.name;
      return json(out);
    }

    return json({ error: "not_found", paths: ["/protocol/openid-connect/auth", "/protocol/openid-connect/token", "/protocol/openid-connect/userinfo"] }, 404);
  },
};
