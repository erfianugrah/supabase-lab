/**
 * Shared helpers for the storage-surface modules: provision a throwaway Pro
 * project, wait until Storage answers, run SQL as postgres, tear down.
 *
 * Both modules are self-provisioning (no OpenTofu state) and delete the
 * project in `finally`. A project name always starts with `ss-` so a
 * sweep by prefix finds anything a crashed run left behind.
 */
import pg from "pg";
import type { Ctx } from "../../harness/src/types";
import { mgmt } from "../../harness/src/mgmt";

export const REGION = "ap-southeast-1";
export const NAME_PREFIX = "ss-";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Proj {
  ref: string;
  dbPass: string;
  anon: string;
  service: string;
  /** https://<ref>.supabase.co (Kong gateway host). */
  apiBase: string;
  /** https://<ref>.storage.supabase.co (direct storage host). */
  storageHost: string;
  createdAt: number;
}

/** mgmt() with a retry on the Cloudflare interstitial / 429. */
export async function mgmtRetry(ctx: Ctx, method: string, path: string, body?: unknown) {
  let last = await mgmt(ctx, method, path, body);
  for (let i = 0; i < 6 && (last.throttled || last.status === 429); i++) {
    await sleep(15_000 * (i + 1));
    last = await mgmt(ctx, method, path, body);
  }
  return last;
}

export async function provision(ctx: Ctx, org: string, tag: string): Promise<Proj> {
  const t0 = Date.now();
  const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1`;
  const create = await mgmtRetry(ctx, "POST", "/projects", {
    organization_slug: org,
    name: `${NAME_PREFIX}${tag}-${t0}`,
    db_pass: dbPass,
    region: REGION,
  });
  const ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
  if (create.status !== 201 || !ref) throw new Error(`create project: HTTP ${create.status} ${create.text.slice(0, 200)}`);
  // From here on the project exists: any throw must still reach teardown, so
  // return the handle as soon as keys are readable and let the caller wait.
  const deadline = Date.now() + 15 * 60_000;
  let status = "";
  while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
    await sleep(10_000);
    const p = await mgmtRetry(ctx, "GET", `/projects/${ref}`);
    status = ((p.json as { status?: string } | undefined)?.status ?? "") as string;
  }
  if (status !== "ACTIVE_HEALTHY") throw Object.assign(new Error(`project not healthy: ${status}`), { ref });
  const k = await mgmtRetry(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const keys = (Array.isArray(k.json) ? k.json : []) as Array<{ name?: string; api_key?: string }>;
  const anon = keys.find((x) => x.name === "anon")?.api_key ?? "";
  const service = keys.find((x) => x.name === "service_role")?.api_key ?? "";
  if (!anon || !service) throw Object.assign(new Error("legacy anon/service_role keys not returned"), { ref });
  const proj: Proj = {
    ref,
    dbPass,
    anon,
    service,
    apiBase: `https://${ref}.supabase.co`,
    storageHost: `https://${ref}.storage.supabase.co`,
    createdAt: t0,
  };
  // ACTIVE_HEALTHY is not readiness: wait for Storage itself.
  const sDeadline = Date.now() + 5 * 60_000;
  let ok = false;
  while (Date.now() < sDeadline && !ok) {
    try {
      const r = await fetch(`${proj.apiBase}/storage/v1/bucket`, {
        headers: { apikey: service, Authorization: `Bearer ${service}` },
        signal: AbortSignal.timeout(15_000),
      });
      ok = r.status === 200;
    } catch {
      /* DNS / TLS not ready yet */
    }
    if (!ok) await sleep(5_000);
  }
  if (!ok) throw Object.assign(new Error("storage API never answered 200 on /bucket"), { ref });
  return proj;
}

export async function teardown(ctx: Ctx, ref: string): Promise<number> {
  if (!ref) return 0;
  const r = await mgmtRetry(ctx, "DELETE", `/projects/${ref}`);
  return r.status;
}

/** One SQL statement through the Management API (runs as postgres via pg-meta). */
export async function mgmtSql(ctx: Ctx, ref: string, query: string): Promise<{ status: number; rows: any[]; text: string }> {
  const r = await mgmtRetry(ctx, "POST", `/projects/${ref}/database/query`, { query });
  return { status: r.status, rows: Array.isArray(r.json) ? (r.json as any[]) : [], text: r.text };
}

/** Pooler (session mode) connection string host, from the project's pooler config. */
export async function poolerHost(ctx: Ctx, ref: string): Promise<{ host: string; user: string } | null> {
  const r = await mgmtRetry(ctx, "GET", `/projects/${ref}/config/database/pooler`);
  const arr = (Array.isArray(r.json) ? r.json : []) as Array<{ db_host?: string; db_user?: string; pool_mode?: string; database_type?: string }>;
  const primary = arr.find((x) => x.database_type === "PRIMARY") ?? arr[0];
  if (!primary?.db_host) return null;
  return { host: primary.db_host, user: primary.db_user ?? `postgres.${ref}` };
}

/**
 * A direct session as `postgres` through the session-mode pooler (port 5432),
 * so `set storage.allow_delete_query` and the statement that follows share one
 * backend connection.
 */
export async function pgSession(ctx: Ctx, proj: Proj): Promise<pg.Client> {
  const p = await poolerHost(ctx, proj.ref);
  if (!p) throw new Error("no pooler config");
  const c = new pg.Client({
    host: p.host,
    port: 5432,
    user: `postgres.${proj.ref}`,
    password: proj.dbPass,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
    // A stalled pooler socket otherwise hangs the whole run silently (one
    // SS01 run sat 15 minutes with no CPU before this was added).
    query_timeout: 180_000,
    keepAlive: true,
  });
  await c.connect();
  return c;
}

export function authHeaders(key: string, extra: Record<string, string> = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

export async function timed<T>(f: () => Promise<T>): Promise<{ ms: number; v: T }> {
  const t = performance.now();
  const v = await f();
  return { ms: performance.now() - t, v };
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

export const r1 = (x: number) => Math.round(x * 10) / 10;

// ---- S3 canary subprocess (AWS SDK v3 lives in canary/, not in the registry) ----

const CANARY_DIR = new URL("./canary/", import.meta.url).pathname;

export interface S3Cfg {
  endpoint: string;
  ref: string;
  anon: string;
  token: string;
  region: string;
}
export interface S3Op {
  op: "put" | "get" | "head" | "list" | "delete" | "copy" | "multipart" | "presign-get";
  bucket: string;
  key?: string;
  body?: string;
  prefix?: string;
  from?: string;
}
export interface S3OpResult {
  op: string;
  key: string;
  ok: boolean;
  status: number;
  code: string;
  message: string;
  ms: number;
  body?: string;
  keys?: string[];
  requestId?: string;
}

export function s3cfg(p: Proj, host: "storage" | "api" = "storage"): S3Cfg {
  return {
    endpoint: `${host === "storage" ? p.storageHost : p.apiBase}/storage/v1/s3`,
    ref: p.ref,
    anon: p.anon,
    token: p.service,
    region: REGION,
  };
}

async function exec(cmd: string[], cwd: string, stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/** Names from `tools` that are not on PATH (the canary shells out to them). */
export function missingTools(tools: string[]): string[] {
  return tools.filter((t) => !Bun.which(t));
}

let depsReady = false;
export async function ensureCanaryDeps(): Promise<void> {
  if (depsReady) return;
  const missing = missingTools(["bun"]);
  if (missing.length) throw new Error(`required tool not on PATH: ${missing.join(", ")}`);
  const r = await exec(["bun", "install"], CANARY_DIR);
  if (r.code !== 0) throw new Error(`bun install in canary/ failed: ${r.err.slice(0, 300)}`);
  depsReady = true;
}

/** Run S3 operations through the AWS SDK v3 in a child process; one result per op. */
export async function s3ops(cfg: S3Cfg, ops: S3Op[], runtime: "bun" | "node" = "bun"): Promise<S3OpResult[]> {
  await ensureCanaryDeps();
  const r = await exec([runtime, "s3op.ts"], CANARY_DIR, JSON.stringify({ cfg, ops }));
  if (r.code !== 0) throw new Error(`s3op.ts exited ${r.code}: ${r.err.slice(0, 400)}`);
  return JSON.parse(r.out) as S3OpResult[];
}

/** Control: request lines the SDK puts on the wire and which path its signature covers (canary/wire.ts, local listener only). */
export async function s3wire(runtime: "bun" | "node"): Promise<unknown> {
  await ensureCanaryDeps();
  const r = await exec([runtime, "wire.ts"], CANARY_DIR);
  if (r.code !== 0) throw new Error(`wire.ts exited ${r.code}: ${r.err.slice(0, 400)}`);
  return JSON.parse(r.out);
}

/** Run the key-matrix canary (canary/matrix.ts) and return its JSON document. */
export async function s3matrix(cfg: S3Cfg, bucket: string, restBase: string, restKey: string, runtime: "bun" | "node" = "bun"): Promise<any> {
  await ensureCanaryDeps();
  const r = await exec([runtime, "matrix.ts"], CANARY_DIR, JSON.stringify({ cfg, bucket, restBase, restKey }));
  if (r.code !== 0) throw new Error(`matrix.ts exited ${r.code}: ${r.err.slice(0, 400)}`);
  return JSON.parse(r.out);
}
