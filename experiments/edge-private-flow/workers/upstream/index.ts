// upstream: stand-in for the integration layer's JWT policy (an API
// gateway's JWT validation). Validates the forwarded Supabase user
// token against the project's published JWKS: signature, issuer, audience, exp.
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

interface Env {
  SUPABASE_URL: string;
}
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const t = performance.now();
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return Response.json({ ok: false, reason: "no token" }, { status: 401 });
    jwks ??= createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
    try {
      const header = decodeProtectedHeader(token);
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `${env.SUPABASE_URL}/auth/v1`,
        audience: "authenticated",
      });
      return Response.json({
        ok: true,
        alg: header.alg,
        kid: header.kid,
        sub: payload.sub,
        role: payload.role,
        ms: Math.round(performance.now() - t),
      });
    } catch (e) {
      return Response.json({ ok: false, reason: String(e) }, { status: 401 });
    }
  },
};
