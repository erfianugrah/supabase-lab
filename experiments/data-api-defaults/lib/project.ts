/**
 * Shared self-provisioned project for the DD modules.
 *
 * One Pro-org project per run, created on first use and memoised for the
 * process, so DD01..DD04 measure the SAME fresh project (DD01 needs the
 * untouched default privileges; DD02 needs pg_graphql absent). DD99 deletes
 * it. Module ids sort within the destructive tier, so DD99 runs last.
 *
 * Name prefix: PVLAB_DD_PREFIX (default "pvlab-dd-"). `lib/cleanup.ts` deletes
 * every project of the Pro org (PVLAB_ORG_PRO) whose name starts with that
 * prefix, for a run that died before DD99.
 */
import { Client } from "pg";
import type { Ctx, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

export const REGION = "ap-southeast-1";
export const prefix = (): string => process.env.PVLAB_DD_PREFIX || "pvlab-dd-";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Keys {
  anon: string;
  service: string;
  publishable: string;
  secret: string;
}

export interface DdProject {
  ref: string;
  host: string;
  dbPass: string;
  keys: Keys;
  pgVersion: string;
  createMs: number;
  poolerHost: string;
  poolerUser: string;
}

let cached: Promise<DdProject> | null = null;
let current: DdProject | null = null;

/**
 * Skip result when the Pro org is not configured. The `org` capability comes from
 * PVLAB_ORG_SLUGS but create() needs ctx.orgs.pro (PVLAB_ORG_PRO), so a module must
 * check this before ensureProject. Returns null when the project can be created.
 */
export function skipWithoutPro(ctx: Ctx, id: string): TestResult[] | null {
  if (ctx.orgs.pro) return null;
  return [{ id, title: id, status: "skip", detail: "PVLAB_ORG_PRO not set: no Pro org to create the project in" }];
}

export function ensureProject(ctx: Ctx): Promise<DdProject> {
  if (!cached) cached = create(ctx);
  return cached;
}

export function currentProject(): DdProject | null {
  return current;
}

async function create(ctx: Ctx): Promise<DdProject> {
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
  // Registered before any wait, so DD99 can delete a project that never got healthy.
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
    publishable: rows.find((x) => x.type === "publishable")?.api_key ?? "",
    secret: rows.find((x) => x.type === "secret")?.api_key ?? "",
  };
  if (!keys.anon || !keys.service || !keys.publishable || !keys.secret) {
    throw new Error(`key set incomplete: ${rows.map((x) => `${x.name}/${x.type}`).join(",")}`);
  }

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

/** SQL as the postgres role through the Management API query endpoint. */
export async function sql(ctx: Ctx, ref: string, query: string): Promise<SqlResult> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
  if (r.status < 300) return { status: r.status, text: r.text, rows: (Array.isArray(r.json) ? r.json : []) as Record<string, unknown>[] };
  const msg = String((r.json as { message?: string } | undefined)?.message ?? r.text);
  return { status: r.status, text: r.text, error: msg.replace(/^Failed to run sql query:\s*/, "").trim() };
}

export interface RestResult {
  status: number;
  body: string;
  json?: unknown;
}

/** One Data API request. `mode` picks how the key travels. */
export async function dataApi(
  host: string,
  path: string,
  key: string | null,
  opts: { mode?: "both" | "apikey" | "bearer"; method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<RestResult> {
  const mode = opts.mode ?? "both";
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (key && mode !== "bearer") headers.apikey = key;
  if (key && mode !== "apikey") headers.Authorization = `Bearer ${key}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`https://${host}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  return { status: res.status, body, json };
}

/** Poll until `done(result)` is true; returns the last result and seconds waited. */
export async function pollApi(
  fn: () => Promise<RestResult>,
  done: (r: RestResult) => boolean,
  maxMs = 45_000,
  everyMs = 2_000,
): Promise<{ last: RestResult; s: number; ok: boolean }> {
  const t0 = Date.now();
  let last = await fn();
  while (!done(last) && Date.now() - t0 < maxMs) {
    await sleep(everyMs);
    last = await fn();
  }
  return { last, s: Math.round((Date.now() - t0) / 1000), ok: done(last) };
}

export interface PgSession {
  query(text: string): Promise<{ rows: Record<string, unknown>[]; notices: string[]; code?: string; error?: string }>;
  close(): Promise<void>;
}

/** Session-mode pooler connection as postgres, capturing NOTICE/WARNING text. */
export async function pgSession(p: DdProject): Promise<PgSession> {
  const c = new Client({
    host: p.poolerHost,
    port: 5432,
    user: p.poolerUser,
    password: p.dbPass,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  });
  let notices: string[] = [];
  c.on("notice", (n) => notices.push(`${n.severity}: ${n.message}`));
  c.on("error", () => {});
  await c.connect();
  return {
    async query(text: string) {
      notices = [];
      try {
        const r = await c.query(text);
        return { rows: (r.rows ?? []) as Record<string, unknown>[], notices };
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return { rows: [], notices, code: err.code, error: err.message };
      }
    },
    close: () => c.end().catch(() => {}),
  };
}

/** Replace the project ref (and host) so evidence text carries no identifier. */
export const redact = (p: DdProject | null, s: string): string => (p ? s.replaceAll(p.ref, "<ref>") : s);

/** First `n` chars on one line, ref redacted. */
export const brief = (p: DdProject | null, s: string, n = 200): string => redact(p, s).replace(/\s+/g, " ").slice(0, n);
