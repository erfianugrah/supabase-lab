/**
 * Shared project, SQL and receiver plumbing for the pgnet-under-load modules.
 *
 * One Pro-org project per compute size per process, created on first use and
 * memoised: NL01/NL02 use a Micro, NL03/NL04 a Large (dedicated CPU). NL99
 * deletes every project this process created. Run the two pairs as separate
 * processes (`make micro`, `make large`) so they provision in parallel.
 *
 * PVLAB_NL_REF_MICRO / PVLAB_NL_REF_LARGE reuse an existing project
 * (development only; NL99 leaves a reused project alone, `make clean` lists
 * and deletes by the name prefix PVLAB_NL_PREFIX, default "pvlab-nl-").
 *
 * The receiver is the Worker in ../receiver (PVLAB_ENDPOINT_RECEIVER). It
 * records every arrival in a Durable Object ledger before answering, keyed by
 * run id; `ledger()` reads it back. Credentials (db password, service key)
 * are generated or fetched per run, held in memory, never logged.
 */
import { Client } from "pg";
import { mgmt } from "../../../harness/src/mgmt.js";
import { logsQuery } from "../../../harness/src/platform.js";
import type { Ctx, TestResult } from "../../../harness/src/types.js";

export const REGION = process.env.PVLAB_NL_REGION || "ap-southeast-1";
export const prefix = (): string => process.env.PVLAB_NL_PREFIX || "pvlab-nl-";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
export type Size = "micro" | "large";
export type Row = Record<string, unknown>;

export interface NlProject {
  ref: string;
  host: string;
  size: Size;
  dbPass: string;
  service: string;
  pgVersion: string;
  poolerHost: string;
  poolerUser: string;
  reused: boolean;
  createS: number;
}

const cache = new Map<Size, Promise<NlProject>>();
const created = new Map<Size, NlProject>();

export function skipWithout(ctx: Ctx, id: string, title: string): TestResult[] | null {
  if (!ctx.orgs.pro && !process.env.PVLAB_NL_REF_MICRO && !process.env.PVLAB_NL_REF_LARGE)
    return [{ id, title, status: "skip", detail: "PVLAB_ORG_PRO not set: no Pro org to create the project in" }];
  if (!ctx.endpoints.receiver) return [{ id, title, status: "skip", detail: "PVLAB_ENDPOINT_RECEIVER not set (make receiver-up)" }];
  return null;
}

export function ensureProject(ctx: Ctx, size: Size): Promise<NlProject> {
  let p = cache.get(size);
  if (!p) {
    p = create(ctx, size);
    cache.set(size, p);
  }
  return p;
}

export function createdProjects(): NlProject[] {
  return [...created.values()];
}

/** Replace the receiver URL and every project ref seen in this process with placeholders. */
export function scrub(ctx: Ctx, s: string): string {
  let t = s;
  const recv = ctx.endpoints.receiver ?? "";
  if (recv) t = t.split(recv).join("<receiver>");
  for (const p of created.values()) t = t.split(p.ref).join("<ref>");
  return t;
}

/** SQL as `postgres` through the Management API query endpoint. */
export async function sql(ctx: Ctx, ref: string, query: string, timeoutMs = 120_000): Promise<{ status: number; rows: Row[]; error: string }> {
  try {
    const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, timeoutMs);
    if (r.status < 300) return { status: r.status, rows: (Array.isArray(r.json) ? r.json : []) as Row[], error: "" };
    const msg = String((r.json as { message?: string } | undefined)?.message ?? r.text);
    return { status: r.status, rows: [], error: msg.replace(/^Failed to run sql query:\s*/, "").trim().slice(0, 400) };
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

/**
 * Objects every module uses. nl_post enqueues one net.http_post whose JSON
 * body carries the run, the call id, an optional message id and the enqueue
 * time on the database clock, and records the request id in nl_calls.
 * A null timeout calls http_post without the argument (the SQL default).
 */
export const BASE_SQL = `
create extension if not exists pg_net;
create table if not exists public.nl_calls (
  id bigint generated always as identity primary key,
  run text not null, tag text not null, target text not null, msg int,
  req_id bigint, enq_ms bigint not null, tmo int);
alter table public.nl_calls enable row level security;
create index if not exists nl_calls_run on public.nl_calls (run);
create index if not exists nl_calls_req on public.nl_calls (req_id);
create or replace function public.nl_post(p_run text, p_tag text, p_target text, p_url text, p_tmo int, p_msg int default null)
returns bigint language plpgsql as $f$
declare
  e bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  cid bigint;
  rid bigint;
  b jsonb;
begin
  insert into public.nl_calls(run, tag, target, msg, enq_ms, tmo) values (p_run, p_tag, p_target, p_msg, e, p_tmo) returning id into cid;
  b := jsonb_build_object('run', p_run, 'id', cid, 'msg', p_msg, 'enq_ms', e, 'target', p_target);
  if p_tmo is null then
    rid := net.http_post(url := p_url, body := b, headers := '{"Content-Type":"application/json"}'::jsonb);
  else
    rid := net.http_post(url := p_url, body := b, headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := p_tmo);
  end if;
  update public.nl_calls set req_id = rid where id = cid;
  return cid;
end $f$;
revoke execute on function public.nl_post(text, text, text, text, int, int) from public, anon, authenticated;
create or replace function public.nl_json(t text) returns jsonb language plpgsql immutable as $j$
begin return t::jsonb; exception when others then return null; end $j$;
`;

/** Calls of a run joined to their pg_net responses. */
export function callsSql(run: string, extraWhere = ""): string {
  return `select c.id, c.tag, c.target, c.msg, c.req_id, c.enq_ms, c.tmo,
    r.id is not null as has_resp, r.status_code, r.timed_out, r.error_msg,
    (public.nl_json(r.content) ->> 'arr_ms')::bigint as arr_ms_body,
    (public.nl_json(r.content) ->> 'q_ms')::int as q_ms,
    (extract(epoch from r.created) * 1000)::bigint as resp_ms
    from public.nl_calls c left join net._http_response r on r.id = c.req_id
    where c.run = '${run}' ${extraWhere} order by c.id`;
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
  return String((p?.json as { status?: string } | undefined)?.status ?? "");
}

async function create(ctx: Ctx, size: Size): Promise<NlProject> {
  const t0 = Date.now();
  let ref = (size === "micro" ? process.env.PVLAB_NL_REF_MICRO : process.env.PVLAB_NL_REF_LARGE) ?? "";
  const reused = Boolean(ref);
  // A reused project's password is unknown; the burners (NL03/NL04) need it via PVLAB_NL_DB_PASS.
  let dbPass = reused ? (process.env.PVLAB_NL_DB_PASS ?? "") : `${crypto.randomUUID().replaceAll("-", "")}Aa1!`;
  if (!reused) {
    const org = ctx.orgs.pro ?? "";
    if (!org) throw new Error("PVLAB_ORG_PRO not set");
    const res = await mgmt(ctx, "POST", "/projects", {
      organization_slug: org,
      name: `${prefix()}${size}-${t0}`,
      db_pass: dbPass,
      region: REGION,
      desired_instance_size: size,
    });
    ref = String((res.json as { ref?: string; id?: string } | undefined)?.ref ?? (res.json as { id?: string } | undefined)?.id ?? "");
    if (res.status !== 201 || !ref) throw new Error(`create project: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    console.error(`[NL] created ${size} project ${ref}`);
  }
  const stub: NlProject = { ref, host: `${ref}.supabase.co`, size, dbPass, service: "", pgVersion: "", poolerHost: "", poolerUser: "", reused, createS: 0 };
  // Registered before any wait, so NL99 can delete a project that never got healthy.
  if (!reused) created.set(size, stub);

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
  await sqlOk(ctx, ref, BASE_SQL);

  const k = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const rows = (Array.isArray(k.json) ? k.json : []) as { name: string; api_key?: string }[];
  const service = rows.find((x) => x.name === "service_role")?.api_key ?? "";
  if (!service) throw new Error("legacy service_role key absent");
  const pool = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`);
  const p0 = (Array.isArray(pool.json) ? pool.json[0] : undefined) as { db_host?: string; db_user?: string } | undefined;

  Object.assign(stub, {
    service,
    dbPass,
    pgVersion: version.split(" on ")[0] ?? version,
    poolerHost: p0?.db_host ?? `aws-0-${REGION}.pooler.supabase.com`,
    poolerUser: p0?.db_user ?? `postgres.${ref}`,
    createS: Math.round((Date.now() - t0) / 1000),
  });
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

export interface LedgerRow {
  id: number;
  msg: number | null;
  path: string;
  outcome: string;
  arr_ms: number;
  enq_ms: number | null;
  sleep_ms: number;
}

/** Every arrival the receiver recorded for one run. */
export async function ledger(ctx: Ctx, run: string): Promise<LedgerRow[]> {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${ctx.endpoints.receiver}/ledger?run=${encodeURIComponent(run)}`, { signal: AbortSignal.timeout(30_000) });
      if (r.ok) return (await r.json()) as LedgerRow[];
    } catch { /* retry */ }
    await sleep(3_000);
  }
  throw new Error(`receiver ledger for ${run} unreadable`);
}

/** Deploy an Edge Function from a source string (verify_jwt off) and return its id. */
export async function deployFunction(ctx: Ctx, ref: string, slug: string, body: string): Promise<string> {
  const dep = await mgmt(ctx, "POST", `/projects/${ref}/functions`, { slug, name: slug, verify_jwt: false, body });
  if (dep.status >= 300) throw new Error(`deploy ${slug}: HTTP ${dep.status} ${dep.text.slice(0, 160)}`);
  return String((dep.json as { id?: string } | undefined)?.id ?? "");
}

/** POST until the function answers 200, so cold deploy latency is out of the measured window. */
export async function warmFunction(url: string, tries = 24): Promise<number> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method: "POST", body: JSON.stringify({ run: "warmup", id: 0 }), headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (r.status === 200) return i + 1;
    } catch { /* retry */ }
    await sleep(5_000);
  }
  throw new Error(`${url.split("/").pop()} never answered 200`);
}

/** Wait until every call of a run has a response row, or the deadline passes. Returns the calls. */
export async function waitResponses(ctx: Ctx, ref: string, run: string, maxMs: number, extraWhere = ""): Promise<Row[]> {
  const t0 = Date.now();
  let rows: Row[] = [];
  while (Date.now() - t0 < maxMs) {
    rows = await sqlOk(ctx, ref, callsSql(run, extraWhere));
    if (rows.length > 0 && rows.every((r) => r.has_resp === true)) return rows;
    await sleep(5_000);
  }
  return rows;
}

// ---- statistics ---------------------------------------------------------------

export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? -1;
}

export function summary(xs: number[]): { n: number; min: number; p50: number; p95: number; max: number } {
  return { n: xs.length, min: xs.length ? Math.min(...xs) : -1, p50: pct(xs, 50), p95: pct(xs, 95), max: xs.length ? Math.max(...xs) : -1 };
}

export const fmt = (s: ReturnType<typeof summary>) => `n=${s.n} min ${s.min} p50 ${s.p50} p95 ${s.p95} max ${s.max} ms`;

/**
 * pg_net's timeout error_msg names the phase times. Pull every "<label>: <n> ms"
 * pair out of it; the labels are whatever the extension wrote.
 */
export function phases(msg: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of msg.matchAll(/([A-Za-z/ -]+?) time:?\s*(-?[\d.]+)\s*ms/g)) out[(m[1] ?? "").trim()] = Number(m[2]);
  return out;
}

// ---- CPU saturation and its control -------------------------------------------

export interface Burn {
  stop: () => Promise<{ started: number; errors: string[] }>;
}

/**
 * N session-pooler connections, each spinning a PL/pgSQL loop until `seconds`
 * pass (pure CPU, no temp files: a FROM-clause generate_series is materialised
 * into a tuplestore, NL01 records whether that spills). `stop` cancels them.
 */
export async function startBurn(ctx: Ctx, p: NlProject, n: number, seconds: number): Promise<Burn> {
  if (!p.dbPass) throw new Error("db password unknown (reused project without PVLAB_NL_DB_PASS)");
  const clients: Client[] = [];
  const errors: string[] = [];
  let started = 0;
  const runs: Promise<unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const c = new Client({ host: p.poolerHost, port: 5432, user: p.poolerUser, password: p.dbPass, database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000 });
    try {
      await c.connect();
      await c.query("set statement_timeout = 0");
      clients.push(c);
      started++;
      runs.push(
        c.query(`/* nl-burn */ do $b$ declare x bigint := 0; t timestamptz := clock_timestamp() + interval '${seconds} seconds';
          begin while clock_timestamp() < t loop x := x + 1; end loop; end $b$`).catch((e) => errors.push(errText(e))),
      );
    } catch (e) {
      errors.push(errText(e));
    }
  }
  return {
    stop: async () => {
      await sql(ctx, p.ref, "select count(pg_cancel_backend(pid)) as n from pg_stat_activity where query like '/* nl-burn */%' and pid <> pg_backend_pid()");
      await Promise.race([Promise.allSettled(runs), sleep(15_000)]);
      for (const c of clients) await c.end().catch(() => {});
      return { started, errors: errors.filter((e) => !/canceling statement due to user request/.test(e)) };
    },
  };
}

/** node_cpu_seconds_total from the project's metrics endpoint: busy and idle seconds summed over CPUs, and the CPU count. */
export async function cpuScrape(p: NlProject): Promise<{ status: number; busy: number; idle: number; cpus: number; t: number }> {
  const auth = Buffer.from(`service_role:${p.service}`).toString("base64");
  try {
    const res = await fetch(`https://${p.host}/customer/v1/privileged/metrics`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { status: res.status, busy: -1, idle: -1, cpus: -1, t: Date.now() };
    let busy = 0;
    let idle = 0;
    const cpus = new Set<string>();
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("node_cpu_seconds_total")) continue;
      const v = Number(line.slice(line.lastIndexOf(" ") + 1));
      const cpu = /cpu="(\d+)"/.exec(line)?.[1];
      if (cpu !== undefined) cpus.add(cpu);
      if (line.includes('mode="idle"')) idle += v;
      else if (!line.includes('mode="steal"') && !line.includes('mode="guest')) busy += v;
    }
    return { status: res.status, busy, idle, cpus: cpus.size, t: Date.now() };
  } catch {
    return { status: 0, busy: -1, idle: -1, cpus: -1, t: Date.now() };
  }
}

/** Busy fraction between two scrapes, -1 when the snapshot did not move. */
export function busyFrac(a: { busy: number; idle: number }, b: { busy: number; idle: number }): number {
  const db = b.busy - a.busy;
  const di = b.idle - a.idle;
  if (a.busy < 0 || b.busy < 0 || db + di <= 0) return -1;
  return Math.round((db / (db + di)) * 1000) / 1000;
}

/** function_logs event types for one function id since t0 (Boot, Shutdown, Log, ...). */
export async function functionEvents(ctx: Ctx, ref: string, fnId: string, t0: number, t1: number): Promise<{ rows: Row[]; error: string }> {
  const ts = (ms: number) => new Date(ms).toISOString().slice(0, 23).replace("T", " ");
  const q = `select log_attributes['event_type'] as et, count(*) as n from logs where source = 'function_logs' and log_attributes['function_id'] = '${fnId}' and timestamp >= toDateTime64('${ts(t0)}', 6) and timestamp < toDateTime64('${ts(t1)}', 6) group by et order by et`;
  let r = await logsQuery({ ...ctx, ref }, q, 6).catch((e) => ({ status: 0, rows: [], error: errText(e) }));
  for (let i = 0; i < 6 && /Too Many|Throttler|Backend error/i.test(r.error); i++) {
    await sleep(20_000);
    r = await logsQuery({ ...ctx, ref }, q, 6).catch((e) => ({ status: 0, rows: [], error: errText(e) }));
  }
  return { rows: r.rows as Row[], error: r.error };
}
