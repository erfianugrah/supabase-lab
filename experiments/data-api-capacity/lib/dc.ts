/**
 * Shared project and probes for the data-api-capacity modules.
 *
 * One Pro-org project per run, created Small on first use and memoised for the
 * process, so DC01..DC03 measure the SAME project in id order (DC01 needs the
 * untouched PostgREST config and resizes to Large at its end; DC02 then
 * mutates the PostgREST config; DC03 is independent of both). DC99 deletes it.
 *
 * PVLAB_DC_REF reuses an existing project instead of creating one (development
 * only: DC99 does not delete a reused project, and a project whose PostgREST
 * config was already patched no longer measures the default).
 *
 * Name prefix: PVLAB_DC_PREFIX (default "pvlab-dc-"); `lib/cleanup.ts` deletes
 * leftovers by that prefix.
 *
 * Credentials: the db password and the test user's password are generated per
 * run, held in memory, never logged. Evidence strings pass through `redact`.
 */
import { mgmt } from "../../../harness/src/mgmt.js";
import { logsQuery, type LogsResult } from "../../../harness/src/platform.js";
import type { Ctx, TestResult } from "../../../harness/src/types.js";

/** PVLAB_DC_REGION / PVLAB_DC_SIZE override the region and starting size (DC04 runs in ap-northeast-2). */
export const REGION = process.env.PVLAB_DC_REGION || "ap-southeast-1";
export const START_SIZE = process.env.PVLAB_DC_SIZE || "small";
export const prefix = (): string => process.env.PVLAB_DC_PREFIX || "pvlab-dc-";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

/** logsQuery that reports a client-side network error as an empty result instead of throwing. */
async function safeLogs(ctx: Ctx, q: string, hours: number): Promise<LogsResult> {
  try {
    return await logsQuery(ctx, q, hours);
  } catch (e) {
    return { status: 0, rows: [], error: errText(e) };
  }
}

export interface Keys {
  anon: string;
  service: string;
}

export interface DcProject {
  ref: string;
  host: string;
  keys: Keys;
  /** Access token of a signed-in confirmed user (role `authenticated`). */
  userJwt: string;
  pgVersion: string;
  reused: boolean;
  createMs: number;
}

let cached: Promise<DcProject> | null = null;
let current: DcProject | null = null;

export function skipWithoutPro(ctx: Ctx, id: string): TestResult[] | null {
  if (ctx.orgs.pro || process.env.PVLAB_DC_REF) return null;
  return [{ id, title: id, status: "skip", detail: "PVLAB_ORG_PRO not set: no Pro org to create the project in" }];
}

export function ensureProject(ctx: Ctx): Promise<DcProject> {
  if (!cached) cached = create(ctx);
  return cached;
}

export function currentProject(): DcProject | null {
  return current;
}

export const SETUP_SQL = `
create or replace function public.dc_sleep(s double precision) returns double precision
  language plpgsql as $$ begin perform pg_sleep(s); return s; end $$;
create or replace function public.dc_sleep_long(s double precision) returns double precision
  language plpgsql set statement_timeout = '30s' as $$ begin perform pg_sleep(s); return s; end $$;
create or replace function public.dc_sleep_xl(s double precision) returns double precision
  language plpgsql set statement_timeout = '180s' as $$ begin perform pg_sleep(s); return s; end $$;
create or replace function public.dc_ping() returns int language sql stable as $$ select 1 $$;
-- nextval is not rolled back with the transaction, so the sequence counts
-- executions even when the statement is then cancelled.
create sequence if not exists public.dc_seq;
create or replace function public.dc_tick_sleep(s double precision) returns bigint
  language plpgsql as $$ declare v bigint; begin v := nextval('public.dc_seq'); perform pg_sleep(s); return v; end $$;
grant usage, select on sequence public.dc_seq to anon, authenticated, service_role;
grant execute on function public.dc_sleep(double precision), public.dc_sleep_long(double precision),
  public.dc_sleep_xl(double precision), public.dc_ping(), public.dc_tick_sleep(double precision)
  to anon, authenticated, service_role;
notify pgrst, 'reload schema';`;

/** A 100,000-row table for point reads (DC04-DC06), readable by the API roles. */
const ITEMS_SQL = `
create table if not exists public.dc_items (id int primary key, payload text not null);
insert into public.dc_items select g, md5(g::text) from generate_series(1, 100000) g on conflict do nothing;
grant select on public.dc_items to anon, authenticated, service_role;
notify pgrst, 'reload schema';`;

let itemsReady: Promise<void> | null = null;

/** Create dc_items once per process and wait until the Data API serves it. */
export function ensureItems(ctx: Ctx, p: DcProject): Promise<void> {
  if (!itemsReady)
    itemsReady = (async () => {
      const setup = await sql(ctx, p.ref, ITEMS_SQL, 120_000);
      if (setup.error) throw new Error(`items setup: ${setup.error}`);
      for (let i = 0; i < 30; i++) {
        const r = await fetch(`https://${p.host}/rest/v1/dc_items?id=eq.1`, { headers: { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` } });
        if (r.status === 200) return;
        await sleep(2_000);
      }
      throw new Error("dc_items never answered 200 through the Data API");
    })();
  return itemsReady;
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
  return String((p?.json as { status?: string } | undefined)?.status ?? "");
}

async function create(ctx: Ctx): Promise<DcProject> {
  const t0 = Date.now();
  let ref = process.env.PVLAB_DC_REF ?? "";
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
  }
  // Registered before any wait, so DC99 can delete a project that never got healthy.
  current = { ref, host: `${ref}.supabase.co`, keys: { anon: "", service: "" }, userJwt: "", pgVersion: "", reused, createMs: 0 };

  let status = "";
  for (let i = 0; i < 120 && status !== "ACTIVE_HEALTHY"; i++) {
    if (i > 0) await sleep(10_000);
    status = await statusOf(ctx, ref);
  }
  if (status !== "ACTIVE_HEALTHY") throw new Error(`project not healthy: ${status}`);

  // ACTIVE_HEALTHY is not readiness (AGENTS.md): retry the first query.
  let version = "";
  for (let i = 0; i < 24 && !version; i++) {
    const r = await sql(ctx, ref, "select version() as v");
    version = String(r.rows?.[0]?.v ?? "");
    if (!version) await sleep(5_000);
  }
  if (!version) throw new Error("database never answered the management query");

  const setup = await sql(ctx, ref, SETUP_SQL);
  if (setup.error) throw new Error(`setup sql: ${setup.error}`);

  const k = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const rows = (Array.isArray(k.json) ? k.json : []) as { name: string; api_key?: string }[];
  const keys = { anon: rows.find((x) => x.name === "anon")?.api_key ?? "", service: rows.find((x) => x.name === "service_role")?.api_key ?? "" };
  if (!keys.anon || !keys.service) throw new Error("legacy anon/service_role keys absent");

  const host = `${ref}.supabase.co`;
  const email = `dc-${t0}@example.com`;
  const password = `${crypto.randomUUID().replaceAll("-", "")}Aa1!`;
  const cu = await fetch(`https://${host}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: keys.service, Authorization: `Bearer ${keys.service}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (cu.status >= 300 && cu.status !== 422) throw new Error(`admin create user: HTTP ${cu.status}`);
  const tok = await fetch(`https://${host}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: keys.anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const tj = (await tok.json().catch(() => ({}))) as { access_token?: string };
  if (!tj.access_token) throw new Error(`password sign-in: HTTP ${tok.status}`);

  // The schema reload is asynchronous: wait for the RPC to answer.
  for (let i = 0; i < 30; i++) {
    const r = await rpc(host, "dc_ping", {}, keys.anon, keys.anon);
    if (r.status === 200) break;
    await sleep(2_000);
  }

  current = { ref, host, keys, userJwt: tj.access_token, pgVersion: version.split(" on ")[0] ?? version, reused, createMs: Date.now() - t0 };
  return current;
}

/** Delete the project (idempotent) and wait until the listing drops it. Reused projects are left alone. */
export async function teardownProject(ctx: Ctx): Promise<{ deleteStatus: number; goneS: number; reused: boolean }> {
  const p = current;
  if (!p) return { deleteStatus: 0, goneS: -1, reused: false };
  if (p.reused) return { deleteStatus: 0, goneS: -1, reused: true };
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
  return { deleteStatus: del.status, goneS, reused: false };
}

export interface SqlResult {
  status: number;
  rows?: Record<string, unknown>[];
  error?: string;
}

/** SQL as `postgres` through the Management API query endpoint (answers 201). */
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

export interface RpcResult {
  status: number;
  ms: number;
  code: string;
  message: string;
  body: string;
}

/** POST /rest/v1/rpc/<fn>. `apikey` and `bearer` are passed separately so a user JWT can ride with the anon key. */
export async function rpc(host: string, fn: string, args: unknown, apikey: string, bearer: string, timeoutMs = 90_000, ua?: string): Promise<RpcResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(`https://${host}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", ...(ua ? { "User-Agent": ua } : {}) },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
      // A fresh connection per request. Run 1 (2026-10-22) recorded "The
      // socket connection was closed unexpectedly" (status 0) on 218 of 220
      // burst requests, run 2 status 0 without text, run 3 an ECONNRESET
      // from api.supabase.com; the first and third match a client reusing a
      // pooled socket the server had closed (a reading, not a probe).
      keepalive: false,
    });
    const body = await res.text();
    let code = "";
    let message = "";
    try {
      const j = JSON.parse(body) as { code?: string; message?: string };
      if (j && typeof j === "object" && !Array.isArray(j)) {
        code = String(j.code ?? "");
        message = String(j.message ?? "");
      }
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, ms: Math.round(performance.now() - t0), code, message, body: body.replace(/\s+/g, " ").slice(0, 300) };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), code: "client", message: errText(e), body: "" };
  }
}

/** The PostgREST config as the Management API reports it. */
export async function postgrestConfig(ctx: Ctx, ref: string): Promise<{ status: number; dbPool: string; acqTimeout: string; maxRows: string }> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/postgrest`).catch((e) => ({ status: 0, text: errText(e), json: undefined, throttled: false }));
  const j = (r.json ?? {}) as { db_pool?: number | null; db_pool_acquisition_timeout?: number | null; max_rows?: number };
  return { status: r.status, dbPool: String(j.db_pool ?? "null"), acqTimeout: String(j.db_pool_acquisition_timeout ?? "null"), maxRows: String(j.max_rows ?? "") };
}

/** PATCH /postgrest; one retry on a client-side network error (run 3 died on an unhandled ECONNRESET here). */
export async function patchPostgrest(ctx: Ctx, ref: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await mgmt(ctx, "PATCH", `/projects/${ref}/postgrest`, body);
      return { status: r.status, text: r.text.replace(/\s+/g, " ").slice(0, 300) };
    } catch (e) {
      if (attempt >= 1) return { status: 0, text: errText(e) };
      await sleep(5_000);
    }
  }
}

export interface AuthenticatorCounts {
  /** All backends logged in as `authenticator` (PostgREST's login role). */
  total: number;
  /** Of those, sleeping in pg_sleep right now. */
  sleeping: number;
  /** All client backends (any role). */
  clients: number;
  maxConnections: number;
  appNames: string;
}

export async function authenticatorCounts(ctx: Ctx, ref: string): Promise<AuthenticatorCounts | null> {
  const r = await sql(
    ctx,
    ref,
    `select count(*) filter (where usename = 'authenticator')::int as total,
            count(*) filter (where usename = 'authenticator' and wait_event = 'PgSleep')::int as sleeping,
            count(*) filter (where backend_type = 'client backend')::int as clients,
            current_setting('max_connections')::int as max_connections,
            coalesce(string_agg(distinct application_name, ',') filter (where usename = 'authenticator'), '') as app_names
       from pg_stat_activity`,
    30_000,
  );
  const row = r.rows?.[0];
  if (!row) return null;
  return {
    total: Number(row.total),
    sleeping: Number(row.sleeping),
    clients: Number(row.clients),
    maxConnections: Number(row.max_connections),
    appNames: String(row.app_names),
  };
}

export interface BurstResult {
  k: number;
  sleepS: number;
  /** status -> count, e.g. "200":10, "504":50 */
  byStatus: Record<string, number>;
  /** error code -> count, e.g. "PGRST003":50 */
  byCode: Record<string, number>;
  ok: number;
  pgrst003: number;
  /** Latencies of the PGRST003 answers (ms). */
  p003Min: number;
  p003Med: number;
  p003Max: number;
  okMin: number;
  okMax: number;
  /** pg_stat_activity read mid-burst. */
  mid: AuthenticatorCounts | null;
  sample003: string;
  sampleOther: string;
}

const median = (xs: number[]) => {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? -1;
};

/**
 * Fire K concurrent dc_sleep_xl(sleepS) calls with the service_role key and
 * read pg_stat_activity at `midS`. The function carries its own 180 s
 * statement_timeout: service_role has no role setting, so without it the 8 s
 * login default of `authenticator` would cut every sleep short (measured
 * 2026-10-22). With K above the pool, the mid-burst count of `authenticator`
 * backends in PgSleep is the pool. The request outcomes are NOT a clean pool
 * count: something between the client and PostgREST, not identified, sends
 * a request again after a PGRST003, so queued requests outlive the
 * acquisition timeout (see DC01b, DC02b) and arrive in waves.
 */
export async function burst(ctx: Ctx, p: DcProject, k: number, sleepS: number, midS: number): Promise<BurstResult> {
  const calls = Array.from({ length: k }, () => rpc(p.host, "dc_sleep_xl", { s: sleepS }, p.keys.service, p.keys.service, (sleepS + 60) * 1000));
  await sleep(midS * 1000);
  const mid = await authenticatorCounts(ctx, p.ref);
  const rs = await Promise.all(calls);
  const byStatus: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  for (const r of rs) {
    byStatus[String(r.status)] = (byStatus[String(r.status)] ?? 0) + 1;
    if (r.code) byCode[r.code] = (byCode[r.code] ?? 0) + 1;
  }
  const p003 = rs.filter((r) => r.code === "PGRST003").map((r) => r.ms);
  const okMs = rs.filter((r) => r.status === 200).map((r) => r.ms);
  const other = rs.find((r) => r.status !== 200 && r.code !== "PGRST003");
  return {
    k,
    sleepS,
    byStatus,
    byCode,
    ok: okMs.length,
    pgrst003: p003.length,
    p003Min: p003.length ? Math.min(...p003) : -1,
    p003Med: median(p003),
    p003Max: p003.length ? Math.max(...p003) : -1,
    okMin: okMs.length ? Math.min(...okMs) : -1,
    okMax: okMs.length ? Math.max(...okMs) : -1,
    mid,
    sample003: rs.find((r) => r.code === "PGRST003")?.body ?? "",
    sampleOther: other ? `${other.status} ${other.body || other.message}` : "",
  };
}

export interface ProbeOutcome {
  ua: string;
  status: number;
  code: string;
  ms: number;
  body: string;
}

/**
 * Hold every pooled connection with `poolSize` dc_sleep_xl(holdS) calls, wait
 * `settleS`, then send `probes` single dc_ping requests, each with its own
 * User-Agent so the PostgREST access log lines it caused can be counted per
 * client request afterwards (`linesForUa`). Returns once the holders finish.
 */
export async function saturateAndProbe(
  ctx: Ctx,
  p: DcProject,
  poolSize: number,
  holdS: number,
  probes: number,
  tag: string,
  settleS = 6,
): Promise<{ probes: ProbeOutcome[]; sleepingAtProbe: number; holdersOk: number; holderOutcomes: string }> {
  const holders = Array.from({ length: poolSize }, () => rpc(p.host, "dc_sleep_xl", { s: holdS }, p.keys.service, p.keys.service, (holdS + 60) * 1000));
  await sleep(settleS * 1000);
  const c = await authenticatorCounts(ctx, p.ref);
  const runId = Date.now().toString(36);
  const outs = await Promise.all(
    Array.from({ length: probes }, async (_, i) => {
      const ua = `pvlab-dc-${tag}-${runId}-${i}`;
      const r = await rpc(p.host, "dc_ping", {}, p.keys.service, p.keys.service, (holdS + 60) * 1000, ua);
      return { ua, status: r.status, code: r.code, ms: r.ms, body: r.body };
    }),
  );
  const hs = await Promise.all(holders);
  const hb: Record<string, number> = {};
  for (const h of hs) hb[`${h.status}${h.code ? `/${h.code}` : ""}`] = (hb[`${h.status}${h.code ? `/${h.code}` : ""}`] ?? 0) + 1;
  return { probes: outs, sleepingAtProbe: c?.sleeping ?? -1, holdersOk: hs.filter((h) => h.status === 200).length, holderOutcomes: fmtCounts(hb) };
}

/**
 * PostgREST access-log lines carrying `ua`, by HTTP status. postgrest_logs
 * ingestion lags by tens of seconds, so poll until two reads agree.
 */
export async function linesForUa(ctx: Ctx, ref: string, ua: string, maxWaitS = 120): Promise<{ total: number; byStatus: string; error: string }> {
  const c: Ctx = { ...ctx, ref };
  const q = `select event_message from logs where source = 'postgrest_logs' and event_message like '%${ua}%' limit 200`;
  const t0 = Date.now();
  let prev = -1;
  let last = { total: 0, byStatus: "", error: "" };
  while (Date.now() - t0 < maxWaitS * 1000) {
    const r = await safeLogs(c, q, 2);
    const by: Record<string, number> = {};
    for (const row of r.rows) {
      const m = String(row.event_message ?? "").match(/" (\d{3}) /);
      const s = m?.[1] ?? "?";
      by[s] = (by[s] ?? 0) + 1;
    }
    last = { total: r.rows.length, byStatus: fmtCounts(by) || "none", error: r.error };
    if (r.rows.length > 0 && r.rows.length === prev) return last;
    prev = r.rows.length;
    await sleep(20_000);
  }
  return last;
}

export async function seqValue(ctx: Ctx, ref: string): Promise<number> {
  const r = await sql(ctx, ref, "select last_value::bigint as v, is_called from public.dc_seq");
  const row = r.rows?.[0];
  if (!row) return -1;
  return row.is_called ? Number(row.v) : 0;
}

export const fmtCounts = (o: Record<string, number>) =>
  Object.entries(o)
    .sort()
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");

export function burstColumns(prefix: string, b: BurstResult): Record<string, number | string> {
  return {
    [`${prefix}_k`]: b.k,
    [`${prefix}_ok`]: b.ok,
    [`${prefix}_pgrst003`]: b.pgrst003,
    [`${prefix}_statuses`]: fmtCounts(b.byStatus),
    [`${prefix}_codes`]: fmtCounts(b.byCode) || "none",
    [`${prefix}_p003_ms_min`]: b.p003Min,
    [`${prefix}_p003_ms_med`]: b.p003Med,
    [`${prefix}_p003_ms_max`]: b.p003Max,
    [`${prefix}_mid_authenticator_total`]: b.mid?.total ?? -1,
    [`${prefix}_mid_authenticator_sleeping`]: b.mid?.sleeping ?? -1,
    [`${prefix}_mid_client_backends`]: b.mid?.clients ?? -1,
  };
}

export interface Outage {
  samples: number;
  failed: number;
  firstFailS: number;
  lastFailS: number;
  maxContiguousS: number;
  failStatuses: string;
  sampleFail: string;
}

/** Ping dc_ping every `everyMs` for `forS` seconds starting now; `op` runs once at t=0. */
export async function sampleDuring(p: DcProject, forS: number, everyMs: number, op: () => Promise<unknown>): Promise<{ outage: Outage; opResult: unknown }> {
  const t0 = Date.now();
  const opP = op().catch((e) => ({ status: 0, text: errText(e) }));
  const fails: { t: number; s: string }[] = [];
  let samples = 0;
  let runStart = -1;
  let maxRun = 0;
  let sampleFail = "";
  const statuses: Record<string, number> = {};
  while (Date.now() - t0 < forS * 1000) {
    const ts = Date.now();
    const r = await rpc(p.host, "dc_ping", {}, p.keys.anon, p.keys.anon, 10_000);
    samples++;
    const t = (ts - t0) / 1000;
    if (r.status !== 200) {
      fails.push({ t, s: String(r.status) });
      statuses[`${r.status}${r.code ? `/${r.code}` : ""}`] = (statuses[`${r.status}${r.code ? `/${r.code}` : ""}`] ?? 0) + 1;
      if (!sampleFail) sampleFail = `${r.status} ${r.body || r.message}`.slice(0, 200);
      if (runStart < 0) runStart = t;
      maxRun = Math.max(maxRun, (Date.now() - t0) / 1000 - runStart);
    } else {
      runStart = -1;
    }
    const wait = everyMs - (Date.now() - ts);
    if (wait > 0) await sleep(wait);
  }
  const opResult = await opP;
  return {
    outage: {
      samples,
      failed: fails.length,
      firstFailS: fails.length ? Math.round(fails[0]!.t * 10) / 10 : -1,
      lastFailS: fails.length ? Math.round(fails[fails.length - 1]!.t * 10) / 10 : -1,
      maxContiguousS: Math.round(maxRun * 10) / 10,
      failStatuses: fmtCounts(statuses) || "none",
      sampleFail,
    },
    opResult,
  };
}

/**
 * Wait for the first "Starting PostgREST" line whose event time is after
 * `patchMs`. A config PATCH restarts PostgREST, not always at once: run 4
 * measured 0.5 to 0.9 s with nothing long in flight and 55.3 s with 60 s
 * requests in flight (run 1 did not record PATCH times). The delay is
 * computed from the log line's own timestamp, so ingestion lag does not
 * inflate it; it only bounds how long this waits. -1 if none by `maxS`.
 */
export async function waitRestart(ctx: Ctx, ref: string, patchMs: number, maxS = 420): Promise<{ delayS: number; waitedS: number }> {
  const c: Ctx = { ...ctx, ref };
  const t0 = Date.now();
  while (Date.now() - t0 < maxS * 1000) {
    const back = Math.ceil((Date.now() - patchMs) / 1000) + 10;
    const r = await safeLogs(
      c,
      `select timestamp from logs where source = 'postgrest_logs' and event_message like '%Starting PostgREST%' and timestamp > now() - interval ${back} second order by timestamp limit 20`,
      1,
    );
    const ts = r.rows
      .map((x) => Date.parse(`${String(x.timestamp ?? "").replace(/Z?$/, "Z")}`))
      .filter((t) => Number.isFinite(t) && t >= patchMs - 1_000)
      .sort((a, b) => a - b);
    if (ts.length) return { delayS: Math.round((ts[0]! - patchMs) / 100) / 10, waitedS: Math.round((Date.now() - t0) / 1000) };
    await sleep(15_000);
  }
  return { delayS: -1, waitedS: Math.round((Date.now() - t0) / 1000) };
}

/** Ping until `n` consecutive 200s; seconds taken, or -1 by `maxS`. */
export async function untilHealthy(p: DcProject, n = 5, maxS = 300): Promise<number> {
  const t0 = Date.now();
  let ok = 0;
  while (Date.now() - t0 < maxS * 1000) {
    const r = await rpc(p.host, "dc_ping", {}, p.keys.anon, p.keys.anon, 10_000);
    ok = r.status === 200 ? ok + 1 : 0;
    if (ok >= n) return Math.round((Date.now() - t0) / 1000);
    await sleep(1_000);
  }
  return -1;
}

/** Count "Starting PostgREST" lines in postgrest_logs since `sinceMs` (epoch ms). Ingestion lags; call it late. */
export async function postgrestStarts(ctx: Ctx, ref: string, sinceMs: number): Promise<{ count: number; error: string; times: string }> {
  const c: Ctx = { ...ctx, ref };
  const back = Math.ceil((Date.now() - sinceMs) / 1000) + 5;
  const r = await safeLogs(
    c,
    `select timestamp, event_message from logs where source = 'postgrest_logs' and event_message like '%Starting PostgREST%' and timestamp > now() - interval ${back} second order by timestamp limit 50`,
    3,
  );
  return { count: r.rows.length, error: r.error, times: r.rows.map((x) => String(x.timestamp ?? "")).join(",").slice(0, 400) };
}

/**
 * Resize through the compute add-on and wait until Postgres reports the
 * target's max_connections, the project is ACTIVE_HEALTHY, and the Data API
 * answered 5 consecutive pings.
 */
export async function resize(ctx: Ctx, p: DcProject, variant: string, wantMaxConn: number, maxMs = 20 * 60_000, watchS = 300, fromMaxConn = -1): Promise<{ status: number; text: string; settledS: number; maxConn: number; watch?: Outage }> {
  const t0 = Date.now();
  let r = await mgmt(ctx, "PATCH", `/projects/${p.ref}/billing/addons`, { addon_type: "compute_instance", addon_variant: variant });
  for (let i = 0; i < 4 && r.status === 429; i++) {
    await sleep(60_000);
    r = await mgmt(ctx, "PATCH", `/projects/${p.ref}/billing/addons`, { addon_type: "compute_instance", addon_variant: variant });
  }
  if (r.status >= 300) return { status: r.status, text: r.text.slice(0, 200), settledS: -1, maxConn: -1 };
  let maxConn = -1;
  while (Date.now() - t0 < maxMs) {
    await sleep(10_000);
    const q = await sql(ctx, p.ref, "select current_setting('max_connections')::int as m", 20_000);
    maxConn = Number(q.rows?.[0]?.m ?? -1);
    // wantMaxConn <= 0: target figure unknown, accept any change from fromMaxConn.
    if (wantMaxConn > 0 ? maxConn !== wantMaxConn : maxConn <= 0 || maxConn === fromMaxConn) continue;
    if ((await statusOf(ctx, p.ref)) !== "ACTIVE_HEALTHY") continue;
    let okRun = 0;
    for (let i = 0; i < 20 && okRun < 5; i++) {
      const ping = await rpc(p.host, "dc_ping", {}, p.keys.anon, p.keys.anon, 10_000);
      okRun = ping.status === 200 ? okRun + 1 : 0;
      await sleep(1_000);
    }
    if (okRun >= 5) {
      const settledS = Math.round((Date.now() - t0) / 1000);
      // Run 2 (2026-10-22) passed this check 41 s after the PATCH and then
      // saw the Data API fail for minutes: watch for a late second phase.
      const { outage } = await sampleDuring(p, watchS, 1_000, async () => undefined);
      return { status: r.status, text: "", settledS, maxConn, watch: outage };
    }
  }
  return { status: r.status, text: "timed out waiting for the resize to settle", settledS: -1, maxConn };
}

export const redact = (s: string): string => (current ? s.replaceAll(current.ref, "<ref>") : s);

/** Facts one module hands the next within a run (DC01 measures, DC02 reuses). */
export const state: { smallPool: number; largePool: number } = { smallPool: -1, largePool: -1 };
