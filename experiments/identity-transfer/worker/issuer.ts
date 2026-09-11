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
 *
 * `persona.claims` are extra userinfo claims. The Keycloak provider copies
 * every claim that is not one of sub/email/email_verified/name into the
 * provider claims' custom-claims map (internal/api/provider/keycloak.go), which
 * is the same field Apple's parser writes `transfer_sub` to
 * (internal/api/provider/oidc.go), so a lab claim named `transfer_sub` travels
 * the identical downstream path.
 *
 * The worker also serves the Before User Created auth hook at /hook/reject,
 * /hook/allow and /hook/decide. The hook protocol is a POST of {metadata, user}
 * signed with a standard-webhooks symmetric secret; a 200 carrying
 * {"error":{"http_code","message"}} refuses the signup and the message is
 * surfaced to the client (internal/hooks/hookserrors). The refusing routes
 * answer with a digest of the payload they were handed as that message, which
 * is how a test reads the payload back without the worker holding state. The
 * signature is NOT verified here: this issuer is already a lab fixture that
 * mints any identity asked of it, so authenticating its callers would prove
 * nothing.
 */
export interface Env {}

interface Persona {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  /** Extra userinfo claims; these land in the provider's custom-claims map. */
  claims?: Record<string, unknown>;
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

/**
 * A one-line description of the hook payload, short enough to survive the ride
 * back to the client as an error message. Keys only, plus the one value the
 * Apple question turns on - whether a provider custom claim reached the hook.
 */
function hookDigest(payload: Record<string, unknown>): string {
  const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o as object).sort() : []);
  const user = (payload.user ?? {}) as Record<string, unknown>;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const custom = (meta.custom_claims ?? {}) as Record<string, unknown>;
  const tsub = typeof custom.transfer_sub === "string" ? custom.transfer_sub : "";
  const email = typeof user.email === "string" ? user.email : "";
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}~` : s);
  return [
    `top=${cut(keys(payload).join("|"), 40)}`,
    `um=${cut(keys(meta).join("|"), 110)}`,
    `cc=${cut(keys(custom).join("|"), 60)}`,
    `tsub=${tsub ? cut(tsub, 40) : "-"}`,
    `email=${email ? cut(email, 40) : "-"}`,
  ].join(" ");
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
      for (const [k, v] of Object.entries(persona.claims ?? {})) out[k] = v;
      return json(out);
    }

    if (path === "/hook/reject" || path === "/hook/allow" || path === "/hook/decide") {
      if (req.method !== "POST") return json({ error: "invalid_request" }, 405);
      let payload: Record<string, unknown> = {};
      try {
        payload = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: { http_code: 400, message: "hook payload was not JSON" } });
      }
      if (path === "/hook/allow") return json({});
      if (path === "/hook/decide") {
        // Per-request mode, for a rig whose hook URI is fixed at boot. The
        // switch is the provider custom claim rather than anything about the
        // request, for two reasons: refuse and allow can then be compared
        // without restarting the server, and a case can carry a claim that
        // WOULD be refused through a path where the hook does not run, which
        // is how "the hook did not run here" is told from "it ran and was
        // happy".
        const user = (payload.user ?? {}) as Record<string, unknown>;
        const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
        const custom = (meta.custom_claims ?? {}) as Record<string, unknown>;
        const tsub = typeof custom.transfer_sub === "string" ? custom.transfer_sub : "";
        if (!tsub.startsWith("REJECT")) return json({});
      }
      return json({ error: { http_code: 403, message: hookDigest(payload) } });
    }

    return json({ error: "not_found", paths: ["/protocol/openid-connect/auth", "/protocol/openid-connect/token", "/protocol/openid-connect/userinfo", "/hook/reject", "/hook/allow", "/hook/decide"] }, 404);
  },
};
