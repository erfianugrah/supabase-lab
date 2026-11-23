// gateway: stand-in for ONE integration entry point in front of several
// internal "process APIs" (the pattern an integration layer keeps when calls
// arrive over the internet instead of a private network).
//
// Served on two hostnames:
//   GW host  - mTLS enabled at the Cloudflare edge (Cloudflare-managed CA).
//              The Worker refuses unless request.cf.tlsClientAuth.certVerified
//              is SUCCESS, then validates the forwarded Supabase JWT.
//   SVC host - behind a Cloudflare Access application with a service-token
//              policy (Access enforces it before the Worker runs); the Worker
//              still validates the JWT.
// Routes: /process/orders, /process/rates (mock data), /whoami.
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

interface Env {
  SUPABASE_URL: string;
  GW_HOST: string;
}
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

const PROCESS: Record<string, unknown> = {
  "/process/orders": { orders: [{ id: "o-1", status: "confirmed" }] },
  "/process/rates": { rates: [{ room: "studio", sgd: 210 }] },
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url);
    const tls = (req as unknown as { cf?: { tlsClientAuth?: Record<string, string> } }).cf?.tlsClientAuth ?? {};
    const mtls = {
      presented: tls.certPresented ?? null,
      verified: tls.certVerified ?? null,
      subject: tls.certSubjectDN ?? null,
      issuer: tls.certIssuerDN ?? null,
    };
    if (u.hostname === env.GW_HOST && mtls.verified !== "SUCCESS") {
      return Response.json({ gate: "mtls", ok: false, mtls }, { status: 403 });
    }

    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return Response.json({ gate: "jwt", ok: false, reason: "no token", mtls }, { status: 401 });
    jwks ??= createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
    let claims: Record<string, unknown>;
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: `${env.SUPABASE_URL}/auth/v1`, audience: "authenticated" });
      claims = { sub: payload.sub, role: payload.role, alg: decodeProtectedHeader(token).alg };
    } catch (e) {
      return Response.json({ gate: "jwt", ok: false, reason: String(e), mtls }, { status: 401 });
    }

    const accessJwt = req.headers.get("cf-access-jwt-assertion");
    const who = { host: u.hostname, mtls, claims, access: accessJwt ? "present" : null, colo: (req as unknown as { cf?: { colo?: string } }).cf?.colo ?? null };
    if (u.pathname === "/whoami") return Response.json({ ok: true, ...who });
    const data = PROCESS[u.pathname];
    if (!data) return Response.json({ ok: false, error: "no such process API" }, { status: 404 });
    return Response.json({ ok: true, ...who, data });
  },
};
