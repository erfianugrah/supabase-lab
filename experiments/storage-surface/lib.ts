/**
 * Shared helpers for the storage-surface modules: provision a throwaway Pro
 * project, wait until Storage answers, run SQL as postgres, tear down.
 *
 * Both modules are self-provisioning (no OpenTofu state) and delete the
 * project in `finally`. A project name always starts with `ss-` so a
 * sweep by prefix finds anything a crashed run left behind.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  // A network error here leaks a project (one SS03 run lost DNS for about a
  // minute at the end and returned -1), so retry thrown errors as well as
  // throttling, for up to about 10 minutes.
  for (let i = 0; i < 20; i++) {
    try {
      const r = await mgmtRetry(ctx, "DELETE", `/projects/${ref}`);
      if (r.status < 500 && r.status !== 0) return r.status;
    } catch {
      /* DNS / connection failure: try again */
    }
    await sleep(30_000);
  }
  return -1;
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

// ---- SS03-SS05: one battery, three kinds of target ----
//
// The canary scripts (canary/upload.ts, canary/battery.ts) take a Target on
// stdin and never learn whether it is a managed project or the local stack.
// The module builds the Target: from a provisioned project, or from the
// self-hosted rig described by ctx.endpoints (`stack_dir`, `gw`), the same
// roles experiments/self-hosted-defaults uses.

export interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export interface TargetHost {
  name: "gateway" | "direct";
  rest: string;
  s3: string;
}
export interface Target {
  kind: string;
  managed: boolean;
  hosts: TargetHost[];
  region: string;
  creds: Creds;
  sessionKeyId: string;
  anon: string;
  service: string;
  secrets: string[];
}

export function managedTarget(p: Proj): Target {
  return {
    kind: "managed",
    managed: true,
    hosts: [
      { name: "gateway", rest: `${p.apiBase}/storage/v1`, s3: `${p.apiBase}/storage/v1/s3` },
      { name: "direct", rest: `${p.storageHost}/storage/v1`, s3: `${p.storageHost}/storage/v1/s3` },
    ],
    region: REGION,
    creds: { accessKeyId: p.ref, secretAccessKey: p.anon, sessionToken: p.service },
    sessionKeyId: p.ref,
    anon: p.anon,
    service: p.service,
    secrets: [p.anon, p.service, p.dbPass],
  };
}

export interface Stack {
  dir: string;
  gw: string;
  env: Record<string, string>;
}

/** The self-hosted rig from ctx.endpoints, or null when the run is not pointed at one. */
export function stackOf(ctx: Ctx): Stack | null {
  const dir = ctx.endpoints["stack_dir"] ?? "";
  const gw = ctx.endpoints["gw"] ?? "";
  if (!dir || !gw || !existsSync(join(dir, ".env"))) return null;
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(dir, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]!] = (m[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
  return { dir, gw, env };
}

export async function shell(cmd: string[], env?: Record<string, string>, cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd, env: env ? { ...process.env, ...env } : undefined, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

/** STORAGE_BACKEND, FILE_SIZE_LIMIT, image and compose files of the running storage container. */
export async function storageContainer(): Promise<{ backend: string; limit: string; image: string; files: string[]; workdir: string } | null> {
  const r = await shell(["docker", "inspect", "supabase-storage"]);
  if (r.code !== 0) return null;
  const info = JSON.parse(r.out)[0];
  const env: Record<string, string> = {};
  for (const kv of (info?.Config?.Env ?? []) as string[]) {
    const i = kv.indexOf("=");
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const labels = (info?.Config?.Labels ?? {}) as Record<string, string>;
  return {
    backend: env.STORAGE_BACKEND ?? "",
    limit: env.FILE_SIZE_LIMIT ?? "",
    image: String(info?.Config?.Image ?? ""),
    files: (labels["com.docker.compose.project.config_files"] ?? "").split(",").filter(Boolean),
    workdir: labels["com.docker.compose.project.working_dir"] ?? "",
  };
}

export function stackTarget(s: Stack, backend: string, image: string): Target {
  const tag = image.split(":")[1] ?? "";
  return {
    kind: `sh-${backend}${tag ? `@${tag}` : ""}`,
    managed: false,
    hosts: [{ name: "gateway", rest: `${s.gw}/storage/v1`, s3: `${s.gw}/storage/v1/s3` }],
    region: s.env.REGION ?? "stub",
    creds: { accessKeyId: s.env.S3_PROTOCOL_ACCESS_KEY_ID ?? "", secretAccessKey: s.env.S3_PROTOCOL_ACCESS_KEY_SECRET ?? "" },
    sessionKeyId: s.env.STORAGE_TENANT_ID ?? "stub",
    anon: s.env.ANON_KEY ?? "",
    service: s.env.SERVICE_ROLE_KEY ?? "",
    secrets: Object.entries(s.env)
      .filter(([k, v]) => /(PASSWORD|SECRET|KEY|TOKEN|JWT|JWKS)/i.test(k) && v.length >= 8)
      .map(([, v]) => v),
  };
}

/**
 * Re-create the storage service with a raised FILE_SIZE_LIMIT, through the
 * rig's storage-limit layer, keeping every compose file the running stack was
 * started with (read from the container's compose label).
 */
export async function raiseStackLimit(limit: number): Promise<{ ok: boolean; detail: string }> {
  const sc = await storageContainer();
  if (!sc) return { ok: false, detail: "supabase-storage not running" };
  const layer = new URL("../self-hosted-defaults/compose/docker-compose.storage-limit.yml", import.meta.url).pathname;
  const files = [...sc.files.filter((f) => f !== layer), layer];
  const tag = sc.image.split(":")[1] ?? "";
  const args = ["docker", "compose", ...files.flatMap((f) => ["-f", f]), "up", "-d", "--wait", "--no-deps", "storage"];
  const r = await shell(args, { STORAGE_FILE_SIZE_LIMIT: String(limit), STORAGE_IMAGE_TAG: tag }, sc.workdir);
  const after = await storageContainer();
  return { ok: r.code === 0 && after?.limit === String(limit), detail: `compose exit ${r.code}; FILE_SIZE_LIMIT now ${after?.limit ?? "?"}${r.code ? `; ${r.err.slice(-300)}` : ""}` };
}

/** psql as supabase_admin inside the stack's db container; rows as arrays of text. */
export async function stackSql(query: string): Promise<{ ok: boolean; rows: string[][]; err: string }> {
  const r = await shell(["docker", "exec", "supabase-db", "psql", "-U", "supabase_admin", "-d", "postgres", "-At", "-F", "\t", "-c", query]);
  return { ok: r.code === 0, rows: r.out.split("\n").filter(Boolean).map((l) => l.split("\t")), err: r.err.trim().slice(0, 300) };
}

/** One canary command under Node; one JSON document back. */
export async function canary<T = any>(script: string, input: unknown, timeoutMs = 3_600_000): Promise<T> {
  await ensureCanaryDeps();
  const proc = Bun.spawn(["node", script], { cwd: CANARY_DIR, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  const last = out.trim().split("\n").at(-1) ?? "";
  if (code !== 0 || !last) throw new Error(`${script} exited ${code}: ${err.slice(-400)}`);
  return JSON.parse(last) as T;
}

/**
 * A TUS upload in a child process that is SIGKILLed after `killAfter` chunks
 * (0 = let it finish). Returns every JSON line the child printed.
 */
export async function tusChild(input: unknown, killAfter: number, timeoutMs = 3_600_000): Promise<{ lines: any[]; killed: boolean }> {
  await ensureCanaryDeps();
  const proc = Bun.spawn(["node", "upload.ts"], { cwd: CANARY_DIR, stdin: new Blob([JSON.stringify({ cmd: "tus", tus: input })]), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const lines: any[] = [];
  let killed = false;
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const j = JSON.parse(l);
        lines.push(j);
        if (killAfter > 0 && j.chunk >= killAfter && !killed) {
          proc.kill("SIGKILL");
          killed = true;
        }
      } catch {
        /* not a JSON line */
      }
    }
  }
  await proc.exited;
  clearTimeout(timer);
  return { lines, killed };
}

/** Managed Storage config (Management API), raw JSON. */
export async function storageConfig(ctx: Ctx, ref: string) {
  return mgmtRetry(ctx, "GET", `/projects/${ref}/config/storage`);
}
