/**
 * Pure helpers for TD02 (point reads) and TD03 (job-state writes): targets,
 * run sizes from the environment, the seeded synthetic data, per-dialect
 * statements, and the checks that turn a RunResult's ops into the numbers a
 * row reports. No I/O here; td02-03-io.ts does the network side.
 */
import type { LocalBackend, OpResult, Stmt, StmtOut, WorkerBackend } from "./contract";
import { rng, separated, type Summary, summarize } from "./stats";

/* -------------------------------- targets -------------------------------- */

export type Vantage = "worker" | "local";
export type Dialect = "sqlite" | "pg" | "http";
/** Which database a target reads: the fixture holds one of each. */
export type Store = "d1" | "turso" | "tursodb" | "supabase";

export interface Target {
  /** Stable name used in rows and env lists: "d1", "local_pg_pooler", ... */
  key: string;
  backend: WorkerBackend | LocalBackend;
  vantage: Vantage;
  dialect: Dialect;
  store: Store;
}

const t = (key: string, backend: Target["backend"], vantage: Vantage, dialect: Dialect, store: Store): Target => ({ key, backend, vantage, dialect, store });

export const TARGETS = {
  d1: t("d1", "d1", "worker", "sqlite", "d1"),
  turso: t("turso", "turso", "worker", "sqlite", "turso"),
  tursodb: t("tursodb", "tursodb", "worker", "sqlite", "tursodb"),
  pg: t("pg", "pg", "worker", "pg", "supabase"),
  pg_cached: t("pg_cached", "pg_cached", "worker", "pg", "supabase"),
  postgrest: t("postgrest", "postgrest", "worker", "http", "supabase"),
  local_turso_http: t("local_turso_http", "turso_http", "local", "sqlite", "turso"),
  local_pg_pooler: t("local_pg_pooler", "pg_pooler", "local", "pg", "supabase"),
  local_pg_direct: t("local_pg_direct", "pg_direct", "local", "pg", "supabase"),
  local_d1_rest: t("local_d1_rest", "d1_rest", "local", "sqlite", "d1"),
} as const satisfies Record<string, Target>;
export type TargetKey = keyof typeof TARGETS;

/* ---------------------------------- env ---------------------------------- */

type Env = Record<string, string | undefined>;

/** `name` from env if set, else the smoke size under TD_SMOKE=1, else the full size. */
export function envInt(env: Env, name: string, full: number, smoke: number): number {
  const raw = env[name];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
    return n;
  }
  return env.TD_SMOKE === "1" ? smoke : full;
}

/** Comma list from env, else smoke/full default. Empty entries dropped. */
export function envList(env: Env, name: string, full: readonly string[], smoke: readonly string[]): string[] {
  const raw = env[name];
  if (raw !== undefined && raw !== "") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return [...(env.TD_SMOKE === "1" ? smoke : full)];
}

/** Resolve target keys, rejecting unknown names (a typo must not silently shrink a battery). */
export function pickTargets(keys: readonly string[], allowed: readonly TargetKey[]): Target[] {
  return keys.map((k) => {
    if (!(allowed as readonly string[]).includes(k)) throw new Error(`unknown target ${k}; allowed: ${allowed.join(",")}`);
    return TARGETS[k as TargetKey];
  });
}

/* ------------------------------ TD02 data -------------------------------- */

export const KV_TABLE = "td02_kv";
export interface KvRow {
  id: number;
  k: string;
  v: string;
  n: number;
}

/** `count` rows with ids 1..count, generated in id order from one seeded stream. */
export function genKv(count: number, seed: number): KvRow[] {
  const r = rng(seed);
  const hex8 = () => Math.floor(r() * 0x100000000).toString(16).padStart(8, "0");
  const out: KvRow[] = [];
  for (let id = 1; id <= count; id++) {
    out.push({ id, k: `key-${String(id).padStart(6, "0")}`, v: Array.from({ length: 6 }, hex8).join(""), n: Math.floor(r() * 1_000_000) });
  }
  return out;
}

/** DDL per dialect. Postgres also enables RLS (the secret key bypasses it) and grants service_role explicitly. */
export function kvDdl(d: "sqlite" | "pg"): string[] {
  const create = `create table ${KV_TABLE} (id integer primary key, k text not null, v text not null, n integer not null)`;
  if (d === "sqlite") return [`drop table if exists ${KV_TABLE}`, create];
  return [
    `drop table if exists public.${KV_TABLE}`,
    create.replace(`table ${KV_TABLE}`, `table public.${KV_TABLE}`),
    `alter table public.${KV_TABLE} enable row level security`,
    `grant select on public.${KV_TABLE} to service_role`,
    `notify pgrst, 'reload schema'`,
  ];
}

/**
 * Multi-row INSERTs with literal values (no bound parameters: D1 caps them at
 * 100 per query). Values are [0-9a-z-] only, so the text is the same in both
 * dialects.
 */
export function kvInserts(rows: readonly KvRow[], perStmt = 500): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += perStmt) {
    const vals = rows.slice(i, i + perStmt).map((x) => `(${x.id},'${x.k}','${x.v}',${x.n})`);
    out.push(`insert into ${KV_TABLE} (id, k, v, n) values ${vals.join(",")}`);
  }
  return out;
}

/** The check both dialects answer the same way when the seed is identical. */
export const KV_CHECK_SQL = `select count(*) as c, sum(n) as s, max(id) as m from ${KV_TABLE}`;
export function kvExpected(rows: readonly KvRow[]): { c: number; s: number; m: number } {
  return { c: rows.length, s: rows.reduce((a, x) => a + x.n, 0), m: rows.length };
}

export function pointRead(d: Dialect, id: number): Stmt {
  if (d === "http") return { http: { method: "GET", path: `${KV_TABLE}?id=eq.${id}&select=id,k,v,n` } };
  return { sql: `select id, k, v, n from ${KV_TABLE} where id = ${d === "pg" ? "$1" : "?"}`, params: [id] };
}

/** Uniform ids in 1..maxId, or drawn from the first `hot` ids of a shuffled range when hot > 0. */
export function keySequence(count: number, maxId: number, seed: number, hot = 0): number[] {
  const r = rng(seed);
  if (hot > 0) {
    const pool = Array.from({ length: Math.min(hot, maxId) }, () => 1 + Math.floor(r() * maxId));
    return Array.from({ length: count }, () => pool[Math.floor(r() * pool.length)]!);
  }
  return Array.from({ length: count }, () => 1 + Math.floor(r() * maxId));
}

/** Split into consecutive blocks of at most `size`. */
export function blocks<T>(xs: readonly T[], size: number): T[][] {
  const s = Math.max(1, size);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += s) out.push(xs.slice(i, i + s));
  return out;
}

/* ------------------------------ TD02 checks ------------------------------ */

export interface ReadSample {
  ms: number;
  ok: boolean;
  /** First op of its invocation (fresh lane / client). */
  first: boolean;
  /** Row came back with the seeded value. */
  match: boolean;
  error?: string;
}

/** A row's value matches the seed. Works for SQL rows and PostgREST JSON rows alike. */
export function rowMatches(out: StmtOut | undefined, want: KvRow | undefined): boolean {
  const row = out?.rows?.[0] as Record<string, unknown> | undefined;
  return !!row && !!want && row.v === want.v && Number(row.id) === want.id;
}

/**
 * Samples for one block (one invocation): each statement's op in statement
 * order. A statement with no op (the request failed as a whole) becomes a
 * failed sample carrying the request error, so attempts are never lost.
 */
export function blockSamples(ops: readonly OpResult[], ids: readonly number[], rows: readonly KvRow[], reqError?: string): ReadSample[] {
  const byStmt = new Map<number, OpResult>();
  for (const o of ops) if (!byStmt.has(o.stmt)) byStmt.set(o.stmt, o);
  return ids.map((id, k) => {
    const o = byStmt.get(k);
    if (!o) return { ms: Number.NaN, ok: false, first: k === 0, match: false, error: reqError ?? "no op returned" };
    const match = o.ok && rowMatches(o.out?.[0], rows[id - 1]);
    return { ms: o.ms, ok: o.ok, first: k === 0, match, ...(o.error ? { error: o.error } : {}) };
  });
}

export interface ReadStats {
  attempted: number;
  /** Summary over ok samples after the warm-up (first `warmup` attempts) is dropped. */
  all: Summary;
  first: Summary;
  rest: Summary;
  errors: number;
  mismatches: number;
  errorTexts: { text: string; count: number }[];
}

export function readStats(samples: readonly ReadSample[], warmup: number): ReadStats {
  const kept = samples.slice(Math.min(warmup, samples.length));
  const ok = kept.filter((s) => s.ok);
  const all = summarize(ok.map((s) => s.ms));
  all.dropped = samples.length - kept.length;
  const texts = new Map<string, number>();
  for (const s of samples) if (!s.ok) texts.set(s.error ?? "unknown", (texts.get(s.error ?? "unknown") ?? 0) + 1);
  return {
    attempted: samples.length,
    all,
    first: summarize(ok.filter((s) => s.first).map((s) => s.ms)),
    rest: summarize(ok.filter((s) => !s.first).map((s) => s.ms)),
    errors: samples.filter((s) => !s.ok).length,
    mismatches: samples.filter((s) => s.ok && !s.match).length,
    errorTexts: [...texts.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count),
  };
}

/**
 * The plan's comparison rule applied to every pair: order by p50, mark each
 * adjacent pair "<" (p25-p75 spreads separate) or "~" (they overlap). "~" is
 * not transitive, so non-adjacent pairs that separate are listed after the
 * chain as "(also a < c)"; without that, "a ~ b ~ c" read as all-overlapping.
 */
export function rankBySpread(entries: readonly { key: string; s: Pick<Summary, "p25" | "p50" | "p75" | "n"> }[]): string {
  const xs = entries.filter((e) => e.s.n > 0 && Number.isFinite(e.s.p50)).sort((a, b) => a.s.p50 - b.s.p50);
  if (xs.length === 0) return "no samples";
  let out = xs[0]!.key;
  for (let i = 1; i < xs.length; i++) out += ` ${separated(xs[i - 1]!.s, xs[i]!.s) === "a" ? "<" : "~"} ${xs[i]!.key}`;
  const also: string[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 2; j < xs.length; j++) {
      // Skip pairs the chain already implies through a "<" between them.
      const chained = xs.slice(i, j).some((_, k) => separated(xs[i + k]!.s, xs[i + k + 1]!.s) === "a");
      if (!chained && separated(xs[i]!.s, xs[j]!.s) === "a") also.push(`${xs[i]!.key} < ${xs[j]!.key}`);
    }
  }
  return also.length ? `${out} (also ${also.join(", ")})` : out;
}

/* --------------------------- TD02 ceiling row ---------------------------- */

export interface CeilingStep {
  repeat: number;
  okOps: number;
  failedOps: number;
  /** Ops the invocation never reported (request-level failure or truncated response). */
  missing: number;
  /** Earliest failure by start time: its iteration index and verbatim text. */
  firstFailI: number | null;
  firstError: string | null;
}

export function ceilingStep(repeat: number, ops: readonly OpResult[], reqError?: string): CeilingStep {
  const failed = ops.filter((o) => !o.ok).sort((a, b) => a.t0 - b.t0);
  const okOps = ops.length - failed.length;
  const first = failed[0];
  return {
    repeat,
    okOps,
    failedOps: failed.length,
    missing: Math.max(0, repeat - ops.length),
    firstFailI: first ? first.i : null,
    firstError: first?.error ?? (ops.length < repeat ? (reqError ?? "response carried fewer ops than requested") : null),
  };
}

export const ceilingHit = (s: CeilingStep) => s.failedOps > 0 || s.missing > 0;

/* ------------------------------ TD03 jobs -------------------------------- */

export const JOBS_TABLE = "td03_jobs";

export function jobsDdl(d: "sqlite" | "pg"): string[] {
  const create = `create table ${JOBS_TABLE} (id text primary key, status text not null, attempts integer not null, payload text not null, updated_at bigint not null)`;
  if (d === "sqlite") return [`drop table if exists ${JOBS_TABLE}`, create];
  return [
    `drop table if exists public.${JOBS_TABLE}`,
    create.replace(`table ${JOBS_TABLE}`, `table public.${JOBS_TABLE}`),
    `alter table public.${JOBS_TABLE} enable row level security`,
    `grant select, insert, update, delete on public.${JOBS_TABLE} to service_role`,
    `notify pgrst, 'reload schema'`,
  ];
}

export type StepKind = "insert" | "update" | "read";
export interface StepPlan {
  job: number;
  step: number;
  kind: StepKind;
  /** For reads: what read-your-write expects. For writes: the status written. */
  status: string;
  attempts: number;
}

/** insert queued; then queued -> claimed -> running -> done; a read after every write. */
export const TRANSITIONS: readonly { from: string | null; to: string }[] = [
  { from: null, to: "queued" },
  { from: "queued", to: "claimed" },
  { from: "claimed", to: "running" },
  { from: "running", to: "done" },
];
export const STEPS_PER_JOB = TRANSITIONS.length * 2;

export function jobPayload(seed: number, job: number): string {
  const r = rng(seed + job * 7919);
  return JSON.stringify({ kind: "transform", src: `obj-${Math.floor(r() * 1e9).toString(36)}`, width: 320 + Math.floor(r() * 1600), quality: 60 + Math.floor(r() * 40) });
}

/** The 8 statements for one job, in the dialect's own placeholders, plus what each step expects. */
export function jobStatements(d: Dialect, jobId: string, job: number, payload: string, tsBase: number): { stmts: Stmt[]; plan: StepPlan[] } {
  const stmts: Stmt[] = [];
  const plan: StepPlan[] = [];
  const ph = (n: number) => (d === "pg" ? `$${n}` : "?");
  const enc = encodeURIComponent;
  TRANSITIONS.forEach((tr, attempts) => {
    const ts = tsBase + attempts;
    if (tr.from === null) {
      stmts.push(
        d === "http"
          ? { http: { method: "POST", path: JOBS_TABLE, body: { id: jobId, status: tr.to, attempts, payload, updated_at: ts }, headers: { Prefer: "return=minimal" } } }
          : { sql: `insert into ${JOBS_TABLE} (id, status, attempts, payload, updated_at) values (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)})`, params: [jobId, tr.to, attempts, payload, ts] },
      );
      plan.push({ job, step: plan.length, kind: "insert", status: tr.to, attempts });
    } else {
      stmts.push(
        d === "http"
          ? { http: { method: "PATCH", path: `${JOBS_TABLE}?id=eq.${enc(jobId)}&status=eq.${tr.from}&select=id`, body: { status: tr.to, attempts, updated_at: ts }, headers: { Prefer: "return=representation" } } }
          : { sql: `update ${JOBS_TABLE} set status = ${ph(1)}, attempts = ${ph(2)}, updated_at = ${ph(3)} where id = ${ph(4)} and status = ${ph(5)}`, params: [tr.to, attempts, ts, jobId, tr.from] },
      );
      plan.push({ job, step: plan.length, kind: "update", status: tr.to, attempts });
    }
    stmts.push(
      d === "http"
        ? { http: { method: "GET", path: `${JOBS_TABLE}?id=eq.${enc(jobId)}&select=id,status,attempts` } }
        : { sql: `select id, status, attempts from ${JOBS_TABLE} where id = ${ph(1)}`, params: [jobId] },
    );
    plan.push({ job, step: plan.length, kind: "read", status: tr.to, attempts });
  });
  return { stmts, plan };
}

/** Rows a write changed, read from whatever each driver reports. Null when the driver said nothing usable. */
export function affected(t: Target, kind: "insert" | "update", out: StmtOut | undefined): number | null {
  if (!out) return null;
  const m = out.meta ?? {};
  const num = (x: unknown) => (x === undefined || x === null || Number.isNaN(Number(x)) ? null : Number(x));
  if (t.dialect === "http") return kind === "insert" ? (m.status === 201 ? 1 : 0) : (out.rowCount ?? null);
  if (t.store === "d1") return num(m.changes);
  if (t.store === "turso" || t.store === "tursodb") return num(m.rowsAffected);
  return out.rowCount ?? null;
}

export interface JobSample {
  job: number;
  kind: StepKind;
  ms: number;
  ok: boolean;
  /** Writes: exactly one row changed. Reads: status and attempts as just written. */
  checked: boolean;
  error?: string;
}

export function jobSamples(t: Target, ops: readonly OpResult[], plan: readonly StepPlan[], reqError?: string): JobSample[] {
  const byStmt = new Map<number, OpResult>();
  for (const o of ops) if (!byStmt.has(o.stmt)) byStmt.set(o.stmt, o);
  return plan.map((p, k) => {
    const o = byStmt.get(k);
    if (!o) return { job: p.job, kind: p.kind, ms: Number.NaN, ok: false, checked: false, error: reqError ?? "no op returned" };
    let checked = false;
    if (o.ok) {
      const out = o.out?.[0];
      if (p.kind === "read") {
        const row = out?.rows?.[0] as Record<string, unknown> | undefined;
        checked = !!row && row.status === p.status && Number(row.attempts) === p.attempts;
      } else checked = affected(t, p.kind, out) === 1;
    }
    return { job: p.job, kind: p.kind, ms: o.ms, ok: o.ok, checked, ...(o.error ? { error: o.error } : {}) };
  });
}

export interface JobStats {
  jobsAttempted: number;
  jobsMeasured: number;
  jobsDropped: number;
  insert: Summary;
  update: Summary;
  read: Summary;
  /** Sum of a job's 8 op timings, over jobs whose 8 ops all succeeded. */
  job: Summary;
  errors: number;
  /** Reads that did not see the write just before them (row missing, or old status/attempts). */
  rywMisses: number;
  /** Writes that did not change exactly one row. */
  writeMisses: number;
  /** Jobs that reached "done" with every check passing. */
  jobsClean: number;
  errorTexts: { text: string; count: number }[];
}

/** Warm-up is by job: the first `warmupJobs` jobs (in run order) are dropped from the latency summaries but not from the checks. */
export function jobStats(samples: readonly JobSample[], warmupJobs: number): JobStats {
  const order: number[] = [];
  const byJob = new Map<number, JobSample[]>();
  for (const s of samples) {
    if (!byJob.has(s.job)) {
      byJob.set(s.job, []);
      order.push(s.job);
    }
    byJob.get(s.job)!.push(s);
  }
  const measured = new Set(order.slice(Math.min(warmupJobs, order.length)));
  const kept = samples.filter((s) => measured.has(s.job) && s.ok);
  const of = (k: StepKind) => summarize(kept.filter((s) => s.kind === k).map((s) => s.ms));
  const totals: number[] = [];
  for (const j of order) {
    if (!measured.has(j)) continue;
    const ss = byJob.get(j)!;
    if (ss.length === STEPS_PER_JOB && ss.every((s) => s.ok)) totals.push(ss.reduce((a, s) => a + s.ms, 0));
  }
  const texts = new Map<string, number>();
  for (const s of samples) if (!s.ok) texts.set(s.error ?? "unknown", (texts.get(s.error ?? "unknown") ?? 0) + 1);
  return {
    jobsAttempted: order.length,
    jobsMeasured: measured.size,
    jobsDropped: order.length - measured.size,
    insert: of("insert"),
    update: of("update"),
    read: of("read"),
    job: summarize(totals),
    errors: samples.filter((s) => !s.ok).length,
    rywMisses: samples.filter((s) => s.kind === "read" && s.ok && !s.checked).length,
    writeMisses: samples.filter((s) => s.kind !== "read" && s.ok && !s.checked).length,
    jobsClean: order.filter((j) => byJob.get(j)!.every((s) => s.ok && s.checked)).length,
    errorTexts: [...texts.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count),
  };
}

/** Pick the latency columns a row reports (n, p25, p50, p75, p95, p99) under a prefix. */
export function latencyColumns(prefix: string, s: Summary): Record<string, number> {
  return { [`${prefix}_n`]: s.n, [`${prefix}_p25`]: s.p25, [`${prefix}_p50`]: s.p50, [`${prefix}_p75`]: s.p75, [`${prefix}_p95`]: s.p95, [`${prefix}_p99`]: s.p99 };
}

/** Distinct values of a meta field across ops (e.g. D1 served_by_region), joined. "" when absent. */
export function metaValues(ops: readonly OpResult[], field: string): string {
  const seen = new Set<string>();
  for (const o of ops) for (const out of o.out ?? []) {
    const v = out.meta?.[field];
    if (v !== undefined && v !== null) seen.add(String(v));
  }
  return [...seen].join(",");
}

export function shortErrors(texts: readonly { text: string; count: number }[], max = 3): string {
  return texts.slice(0, max).map((e) => `${e.count}x ${e.text.slice(0, 200)}`).join(" | ");
}
