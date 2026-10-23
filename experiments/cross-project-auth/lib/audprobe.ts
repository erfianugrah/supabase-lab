/**
 * Shared pieces for X08 (audience mismatch) and X09 (the hub's OAuth 2.1
 * server): fixtures that let Storage and Realtime answer per tenant on both
 * projects, a probe matrix that presents one token to every surface, a custom
 * access token hook on the hub that rewrites `aud`, and the headless OAuth 2.1
 * code flow (the same steps as byo-oauth O03).
 *
 * The pair is lib/fanout.ts's: A (the hub) issues every token, B (the spoke)
 * trusts A through `oidc_issuer_url`. Tokens never leave this module's
 * callers in evidence: only decoded claim sets, with refs redacted.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { RtSock } from "../../third-party-auth/lib/rtws.js";
import { brief, codeOf, createTpa, listTpa, readAll, redact, rest, sleep, sql, until, type Pair, type Proj, type Rest } from "./fanout.js";

export const BUCKET = "xaud";
export const OBJ = "tenant-a/probe.txt";
export const TOPIC = "tenant:tenant-a";
export const HOOK_FN = "xaud_hook";
export const HOOK_URI = `pg-functions://postgres/public/${HOOK_FN}`;
export const SPOKE_AUD = "spoke-api";
export const REDIRECT = "http://localhost:54321/callback";
const objBody = (p: Proj) => `xaud-${p.role}`;

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export function decode(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [h, c] = token.split(".");
  const j = (s?: string) => {
    try {
      return JSON.parse(Buffer.from(s ?? "", "base64url").toString()) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  return { header: j(h), claims: j(c) };
}

/**
 * The claim set as evidence: every claim name, and the values that matter
 * here. `sub`, `session_id`, `kid` and `email` are reduced to "present";
 * `iss` keeps its shape with the ref redacted.
 */
export interface ClaimSet {
  [k: string]: string | number;
  alg: string;
  kid: string;
  iss: string;
  aud: string;
  role: string;
  client_id: string;
  scope: string;
  tenant_id: string;
  amr: string;
  aal: string;
  ttl_s: number;
  claim_names: string;
}

export function claimSet(token: string): ClaimSet {
  const { header, claims } = decode(token);
  const am = (claims.app_metadata ?? {}) as Record<string, unknown>;
  const amr = Array.isArray(claims.amr) ? (claims.amr as { method?: string }[]).map((x) => x.method).join("+") : "";
  return {
    alg: String(header.alg ?? ""),
    kid: header.kid ? "present" : "absent",
    iss: redact(String(claims.iss ?? "")),
    aud: JSON.stringify(claims.aud ?? null),
    role: String(claims.role ?? ""),
    client_id: claims.client_id ? "present" : "absent",
    scope: String(claims.scope ?? ""),
    tenant_id: String(am.tenant_id ?? ""),
    amr,
    aal: String(claims.aal ?? ""),
    ttl_s: Number(claims.exp ?? 0) - Number(claims.iat ?? 0),
    claim_names: Object.keys(claims).sort().join(","),
  };
}

// ---------------------------------------------------------------------------
// Fixtures: a private bucket and a private Realtime topic, per tenant claim
// ---------------------------------------------------------------------------

const FIXTURE_SQL = `
drop policy if exists xaud_read on storage.objects;
create policy xaud_read on storage.objects for select to authenticated
  using (bucket_id = '${BUCKET}' and (storage.foldername(name))[1] = (select auth.jwt() -> 'app_metadata' ->> 'tenant_id'));
drop policy if exists xaud_rt_read on realtime.messages;
create policy xaud_rt_read on realtime.messages for select to authenticated
  using (realtime.topic() = 'tenant:' || (select auth.jwt() -> 'app_metadata' ->> 'tenant_id'));
`;

async function storageReq(p: Proj, method: string, path: string, body?: string, contentType = "application/json"): Promise<Rest> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${p.url}/storage/v1${path}`, {
      method,
      headers: { apikey: p.service, Authorization: `Bearer ${p.service}`, "Content-Type": contentType },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, body: text, json, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { status: 0, body: String(e), ms: Math.round(performance.now() - t0) };
  }
}

export interface FixtureOut {
  sql: number;
  sqlTries: number;
  sqlFirstError: string;
  bucket: number;
  upload: number;
  warmJoin: string;
}

const fixtured = new Set<string>();

/** Policies, private bucket with one object under tenant-a/, and a public Realtime join (creates the messages partition). */
export async function ensureFixtures(ctx: Ctx, p: Proj): Promise<FixtureOut | null> {
  if (fixtured.has(p.ref)) return null;
  // Warm-up first: Storage and Realtime create their own objects on first use.
  const b = await storageReq(p, "POST", "/bucket", JSON.stringify({ id: BUCKET, name: BUCKET, public: false }));
  const u = await storageReq(p, "POST", `/object/${BUCKET}/${OBJ}`, objBody(p), "text/plain");
  const sock = new RtSock(p.host, p.anon);
  let warm = "socket did not open";
  if (await sock.open()) {
    const r = await sock.join("xaud-warmup", { private: false });
    warm = r.status;
  }
  sock.close();
  let s = await sql(ctx, p.ref, FIXTURE_SQL);
  const firstError = s.error ? redact(s.error).slice(0, 200) : "";
  let tries = 1;
  while (s.status >= 300 && tries < 6) {
    await sleep(5_000);
    s = await sql(ctx, p.ref, FIXTURE_SQL);
    tries++;
  }
  if (s.status >= 300) throw new Error(`fixture SQL on ${p.role} failed after ${tries} tries: ${redact(s.error ?? "")}`);
  fixtured.add(p.ref);
  return { sql: s.status, sqlTries: tries, sqlFirstError: firstError, bucket: b.status, upload: u.status, warmJoin: warm };
}

/** Trust on B: reuse X04's integration if one exists, else create it. */
export async function ensureTrust(ctx: Ctx, pair: Pair): Promise<{ created: number; existing: number }> {
  const have = await listTpa(ctx, pair.b.ref);
  if (have.length) return { created: 0, existing: have.length };
  const t = await createTpa(ctx, pair);
  pair.tpaId = t.id;
  return { created: t.status, existing: 0 };
}

// ---------------------------------------------------------------------------
// The probe matrix
// ---------------------------------------------------------------------------

export type Cell = { ok: boolean; text: string };

export async function probeRest(p: Proj, token: string): Promise<Cell> {
  const r = await readAll(p, token);
  if (r.status === 200 && Array.isArray(r.json)) {
    const ts = [...new Set((r.json as { tenant_id?: string }[]).map((x) => x.tenant_id))].sort().join(",");
    return { ok: true, text: `200 rows=${r.json.length} tenants=${ts || "none"}` };
  }
  return { ok: false, text: `${r.status} ${codeOf(r)} ${brief(String((r.json as { message?: string } | undefined)?.message ?? r.body), 90)}`.trim() };
}

export async function probeStorage(p: Proj, token: string): Promise<Cell> {
  const r = await rest(`${p.url}/storage/v1/object/authenticated/${BUCKET}/${OBJ}`, { apikey: p.anon, bearer: token });
  if (r.status === 200) return { ok: r.body === objBody(p), text: `200 body ${r.body === objBody(p) ? "matches" : "differs"}` };
  const j = (r.json ?? {}) as { statusCode?: string; error?: string; message?: string };
  return { ok: false, text: `${r.status} ${brief(`${j.statusCode ?? ""} ${j.error ?? ""} ${j.message ?? r.body}`, 120)}`.trim() };
}

export async function probeRealtime(p: Proj, token: string): Promise<Cell> {
  const sock = new RtSock(p.host, p.anon);
  try {
    if (!(await sock.open())) return { ok: false, text: `socket: ${sock.closedWhy}` };
    const r = await sock.join(TOPIC, { private: true }, token);
    return { ok: r.status === "ok", text: r.status === "ok" ? "join ok" : `join ${r.status}: ${brief(r.detail, 140)}` };
  } finally {
    sock.close();
  }
}

export async function probeAuthUser(p: Proj, token: string): Promise<Cell> {
  const r = await rest(`${p.url}/auth/v1/user`, { apikey: p.anon, bearer: token });
  const j = (r.json ?? {}) as { aud?: string; error_code?: string; msg?: string; message?: string };
  if (r.status === 200) return { ok: true, text: `200 user.aud=${j.aud ?? "?"}` };
  return { ok: false, text: `${r.status} ${j.error_code ?? ""} ${brief(String(j.msg ?? j.message ?? r.body), 90)}`.trim() };
}

export interface Matrix {
  a_rest: Cell;
  b_rest: Cell;
  a_storage: Cell;
  b_storage: Cell;
  a_realtime: Cell;
  b_realtime: Cell;
  a_auth_user: Cell;
}

export async function matrix(pair: Pair, token: string): Promise<Matrix> {
  return {
    a_rest: await probeRest(pair.a, token),
    b_rest: await probeRest(pair.b, token),
    a_storage: await probeStorage(pair.a, token),
    b_storage: await probeStorage(pair.b, token),
    a_realtime: await probeRealtime(pair.a, token),
    b_realtime: await probeRealtime(pair.b, token),
    a_auth_user: await probeAuthUser(pair.a, token),
  };
}

export const matrixMeasurements = (m: Matrix): Record<string, string> => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.text]));
export const matrixLine = (m: Matrix): string =>
  Object.entries(m)
    .map(([k, v]) => `${k}=${v.ok ? "ACCEPT" : "REFUSE"}`)
    .join(" ");

/** Wait until B accepts `token` on all three surfaces (the trust has to reach Storage and Realtime too). */
export async function awaitSpoke(pair: Pair, token: string, budgetMs = 120_000): Promise<{ restMs: number; storageMs: number; realtimeMs: number; last: string }> {
  const t0 = performance.now();
  const r = await until(() => readAll(pair.b, token), (x) => x.status === 200, budgetMs, 1000);
  const restMs = r.ms;
  let storageMs = -1;
  let realtimeMs = -1;
  let last = "";
  while (performance.now() - t0 < budgetMs && (storageMs < 0 || realtimeMs < 0)) {
    if (storageMs < 0) {
      const s = await probeStorage(pair.b, token);
      if (s.ok) storageMs = Math.round(performance.now() - t0);
      else last = `storage ${s.text}`;
    }
    if (realtimeMs < 0) {
      const q = await probeRealtime(pair.b, token);
      if (q.ok) realtimeMs = Math.round(performance.now() - t0);
      else last = `realtime ${q.text}`;
    }
    if (storageMs < 0 || realtimeMs < 0) await sleep(2000);
  }
  return { restMs, storageMs, realtimeMs, last };
}

// ---------------------------------------------------------------------------
// Users and tokens on the hub
// ---------------------------------------------------------------------------

export interface Minted {
  createStatus: number;
  createAud: string;
  createText: string;
  grantStatus: number;
  grantText: string;
  token: string;
  email: string;
  password: string;
}

export async function createUser(p: Proj, appMeta: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Omit<Minted, "grantStatus" | "grantText" | "token">> {
  const email = `xaud-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = `${crypto.randomUUID()}Aa1!`;
  let c: Rest | undefined;
  for (let i = 0; i < 8; i++) {
    c = await rest(`${p.url}/auth/v1/admin/users`, {
      apikey: p.service,
      method: "POST",
      body: { email, password, email_confirm: true, app_metadata: appMeta, ...extra },
    });
    if (c.status < 500) break;
    await sleep(5_000);
  }
  return {
    createStatus: c?.status ?? 0,
    createAud: String((c?.json as { aud?: string } | undefined)?.aud ?? ""),
    createText: c && c.status >= 300 ? brief(c.body, 200) : "",
    email,
    password,
  };
}

export async function passwordGrant(p: Proj, email: string, password: string): Promise<{ status: number; text: string; token: string }> {
  let s: Rest | undefined;
  for (let i = 0; i < 4; i++) {
    s = await rest(`${p.url}/auth/v1/token?grant_type=password`, { apikey: p.anon, method: "POST", body: { email, password } });
    if (s.status < 500 || i === 3) break;
    await sleep(3_000);
  }
  const token = (s?.json as { access_token?: string } | undefined)?.access_token ?? "";
  return { status: s?.status ?? 0, text: token ? "" : brief(s?.body ?? "", 240), token };
}

export async function mint(p: Proj, appMeta: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Minted> {
  const u = await createUser(p, appMeta, extra);
  if (u.createStatus >= 300) return { ...u, grantStatus: 0, grantText: "not attempted", token: "" };
  const g = await passwordGrant(p, u.email, u.password);
  return { ...u, grantStatus: g.status, grantText: g.text, token: g.token };
}

// ---------------------------------------------------------------------------
// The custom access token hook on the hub
// ---------------------------------------------------------------------------

/**
 * Rewrites `aud` from app_metadata.aud_override (any JSON value; the string
 * "__drop__" removes the claim). For a token that carries `client_id` (OAuth
 * 2.1 server issuance) with no per-user override, `aud` comes from the single
 * row of public.xaud_oauth_aud when that table has one.
 */
const HOOK_SQL = `
create table if not exists public.xaud_oauth_aud (aud jsonb not null);
revoke all on public.xaud_oauth_aud from anon, authenticated;
create or replace function public.${HOOK_FN}(event jsonb) returns jsonb
language plpgsql stable as $$
declare
  claims jsonb := event -> 'claims';
  ov jsonb := event -> 'claims' -> 'app_metadata' -> 'aud_override';
  oa jsonb;
begin
  if ov is not null then
    if ov = '"__drop__"'::jsonb then
      claims := claims - 'aud';
    else
      claims := jsonb_set(claims, '{aud}', ov);
    end if;
  elsif claims ? 'client_id' then
    select x.aud into oa from public.xaud_oauth_aud x limit 1;
    if oa is not null then
      claims := jsonb_set(claims, '{aud}', oa);
    end if;
  end if;
  return jsonb_build_object('claims', claims);
end $$;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.${HOOK_FN}(jsonb) to supabase_auth_admin;
grant select on public.xaud_oauth_aud to supabase_auth_admin;
revoke execute on function public.${HOOK_FN}(jsonb) from authenticated, anon, public;
`;

export interface HookOut {
  sql: number;
  sqlError: string;
  patch: number;
  patchText: string;
  liveMs: number;
  liveLast: string;
}

let hook: Promise<HookOut> | null = null;

/** Install and enable the hook once per process; wait until a string override shows in a fresh token. */
export function ensureHook(ctx: Ctx, a: Proj): Promise<HookOut> {
  if (!hook) hook = installHook(ctx, a);
  return hook;
}

async function installHook(ctx: Ctx, a: Proj): Promise<HookOut> {
  const s = await sql(ctx, a.ref, HOOK_SQL);
  const pt = await mgmt(ctx, "PATCH", `/projects/${a.ref}/config/auth`, {
    hook_custom_access_token_enabled: true,
    hook_custom_access_token_uri: HOOK_URI,
  });
  const probe = await createUser(a, { tenant_id: "tenant-a", aud_override: SPOKE_AUD });
  const t0 = performance.now();
  let liveMs = -1;
  let liveLast = "";
  while (performance.now() - t0 < 120_000) {
    const g = await passwordGrant(a, probe.email, probe.password);
    const aud = g.token ? decode(g.token).claims.aud : undefined;
    if (aud === SPOKE_AUD) {
      liveMs = Math.round(performance.now() - t0);
      break;
    }
    liveLast = g.token ? `aud=${JSON.stringify(aud)}` : `${g.status} ${g.text}`;
    await sleep(3000);
  }
  return { sql: s.status, sqlError: s.error ?? "", patch: pt.status, patchText: pt.status >= 300 ? brief(pt.text, 200) : "", liveMs, liveLast: brief(liveLast, 200) };
}

// ---------------------------------------------------------------------------
// OAuth 2.1 server: enable, register a client, headless code flow
// ---------------------------------------------------------------------------

async function raw(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

export async function discovery(a: Proj): Promise<{ status: number; grants: string; issuer: string; scopes: string; text: string }> {
  const r = await raw(`${a.url}/.well-known/oauth-authorization-server/auth/v1`);
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(r.text) as Record<string, unknown>;
  } catch {
    /* not json */
  }
  const list = (k: string) => (Array.isArray(j[k]) ? (j[k] as string[]).join(",") : String(j[k] ?? ""));
  return { status: r.status, grants: list("grant_types_supported"), issuer: redact(String(j.issuer ?? "")), scopes: list("scopes_supported"), text: r.status === 200 ? "" : brief(r.text, 160) };
}

/** Poll discovery until the enabled server answers 200 (the config change reaches Auth after the PATCH returns). */
export async function awaitOauthServer(a: Proj, budgetMs = 300_000): Promise<{ ms: number; polls: number; last: string }> {
  const t0 = performance.now();
  let polls = 0;
  let last = "";
  while (performance.now() - t0 < budgetMs) {
    polls++;
    const d = await discovery(a);
    if (d.status === 200) return { ms: Math.round(performance.now() - t0), polls, last };
    last = `${d.status} ${d.text}`;
    await sleep(5_000);
  }
  return { ms: -1, polls, last };
}

export interface Client {
  status: number;
  clientId: string;
  clientSecret: string;
  text: string;
}

export async function registerClient(a: Proj, name: string): Promise<Client> {
  const r = await rest(`${a.url}/auth/v1/admin/oauth/clients`, {
    apikey: a.service,
    method: "POST",
    body: { name, redirect_uris: [REDIRECT], client_type: "confidential" },
  });
  const j = (r.json ?? {}) as { client_id?: string; client_secret?: string };
  return { status: r.status, clientId: j.client_id ?? "", clientSecret: j.client_secret ?? "", text: r.status >= 300 ? brief(r.body, 200) : "" };
}

export interface Flow {
  authorizeStatus: number;
  consentStatus: number;
  tokenStatus: number;
  token: string;
  refresh: string;
  tokenType: string;
  responseScope: string;
  detail: string;
  /** How the code was obtained: consent POST, or returned by the GET for a prior consent. */
  consentPath: string;
}

/** authorize (PKCE) -> GET authorization (binds the user) -> consent approve -> token with client_secret_basic. */
export async function codeFlow(a: Proj, userToken: string, c: Client, scope = "openid email"): Promise<Flow> {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
    scope,
  });
  const hdr = { apikey: a.anon, Authorization: `Bearer ${userToken}` };
  const out: Flow = { authorizeStatus: 0, consentStatus: 0, tokenStatus: 0, token: "", refresh: "", tokenType: "", responseScope: "", detail: "", consentPath: "" };
  const az = await raw(`${a.url}/auth/v1/oauth/authorize?${q.toString()}`, { headers: hdr });
  out.authorizeStatus = az.status;
  const aid = /authorization_id=([A-Za-z0-9_-]+)/.exec(`${az.text} ${az.headers.get("location") ?? ""}`)?.[1];
  if (!aid) return { ...out, detail: `authorize ${az.status}: ${brief(az.text, 200)}` };
  // GET the authorization: binds the user, and for a user who already
  // consented to this client and scope it answers with the redirect (code)
  // instead of a pending request.
  const g = await raw(`${a.url}/auth/v1/oauth/authorizations/${aid}`, { headers: hdr });
  let code = /[?&]code=([A-Za-z0-9._~-]+)/.exec(g.text)?.[1];
  if (code) {
    out.consentPath = `skipped: GET authorization ${g.status} returned the code (prior consent)`;
  } else {
    const consent = await raw(`${a.url}/auth/v1/oauth/authorizations/${aid}/consent`, {
      method: "POST",
      headers: { ...hdr, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    out.consentStatus = consent.status;
    code = /[?&]code=([A-Za-z0-9._~-]+)/.exec(consent.text)?.[1];
    out.consentPath = `GET authorization ${g.status} (${brief(g.text.replace(/"(redirect_url|authorization_id|client_id)":"[^"]*"/g, '"$1":"<x>"').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"), 160)}); consent POST ${consent.status}`;
    if (!code) return { ...out, detail: `consent ${consent.status}: ${brief(consent.text, 200)}` };
  }
  const tok = await raw(`${a.url}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${c.clientId}:${c.clientSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: verifier }).toString(),
  });
  out.tokenStatus = tok.status;
  let j: { access_token?: string; refresh_token?: string; token_type?: string; scope?: string } = {};
  try {
    j = JSON.parse(tok.text);
  } catch {
    /* not json */
  }
  out.token = j.access_token ?? "";
  out.refresh = j.refresh_token ?? "";
  out.tokenType = j.token_type ?? "";
  out.responseScope = j.scope ?? "";
  if (!out.token) out.detail = `token ${tok.status}: ${brief(tok.text, 200)}`;
  return out;
}

/** Refresh an OAuth refresh token at a project's /oauth/token (client_secret_basic). */
export async function oauthRefresh(p: Proj, c: Client, refresh: string): Promise<{ status: number; text: string; token: string }> {
  const r = await raw(`${p.url}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${c.clientId}:${c.clientSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: c.clientId }).toString(),
  });
  let j: { access_token?: string } = {};
  try {
    j = JSON.parse(r.text);
  } catch {
    /* not json */
  }
  return { status: r.status, text: j.access_token ? "" : brief(r.text, 200), token: j.access_token ?? "" };
}

export async function setOauthAud(ctx: Ctx, a: Proj, aud: unknown | null): Promise<number> {
  const q = aud === null ? "delete from public.xaud_oauth_aud;" : `delete from public.xaud_oauth_aud; insert into public.xaud_oauth_aud values ('${JSON.stringify(aud)}'::jsonb);`;
  return (await sql(ctx, a.ref, q)).status;
}
