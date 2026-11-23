// tunnel-origin: local stand-in for a process API reachable only through a
// Cloudflare Tunnel (no inbound port). Listens on localhost:8787. Validates the
// forwarded Supabase user JWT against the project JWKS and reports whether
// Cloudflare Access put its assertion header on the request.
// Run from this directory (jose resolves from ./node_modules):
//   SUPABASE_URL=https://<ref>.supabase.co bun tunnel-origin.ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const jwks = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

Bun.serve({
  hostname: "127.0.0.1",
  port: 8787,
  async fetch(req) {
    const u = new URL(req.url);
    const access = req.headers.get("cf-access-jwt-assertion") ? "present" : null;
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return Response.json({ gate: "jwt", ok: false, access }, { status: 401 });
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: `${SUPABASE_URL}/auth/v1`, audience: "authenticated" });
      return Response.json({ ok: true, origin: "local-via-tunnel", path: u.pathname, access, sub: payload.sub });
    } catch (e) {
      return Response.json({ gate: "jwt", ok: false, reason: String(e), access }, { status: 401 });
    }
  },
});
console.log("tunnel-origin listening on 127.0.0.1:8787");
