/**
 * Operator-run key service (stand-in for a KMS or HSM; runs in Docker, never
 * on Supabase). Holds one KEK per tenant and exposes exactly two calls:
 *
 *   POST /wrap    {tenant_id, dek}      -> {wrapped, key_id}
 *   POST /unwrap  {tenant_id, wrapped}  -> {dek}
 *
 * Both need `Authorization: Bearer <Supabase access token>`. The token is
 * verified against the JWKS of the tenant's home target (issuer pinned per
 * target, audience `authenticated`), then membership is checked through that
 * target's Data API with the caller's own token, so RLS decides.
 * `unwrap` additionally needs no particular role (viewers read); `wrap` needs
 * owner or editor. This is the only place a DEK is ever unwrapped.
 *
 * Wrapping: AES-256-GCM under the tenant KEK, AAD = "ck-dek-v1|<tenant_id>",
 * wrapped = base64(nonce(12) || ciphertext+tag). key_id = "<kek label>".
 *
 * Config (mounted read-only, written per run, gitignored):
 *   /config/config.json  {targets: {name: {issuer, auth_url, jwks_url, rest_url, apikey}},
 *                         tenants: {tenant_id: target_name}}
 *   /config/keks.json    {tenant_id: {key_id, kek_b64}}
 * Re-read on every request, so a run can add tenants without a restart.
 *
 * Typed errors: {error: <code>, message}. 400 bad_request, 401 invalid_token,
 * 403 not_member / forbidden_role, 404 unknown_tenant, 409 unwrap_failed,
 * 502 membership_check_failed.
 */
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { readFileSync } from "node:fs";

interface TargetCfg {
  /** Expected `iss` claim (may name a host this container cannot reach). */
  issuer: string;
  /** Auth base URL as reachable from this container (.../auth/v1). */
  auth_url: string;
  jwks_url: string;
  rest_url: string;
  apikey: string;
}
interface Cfg {
  targets: Record<string, TargetCfg>;
  tenants: Record<string, string>;
}
type Keks = Record<string, { key_id: string; kek_b64: string }>;

const CONFIG_DIR = process.env.KEYSVC_CONFIG_DIR ?? "/config";
const PORT = Number(process.env.PORT ?? 8790);
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const counters = { wrap: 0, unwrap: 0, denied: 0 };

const load = <T>(f: string): T => JSON.parse(readFileSync(`${CONFIG_DIR}/${f}`, "utf8")) as T;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });
}
const fail = (status: number, error: string, message: string) => {
  if (status === 401 || status === 403) counters.denied++;
  return json(status, { error, message });
};

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    msg: string,
  ) {
    super(msg);
  }
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

async function kekFor(tenant: string): Promise<{ key: CryptoKey; key_id: string }> {
  const k = load<Keks>("keks.json")[tenant];
  if (!k) throw new HttpError(404, "unknown_tenant", "no KEK for tenant");
  const key = await crypto.subtle.importKey("raw", unb64(k.kek_b64), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, key_id: k.key_id };
}

/** Verify the bearer token for this tenant's home target; returns the user id and verification path. */
async function authorize(req: Request, tenant: string, roles: string[] | null): Promise<{ sub: string; alg: string }> {
  const cfg = load<Cfg>("config.json");
  const targetName = cfg.tenants[tenant];
  if (!targetName) throw new HttpError(404, "unknown_tenant", "tenant not in directory");
  const t = cfg.targets[targetName];
  if (!t) throw new HttpError(404, "unknown_tenant", "tenant's target not configured");
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new HttpError(401, "invalid_token", "missing bearer token");
  let alg = "";
  try {
    alg = String(decodeProtectedHeader(token).alg ?? "");
  } catch {
    throw new HttpError(401, "invalid_token", "malformed token");
  }
  let sub = "";
  if (alg === "HS256") {
    // Symmetric tokens cannot be verified from a JWKS; ask the issuing Auth server.
    const r = await fetch(`${t.auth_url}/user`, { headers: { apikey: t.apikey, authorization: `Bearer ${token}` } });
    if (r.status !== 200) throw new HttpError(401, "invalid_token", `auth server answered ${r.status}`);
    sub = String(((await r.json()) as { id?: string }).id ?? "");
  } else {
    let set = jwks.get(t.jwks_url);
    if (!set) {
      set = createRemoteJWKSet(new URL(t.jwks_url), { cooldownDuration: 5_000 });
      jwks.set(t.jwks_url, set);
    }
    try {
      const { payload } = await jwtVerify(token, set, { issuer: t.issuer, audience: "authenticated" });
      sub = String(payload.sub ?? "");
    } catch (e) {
      throw new HttpError(401, "invalid_token", String((e as Error).message).slice(0, 120));
    }
  }
  if (!sub) throw new HttpError(401, "invalid_token", "token has no subject");
  // Membership through the Data API with the caller's token: RLS decides.
  const url = `${t.rest_url}/memberships?select=role&tenant_id=eq.${tenant}&user_id=eq.${sub}`;
  const r = await fetch(url, { headers: { apikey: t.apikey, authorization: `Bearer ${token}`, "accept-profile": "app" } });
  if (r.status !== 200) throw new HttpError(502, "membership_check_failed", `data api answered ${r.status}`);
  const rows = (await r.json()) as { role: string }[];
  if (!rows.length) throw new HttpError(403, "not_member", "caller is not a member of the tenant");
  if (roles && !roles.includes(rows[0]!.role)) throw new HttpError(403, "forbidden_role", `role ${rows[0]!.role} may not wrap`);
  return { sub, alg };
}

const aad = (tenant: string) => new TextEncoder().encode(`ck-dek-v1|${tenant}`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function handle(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method === "GET" && path === "/health") return json(200, { ok: true, ...counters });
  if (req.method !== "POST" || (path !== "/wrap" && path !== "/unwrap")) return fail(404, "not_found", "no such route");
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "bad_request", "body is not JSON");
  }
  const tenant = String(body.tenant_id ?? "");
  if (!UUID.test(tenant)) return fail(400, "bad_request", "tenant_id must be a uuid");
  try {
    if (path === "/wrap") {
      const dek = unb64(String(body.dek ?? ""));
      if (dek.length !== 32) return fail(400, "bad_request", "dek must be 32 bytes, base64");
      await authorize(req, tenant, ["owner", "editor"]);
      const { key, key_id } = await kekFor(tenant);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(tenant) }, key, dek));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      counters.wrap++;
      return json(200, { wrapped: b64(out), key_id });
    }
    const wrapped = unb64(String(body.wrapped ?? ""));
    if (wrapped.length !== 12 + 32 + 16) return fail(400, "bad_request", "wrapped has the wrong length");
    await authorize(req, tenant, null);
    const { key } = await kekFor(tenant);
    let dek: Uint8Array;
    try {
      dek = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapped.subarray(0, 12), additionalData: aad(tenant) }, key, wrapped.subarray(12)),
      );
    } catch {
      return fail(409, "unwrap_failed", "wrapped key does not authenticate under this tenant's KEK");
    }
    counters.unwrap++;
    return json(200, { dek: b64(dek) });
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message);
    return fail(500, "internal", String((e as Error).message).slice(0, 120));
  }
}

Bun.serve({ port: PORT, hostname: "0.0.0.0", fetch: handle });
console.log(`keysvc listening on ${PORT}`);
