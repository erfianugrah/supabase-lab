/**
 * Vendor API helpers for the fixture, `make cleanup` and modules that create
 * their own databases (TD01). Every create, delete and leftover listing goes
 * through `assertSec` / `secOnly`: the Cloudflare account is shared with
 * production Workers, D1 databases and Hyperdrive configs, and the Supabase and
 * Turso orgs hold other work, so nothing whose name lacks the `sec-` prefix is
 * ever touched. Deletes by id read the resource's NAME first and refuse a
 * non-`sec-` one.
 *
 * Credentials come from the environment (injected per command by sx), are
 * sent as request headers from this process, and never reach an argv.
 *   Cloudflare: CLOUDFLARE_EMAIL, CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID
 *   Turso:      TURSO_API_TOKEN, org slug in PVLAB_TURSO_ORG (or PVLAB_ORG_TURSO)
 *   Supabase:   the harness Ctx (SUPABASE_ACCESS_TOKEN), org in ctx.orgs.pro
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";
import { PREFIX } from "./contract";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function assertSec(name: string | undefined | null): string {
  if (!name || !name.startsWith(PREFIX)) throw new Error(`refusing to touch a resource not named ${PREFIX}* (got ${JSON.stringify(name ?? null)})`);
  return name;
}

export function secOnly<T>(items: readonly T[], nameOf: (x: T) => string | undefined | null): T[] {
  return items.filter((x) => {
    const n = nameOf(x);
    return typeof n === "string" && n.startsWith(PREFIX);
  });
}

/** A 404 (or Turso/Cloudflare "not found" body) on delete means already gone. */
export function goneOk(status: number): boolean {
  return status === 404 || (status >= 200 && status < 300);
}

/* ------------------------------- Cloudflare ------------------------------ */

export interface CfCreds {
  email: string;
  key: string;
  account: string;
}

export function cfCreds(env: Record<string, string | undefined> = process.env): CfCreds | null {
  const email = env.CLOUDFLARE_EMAIL;
  const key = env.CLOUDFLARE_API_KEY;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  return email && key && account ? { email, key, account } : null;
}

export interface CfResponse<T = unknown> {
  status: number;
  success: boolean;
  result: T;
  errors: { code?: number; message?: string }[];
  resultInfo?: { page?: number; per_page?: number; total_pages?: number; count?: number; total_count?: number };
  text: string;
}

/** Account-scoped Cloudflare REST call; `path` is relative to /accounts/{id}/. */
export async function cf<T = unknown>(c: CfCreds, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<CfResponse<T>> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.account}/${path}`, {
    method,
    headers: {
      "X-Auth-Email": c.email,
      "X-Auth-Key": c.key,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let j: { success?: boolean; result?: T; errors?: CfResponse["errors"]; result_info?: CfResponse["resultInfo"] } = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* non-JSON body: keep text */
  }
  return { status: res.status, success: !!j.success, result: j.result as T, errors: j.errors ?? [], resultInfo: j.result_info, text: text.slice(0, 2000) };
}

export const cfErr = (r: CfResponse) => `HTTP ${r.status} ${r.errors.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ") || r.text.slice(0, 300)}`;

export interface Named {
  name: string;
  id: string;
}

export async function listD1(c: CfCreds): Promise<Named[]> {
  const out: Named[] = [];
  for (let page = 1; page < 100; page++) {
    const r = await cf<{ uuid: string; name: string }[]>(c, "GET", `d1/database?per_page=100&page=${page}`);
    if (!r.success) throw new Error(`list D1: ${cfErr(r)}`);
    out.push(...(r.result ?? []).map((d) => ({ name: d.name, id: d.uuid })));
    if ((r.result ?? []).length < 100) break;
  }
  return out;
}

export async function listHyperdrive(c: CfCreds): Promise<Named[]> {
  const r = await cf<{ id: string; name: string }[]>(c, "GET", "hyperdrive/configs");
  if (!r.success) throw new Error(`list Hyperdrive: ${cfErr(r)}`);
  return (r.result ?? []).map((h) => ({ name: h.name, id: h.id }));
}

export async function listWorkers(c: CfCreds): Promise<Named[]> {
  const r = await cf<{ id: string }[]>(c, "GET", "workers/scripts");
  if (!r.success) throw new Error(`list Workers: ${cfErr(r)}`);
  return (r.result ?? []).map((w) => ({ name: w.id, id: w.id }));
}

export async function createD1(c: CfCreds, name: string, locationHint: string): Promise<{ id: string; raw: Record<string, unknown> }> {
  assertSec(name);
  const r = await cf<Record<string, unknown>>(c, "POST", "d1/database", { name, primary_location_hint: locationHint });
  if (!r.success) throw new Error(`create D1 ${name}: ${cfErr(r)}`);
  return { id: String(r.result.uuid ?? ""), raw: r.result };
}

/** GET the database, refuse a non-sec- name, then DELETE. Returns the HTTP status (404 = already gone). */
export async function deleteD1(c: CfCreds, id: string): Promise<number> {
  const g = await cf<{ name?: string }>(c, "GET", `d1/database/${id}`);
  if (g.status === 404 || (!g.success && /not found|7404/i.test(g.text))) return 404;
  if (!g.success) throw new Error(`read D1 before delete: ${cfErr(g)}`);
  assertSec(g.result?.name);
  const d = await cf(c, "DELETE", `d1/database/${id}`);
  return d.success ? 200 : d.status;
}

export interface HyperdriveOrigin {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export async function createHyperdrive(c: CfCreds, name: string, origin: HyperdriveOrigin, cachingDisabled: boolean): Promise<{ id: string } | { error: string }> {
  assertSec(name);
  const r = await cf<{ id?: string }>(c, "POST", "hyperdrive/configs", {
    name,
    origin: { ...origin, scheme: "postgres" },
    caching: { disabled: cachingDisabled },
  }, 90_000);
  if (!r.success || !r.result?.id) return { error: cfErr(r) };
  return { id: r.result.id };
}

export async function deleteHyperdrive(c: CfCreds, id: string): Promise<number> {
  const g = await cf<{ name?: string }>(c, "GET", `hyperdrive/configs/${id}`);
  if (g.status === 404) return 404;
  if (!g.success) throw new Error(`read Hyperdrive before delete: ${cfErr(g)}`);
  assertSec(g.result?.name);
  const d = await cf(c, "DELETE", `hyperdrive/configs/${id}`);
  return d.success ? 200 : d.status;
}

export async function deleteWorker(c: CfCreds, name: string): Promise<number> {
  assertSec(name);
  const d = await cf(c, "DELETE", `workers/scripts/${encodeURIComponent(name)}?force=true`);
  if (d.status === 404 || (!d.success && /10007|not found/i.test(d.text))) return 404;
  return d.success ? 200 : d.status;
}

export async function workersSubdomain(c: CfCreds): Promise<string> {
  const r = await cf<{ subdomain?: string }>(c, "GET", "workers/subdomain");
  if (!r.success || !r.result?.subdomain) throw new Error(`workers.dev subdomain: ${cfErr(r)}`);
  return r.result.subdomain;
}

/** D1 REST query endpoint (the admin path, not an app path). */
export async function d1Rest(c: CfCreds, id: string, sql: string, params: unknown[] = []): Promise<CfResponse<{ results?: unknown[]; success?: boolean; meta?: Record<string, unknown> }[]>> {
  return cf(c, "POST", `d1/database/${id}/query`, { sql, params });
}

/* --------------------------------- Turso -------------------------------- */

export interface TursoCreds {
  token: string;
  org: string;
}

export function tursoCreds(env: Record<string, string | undefined> = process.env): TursoCreds | null {
  const token = env.TURSO_API_TOKEN;
  const org = env.PVLAB_TURSO_ORG || env.PVLAB_ORG_TURSO;
  return token && org ? { token, org } : null;
}

export interface TursoResponse<T = Record<string, unknown>> {
  status: number;
  json: T;
  text: string;
}

/** Org-scoped Turso Platform API call; `path` is relative to /v1/organizations/{org}/. */
export async function turso<T = Record<string, unknown>>(t: TursoCreds, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<TursoResponse<T>> {
  const res = await fetch(`https://api.turso.tech/v1/organizations/${t.org}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${t.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = {} as T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    /* keep text */
  }
  return { status: res.status, json, text: text.slice(0, 2000) };
}

export async function listTurso(t: TursoCreds): Promise<{ groups: string[]; databases: { name: string; group: string; hostname: string }[] }> {
  const g = await turso<{ groups?: { name: string }[] }>(t, "GET", "groups");
  const d = await turso<{ databases?: { Name: string; group?: string; Hostname?: string }[] }>(t, "GET", "databases");
  if (g.status !== 200) throw new Error(`list Turso groups: HTTP ${g.status} ${g.text.slice(0, 200)}`);
  if (d.status !== 200) throw new Error(`list Turso databases: HTTP ${d.status} ${d.text.slice(0, 200)}`);
  return {
    groups: (g.json.groups ?? []).map((x) => x.name),
    databases: (d.json.databases ?? []).map((x) => ({ name: x.Name, group: x.group ?? "", hostname: x.Hostname ?? "" })),
  };
}

export async function createTursoGroup(t: TursoCreds, name: string, location: string): Promise<"created" | "exists"> {
  assertSec(name);
  const r = await turso(t, "POST", "groups", { name, location });
  if (r.status === 200 || r.status === 201) return "created";
  if (r.status === 409 || /already exists/i.test(r.text)) return "exists";
  throw new Error(`create Turso group ${name}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
}

/** `useTursodb` sends the field turso-cli sends for `db create --tursodb` (not in the API reference). */
export async function createTursoDb(t: TursoCreds, name: string, group: string, useTursodb = false): Promise<{ hostname: string; dbId: string }> {
  assertSec(name);
  assertSec(group);
  const r = await turso<{ database?: { Hostname?: string; DbId?: string } }>(t, "POST", "databases", useTursodb ? { name, group, use_tursodb: true } : { name, group });
  if ((r.status !== 200 && r.status !== 201) || !r.json.database?.Hostname) throw new Error(`create Turso db ${name}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return { hostname: r.json.database.Hostname, dbId: r.json.database.DbId ?? "" };
}

/** Database auth token (JWT). Default: full access, 7-day expiry. */
export async function tursoDbToken(t: TursoCreds, name: string, expiration = "7d", authorization: "full-access" | "read-only" = "full-access"): Promise<string> {
  assertSec(name);
  const r = await turso<{ jwt?: string }>(t, "POST", `databases/${encodeURIComponent(name)}/auth/tokens?expiration=${expiration}&authorization=${authorization}`);
  if (!r.json.jwt) throw new Error(`Turso db token for ${name}: HTTP ${r.status} ${r.text.slice(0, 200).replace(/ey[A-Za-z0-9_-]{10,}\.[^\s"]*/g, "<jwt>")}`);
  return r.json.jwt;
}

export async function deleteTursoDb(t: TursoCreds, name: string): Promise<number> {
  assertSec(name);
  const r = await turso(t, "DELETE", `databases/${encodeURIComponent(name)}`);
  return r.status === 404 || /not found/i.test(r.text) ? 404 : r.status;
}

export async function deleteTursoGroup(t: TursoCreds, name: string): Promise<number> {
  assertSec(name);
  const r = await turso(t, "DELETE", `groups/${encodeURIComponent(name)}`);
  return r.status === 404 || /not found/i.test(r.text) ? 404 : r.status;
}

/* -------------------------------- Supabase ------------------------------- */

export interface SbProject {
  ref: string;
  name: string;
  org: string;
  status: string;
  region: string;
}

export async function listSbProjects(ctx: Ctx): Promise<SbProject[]> {
  const r = await mgmt(ctx, "GET", "/projects");
  if (!Array.isArray(r.json)) throw new Error(`list projects: HTTP ${r.status}${r.throttled ? " (throttled)" : ""}`);
  return (r.json as Record<string, unknown>[]).map((p) => ({
    ref: String(p.ref ?? p.id ?? ""),
    name: String(p.name ?? ""),
    org: String(p.organization_slug ?? p.organization_id ?? ""),
    status: String(p.status ?? ""),
    region: String(p.region ?? ""),
  }));
}

/** sec- projects in the given org only. */
export async function listSecProjects(ctx: Ctx, org: string): Promise<SbProject[]> {
  return secOnly(await listSbProjects(ctx), (p) => p.name).filter((p) => p.org === org);
}

/** Read the project's name, refuse a non-sec- one, then delete (retrying through 429). */
export async function deleteSbProject(ctx: Ctx, ref: string): Promise<number> {
  const g = await mgmt(ctx, "GET", `/projects/${ref}`);
  if (g.status === 404) return 404;
  if (g.status >= 300) throw new Error(`read project before delete: HTTP ${g.status}`);
  assertSec(String((g.json as { name?: string } | undefined)?.name ?? ""));
  let status = 0;
  for (let i = 0; i < 6; i++) {
    const r = await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => ({ status: 0 }) as { status: number });
    status = r.status;
    if (goneOk(status)) return status;
    await sleep(status === 429 ? 15_000 : 3_000);
  }
  return status;
}
