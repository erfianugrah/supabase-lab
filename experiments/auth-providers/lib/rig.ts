/**
 * Shared rig for the auth-providers experiment: a self-provisioned throwaway
 * project, a lab OIDC issuer deployed as a Cloudflare Worker with a per-run
 * RS256 key, and the browser-flow helpers.
 *
 * Nothing here is held in OpenTofu state: every module creates what it needs
 * and deletes it in `finally`. Projects are named `au-*` so a sweep can
 * tell them apart from anything else in the org.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Ctx } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, type ProjectKeys } from "../../../harness/src/platform";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const SITE_URL = "http://localhost:3000/pvlab-callback";
export const REGION = "ap-southeast-1";
const WORKER_ENTRY = resolve(import.meta.dir, "../worker/issuer.ts");

export const b64url = (s: string | Uint8Array) =>
  Buffer.from(s).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

export function jwtPayload(token: string): Record<string, unknown> {
  try {
    const p = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- project --

export interface Rig {
  /** The suite ctx with ref / apiHost pointed at the throwaway project. */
  ctx: Ctx;
  ref: string;
  org: string;
  keys: ProjectKeys;
  /** Seconds from the create call to ACTIVE_HEALTHY. */
  provisionS: number;
}

export async function provisionProject(base: Ctx, org: string, tag: string, opts: { pro?: boolean } = {}): Promise<Rig> {
  const t0 = Date.now();
  const name = `au-${tag}-${t0.toString(36)}`;
  const create = await mgmt(base, "POST", "/projects", {
    organization_slug: org,
    name,
    db_pass: `${crypto.randomUUID()}Aa1!`,
    region: REGION,
    ...(opts.pro ? { desired_instance_size: "micro" } : {}),
  });
  const ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
  if (create.status !== 201 || !ref) throw new Error(`create: HTTP ${create.status}: ${create.text.slice(0, 300)}`);
  const ctx: Ctx = { ...base, ref, apiHost: `${ref}.${base.apiHostSuffix ?? "supabase.co"}`, phzHost: `db.${ref}.supabase.co` };
  let status = "";
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
    await sleep(10_000);
    const p = await mgmt(base, "GET", `/projects/${ref}`);
    status = ((p.json as { status?: string } | undefined)?.status ?? "") as string;
  }
  if (status !== "ACTIVE_HEALTHY") {
    await destroyProject(base, ref);
    throw new Error(`project not healthy: ${status}`);
  }
  // ACTIVE_HEALTHY does not mean the Auth server answers (key-rotation lesson).
  let keys: ProjectKeys | undefined;
  for (let i = 0; i < 12 && !keys; i++) {
    try {
      keys = await fetchKeys(ctx);
    } catch {
      await sleep(5_000);
    }
  }
  if (!keys?.secret || !keys.publishable) {
    await destroyProject(base, ref);
    throw new Error("sb_ keys absent from api-keys");
  }
  for (let i = 0; i < 24; i++) {
    const h = await fetch(`https://${ctx.apiHost}/auth/v1/settings`, { headers: { apikey: keys.publishable }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    if (h?.status === 200) break;
    await sleep(5_000);
  }
  return { ctx, ref, org, keys, provisionS: Math.round((Date.now() - t0) / 1000) };
}

export async function destroyProject(base: Ctx, ref: string): Promise<number> {
  if (!ref) return 0;
  const r = await mgmt(base, "DELETE", `/projects/${ref}`);
  return r.status;
}

/** PATCH /config/auth, then poll /auth/v1/settings until `ready(settings)`. */
export async function patchAuthConfig(
  rig: Rig,
  body: Record<string, unknown>,
  ready?: (settings: Record<string, unknown>) => boolean,
  budgetMs = 120_000,
): Promise<{ status: number; settled: boolean; settleS: number; text: string }> {
  const t0 = Date.now();
  const patch = await mgmt(rig.ctx, "PATCH", `/projects/${rig.ref}/config/auth`, body);
  if (patch.status >= 300) return { status: patch.status, settled: false, settleS: 0, text: patch.text.slice(0, 400) };
  if (!ready) return { status: patch.status, settled: true, settleS: 0, text: "" };
  while (Date.now() - t0 < budgetMs) {
    const s = await fetch(`https://${rig.ctx.apiHost}/auth/v1/settings`, { headers: { apikey: rig.keys.publishable! }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    const j = (await s?.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (j && ready(j)) return { status: patch.status, settled: true, settleS: Math.round((Date.now() - t0) / 1000), text: "" };
    await sleep(3_000);
  }
  return { status: patch.status, settled: false, settleS: Math.round((Date.now() - t0) / 1000), text: "settings never reported the change" };
}

// ------------------------------------------------------------- auth admin --

export interface Http {
  status: number;
  text: string;
  json?: any;
}

export async function authFetch(rig: Rig, method: string, path: string, opts: { key?: string; body?: unknown; bearer?: string } = {}): Promise<Http> {
  const key = opts.key ?? rig.keys.secret!;
  const res = await fetch(`https://${rig.ctx.apiHost}/auth/v1${path}`, {
    method,
    headers: {
      apikey: key,
      ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

/** Never throws; returns the Auth error code (`error_code` or `code`) of a failed response. */
export const errCode = (h: Http): string => String(h.json?.error_code ?? h.json?.code ?? h.json?.error ?? "");
export const errMsg = (h: Http): string => String(h.json?.msg ?? h.json?.message ?? h.json?.error_description ?? h.text).slice(0, 240);

export async function adminCreateUser(rig: Rig, email: string, password: string): Promise<string> {
  const r = await authFetch(rig, "POST", "/admin/users", { body: { email, password, email_confirm: true } });
  if (r.status >= 300) throw new Error(`admin create user: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.id as string;
}

// ----------------------------------------------------------- lab issuer ----

export interface Issuer {
  name: string;
  url: string;
  clientSecret: string;
  priv: JsonWebKey & { kid: string };
  pub: JsonWebKey & { kid: string };
}

export async function genKeypair(): Promise<{ priv: JsonWebKey & { kid: string }; pub: JsonWebKey & { kid: string } }> {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const kid = `pvlab-${crypto.randomUUID().slice(0, 8)}`;
  const priv = { ...(await crypto.subtle.exportKey("jwk", kp.privateKey)), kid, alg: "RS256", use: "sig" } as JsonWebKey & { kid: string };
  const pub = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid, alg: "RS256", use: "sig" } as JsonWebKey & { kid: string };
  return { priv, pub };
}

export async function mintIdToken(priv: JsonWebKey & { kid: string }, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", priv, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: priv.kid, ...header }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

async function wrangler(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["wrangler", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: o + e };
}

/**
 * Whether the lab issuer can be deployed: wrangler is on PATH and logged in.
 * Returns a skip reason, or undefined when ready. Call before provisioning
 * anything so a missing prerequisite becomes a `skip` row, not a failure.
 */
export async function issuerSkipReason(): Promise<string | undefined> {
  try {
    const w = await wrangler(["whoami"], tmpdir());
    if (w.code !== 0 || /not authenticated/i.test(w.out)) return "wrangler is not logged in to Cloudflare (wrangler login, or set CLOUDFLARE_API_TOKEN)";
    return undefined;
  } catch {
    return "wrangler not found on PATH (needed to deploy the lab issuer Worker)";
  }
}

/**
 * Deploy the lab issuer as `au-iss-<tag>` on workers.dev with a fresh
 * RS256 key. Returns once the discovery document answers. Throws when the
 * deploy fails; callers check issuerSkipReason() first to skip instead.
 */
export async function deployIssuer(tag: string): Promise<Issuer> {
  const { priv, pub } = await genKeypair();
  const clientSecret = `pvlab-${crypto.randomUUID()}`;
  const name = `au-iss-${tag}-${Date.now().toString(36)}`;
  const dir = await mkdtemp(join(tmpdir(), "au-iss-"));
  try {
    await writeFile(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({
        name,
        main: WORKER_ENTRY,
        compatibility_date: "2026-01-01",
        workers_dev: true,
        vars: { SIGNING_JWK: JSON.stringify(priv), PUBLIC_JWK: JSON.stringify(pub), CLIENT_SECRET: clientSecret },
      }),
    );
    const d = await wrangler(["deploy", "--config", join(dir, "wrangler.jsonc")], dir);
    const m = d.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/);
    if (d.code !== 0 || !m) throw new Error(`wrangler deploy failed (exit ${d.code}): ${d.out.replace(/\s+/g, " ").slice(-300)}`);
    const url = m[0];
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`${url}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      if (r?.status === 200) return { name, url, clientSecret, priv, pub };
      await sleep(2_000);
    }
    await deleteIssuer(name);
    throw new Error("issuer discovery never answered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function deleteIssuer(name: string): Promise<boolean> {
  if (!name) return true;
  const dir = await mkdtemp(join(tmpdir(), "au-del-"));
  try {
    const d = await wrangler(["delete", "--name", name, "--force"], dir);
    return d.code === 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------- browser-flow hops --

export interface Persona {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  aud?: string;
  omit_nonce?: boolean;
  claims?: Record<string, unknown>;
}

export interface FlowResult {
  /** Params the Auth server put on the issuer authorize redirect. */
  authorizeParams: Record<string, string>;
  authorizeStatus: number;
  callbackStatus: number;
  accessToken?: string;
  refreshToken?: string;
  userId?: string;
  email?: string;
  provider?: string;
  error?: string;
  errorCode?: string;
  errorDescription?: string;
  /** Where the flow stopped, when it never reached the Auth callback. */
  stage?: string;
}

/**
 * The OAuth browser flow with each redirect followed by hand:
 * Auth /authorize -> issuer /authorize (persona appended) -> Auth /callback ->
 * site_url with tokens in the fragment (implicit) or an error.
 */
export async function oauthFlow(rig: Rig, provider: string, persona: Persona): Promise<FlowResult> {
  const apikey = rig.keys.publishable!;
  const base = `https://${rig.ctx.apiHost}/auth/v1`;
  const empty: FlowResult = { authorizeParams: {}, authorizeStatus: -1, callbackStatus: -1 };
  const r1 = await fetch(`${base}/authorize?provider=${encodeURIComponent(provider)}&redirect_to=${encodeURIComponent(SITE_URL)}`, {
    headers: { apikey },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const issuerAuth = r1.headers.get("location");
  if (r1.status !== 302 || !issuerAuth) {
    const body = (await r1.text()).slice(0, 300);
    return { ...empty, authorizeStatus: r1.status, stage: "authorize", error: `authorize did not redirect: ${body}` };
  }
  const u = new URL(issuerAuth);
  const authorizeParams = Object.fromEntries(u.searchParams.entries());
  u.searchParams.set("persona", b64url(JSON.stringify(persona)));
  const r2 = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const callback = r2.headers.get("location");
  if (r2.status !== 302 || !callback) {
    return { ...empty, authorizeParams, authorizeStatus: r1.status, stage: "issuer", error: `issuer did not redirect: HTTP ${r2.status}` };
  }
  const r3 = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const landing = r3.headers.get("location");
  if (!landing) {
    const body = (await r3.text()).slice(0, 300);
    return { ...empty, authorizeParams, authorizeStatus: r1.status, callbackStatus: r3.status, stage: "callback", error: `callback did not redirect: ${body}` };
  }
  const l = new URL(landing);
  const frag = new URLSearchParams(l.hash.replace(/^#/, ""));
  const pick = (k: string) => frag.get(k) ?? l.searchParams.get(k) ?? undefined;
  const out: FlowResult = { authorizeParams, authorizeStatus: r1.status, callbackStatus: r3.status, stage: "landed" };
  const access = pick("access_token");
  if (access) {
    const p = jwtPayload(access);
    out.accessToken = access;
    out.refreshToken = pick("refresh_token");
    out.userId = typeof p.sub === "string" ? p.sub : undefined;
    out.email = typeof p.email === "string" ? p.email : undefined;
    out.provider = (p.app_metadata as { provider?: string } | undefined)?.provider;
  } else {
    out.error = pick("error");
    out.errorCode = pick("error_code");
    out.errorDescription = pick("error_description");
  }
  return out;
}

export const flowNote = (f: FlowResult): string =>
  f.userId ? `session for user ${f.userId.slice(0, 8)}... email="${f.email ?? ""}" provider=${f.provider ?? "?"}` : `no session: stage=${f.stage} error=${f.error ?? "-"} code=${f.errorCode ?? "-"} "${f.errorDescription ?? ""}"`;

/** A scalar for a `measurements` cell. */
export const cell = (v: unknown): string | number => (typeof v === "number" ? v : v === undefined || v === null || v === "" ? "-" : String(v));

/**
 * Create a custom provider, retrying while the Auth server cannot resolve the
 * issuer host. A workers.dev hostname deployed seconds ago was refused with
 * `validation_failed` "Unable to resolve hostname" by the Auth server's
 * resolver (AU03 run on 2026-10-10), so the first create is allowed to wait.
 * `waitedS` is that wait; it is a measurement, not a retry to hide.
 */
export async function createProviderWhenResolvable(rig: Rig, body: Record<string, unknown>, budgetMs = 180_000): Promise<Http & { waitedS: number; attempts: number }> {
  const t0 = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    const r = await authFetch(rig, "POST", "/admin/custom-providers", { body });
    const unresolved = r.status === 400 && /resolve|lookup|no such host/i.test(r.text);
    if (!unresolved || Date.now() - t0 > budgetMs) return { ...r, waitedS: Math.round((Date.now() - t0) / 1000), attempts };
    await sleep(5_000);
  }
}
