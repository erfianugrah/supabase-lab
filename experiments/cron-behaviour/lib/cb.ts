/**
 * Shared project and SQL plumbing for the cron-behaviour modules.
 *
 * One Pro-org Micro per process, created on first use and memoised; CB99
 * deletes it. Every module that needs the project calls `ensureProject`, so
 * any subset of CB01..CB05 runs on its own. Run two processes in parallel
 * (`make run LABEL=a` and `make run LABEL=b`) for n=2 on separate projects.
 *
 * PVLAB_CB_REF reuses an existing project (development only; CB99 leaves a
 * reused project alone). Leftovers are found by the name prefix PVLAB_CB_PREFIX
 * (default "cb-"): `make clean` lists them, `make clean DELETE=1` deletes.
 */
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx, TestResult } from "../../../harness/src/types.js";

export const REGION = process.env.PVLAB_CB_REGION || "ap-southeast-1";
export const prefix = (): string => process.env.PVLAB_CB_PREFIX || "cb-";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
export type Row = Record<string, unknown>;

export interface CbProject {
  ref: string;
  pgVersion: string;
  reused: boolean;
  createS: number;
}

let cached: Promise<CbProject> | undefined;
let created: CbProject | undefined;

export function skipWithout(ctx: Ctx, id: string, title: string): TestResult[] | null {
  if (!ctx.orgs.pro && !process.env.PVLAB_CB_REF)
    return [{ id, title, status: "skip", detail: "PVLAB_ORG_PRO not set: no Pro org to create the project in" }];
  return null;
}

export function ensureProject(ctx: Ctx): Promise<CbProject> {
  if (!cached) cached = create(ctx);
  return cached;
}

export const createdProject = (): CbProject | undefined => created;

/** Replace the project ref with a placeholder. */
export function scrub(s: string): string {
  return created ? s.split(created.ref).join("<ref>") : s;
}

/** SQL as `postgres` through the Management API query endpoint. */
export async function sql(ctx: Ctx, ref: string, query: string, timeoutMs = 120_000): Promise<{ status: number; rows: Row[]; error: string }> {
  try {
    const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, timeoutMs);
    if (r.status < 300) return { status: r.status, rows: (Array.isArray(r.json) ? r.json : []) as Row[], error: "" };
    const msg = String((r.json as { message?: string } | undefined)?.message ?? r.text);
    return { status: r.status, rows: [], error: msg.replace(/^Failed to run sql query:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 400) };
  } catch (e) {
    return { status: 0, rows: [], error: errText(e) };
  }
}

export async function sqlOk(ctx: Ctx, ref: string, query: string, timeoutMs = 120_000): Promise<Row[]> {
  let r = await sql(ctx, ref, query, timeoutMs);
  // The query endpoint answers a throttle or a transient 5xx now and then; a real SQL error is a 400.
  for (let i = 0; i < 4 && (r.status === 0 || r.status === 429 || r.status >= 500); i++) {
    await sleep(5_000);
    r = await sql(ctx, ref, query, timeoutMs);
  }
  if (r.error) throw new Error(`SQL ${r.status}: ${r.error}`);
  return r.rows;
}

export async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
  return String((p?.json as { status?: string } | undefined)?.status ?? "");
}

async function create(ctx: Ctx): Promise<CbProject> {
  const t0 = Date.now();
  let ref = process.env.PVLAB_CB_REF ?? "";
  const reused = Boolean(ref);
  if (!reused) {
    const org = ctx.orgs.pro ?? "";
    if (!org) throw new Error("PVLAB_ORG_PRO not set");
    const res = await mgmt(ctx, "POST", "/projects", {
      organization_slug: org,
      name: `${prefix()}micro-${t0}`,
      db_pass: `${crypto.randomUUID().replaceAll("-", "")}Aa1!`,
      region: REGION,
      desired_instance_size: "micro",
    });
    ref = String((res.json as { ref?: string; id?: string } | undefined)?.ref ?? (res.json as { id?: string } | undefined)?.id ?? "");
    if (res.status !== 201 || !ref) throw new Error(`create project: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    console.error(`[CB] created micro project ${ref}`);
  }
  const stub: CbProject = { ref, pgVersion: "", reused, createS: 0 };
  // Registered before any wait, so CB99 can delete a project that never got healthy.
  if (!reused) created = stub;

  let status = "";
  for (let i = 0; i < 120 && status !== "ACTIVE_HEALTHY"; i++) {
    if (i > 0) await sleep(10_000);
    status = await statusOf(ctx, ref);
  }
  if (status !== "ACTIVE_HEALTHY") throw new Error(`project not healthy: ${status}`);
  // ACTIVE_HEALTHY is not readiness: retry the first query.
  let version = "";
  for (let i = 0; i < 24 && !version; i++) {
    const r = await sql(ctx, ref, "select version() as v");
    version = String(r.rows[0]?.v ?? "");
    if (!version) await sleep(5_000);
  }
  if (!version) throw new Error("database never answered the management query");
  await sqlOk(ctx, ref, "create extension if not exists pg_cron");
  stub.pgVersion = version.split(" on ")[0] ?? version;
  stub.createS = Math.round((Date.now() - t0) / 1000);
  return stub;
}

/** Delete the project and wait until the listing drops it. */
export async function deleteProject(ctx: Ctx, ref: string): Promise<{ deleteStatus: number; goneS: number }> {
  let del = await mgmt(ctx, "DELETE", `/projects/${ref}`);
  for (let i = 0; i < 3 && (del.status === 429 || del.throttled); i++) {
    await sleep(30_000);
    del = await mgmt(ctx, "DELETE", `/projects/${ref}`);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    const l = await mgmt(ctx, "GET", "/projects");
    const arr = (Array.isArray(l.json) ? l.json : []) as { id?: string; ref?: string }[];
    if (l.status === 200 && !arr.some((x) => (x.ref ?? x.id) === ref)) return { deleteStatus: del.status, goneS: Math.round((Date.now() - t0) / 1000) };
    await sleep(10_000);
  }
  return { deleteStatus: del.status, goneS: -1 };
}

/** pg_cron version and every cron.* setting with its pg_settings context. */
export async function cronFacts(ctx: Ctx, ref: string): Promise<{ version: string; settings: Row[] }> {
  const v = await sqlOk(ctx, ref, "select extversion from pg_extension where extname = 'pg_cron'");
  const s = await sqlOk(ctx, ref, "select name, setting, context from pg_settings where name like 'cron.%' order by name");
  return { version: String(v[0]?.extversion ?? "absent"), settings: s };
}

/**
 * Schedule a job, preferring an interval schedule ('N seconds') and falling
 * back to every minute if the hosted pg_cron refuses it. Returns the jobid
 * and the schedule actually used.
 */
export async function schedule(ctx: Ctx, ref: string, name: string, sched: string, command: string): Promise<{ jobid: number; schedule: string; refused?: string }> {
  const q = (s: string) => `select cron.schedule('${name}', '${s}', $cmd$${command}$cmd$) as jobid`;
  const r = await sql(ctx, ref, q(sched));
  if (!r.error) return { jobid: Number(r.rows[0]?.jobid), schedule: sched };
  if (sched.includes("second")) {
    const rows = await sqlOk(ctx, ref, q("* * * * *"));
    return { jobid: Number(rows[0]?.jobid), schedule: "* * * * *", refused: r.error };
  }
  throw new Error(`cron.schedule ${name}: ${r.error}`);
}

export async function unschedule(ctx: Ctx, ref: string, name: string): Promise<void> {
  await sql(ctx, ref, `select cron.unschedule(jobid) from cron.job where jobname = '${name}'`);
}

export interface RunRow {
  runid: number;
  status: string;
  msg: string;
  startMs: number;
  endMs: number;
}

/** cron.job_run_details for one job, oldest first; times as epoch ms (-1 when null). */
export async function runs(ctx: Ctx, ref: string, jobid: number): Promise<RunRow[]> {
  const rows = await sqlOk(
    ctx,
    ref,
    `select runid, status, coalesce(return_message, '') as msg,
       coalesce((extract(epoch from start_time) * 1000)::bigint, -1) as s,
       coalesce((extract(epoch from end_time) * 1000)::bigint, -1) as e
     from cron.job_run_details where jobid = ${jobid} order by runid`,
  );
  return rows.map((r) => ({ runid: Number(r.runid), status: String(r.status), msg: String(r.msg), startMs: Number(r.s), endMs: Number(r.e) }));
}

/** Wait until a job has `n` runs that are no longer `running`, or the deadline passes. */
export async function waitRuns(ctx: Ctx, ref: string, jobid: number, n: number, maxMs: number): Promise<RunRow[]> {
  const t0 = Date.now();
  let rs: RunRow[] = [];
  while (Date.now() - t0 < maxMs) {
    rs = await runs(ctx, ref, jobid);
    if (rs.filter((r) => r.status !== "running" && r.status !== "starting").length >= n) return rs;
    await sleep(3_000);
  }
  return rs;
}

// ---- statistics ---------------------------------------------------------------

export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? -1;
}

export const r1 = (n: number) => Math.round(n * 10) / 10;
export const hms = (ms: number) => (ms < 0 ? "-" : new Date(ms).toISOString().slice(11, 23));
export const tally = (xs: string[]) => {
  const t: Record<string, number> = {};
  for (const x of xs) t[x] = (t[x] ?? 0) + 1;
  return Object.entries(t).map(([k, v]) => `${k}: ${v}`).join("; ");
};
