// relay: the Edge Function leg of the flow under test.
//
//   client -> front Worker (adds x-gw-secret, pins region) -> THIS -> upstream
//
// Checks, in order: the front-door secret header, then the caller's Supabase
// JWT (getClaims). Then runs one outbound arm chosen by ?arm=:
//   probe        what the runtime exposes (Deno.createHttpClient, SB_REGION)
//   mtls-ca      client.badssl.com with its public client cert (CA-verified mTLS;
//                400 without a cert, 200 with) - run with and without the cert
//   mtls-echo    certauth.idrix.fr with our own CA's client cert (echoes the
//                subject the server received)
//   jwt-upstream the JWT-validating upstream Worker, user token forwarded
//   all          every arm above
//
// verify_jwt is off for this function on purpose: the gateway check is a
// key-possession check (lab L07); the function does its own claims check.
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
const pem = (k: string) => env(k).replaceAll("\\n", "\n");

type Arm = { arm: string; ok: boolean; status?: number; ms: number; detail?: unknown; error?: string };

function client(certKey: string, keyKey: string) {
  const cert = pem(certKey);
  const key = pem(keyKey);
  // Newer Deno takes cert/key; older took certChain/privateKey. Pass both so a
  // failure here is about mTLS, not the option name.
  // deno-lint-ignore no-explicit-any
  return (Deno as any).createHttpClient({ cert, key, certChain: cert, privateKey: key });
}

async function timed(arm: string, fn: () => Promise<Omit<Arm, "arm" | "ms">>): Promise<Arm> {
  const t = performance.now();
  try {
    const r = await fn();
    return { arm, ms: Math.round(performance.now() - t), ...r };
  } catch (e) {
    return { arm, ok: false, ms: Math.round(performance.now() - t), error: String(e) };
  }
}

const arms: Record<string, (token: string) => Promise<Arm>[]> = {
  probe: () => [
    timed("probe", async () => ({
      ok: true,
      detail: {
        createHttpClient: typeof (Deno as unknown as Record<string, unknown>).createHttpClient,
        connectTls: typeof Deno.connectTls,
        denoVersion: Deno.version,
      },
    })),
  ],
  "mtls-ca": () => [
    timed("mtls-ca:no-cert", async () => {
      const r = await fetch("https://client.badssl.com/");
      await r.body?.cancel();
      return { ok: r.status === 400, status: r.status };
    }),
    timed("mtls-ca:with-cert", async () => {
      const r = await fetch("https://client.badssl.com/", { client: client("BADSSL_CERT", "BADSSL_KEY") } as RequestInit);
      await r.body?.cancel();
      return { ok: r.status === 200, status: r.status };
    }),
  ],
  "mtls-echo": () => [
    timed("mtls-echo:own-ca", async () => {
      const r = await fetch("https://certauth.idrix.fr/json/", { client: client("CLIENT_CERT", "CLIENT_KEY") } as RequestInit);
      const j = await r.json();
      return {
        ok: j.SSL_CLIENT_S_DN === "CN=lab-edge-function-client-ec",
        status: r.status,
        detail: { subject: j.SSL_CLIENT_S_DN, issuer: j.SSL_CLIENT_I_DN, verify: j.SSL_CLIENT_VERIFY, proto: j.SSL_PROTOCOL, remote: j.REMOTE_ADDR },
      };
    }),
  ],
  "jwt-upstream": (token) => [
    timed("jwt-upstream:user-token", async () => {
      const r = await fetch(env("UPSTREAM_JWT_URL"), { headers: { authorization: `Bearer ${token}` } });
      return { ok: r.status === 200, status: r.status, detail: await r.json() };
    }),
    timed("jwt-upstream:no-token", async () => {
      const r = await fetch(env("UPSTREAM_JWT_URL"));
      return { ok: r.status === 401, status: r.status, detail: await r.json() };
    }),
  ],
};
arms.all = (t) => [...arms.probe(t), ...arms["mtls-ca"](t), ...arms["mtls-echo"](t), ...arms["jwt-upstream"](t)];

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const region = env("SB_REGION") || null;
  const base = { region, method: req.method };

  if (req.headers.get("x-gw-secret") !== env("FRONT_SECRET") || !env("FRONT_SECRET")) {
    return Response.json({ ...base, gate: "front-secret", ok: false }, { status: 403 });
  }

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"));
  const { data, error } = await sb.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    return Response.json({ ...base, gate: "jwt", ok: false, error: error?.message ?? "no sub" }, { status: 401 });
  }
  const c = data.claims as Record<string, unknown>;
  const header = (data as unknown as { header?: Record<string, unknown> }).header ?? null;

  const arm = url.searchParams.get("arm") ?? "probe";
  const run = arms[arm];
  if (!run) return Response.json({ ...base, error: `unknown arm ${arm}` }, { status: 400 });
  const results = await Promise.all(run(token));
  return Response.json({
    ...base,
    gate: "passed",
    claims: { sub: c.sub, role: c.role, iss: c.iss, alg: header?.alg ?? null, kid: header?.kid ?? null },
    results,
  });
});
