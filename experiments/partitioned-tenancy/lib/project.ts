/**
 * Shared self-provisioned project for the PT modules.
 *
 * One Pro-org Micro project per run, created on first use and memoised for the
 * process, so PT01..PT04 measure the SAME fresh project. PT99 deletes it.
 * Module ids sort within the destructive tier, so PT99 runs last.
 *
 * Name prefix: PVLAB_PT_PREFIX (default "pvlab-pt-"). `lib/cleanup.ts` lists or
 * deletes every visible project whose name starts with that prefix, for a run
 * that died before PT99.
 *
 * Adapted from data-api-defaults/lib/project.ts (same create/ready/teardown
 * sequence); adds auth users with a tenant claim, a session-pooler client and
 * a PostgREST schema-cache wait.
 */
import { Client } from "pg";
import type { Ctx, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

export const REGION = "ap-southeast-1";
export const prefix = (): string => process.env.PVLAB_PT_PREFIX || "pvlab-pt-";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Keys {
  anon: string;
  service: string;
}

export interface PtProject {
  ref: string;
  host: string;
  dbPass: string;
  keys: Keys;
  pgVersion: string;
  createMs: number;
  poolerHost: string;
  poolerUser: string;
}

let cached: Promise<PtProject> | null = null;
let current: PtProject | null = null;

export function skipWithoutPro(ctx: Ctx, id: string): TestResult[] | null {
  if (ctx.orgs.pro) return null;
  return [{ id, title: id, status: "skip", detail: "PVLAB_ORG_PRO not set: no Pro org to create the project in" }];
}

export function ensureProject(ctx: Ctx): Promise<PtProject> {
  if (!cached) cached = create(ctx);
  return cached;
}

export function currentProject(): PtProject | null {
  return current;
}

async function create(ctx: Ctx): Promise<PtProject> {
  const org = ctx.orgs.pro ?? "";
  if (!org) throw new Error("PVLAB_ORG_PRO not set");
  const t0 = Date.now();
  const dbPass = `${crypto.randomUUID().replaceAll("-", "")}Aa1!`;
  const res = await mgmt(ctx, "POST", "/projects", {
    organization_slug: org,
    name: `${prefix()}${t0}`,
    db_pass: dbPass,
    region: REGION,
  });
  const ref = ((res.json as { ref?: string; id?: string } | undefined)?.ref ?? "") as string;
  if (res.status !== 201 || !ref) throw new Error(`create project: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  // Registered before any wait, so PT99 can delete a project that never got healthy.
  current = { ref, host: `${ref}.supabase.co`, dbPass, keys: {} as Keys, pgVersion: "", createMs: 0, poolerHost: "", poolerUser: "" };

  let status = "";
  for (let i = 0; i < 120 && status !== "ACTIVE_HEALTHY"; i++) {
    if (i > 0) await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = ((p.json as { status?: string } | undefined)?.status ?? "") as string;
  }
  if (status !== "ACTIVE_HEALTHY") throw new Error(`project not healthy: ${status}`);

  // ACTIVE_HEALTHY is not readiness (AGENTS.md): retry the first query.
  let version = "";
  for (let i = 0; i < 24 && !version; i++) {
    const r = await sql(ctx, ref, "select version() as v");
    version = (r.rows?.[0]?.v as string | undefined) ?? "";
    if (!version) await sleep(5_000);
  }
  if (!version) throw new Error("database never answered the management query");

  const k = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const rows = (Array.isArray(k.json) ? k.json : []) as { name: string; type?: string; api_key?: string }[];
  const keys: Keys = {
    anon: rows.find((x) => x.name === "anon")?.api_key ?? "",
    service: rows.find((x) => x.name === "service_role")?.api_key ?? "",
  };
  if (!keys.anon || !keys.service) throw new Error(`legacy keys absent: ${rows.map((x) => `${x.name}/${x.type}`).join(",")}`);

  const pool = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`);
  const p0 = (Array.isArray(pool.json) ? pool.json[0] : undefined) as { db_host?: string; db_user?: string } | undefined;

  current = {
    ref,
    host: `${ref}.supabase.co`,
    dbPass,
    keys,
    pgVersion: version.split(" on ")[0] ?? version,
    createMs: Date.now() - t0,
    poolerHost: p0?.db_host ?? "",
    poolerUser: p0?.db_user ?? `postgres.${ref}`,
  };
  return current;
}

/** Delete the project (idempotent) and wait until the control plane stops listing it. */
export async function teardownProject(ctx: Ctx): Promise<{ ref: string; deleteStatus: number; goneS: number }> {
  const p = current;
  if (!p) return { ref: "", deleteStatus: 0, goneS: -1 };
  const del = await mgmt(ctx, "DELETE", `/projects/${p.ref}`);
  const t0 = Date.now();
  let goneS = -1;
  while (Date.now() - t0 < 180_000) {
    const l = await mgmt(ctx, "GET", "/projects");
    const arr = (Array.isArray(l.json) ? l.json : []) as { id?: string; ref?: string }[];
    if (l.status === 200 && !arr.some((x) => (x.ref ?? x.id) === p.ref)) {
      goneS = Math.round((Date.now() - t0) / 1000);
      break;
    }
    await sleep(10_000);
  }
  return { ref: p.ref, deleteStatus: del.status, goneS };
}

export interface SqlResult {
  status: number;
  text: string;
  rows?: Record<string, unknown>[];
  /** Postgres error text with the "Failed to run sql query" wrapper removed. */
  error?: string;
}

/** SQL as the postgres role through the Management API query endpoint (answers 201). */
export async function sql(ctx: Ctx, ref: string, query: string): Promise<SqlResult> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, 120_000);
  if (r.status < 300) return { status: r.status, text: r.text, rows: (Array.isArray(r.json) ? r.json : []) as Record<string, unknown>[] };
  const msg = String((r.json as { message?: string } | undefined)?.message ?? r.text);
  return { status: r.status, text: r.text, error: msg.replace(/^Failed to run sql query:\s*/, "").trim() };
}

/** Like sql() but throws on an error, for setup statements whose failure voids the module. */
export async function sqlOk(ctx: Ctx, ref: string, query: string): Promise<Record<string, unknown>[]> {
  const r = await sql(ctx, ref, query);
  if (r.status >= 300) throw new Error(`setup SQL failed (${r.status}): ${r.error?.slice(0, 300)}`);
  return r.rows ?? [];
}

export interface RestResult {
  status: number;
  body: string;
  json?: unknown;
  ms: number;
}

/** One Data API request with apikey + bearer. `bearer` defaults to the apikey. */
export async function rest(
  host: string,
  path: string,
  apikey: string,
  opts: { bearer?: string; method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RestResult> {
  const headers: Record<string, string> = { apikey, Authorization: `Bearer ${opts.bearer ?? apikey}`, ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const t0 = performance.now();
  try {
    const res = await fetch(`https://${host}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const body = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
    return { status: res.status, body, json, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { status: 0, body: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t0) };
  }
}

/** Rows array length, or -1 when the body is not an array (an error envelope). */
export const rowCount = (r: RestResult): number => (Array.isArray(r.json) ? (r.json as unknown[]).length : -1);
/** Distinct tenant_id values in a rows array, sorted, as "1,2". */
export const tenantsSeen = (r: RestResult): string =>
  Array.isArray(r.json)
    ? [...new Set((r.json as { tenant_id?: number }[]).map((x) => x.tenant_id))].sort((a, b) => Number(a) - Number(b)).join(",")
    : "";
/** PostgREST error code, or the HTTP status when the body has none. */
export const codeOf = (r: RestResult): string => ((r.json as { code?: string } | undefined)?.code ?? "") || (r.status >= 300 ? `HTTP${r.status}` : "");

/**
 * Ask PostgREST to reload its schema cache and poll until `path` stops
 * answering PGRST205 (table not in the schema cache). Returns seconds waited.
 */
export async function awaitExposed(ctx: Ctx, p: PtProject, path: string, maxMs = 60_000): Promise<number> {
  await sql(ctx, p.ref, "notify pgrst, 'reload schema'");
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await rest(p.host, path, p.keys.service);
    if (r.status !== 404 || codeOf(r) !== "PGRST205") return Math.round((Date.now() - t0) / 1000);
    await sleep(2_000);
  }
  return -1;
}

export interface TenantUser {
  email: string;
  tenant: number;
  token: string;
}

/**
 * Create a confirmed auth user with app_metadata.tenant_id (admin endpoint,
 * service key) and sign it in with the password grant. app_metadata is not
 * user-writable, so it is the claim a tenant policy can trust.
 */
export async function tenantUser(p: PtProject, tenant: number): Promise<TenantUser> {
  const email = `pt-${tenant}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = `${crypto.randomUUID()}Aa1!`;
  const c = await rest(p.host, "/auth/v1/admin/users", p.keys.service, {
    method: "POST",
    body: { email, password, email_confirm: true, app_metadata: { tenant_id: tenant } },
  });
  if (c.status !== 200 && c.status !== 201) throw new Error(`admin create user: HTTP ${c.status} ${c.body.slice(0, 200)}`);
  const s = await rest(p.host, "/auth/v1/token?grant_type=password", p.keys.anon, { method: "POST", body: { email, password } });
  const token = (s.json as { access_token?: string } | undefined)?.access_token ?? "";
  if (!token) throw new Error(`password grant: HTTP ${s.status} ${s.body.slice(0, 200)}`);
  return { email, tenant, token };
}

export interface PgSession {
  query(text: string): Promise<{ rows: Record<string, unknown>[]; ms: number; code?: string; error?: string }>;
  close(): Promise<void>;
}

/**
 * Session-mode pooler connection (port 5432) as postgres. Session mode, not
 * transaction mode, because SET ROLE and request.jwt.claims are session-scoped
 * (rls-policy-cost key facts). Retries the first connect: the pooler can lag
 * the project's readiness.
 */
export async function pgSession(p: PtProject, statementTimeoutMs = 0): Promise<PgSession> {
  let lastErr = "";
  for (let i = 0; i < 12; i++) {
    const c = new Client({
      host: p.poolerHost,
      port: 5432,
      user: p.poolerUser,
      password: p.dbPass,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 20_000,
      statement_timeout: statementTimeoutMs || undefined,
    });
    c.on("error", () => {});
    try {
      await c.connect();
      return {
        async query(text: string) {
          const t0 = performance.now();
          try {
            const r = await c.query(text);
            const last = Array.isArray(r) ? r[r.length - 1] : r;
            return { rows: (last?.rows ?? []) as Record<string, unknown>[], ms: Math.round(performance.now() - t0) };
          } catch (e) {
            const err = e as { code?: string; message?: string };
            return { rows: [], ms: Math.round(performance.now() - t0), code: err.code, error: err.message };
          }
        },
        close: () => c.end().catch(() => {}),
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await c.end().catch(() => {});
      await sleep(10_000);
    }
  }
  throw new Error(`session pooler connect failed: ${lastErr}`);
}

/** Replace the project ref so evidence text carries no identifier. */
export const redact = (p: PtProject | null, s: string): string => (p ? s.replaceAll(p.ref, "<ref>") : s);

/** First `n` chars on one line, ref redacted. */
export const brief = (p: PtProject | null, s: string, n = 200): string => redact(p, s).replace(/\s+/g, " ").slice(0, n);

export const median = (xs: number[]): number => {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? -1) : Math.round((((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2) * 100) / 100;
};
