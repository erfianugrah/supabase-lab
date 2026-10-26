/**
 * Self-provisioned project for AR05/AR06 (the AR01-AR04 modules use the tofu
 * project through PVLAB_REF; these create their own through POST /v1/projects
 * in the Pro org, so the auth-rate-limits tofu state is not needed).
 *
 * One project per process, memoised. PVLAB_AR_REF reuses an existing project
 * instead (the AR06 bucket run and the AR05 sweep run as separate invocations
 * against the same project); `lib/cleanup.ts` deletes by name prefix
 * PVLAB_AR_PREFIX (default "pvlab-ar-"), AR99 deletes a project this process
 * created.
 *
 * Credentials (db password, test-user passwords, keys) are generated or
 * fetched per run, held in memory, never logged. Evidence strings pass
 * through `redact`.
 */
import { mgmt } from "../../../harness/src/mgmt.js";
import { logsQuery, type LogsResult } from "../../../harness/src/platform.js";
import type { Ctx, TestResult } from "../../../harness/src/types.js";

export const REGION = process.env.PVLAB_AR_REGION || "ap-southeast-1";
export const START_SIZE = process.env.PVLAB_AR_SIZE || "small";
export const prefix = (): string => process.env.PVLAB_AR_PREFIX || "pvlab-ar-";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

export interface ArProject {
  ref: string;
  host: string;
  anon: string;
  service: string;
  reused: boolean;
  createMs: number;
}

let cached: Promise<ArProject> | null = null;
let current: ArProject | null = null;

export function skipWithoutPro(ctx: Ctx, id: string): TestResult[] | null {
  if (ctx.orgs.pro || process.env.PVLAB_AR_REF) return null;
  return [{ id, title: id, status: "skip", detail: "PVLAB_ORG_PRO not set: no Pro org to create the project in" }];
}

export function ensureProject(ctx: Ctx): Promise<ArProject> {
  if (!cached) cached = create(ctx);
  return cached;
}

export function currentProject(): ArProject | null {
  return current;
}

export const redact = (s: string): string => (current ? s.replaceAll(current.ref, "<ref>") : s);

/** Ctx pointed at this project, for harness helpers that read ctx.ref. */
export const withRef = (ctx: Ctx, p: ArProject): Ctx => ({ ...ctx, ref: p.ref, apiHost: p.host, anonKey: p.anon, serviceKey: p.service });

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
  return String((p?.json as { status?: string } | undefined)?.status ?? "");
}

export interface SqlResult {
  status: number;
  rows?: Record<string, unknown>[];
  error?: string;
}

/** SQL as `postgres` through the Management API query endpoint. */
export async function sql(ctx: Ctx, ref: string, query: string, timeoutMs = 60_000): Promise<SqlResult> {
  try {
    const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, timeoutMs);
    if (r.status < 300) return { status: r.status, rows: (Array.isArray(r.json) ? r.json : []) as Record<string, unknown>[] };
    const msg = String((r.json as { message?: string } | undefined)?.message ?? r.text);
    return { status: r.status, error: msg.replace(/^Failed to run sql query:\s*/, "").trim().slice(0, 300) };
  } catch (e) {
    return { status: 0, error: errText(e) };
  }
}

async function create(ctx: Ctx): Promise<ArProject> {
  const t0 = Date.now();
  let ref = process.env.PVLAB_AR_REF ?? "";
  const reused = Boolean(ref);
  if (!reused) {
    const org = ctx.orgs.pro ?? "";
    if (!org) throw new Error("PVLAB_ORG_PRO not set");
    const res = await mgmt(ctx, "POST", "/projects", {
      organization_slug: org,
      name: `${prefix()}${t0}`,
      db_pass: `${crypto.randomUUID().replaceAll("-", "")}Aa1!`,
      region: REGION,
      desired_instance_size: START_SIZE,
    });
    ref = String((res.json as { ref?: string; id?: string } | undefined)?.ref ?? (res.json as { id?: string } | undefined)?.id ?? "");
    if (res.status !== 201 || !ref) throw new Error(`create project: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    ctx.log(`AR project created: ${ref} (${START_SIZE}, ${REGION})`);
  }
  current = { ref, host: `${ref}.supabase.co`, anon: "", service: "", reused, createMs: 0 };

  let status = "";
  for (let i = 0; i < 120 && status !== "ACTIVE_HEALTHY"; i++) {
    if (i > 0) await sleep(10_000);
    status = await statusOf(ctx, ref);
  }
  if (status !== "ACTIVE_HEALTHY") throw new Error(`project not healthy: ${status}`);

  // ACTIVE_HEALTHY is not readiness: retry the first query.
  let ok = false;
  for (let i = 0; i < 24 && !ok; i++) {
    const r = await sql(ctx, ref, "select 1 as one");
    ok = r.rows?.[0]?.one === 1;
    if (!ok) await sleep(5_000);
  }
  if (!ok) throw new Error("database never answered the management query");

  const k = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const rows = (Array.isArray(k.json) ? k.json : []) as { name: string; api_key?: string }[];
  const anon = rows.find((x) => x.name === "anon")?.api_key ?? "";
  const service = rows.find((x) => x.name === "service_role")?.api_key ?? "";
  if (!anon || !service) throw new Error("legacy anon/service_role keys absent");

  // Auth answers before the project is useful: wait for /auth/v1/health.
  for (let i = 0; i < 30; i++) {
    const h = await fetch(`https://${ref}.supabase.co/auth/v1/health`, { headers: { apikey: anon } }).catch(() => null);
    if (h?.status === 200) break;
    await sleep(2_000);
  }
  current = { ref, host: `${ref}.supabase.co`, anon, service, reused, createMs: Date.now() - t0 };
  return current;
}

/** Delete the project this process created (idempotent) and wait until the listing drops it. */
export async function teardownProject(ctx: Ctx): Promise<{ deleteStatus: number; goneS: number; reused: boolean }> {
  const p = current;
  if (!p) return { deleteStatus: 0, goneS: -1, reused: false };
  if (p.reused && !process.env.PVLAB_AR_DELETE_REUSED) return { deleteStatus: 0, goneS: -1, reused: true };
  let del = await mgmt(ctx, "DELETE", `/projects/${p.ref}`);
  for (let i = 0; i < 3 && (del.status === 429 || del.throttled); i++) {
    await sleep(30_000);
    del = await mgmt(ctx, "DELETE", `/projects/${p.ref}`);
  }
  const t0 = Date.now();
  let goneS = -1;
  while (Date.now() - t0 < 240_000) {
    const l = await mgmt(ctx, "GET", "/projects");
    const arr = (Array.isArray(l.json) ? l.json : []) as { id?: string; ref?: string }[];
    if (l.status === 200 && !arr.some((x) => (x.ref ?? x.id) === p.ref)) {
      goneS = Math.round((Date.now() - t0) / 1000);
      break;
    }
    await sleep(10_000);
  }
  return { deleteStatus: del.status, goneS, reused: p.reused };
}

// ---------------------------------------------------------------- auth config

export async function authConfig(ctx: Ctx, p: ArProject): Promise<Record<string, unknown>> {
  const r = await mgmt(ctx, "GET", `/projects/${p.ref}/config/auth`);
  return (r.json as Record<string, unknown>) ?? {};
}

export async function patchAuth(ctx: Ctx, p: ArProject, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  let r = await mgmt(ctx, "PATCH", `/projects/${p.ref}/config/auth`, body);
  for (let i = 0; i < 3 && (r.status === 429 || r.throttled); i++) {
    await sleep(20_000);
    r = await mgmt(ctx, "PATCH", `/projects/${p.ref}/config/auth`, body);
  }
  return { status: r.status, text: redact(r.text.replace(/\s+/g, " ").slice(0, 200)) };
}

/** Every rate_limit_* field of config/auth, as `k=v` pairs (and the forwarding toggle). */
export function rateLimitFields(cfg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg).sort(([a], [b]) => a.localeCompare(b))) {
    if (k.startsWith("rate_limit_") || k === "security_sb_forwarded_for_enabled" || k === "mfa_max_enrolled_factors") out[k] = String(v);
  }
  return out;
}

/**
 * PATCH a field, then wait until GET reads it back and /auth/v1/health has
 * answered 200 for `settleS` seconds in a row. Readback is not propagation
 * (auth-refresh-race: a PATCHed value read back while the running service
 * kept the old one); callers verify behaviour after this.
 */
export async function patchAndSettle(ctx: Ctx, p: ArProject, body: Record<string, unknown>, settleS = 15): Promise<{ status: number; text: string; readbackS: number; healthGaps: number; patchAt: number }> {
  const patchAt = Date.now();
  const r = await patchAuth(ctx, p, body);
  let readbackS = -1;
  for (let i = 0; i < 30; i++) {
    const cfg = await authConfig(ctx, p);
    if (Object.entries(body).every(([k, v]) => String(cfg[k]) === String(v))) {
      readbackS = Math.round((Date.now() - patchAt) / 100) / 10;
      break;
    }
    await sleep(2_000);
  }
  let okRun = 0;
  let gaps = 0;
  const t0 = Date.now();
  while (okRun < settleS && Date.now() - t0 < 180_000) {
    const h = await fetch(`https://${p.host}/auth/v1/health`, { headers: { apikey: p.anon }, signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (h?.status === 200) okRun++;
    else {
      okRun = 0;
      gaps++;
    }
    await sleep(1_000);
  }
  return { ...r, readbackS, healthGaps: gaps, patchAt };
}

/** Auth log lines since `sinceMs` whose message matches `like` (SQL LIKE on event_message). */
export async function authLogLines(ctx: Ctx, p: ArProject, like: string, sinceMs: number): Promise<{ lines: string[]; error: string; status: number }> {
  const since = new Date(sinceMs - 5_000).toISOString();
  const q = `select timestamp, event_message from auth_logs where timestamp > '${since}' and event_message like '${like}' order by timestamp asc limit 50`;
  let r: LogsResult;
  try {
    r = await logsQuery(withRef(ctx, p), q, 2);
  } catch (e) {
    return { lines: [], error: errText(e), status: 0 };
  }
  return { lines: r.rows.map((x) => redact(String(x.event_message ?? "")).slice(0, 300)), error: r.error, status: r.status };
}

// ---------------------------------------------------------------- auth calls

export interface Hit {
  status: number;
  ms: number;
  /** Client-side send time relative to the caller's t0, ms. */
  at: number;
  code: string;
  body: string;
  json?: Record<string, unknown>;
}

async function call(url: string, init: RequestInit, t0: number, timeoutMs = 30_000): Promise<Hit> {
  const at = performance.now() - t0;
  const s = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    const code = String(json?.error_code ?? json?.code ?? "");
    return { status: res.status, ms: performance.now() - s, at, code, body: text.replace(/\s+/g, " ").slice(0, 160), json };
  } catch (e) {
    return { status: 0, ms: performance.now() - s, at, code: "client", body: errText(e) };
  }
}

export function passwordGrant(p: ArProject, email: string, password: string, t0 = performance.now()): Promise<Hit> {
  return call(
    `https://${p.host}/auth/v1/token?grant_type=password`,
    { method: "POST", headers: { apikey: p.anon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) },
    t0,
  );
}

export function refreshGrant(p: ArProject, refreshToken: string, t0 = performance.now()): Promise<Hit> {
  return call(
    `https://${p.host}/auth/v1/token?grant_type=refresh_token`,
    { method: "POST", headers: { apikey: p.anon, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: refreshToken }) },
    t0,
  );
}

export function getUser(p: ArProject, jwt: string, t0 = performance.now()): Promise<Hit> {
  return call(`https://${p.host}/auth/v1/user`, { method: "GET", headers: { apikey: p.anon, Authorization: `Bearer ${jwt}` } }, t0);
}

export function putUser(p: ArProject, jwt: string, i: number, t0 = performance.now()): Promise<Hit> {
  return call(
    `https://${p.host}/auth/v1/user`,
    { method: "PUT", headers: { apikey: p.anon, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }, body: JSON.stringify({ data: { ar06: i } }) },
    t0,
  );
}

export function signup(p: ArProject, email: string, password: string, t0 = performance.now()): Promise<Hit> {
  return call(
    `https://${p.host}/auth/v1/signup`,
    { method: "POST", headers: { apikey: p.anon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) },
    t0,
  );
}

export function health(p: ArProject, t0 = performance.now()): Promise<Hit> {
  return call(`https://${p.host}/auth/v1/health`, { method: "GET", headers: { apikey: p.anon } }, t0);
}

/** Sequential calls until the first 429 (or `max`); returns every hit. */
export async function untilFirst429(make: (i: number) => Promise<Hit>, max: number): Promise<{ hits: Hit[]; first429: number; statuses: Record<string, number>; body429: string }> {
  const hits: Hit[] = [];
  const statuses: Record<string, number> = {};
  for (let i = 1; i <= max; i++) {
    const h = await make(i);
    hits.push(h);
    statuses[String(h.status)] = (statuses[String(h.status)] ?? 0) + 1;
    if (h.status === 429) return { hits, first429: i, statuses, body429: h.body };
  }
  return { hits, first429: 0, statuses, body429: "" };
}

export const fmtCounts = (o: Record<string, number>) =>
  Object.entries(o)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");

export function pctl(xs: number[], q: number): number {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))] ?? -1);
}

// ---------------------------------------------------------------- users

export interface TestUser {
  email: string;
  password: string;
}

/** Admin-create `n` confirmed users (service key, concurrency 8). Passwords are per run, never logged. */
export async function createUsers(p: ArProject, tag: string, n: number): Promise<{ users: TestUser[]; failed: number }> {
  const password = `${crypto.randomUUID().replaceAll("-", "")}Aa1!`;
  const users: TestUser[] = Array.from({ length: n }, (_, i) => ({ email: `ar-${tag}-${i}@example.com`, password }));
  let failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < users.length) {
        const u = users[next++]!;
        const r = await fetch(`https://${p.host}/auth/v1/admin/users`, {
          method: "POST",
          headers: { apikey: p.service, Authorization: `Bearer ${p.service}`, "Content-Type": "application/json" },
          body: JSON.stringify({ email: u.email, password: u.password, email_confirm: true }),
        }).catch(() => null);
        if (!r || (r.status >= 300 && r.status !== 422)) failed++;
        await r?.text().catch(() => "");
      }
    }),
  );
  return { users, failed };
}

// ---------------------------------------------------------------- compute

/** Resize through the compute add-on; wait for max_connections to change, ACTIVE_HEALTHY, and 10 s of auth health. */
export async function resize(ctx: Ctx, p: ArProject, variant: string, maxMs = 25 * 60_000): Promise<{ status: number; text: string; settledS: number; maxConn: number }> {
  const t0 = Date.now();
  const before = Number((await sql(ctx, p.ref, "select current_setting('max_connections')::int as m")).rows?.[0]?.m ?? -1);
  let r = await mgmt(ctx, "PATCH", `/projects/${p.ref}/billing/addons`, { addon_type: "compute_instance", addon_variant: variant });
  for (let i = 0; i < 4 && r.status === 429; i++) {
    await sleep(60_000);
    r = await mgmt(ctx, "PATCH", `/projects/${p.ref}/billing/addons`, { addon_type: "compute_instance", addon_variant: variant });
  }
  if (r.status >= 300) return { status: r.status, text: redact(r.text.slice(0, 200)), settledS: -1, maxConn: -1 };
  let maxConn = -1;
  while (Date.now() - t0 < maxMs) {
    await sleep(15_000);
    const q = await sql(ctx, p.ref, "select current_setting('max_connections')::int as m", 20_000);
    maxConn = Number(q.rows?.[0]?.m ?? -1);
    if (maxConn <= 0 || maxConn === before) continue;
    if ((await statusOf(ctx, p.ref)) !== "ACTIVE_HEALTHY") continue;
    let okRun = 0;
    for (let i = 0; i < 40 && okRun < 10; i++) {
      const h = await health(p);
      okRun = h.status === 200 ? okRun + 1 : 0;
      await sleep(1_000);
    }
    if (okRun >= 10) return { status: r.status, text: "", settledS: Math.round((Date.now() - t0) / 1000), maxConn };
  }
  return { status: r.status, text: "timed out waiting for the resize to settle", settledS: -1, maxConn };
}

/** Node CPU (busy, idle seconds summed over CPUs) from the project's metrics endpoint; null when unreadable. */
export interface CpuSnap {
  busy: number;
  idle: number;
  ncpu: number;
  t: number;
  /** process_cpu_seconds_total{service_type="gotrue"}: the Auth process's own CPU seconds. */
  gotrueCpu: number;
  /** db_sql_connection_wait_total / _duration_milliseconds_total for gotrue: Auth pool waits. */
  poolWaits: number;
  poolWaitMs: number;
}

/**
 * Node CPU (busy, idle seconds summed over CPUs; node exporter labelled
 * service_type="db"), the Auth process CPU and Auth's DB-pool wait counters,
 * from the project's metrics endpoint; null when unreadable. The payload is a
 * snapshot that refreshes rarely (data-api-capacity DC05), so callers compare
 * distinct snapshots and normalise by node CPU seconds, not wall time.
 */
export async function nodeCpu(p: ArProject): Promise<CpuSnap | null> {
  const auth = Buffer.from(`service_role:${p.service}`).toString("base64");
  try {
    const res = await fetch(`https://${p.host}/customer/v1/privileged/metrics`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const text = await res.text();
    let busy = 0;
    let idle = 0;
    const cpus = new Set<string>();
    let gotrueCpu = -1;
    let poolWaits = -1;
    let poolWaitMs = -1;
    for (const line of text.split("\n")) {
      const gv = () => Number(line.slice(line.lastIndexOf(" ") + 1));
      if (line.includes('service_type="gotrue"')) {
        if (line.startsWith("process_cpu_seconds_total")) gotrueCpu = gv();
        else if (line.startsWith("db_sql_connection_wait_total")) poolWaits = gv();
        else if (line.startsWith("db_sql_connection_wait_duration_milliseconds_total")) poolWaitMs = gv();
      }
      if (!line.startsWith("node_cpu_seconds_total")) continue;
      const v = Number(line.slice(line.lastIndexOf(" ") + 1));
      const cpu = /cpu="(\d+)"/.exec(line)?.[1];
      if (cpu) cpus.add(cpu);
      if (line.includes('mode="idle"')) idle += v;
      else if (!line.includes('mode="steal"') && !line.includes('mode="guest')) busy += v;
    }
    return { busy, idle, ncpu: cpus.size, t: Date.now(), gotrueCpu, poolWaits, poolWaitMs };
  } catch {
    return null;
  }
}

/** Busy share between two node CPU readings, percent; -1 when not computable (stale snapshot or missing). */
export function cpuPct(a: { busy: number; idle: number } | null, b: { busy: number; idle: number } | null): number {
  if (!a || !b) return -1;
  const db = b.busy - a.busy;
  const di = b.idle - a.idle;
  if (db + di <= 0) return -1;
  return Math.round((1000 * db) / (db + di)) / 10;
}

/** Auth process CPU in cores between two snapshots (its CPU seconds over node seconds per CPU); -1 when not computable. */
export function gotrueCores(a: CpuSnap | null, b: CpuSnap | null): number {
  if (!a || !b || a.gotrueCpu < 0 || b.gotrueCpu < 0 || !b.ncpu) return -1;
  const nodeS = (b.busy - a.busy + (b.idle - a.idle)) / b.ncpu;
  if (nodeS <= 0) return -1;
  return Math.round((100 * (b.gotrueCpu - a.gotrueCpu)) / nodeS) / 100;
}
