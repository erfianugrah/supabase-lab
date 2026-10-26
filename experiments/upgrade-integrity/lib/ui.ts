/**
 * Shared project, fixture and integrity checks for the upgrade-integrity modules.
 *
 * One Pro-org project per run, created on Postgres 15 (`postgres_engine: "15"`
 * on POST /v1/projects; the OpenAPI document types the field deprecated null,
 * a 2026-10-23 probe showed it accepted and applied) and memoised for the
 * process, so UI01..UI06 act on the SAME project in id order and UI99 deletes
 * it.
 *
 * Every catalog query runs as the Management API's SQL user through
 * POST /v1/projects/{ref}/database/query. VACUUM runs through the session
 * pooler with the generated password, because VERBOSE output arrives as INFO
 * notices and the Management API returns rows only.
 *
 * PVLAB_UI_REF reuses an existing project (development only: UI99 leaves a
 * reused project alone, and UI03 upgrades whatever it is pointed at).
 * Name prefix: PVLAB_UI_PREFIX (default "pvlab-ui-"); `lib/cleanup.ts`
 * lists and deletes leftovers by that prefix.
 */
import { Client } from "pg";
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx, TestResult } from "../../../harness/src/types.js";

export const REGION = process.env.PVLAB_UI_REGION || "ap-southeast-1";
export const SIZE = process.env.PVLAB_UI_SIZE || "micro";
export const ENGINE = process.env.PVLAB_UI_ENGINE || "15";
export const prefix = (): string => process.env.PVLAB_UI_PREFIX || "pvlab-ui-";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
export const SCHEMAS = ["public", "cron", "pgmq"];
export const QUEUE = "ui_q";

export interface UiProject {
  ref: string;
  password: string;
  reused: boolean;
  createStatus: number;
  createBody: string;
  createMs: number;
  /** `database` block of GET /projects/{ref} right after healthy. */
  database: Record<string, unknown>;
  version: string;
}

let cached: Promise<UiProject> | null = null;
let current: UiProject | null = null;

export function currentProject(): UiProject | null {
  return current;
}

export function skipWithoutPro(ctx: Ctx, id: string): TestResult[] | null {
  if (ctx.orgs.pro || process.env.PVLAB_UI_REF) return null;
  return [{ id, title: id, status: "skip", detail: "PVLAB_ORG_PRO not set: no Pro org to create the project in" }];
}

export function ensureProject(ctx: Ctx): Promise<UiProject> {
  if (!cached) cached = create(ctx);
  return cached;
}

/** Replace the project ref and org slug in evidence text (publish-evidence redacts by shape as well). */
export function redact(s: string): string {
  let out = s;
  if (current?.ref) out = out.split(current.ref).join("<ref>");
  const org = process.env.PVLAB_ORG_PRO;
  if (org) out = out.split(org).join("<org>");
  // Instance addresses in connection errors (ECONNREFUSED <v6>:5432).
  out = out.replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}:[0-9a-f]{1,4}\b/gi, "<ipv6>");
  return out;
}

export async function projectStatus(ctx: Ctx, ref: string): Promise<{ status: string; database: Record<string, unknown> }> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
  const j = (p?.json ?? {}) as { status?: string; database?: Record<string, unknown> };
  return { status: String(j.status ?? ""), database: j.database ?? {} };
}

async function create(ctx: Ctx): Promise<UiProject> {
  const t0 = Date.now();
  let ref = process.env.PVLAB_UI_REF ?? "";
  const reused = Boolean(ref);
  const password = process.env.PVLAB_UI_DB_PASS || `${crypto.randomUUID().replaceAll("-", "")}Aa1!`;
  let createStatus = 0;
  let createBody = "";
  if (!reused) {
    const org = ctx.orgs.pro ?? "";
    if (!org) throw new Error("PVLAB_ORG_PRO not set");
    const res = await mgmt(ctx, "POST", "/projects", {
      organization_slug: org,
      name: `${prefix()}${t0}`,
      db_pass: password,
      region: REGION,
      desired_instance_size: SIZE,
      postgres_engine: ENGINE,
    });
    createStatus = res.status;
    const j = (res.json ?? {}) as Record<string, unknown>;
    ref = String(j.ref ?? j.id ?? "");
    // The create response carries no secrets; keep it whole minus the org id.
    createBody = redact(JSON.stringify({ ...j, organization_id: undefined, organization_slug: undefined }));
    if (res.status !== 201 || !ref) throw new Error(`create project: HTTP ${res.status} ${res.text.slice(0, 300)}`);
  }
  current = { ref, password, reused, createStatus, createBody: redact(createBody), createMs: 0, database: {}, version: "" };

  let st = { status: "", database: {} as Record<string, unknown> };
  for (let i = 0; i < 120 && st.status !== "ACTIVE_HEALTHY"; i++) {
    if (i > 0) await sleep(10_000);
    st = await projectStatus(ctx, ref);
  }
  if (st.status !== "ACTIVE_HEALTHY") throw new Error(`project not healthy: ${st.status}`);
  // ACTIVE_HEALTHY is not readiness (AGENTS.md): retry the first query.
  let version = "";
  for (let i = 0; i < 36 && !version; i++) {
    const r = await sql(ctx, ref, "select current_setting('server_version') as v");
    version = String(r.rows?.[0]?.v ?? "");
    if (!version) await sleep(5_000);
  }
  if (!version) throw new Error("database never answered the management query");
  current = { ...current, createMs: Date.now() - t0, database: st.database, version };
  current.createBody = redact(createBody);
  return current;
}

/** Delete the project (idempotent) and wait until GET /projects stops listing it. */
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
  while (Date.now() - t0 < 300_000) {
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

/** SQL through the Management API query endpoint (answers 201). */
export async function sql(ctx: Ctx, ref: string, query: string, timeoutMs = 60_000): Promise<SqlResult> {
  try {
    const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, timeoutMs);
    if (r.status < 300) return { status: r.status, rows: (Array.isArray(r.json) ? r.json : []) as Record<string, unknown>[] };
    const msg = String((r.json as { message?: string } | undefined)?.message ?? (r.throttled ? "throttled (HTML)" : r.text));
    return { status: r.status, error: msg.replace(/^Failed to run sql query:\s*/, "").trim().slice(0, 400) };
  } catch (e) {
    return { status: 0, error: errText(e) };
  }
}

/** sql() that throws on error, for setup steps whose failure ends the module. */
export async function sqlOk(ctx: Ctx, ref: string, query: string, what: string): Promise<Record<string, unknown>[]> {
  const r = await sql(ctx, ref, query, 120_000);
  if (r.error) throw new Error(`${what}: HTTP ${r.status} ${r.error}`);
  return r.rows ?? [];
}

/* ---------- fixture ---------- */

/** The extensions, tables, queue and functions the cron jobs exercise. */
export const FIXTURE_SQL = `
create extension if not exists pg_cron;
create extension if not exists pgmq;
create extension if not exists amcheck with schema extensions;
create table if not exists public.ui_events (
  id bigserial primary key,
  created_at timestamptz not null default clock_timestamp(),
  tick_id bigint,
  payload text not null,
  touched int not null default 0
);
create index if not exists ui_events_created_at_idx on public.ui_events (created_at);
create index if not exists ui_events_payload_idx on public.ui_events (payload);
create table if not exists public.ui_ticks (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  server_version text not null default current_setting('server_version'),
  sent bigint, read_n int, archived_n int, deleted_n int
);
create index if not exists ui_ticks_at_idx on public.ui_ticks (at);
create table if not exists public.ui_minute (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  server_version text not null default current_setting('server_version')
);
-- Identity helpers for the client writers: NULL-safe so a refused function
-- (privilege, or WAL control functions during recovery) cannot fail the insert.
-- SECURITY DEFINER (owner postgres) so the Data API writer's service_role reads the same values.
create or replace function public.ui_sysid() returns text language plpgsql security definer set search_path = '' as $f$
begin return (select system_identifier::text from pg_control_system()); exception when others then return 'err: ' || sqlerrm; end $f$;
create or replace function public.ui_lsn() returns text language plpgsql security definer set search_path = '' as $f$
begin return pg_current_wal_lsn()::text; exception when others then return 'err: ' || sqlerrm; end $f$;
create table if not exists public.ui_client (
  id bigint generated by default as identity primary key,
  src text not null default 'mgmt',
  seq int not null,
  at timestamptz not null default clock_timestamp(),
  server_version text not null default current_setting('server_version'),
  pm_start timestamptz not null default pg_postmaster_start_time(),
  sysid text default public.ui_sysid(),
  addr text default inet_server_addr()::text,
  lsn text default public.ui_lsn(),
  xid bigint default txid_current(),
  recovery boolean default pg_is_in_recovery(),
  unique (src, seq)
);
-- The Data API writer inserts as service_role; explicit so it does not rest on default privileges.
grant select, insert on public.ui_client to service_role;
grant usage on all sequences in schema public to service_role;
notify pgrst, 'reload schema';
create or replace function public.ui_tick() returns void language plpgsql as $f$
declare t bigint; m bigint; r record; i int; nread int := 0; narch int := 0; ndel int := 0;
begin
  insert into public.ui_ticks default values returning id into t;
  insert into public.ui_events (tick_id, payload) select t, md5(random()::text) from generate_series(1, 20);
  update public.ui_events set touched = touched + 1 where id in (select id from public.ui_events order by id desc limit 10);
  delete from public.ui_events where id in (select id from public.ui_events where touched > 0 order by id limit 5);
  for i in 1..3 loop
    select s into m from pgmq.send('${QUEUE}', jsonb_build_object('tick', t, 'i', i)) s;
  end loop;
  for r in select * from pgmq.read('${QUEUE}', 0, 3) loop
    nread := nread + 1;
    if r.msg_id % 2 = 0 then perform pgmq.archive('${QUEUE}', r.msg_id); narch := narch + 1;
    else perform pgmq.delete('${QUEUE}', r.msg_id); ndel := ndel + 1; end if;
  end loop;
  update public.ui_ticks set sent = m, read_n = nread, archived_n = narch, deleted_n = ndel where id = t;
end $f$;
`;

export const QUEUE_SQL = `select pgmq.create('${QUEUE}') where not exists (select 1 from pgmq.list_queues() where queue_name = '${QUEUE}');`;

/* ---------- checks ---------- */

export interface AmcheckRow {
  kind: "heap" | "btree" | "btree_parent";
  rel: string;
  /** "ok", a corruption count with messages, or the error text verbatim. */
  result: string;
  ok: boolean;
}

/** Schema amcheck was installed into (null when the extension is absent). */
export async function amcheckSchema(ctx: Ctx, ref: string): Promise<{ schema: string | null; version: string }> {
  const r = await sql(ctx, ref, "select n.nspname as s, e.extversion as v from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'amcheck'");
  const row = r.rows?.[0];
  return { schema: row ? String(row.s) : null, version: row ? String(row.v) : "" };
}

/**
 * verify_heapam on every table and materialized view in public/cron/pgmq,
 * bt_index_check(heapallindexed) and bt_index_parent_check(heapallindexed,
 * rootdescend) on every valid btree index of those schemas. One call per
 * object so one error does not hide the others.
 */
export async function runAmcheck(ctx: Ctx, ref: string, parent = true): Promise<{ rows: AmcheckRow[]; schema: string | null; version: string }> {
  const { schema, version } = await amcheckSchema(ctx, ref);
  const rows: AmcheckRow[] = [];
  if (!schema) return { rows, schema, version };
  const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
  const sch = SCHEMAS.map((s) => `'${s}'`).join(",");
  const tables = await sql(
    ctx,
    ref,
    `select c.oid::regclass::text as rel from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in (${sch}) and c.relkind in ('r','m') order by 1`,
  );
  for (const t of tables.rows ?? []) {
    const rel = String(t.rel);
    const r = await sql(
      ctx,
      ref,
      `select count(*)::int as n, coalesce(string_agg(format('blk %s off %s att %s: %s', blkno, offnum, attnum, msg), ' | '), '') as msgs
       from ${q(schema)}.verify_heapam('${rel.replaceAll("'", "''")}'::regclass, check_toast => true)`,
      120_000,
    );
    if (r.error) rows.push({ kind: "heap", rel, result: `error: ${r.error}`, ok: false });
    else {
      const n = Number(r.rows?.[0]?.n ?? -1);
      rows.push({ kind: "heap", rel, result: n === 0 ? "ok" : `${n} corruption row(s): ${String(r.rows?.[0]?.msgs ?? "").slice(0, 300)}`, ok: n === 0 });
    }
  }
  const idx = await sql(
    ctx,
    ref,
    `select i.indexrelid::regclass::text as idx from pg_index i
       join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_class ic on ic.oid = i.indexrelid join pg_am am on am.oid = ic.relam
     where am.amname = 'btree' and n.nspname in (${sch}) and i.indisvalid and i.indisready order by 1`,
  );
  for (const x of idx.rows ?? []) {
    const rel = String(x.idx);
    const lit = `'${rel.replaceAll("'", "''")}'::regclass`;
    const a = await sql(ctx, ref, `select ${q(schema)}.bt_index_check(${lit}, true)::text as r`, 120_000);
    rows.push({ kind: "btree", rel, result: a.error ? `error: ${a.error}` : "ok", ok: !a.error });
    if (parent) {
      const b = await sql(ctx, ref, `select ${q(schema)}.bt_index_parent_check(${lit}, true, true)::text as r`, 120_000);
      rows.push({ kind: "btree_parent", rel, result: b.error ? `error: ${b.error}` : "ok", ok: !b.error });
    }
  }
  return { rows, schema, version };
}

export interface SeqRow {
  table: string;
  column: string;
  seq: string;
  last_value: string;
  max_value: string;
  ok: boolean;
}

/**
 * Every sequence feeding a column in public/cron/pgmq - owned (serial,
 * identity) or referenced from a column default (pg_cron's jobid_seq and
 * runid_seq are not owned) - against max() of that column. NULL last_value
 * means not yet called or no privilege; it is ok only when the table is empty.
 */
export async function sequenceCheck(ctx: Ctx, ref: string): Promise<{ rows: SeqRow[]; error?: string }> {
  const sch = SCHEMAS.map((s) => `'${s}'`).join(",");
  const r = await sql(
    ctx,
    ref,
    `with cols as (
       select n.nspname, c.relname, a.attname, d.refobjid as seq
       from pg_attrdef ad
       join pg_depend d on d.classid = 'pg_attrdef'::regclass and d.objid = ad.oid and d.refclassid = 'pg_class'::regclass
       join pg_class s on s.oid = d.refobjid and s.relkind = 'S'
       join pg_class c on c.oid = ad.adrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
       where n.nspname in (${sch})
       union
       select n.nspname, c.relname, a.attname, d.objid
       from pg_depend d
       join pg_class s on s.oid = d.objid and s.relkind = 'S'
       join pg_class c on c.oid = d.refobjid join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid
       where d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a','i') and n.nspname in (${sch})
     )
     select format('%I.%I', nspname, relname) as tbl, attname as col, seq::regclass::text as seq,
       (select ps.last_value::text from pg_sequences ps where format('%I.%I', ps.schemaname, ps.sequencename)::regclass = cols.seq) as last_value,
       (xpath('/row/m/text()', query_to_xml(format('select max(%I) as m from %I.%I', attname, nspname, relname), false, true, '')))[1]::text as max_value
     from cols order by 1, 2`,
    120_000,
  );
  if (r.error) return { rows: [], error: r.error };
  const rows = (r.rows ?? []).map((x) => {
    const last = x.last_value == null ? "null" : String(x.last_value);
    const max = x.max_value == null ? "null" : String(x.max_value);
    const ok = max === "null" ? true : last !== "null" && BigInt(last) >= BigInt(max);
    return { table: String(x.tbl), column: String(x.col), seq: String(x.seq), last_value: last, max_value: max, ok };
  });
  // The archive table's msg_id comes from the QUEUE's sequence and has no default of its own.
  const a = await sql(
    ctx,
    ref,
    `select (select max(msg_id) from pgmq.a_${QUEUE})::text as amax, (select max(msg_id) from pgmq.q_${QUEUE})::text as qmax`,
  );
  const qseq = rows.find((x) => x.table === `pgmq.q_${QUEUE}` && x.column === "msg_id");
  if (!a.error && qseq) {
    const amax = a.rows?.[0]?.amax == null ? "null" : String(a.rows?.[0]?.amax);
    const ok = amax === "null" ? true : qseq.last_value !== "null" && BigInt(qseq.last_value) >= BigInt(amax);
    rows.push({ table: `pgmq.a_${QUEUE}`, column: "msg_id", seq: `${qseq.seq} (queue sequence)`, last_value: qseq.last_value, max_value: amax, ok });
  }
  return { rows };
}

export const FREEZE_TABLES = ["cron.job_run_details", `pgmq.q_${QUEUE}`, `pgmq.a_${QUEUE}`, "public.ui_events", "public.ui_ticks"];

export interface FrozenRow {
  rel: string;
  relfrozenxid: string;
  xid_age: number;
  relminmxid: string;
  mxid_age: number;
  owner: string;
}

export async function frozenAges(ctx: Ctx, ref: string): Promise<{ rows: FrozenRow[]; error?: string }> {
  const list = FREEZE_TABLES.map((t) => `'${t}'`).join(",");
  const r = await sql(
    ctx,
    ref,
    `select format('%I.%I', c.relnamespace::regnamespace::text, c.relname) as rel, c.relfrozenxid::text as fx, age(c.relfrozenxid) as xa,
            c.relminmxid::text as mx, mxid_age(c.relminmxid) as ma, pg_get_userbyid(c.relowner) as owner
     from pg_class c where c.oid in (select to_regclass(x) from unnest(array[${list}]) x) order by 1`,
  );
  if (r.error) return { rows: [], error: r.error };
  return {
    rows: (r.rows ?? []).map((x) => ({
      rel: String(x.rel),
      relfrozenxid: String(x.fx),
      xid_age: Number(x.xa),
      relminmxid: String(x.mx),
      mxid_age: Number(x.ma),
      owner: String(x.owner),
    })),
  };
}

export interface Snapshot {
  at: string;
  serverVersion: string;
  whoami: string;
  extensions: string;
  cronJobs: Record<string, unknown>[];
  cronTables: string;
  pgmqTables: string;
  counts: Record<string, number | string>;
  runStatus: string;
  maxIds: Record<string, string>;
}

/** Versions, cron jobs, schema contents and row counts. */
export async function snapshot(ctx: Ctx, ref: string): Promise<Snapshot> {
  const one = async (q: string): Promise<Record<string, unknown>> => {
    const r = await sql(ctx, ref, q, 90_000);
    return r.error ? { error: r.error } : (r.rows?.[0] ?? {});
  };
  const v = await one(
    `select current_setting('server_version') as v, current_user as u, (select rolsuper from pg_roles where rolname = current_user) as su,
            (select string_agg(extname || ' ' || extversion, ', ' order by extname) from pg_extension where extname in ('pg_cron','pgmq','amcheck')) as ext`,
  );
  const jobs = await sql(ctx, ref, "select jobid, jobname, schedule, active, username from cron.job order by jobid");
  const tbl = await one(
    `select (select string_agg(relname || ':' || relkind::text, ', ' order by relname) from pg_class where relnamespace = 'cron'::regnamespace) as cron_t,
            (select string_agg(relname || ':' || relkind::text, ', ' order by relname) from pg_class where relnamespace = 'pgmq'::regnamespace and relkind in ('r','p')) as pgmq_t`,
  );
  const c = await one(
    `select (select count(*) from public.ui_events) as ui_events, (select count(*) from public.ui_ticks) as ui_ticks,
            (select count(*) from public.ui_minute) as ui_minute, (select count(*) from public.ui_client) as ui_client,
            (select count(*) from pgmq.q_${QUEUE}) as queue, (select count(*) from pgmq.a_${QUEUE}) as archive,
            (select count(*) from cron.job_run_details) as job_run_details`,
  );
  const m = await one(
    `select (select max(id) from public.ui_ticks)::text as ticks, (select max(runid) from cron.job_run_details)::text as runid,
            (select max(id) from public.ui_events)::text as events, (select max(msg_id) from pgmq.a_${QUEUE})::text as archive`,
  );
  const rs = await one(
    `select string_agg(status || '=' || n, ', ' order by status) as s from (select status, count(*) n from cron.job_run_details group by 1) x`,
  );
  const counts: Record<string, number | string> = {};
  for (const [k, val] of Object.entries(c)) counts[k] = k === "error" ? String(val) : Number(val);
  return {
    at: new Date().toISOString(),
    serverVersion: String(v.v ?? v.error ?? ""),
    whoami: `${String(v.u ?? "")} (superuser ${String(v.su ?? "")})`,
    extensions: String(v.ext ?? v.error ?? ""),
    cronJobs: jobs.error ? [{ error: jobs.error }] : (jobs.rows ?? []),
    cronTables: String(tbl.cron_t ?? tbl.error ?? ""),
    pgmqTables: String(tbl.pgmq_t ?? tbl.error ?? ""),
    counts,
    runStatus: String(rs.s ?? rs.error ?? ""),
    maxIds: Object.fromEntries(Object.entries(m).map(([k, x]) => [k, String(x)])),
  };
}

/* ---------- pooler (for VACUUM VERBOSE) ---------- */

export async function poolerHost(ctx: Ctx, ref: string): Promise<{ host: string; user: string }> {
  const pr = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`);
  const arr = Array.isArray(pr.json) ? (pr.json as Array<Record<string, unknown>>) : [];
  const e = arr.find((x) => x.database_type === "PRIMARY") ?? arr[0] ?? {};
  return { host: String(e.db_host ?? ""), user: String(e.db_user ?? `postgres.${ref}`) };
}

export type PgPath = "session" | "transaction" | "direct";

/** A pg client on one path: session pooler (5432), transaction pooler (6543) or the direct host (IPv6). */
export async function pgClient(ctx: Ctx, p: UiProject, path: PgPath = "session", connectMs = 20_000): Promise<{ client: Client; notices: string[] }> {
  let host = `db.${p.ref}.supabase.co`;
  let user = "postgres";
  let port = 5432;
  if (path !== "direct") {
    const ph = await poolerHost(ctx, p.ref);
    if (!ph.host) throw new Error("pooler config unreadable");
    host = ph.host;
    user = ph.user;
    port = path === "transaction" ? 6543 : 5432;
  }
  const notices: string[] = [];
  const c = new Client({ host, port, user, database: "postgres", password: p.password, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: connectMs });
  c.on("error", () => {});
  c.on("notice", (n) => notices.push(`${n.severity ?? "NOTICE"}: ${n.message}${n.detail ? ` | ${n.detail}` : ""}`));
  await c.connect();
  if (path !== "transaction") await c.query("set statement_timeout = 0");
  return { client: c, notices };
}

export function poolerClient(ctx: Ctx, p: UiProject): Promise<{ client: Client; notices: string[] }> {
  return pgClient(ctx, p, "session");
}

/**
 * Server addresses are not published: each distinct inet_server_addr() gets a
 * stable label (addr#1, addr#2, ...) in order of first appearance, so
 * evidence can say "same address" without carrying it.
 */
const addrLabels = new Map<string, string>();
export function addrLabel(raw: unknown): string {
  const a = String(raw ?? "");
  if (!a || a === "null" || a === "undefined") return "none";
  if (!addrLabels.has(a)) addrLabels.set(a, `addr#${addrLabels.size + 1}`);
  return addrLabels.get(a)!;
}

/** The one-statement write every client path runs: insert, return the answering server's identity. */
export function writeSql(src: string, seq: number): string {
  return `insert into public.ui_client (src, seq) values ('${src}', ${seq})
    returning server_version, pm_start::text as pm, sysid, addr, lsn, xid::text as xid, recovery::text as recovery`;
}

/** Columns the Data API writer asks back (`?select=`), aliased to the names writeSql returns. */
export const REST_SELECT = "server_version,pm:pm_start,sysid,addr,lsn,xid,recovery";

/**
 * PostgREST serialises timestamptz as ISO 8601 (`2026-10-23T08:42:13.830604+00:00`);
 * the pg paths read `pm_start::text` (`2026-10-23 08:42:13.830604+00`). Normalise the
 * REST form so writes group by postmaster across paths.
 */
export function pgTimestamptzText(iso: unknown): string {
  return String(iso ?? "").replace("T", " ").replace(/\+00:00$/, "+00");
}

/** Server identity read in one statement (used before the POST and after the upgrade). */
export const IDENTITY_SQL = `select current_setting('server_version') as v, pg_postmaster_start_time()::text as pm, public.ui_sysid() as sysid,
  inet_server_addr()::text as addr, public.ui_lsn() as lsn, txid_current()::text as xid, pg_is_in_recovery()::text as recovery,
  current_setting('synchronous_commit') as synchronous_commit, current_setting('fsync') as fsync, current_setting('wal_level') as wal_level`;

/* ---------- state shared across modules ---------- */

export interface Baseline {
  snap: Snapshot;
  amcheck: AmcheckRow[];
  seq: SeqRow[];
  frozen: FrozenRow[];
  cronSchedule: string;
}

export interface UpgradeRecord {
  postAt: number;
  postStatus: number;
  postBody: string;
  doneAt: number;
  /** First moment the database answered on the target major. */
  newVersionAt: number;
  finalProgress: string;
  error: string;
  /** Every client write attempt, every path. */
  attempts: Attempt[];
  /** Identity of the server before the POST and after the upgrade (IDENTITY_SQL rows). */
  preIdentity: Record<string, unknown>;
  postIdentity: Record<string, unknown>;
  /** Paths that never connected, with the error. */
  unreachable: Record<string, string>;
  fromVersion: string;
  toVersion: string;
}

/** One client write. `src` is the path: `mgmt` (Management API query endpoint), `pooler` (session pooler), `txn` (transaction pooler), `direct`, `rest` (Data API, PostgREST). */
export interface Attempt {
  src: "mgmt" | "pooler" | "txn" | "direct" | "rest";
  seq: number;
  /** Attempt start and acknowledgement (or failure) time, client clock, ms. */
  t: number;
  ackT: number;
  ok: boolean;
  version: string;
  pmStart: string;
  sysid: string;
  addr: string;
  lsn: string;
  xid: string;
  recovery: string;
  err: string;
}

export const state: { baseline?: Baseline; upgrade?: UpgradeRecord } = {};

export function okCount<T extends { ok: boolean }>(rows: T[]): string {
  return `${rows.filter((r) => r.ok).length}/${rows.length}`;
}
