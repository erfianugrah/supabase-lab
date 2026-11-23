// relay: the Edge Function leg of the flow under test.
//
//   client -> front Worker (adds x-gw-secret, pins region) -> THIS -> upstream
//
// Checks, in order: the front-door secret header, then the caller's Supabase
// JWT (getClaims, module-scope client so the JWKS cache survives requests).
// Then runs the outbound arm(s) chosen by ?arm=:
//   probe          what the runtime exposes (Deno.createHttpClient, version)
//   headers        the headers this function received (shared-IP question)
//   mtls-ca        client.badssl.com: 400 without a cert, 200 with (CA-verified)
//   mtls-echo      certauth.idrix.fr: echoes the subject of our own CA's cert
//   jwt-upstream   Worker validating the forwarded user token against JWKS
//   gw             integration-gateway stand-in: mTLS (Cloudflare-managed CA)
//                  + JWT, two "process APIs"; no-cert and no-token cases
//   gw-new-client  same call, new HttpClient per request (latency contrast)
//   svc            gateway behind Cloudflare Access: with / without service token
//   proxy          createHttpClient({proxy}) at a dead proxy: must fail
//   env-proxy      plain fetch while an HTTPS_PROXY secret may be set: reports
//                  whether the secret is visible and whether fetch went direct
//   v1-cert        an X.509 v1 client cert: error, and the worker survives
//   explicit-ec    an EC key with explicit curve params: expected KeyMismatch
//
// verify_jwt is off for this function on purpose: the gateway check is a
// key-possession check (lab L07); the function does its own claims check.
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
const pem = (k: string) => env(k).replaceAll("\\n", "\n");
// deno-lint-ignore no-explicit-any
const D = Deno as any;

type Arm = { arm: string; ok: boolean; status?: number; ms: number; detail?: unknown; error?: string };

const mk = (certKey: string, keyKey: string, extra: Record<string, unknown> = {}) =>
  D.createHttpClient({ cert: pem(certKey), key: pem(keyKey), ...extra });

// Module scope: one per worker, reused across requests.
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"));
let gwClient: unknown;
const gw = () => (gwClient ??= mk("GW_CERT", "GW_KEY"));

async function timed(arm: string, fn: () => Promise<Omit<Arm, "arm" | "ms">>): Promise<Arm> {
  const t = performance.now();
  try {
    const r = await fn();
    return { arm, ms: Math.round(performance.now() - t), ...r };
  } catch (e) {
    return { arm, ok: false, ms: Math.round(performance.now() - t), error: String(e).slice(0, 300) };
  }
}

async function call(url: string, init: RequestInit & { client?: unknown }) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) } as RequestInit);
  const text = await r.text();
  let body: unknown = text.slice(0, 400);
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, body };
}

const arms: Record<string, (token: string, req: Request) => Promise<Arm>[]> = {
  probe: () => [
    timed("probe", async () => ({
      ok: true,
      detail: { createHttpClient: typeof D.createHttpClient, connectTls: typeof Deno.connectTls, denoVersion: Deno.version },
    })),
  ],
  headers: (_t, req) => [
    timed("headers", async () => {
      const pick = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "cf-worker", "cf-ipcountry", "x-region", "user-agent"];
      return { ok: true, detail: Object.fromEntries(pick.map((h) => [h, req.headers.get(h)])) };
    }),
  ],
  "mtls-ca": () => [
    timed("mtls-ca:no-cert", async () => {
      const r = await call("https://client.badssl.com/", {});
      return { ok: r.status === 400, status: r.status };
    }),
    timed("mtls-ca:with-cert", async () => {
      const r = await call("https://client.badssl.com/", { client: mk("BADSSL_CERT", "BADSSL_KEY") });
      return { ok: r.status === 200, status: r.status };
    }),
  ],
  "mtls-echo": () => [
    timed("mtls-echo:own-ca", async () => {
      const r = await call("https://certauth.idrix.fr/json/", { client: mk("CLIENT_CERT", "CLIENT_KEY") });
      const j = r.body as Record<string, string>;
      return {
        ok: j.SSL_CLIENT_S_DN === "CN=lab-edge-function-client-ec",
        status: r.status,
        detail: { subject: j.SSL_CLIENT_S_DN, issuer: j.SSL_CLIENT_I_DN, verify: j.SSL_CLIENT_VERIFY, proto: j.SSL_PROTOCOL, remote: j.REMOTE_ADDR },
      };
    }),
  ],
  "jwt-upstream": (token) => [
    timed("jwt-upstream:user-token", async () => {
      const r = await call(env("UPSTREAM_JWT_URL"), { headers: { authorization: `Bearer ${token}` } });
      return { ok: r.status === 200, status: r.status, detail: r.body };
    }),
    timed("jwt-upstream:no-token", async () => {
      const r = await call(env("UPSTREAM_JWT_URL"), {});
      return { ok: r.status === 401, status: r.status, detail: r.body };
    }),
  ],
  gw: (token) => [
    timed("gw:cert+jwt orders", async () => {
      const r = await call(`${env("GW_URL")}/process/orders`, { client: gw(), headers: { authorization: `Bearer ${token}` } });
      return { ok: r.status === 200, status: r.status, detail: r.body };
    }),
    timed("gw:cert+jwt rates", async () => {
      const r = await call(`${env("GW_URL")}/process/rates`, { client: gw(), headers: { authorization: `Bearer ${token}` } });
      return { ok: r.status === 200, status: r.status, detail: r.body };
    }),
    timed("gw:cert, no jwt", async () => {
      const r = await call(`${env("GW_URL")}/process/orders`, { client: gw() });
      return { ok: r.status === 401, status: r.status, detail: r.body };
    }),
    timed("gw:jwt, no cert", async () => {
      const r = await call(`${env("GW_URL")}/process/orders`, { headers: { authorization: `Bearer ${token}` } });
      return { ok: r.status === 403, status: r.status, detail: r.body };
    }),
    timed("gw:wrong-CA cert", async () => {
      const r = await call(`${env("GW_URL")}/process/orders`, { client: mk("CLIENT_CERT", "CLIENT_KEY"), headers: { authorization: `Bearer ${token}` } });
      return { ok: r.status === 403, status: r.status, detail: r.body };
    }),
  ],
  "gw-reuse": (token) => [
    timed("gw-reuse", async () => {
      const r = await call(`${env("GW_URL")}/process/orders`, { client: gw(), headers: { authorization: `Bearer ${token}` } });
      return { ok: r.status === 200, status: r.status };
    }),
  ],
  "gw-new-client": (token) => [
    timed("gw-new-client", async () => {
      const r = await call(`${env("GW_URL")}/process/orders`, { client: mk("GW_CERT", "GW_KEY"), headers: { authorization: `Bearer ${token}` } });
      return { ok: r.status === 200, status: r.status };
    }),
  ],
  svc: (token) => [
    timed("svc:token+jwt", async () => {
      const r = await call(`${env("SVC_URL")}/process/rates`, {
        headers: { authorization: `Bearer ${token}`, "CF-Access-Client-Id": env("SVC_ID"), "CF-Access-Client-Secret": env("SVC_SECRET") },
        redirect: "manual",
      });
      return { ok: r.status === 200, status: r.status, detail: r.body };
    }),
    timed("svc:no token", async () => {
      const r = await call(`${env("SVC_URL")}/process/rates`, { headers: { authorization: `Bearer ${token}` }, redirect: "manual" });
      return { ok: r.status !== 200, status: r.status, detail: typeof r.body === "string" ? r.body.slice(0, 120) : r.body };
    }),
  ],
  proxy: () => [
    timed("proxy:dead proxy via createHttpClient", async () => {
      const client = D.createHttpClient({ proxy: { url: "http://127.0.0.1:9" } });
      const r = await call("https://example.com/", { client });
      return { ok: false, status: r.status, detail: "request succeeded: proxy option ignored" };
    }).then((a) => ({ ...a, ok: !!a.error })),
  ],
  "env-proxy": () => [
    timed("env-proxy:plain fetch", async () => {
      const visible = env("HTTPS_PROXY");
      const r = await call("https://example.com/", {});
      return { ok: r.status === 200, status: r.status, detail: { httpsProxySecretVisible: visible || null } };
    }),
  ],
  "v1-cert": () => [
    timed("v1-cert", async () => {
      const r = await call("https://client.badssl.com/", { client: mk("V1_CERT", "V1_KEY") });
      return { ok: false, status: r.status, detail: "v1 cert accepted" };
    }).then((a) => ({ ...a, ok: !!a.error })),
  ],
  "explicit-ec": () => [
    timed("explicit-ec", async () => {
      const r = await call("https://certauth.idrix.fr/json/", { client: mk("EXPLICIT_CERT", "EXPLICIT_KEY") });
      return { ok: false, status: r.status, detail: "explicit-params EC key accepted" };
    }).then((a) => ({ ...a, ok: !!a.error })),
  ],
};
arms.all = (t, r) => [...arms.probe(t, r), ...arms["mtls-ca"](t, r), ...arms["mtls-echo"](t, r), ...arms["jwt-upstream"](t, r)];

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const base = { region: env("SB_REGION") || null, method: req.method };

  if (!env("FRONT_SECRET") || req.headers.get("x-gw-secret") !== env("FRONT_SECRET")) {
    return Response.json({ ...base, gate: "front-secret", ok: false }, { status: 403 });
  }

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data, error } = await sb.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    return Response.json({ ...base, gate: "jwt", ok: false, error: error?.message ?? "no sub" }, { status: 401 });
  }
  const c = data.claims as Record<string, unknown>;
  const header = (data as unknown as { header?: Record<string, unknown> }).header ?? null;

  const arm = url.searchParams.get("arm") ?? "probe";
  const run = arms[arm];
  if (!run) return Response.json({ ...base, error: `unknown arm ${arm}` }, { status: 400 });
  const results = await Promise.all(run(token, req));
  return Response.json({
    ...base,
    gate: "passed",
    claims: { sub: c.sub, role: c.role, iss: c.iss, alg: header?.alg ?? null, kid: header?.kid ?? null },
    results,
  });
});
