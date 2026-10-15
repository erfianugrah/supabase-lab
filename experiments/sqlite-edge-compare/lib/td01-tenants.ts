/**
 * TD01 helpers (database per tenant): tenant names, burst sizing, the
 * create-to-first-query retry loop, error redaction and the burst summary.
 * Pure apart from `untilOk`'s sleep; no vendor calls here (those live in the
 * module, behind lib/vendors.ts's sec- guards).
 */
import { PREFIX } from "./contract";
import { summarize } from "./stats";

export const TD01_PREFIX = `${PREFIX}td01-`;

/** Burst size: TD01_BURST wins, else 2 under TD_SMOKE=1, else 20 (the plan's figure). */
export function burstSize(env: Record<string, string | undefined> = process.env): number {
  const explicit = Number(env.TD01_BURST);
  if (Number.isInteger(explicit) && explicit > 0) return Math.min(explicit, 50);
  return env.TD_SMOKE === "1" ? 2 : 20;
}

/**
 * Every tenant name of one run: `sec-td01-<stamp>-s` for the single row and
 * `sec-td01-<stamp>-b<k>` for the burst. Lowercase letters, digits and dashes
 * only (valid for Turso, D1 and, quoted, a Postgres schema), well under the
 * 63-byte Postgres identifier and DNS-label limits.
 */
export function tenantNames(stamp: string, burst: number): { runPrefix: string; single: string; burst: string[] } {
  if (!/^[a-z0-9]{1,12}$/.test(stamp)) throw new Error(`tenantNames: stamp must be 1-12 lowercase alphanumerics (got ${JSON.stringify(stamp)})`);
  const runPrefix = `${TD01_PREFIX}${stamp}-`;
  return { runPrefix, single: `${runPrefix}s`, burst: Array.from({ length: burst }, (_, k) => `${runPrefix}b${k}`) };
}

/** Double-quoted Postgres identifier. Refuses anything outside the tenant-name alphabet. */
export function pgIdent(name: string): string {
  if (!/^[a-z0-9-]{1,63}$/.test(name)) throw new Error(`pgIdent: unexpected identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** The same three statements on every backend: create the tenant table, write one row, read it back. */
export function firstQuerySql(dialect: "sqlite" | "pg", schema?: string): { create: string; insert: string; select: string } {
  if (dialect === "sqlite") {
    return {
      create: "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)",
      insert: "INSERT OR REPLACE INTO t (id, v) VALUES (1, 'tenant')",
      select: "SELECT v FROM t WHERE id = 1",
    };
  }
  const s = pgIdent(schema ?? "");
  return {
    create: `CREATE TABLE IF NOT EXISTS ${s}.t (id int PRIMARY KEY, v text NOT NULL)`,
    insert: `INSERT INTO ${s}.t (id, v) VALUES (1, 'tenant') ON CONFLICT (id) DO UPDATE SET v = excluded.v`,
    select: `SELECT v FROM ${s}.t WHERE id = 1`,
  };
}

export interface Attempted<T> {
  ok: boolean;
  value?: T;
  attempts: number;
  /** First failure's text (what a client sees before the tenant is reachable). */
  firstError?: string;
  lastError?: string;
  /** Duration of the successful attempt only, ms. */
  lastMs: number;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Call `fn` until it resolves or `deadlineMs` passes. Waits `delays[k]` (last
 * value repeated) between attempts. Errors are recorded, never thrown.
 */
export async function untilOk<T>(fn: () => Promise<T>, opts: { deadlineMs: number; delays?: number[]; wait?: (ms: number) => Promise<unknown> }): Promise<Attempted<T>> {
  const delays = opts.delays?.length ? opts.delays : [250, 500, 1000, 2000];
  const wait = opts.wait ?? sleep;
  const end = Date.now() + opts.deadlineMs;
  let attempts = 0;
  let firstError: string | undefined;
  let lastError: string | undefined;
  for (;;) {
    attempts++;
    const t0 = performance.now();
    try {
      const value = await fn();
      return { ok: true, value, attempts, ...(firstError ? { firstError, lastError } : {}), lastMs: performance.now() - t0 };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      firstError ??= lastError;
    }
    if (Date.now() >= end) return { ok: false, attempts, firstError, lastError, lastMs: 0 };
    await wait(delays[Math.min(attempts - 1, delays.length - 1)]!);
  }
}

/**
 * Strip identifiers from vendor text before it reaches a measurement: Turso
 * hostnames (they carry the org slug), UUIDs (D1 ids), JWTs, emails, plus any
 * literal passed in (refs, org slugs, account id). Truncated to 300 chars.
 */
export function redact(text: string, literals: readonly string[] = []): string {
  let out = text
    .replace(/[a-z0-9.-]+\.turso\.io/gi, "<turso-host>")
    .replace(/[a-z0-9.-]+\.supabase\.(co|com)/gi, "<supabase-host>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{32}\b/g, "<hex32>")
    .replace(/ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, "~");
  for (const l of literals) if (l && l.length >= 6) out = out.split(l).join("<id>");
  return out.slice(0, 300);
}

/** One tenant's onboarding outcome. Times in ms from the tenant's own create start. */
export interface TenantOutcome {
  name: string;
  /** Vendor create call (or CREATE SCHEMA) returned success. */
  created: boolean;
  createMs?: number;
  /** Per-tenant credential mint (Turso DB token), when the backend needs one. */
  tokenMs?: number;
  /** create table + insert + select succeeded. */
  ready: boolean;
  /** Create start to the first successful read-back. */
  createToFirstQueryMs?: number;
  /** Duration of the successful first-query attempt alone. */
  firstQueryMs?: number;
  attempts?: number;
  error?: string;
}

/** Distinct error texts with counts, most frequent first, joined for one measurement cell. */
export function errorSummary(errors: readonly (string | undefined)[]): string {
  const m = new Map<string, number>();
  for (const e of errors) if (e) m.set(e, (m.get(e) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${c}x ${t}`).join(" | ");
}

/** Burst measurements: counts, then p50/p95/max of the create and create-to-first-query times. */
export function burstColumns(outcomes: readonly TenantOutcome[]): Record<string, number | string> {
  const create = summarize(outcomes.filter((o) => o.created && o.createMs !== undefined).map((o) => o.createMs!));
  const c2q = summarize(outcomes.filter((o) => o.ready && o.createToFirstQueryMs !== undefined).map((o) => o.createToFirstQueryMs!));
  const tokens = summarize(outcomes.filter((o) => o.tokenMs !== undefined).map((o) => o.tokenMs!));
  const attempts = outcomes.map((o) => o.attempts ?? 0);
  const out: Record<string, number | string> = {
    n_requested: outcomes.length,
    n_created: outcomes.filter((o) => o.created).length,
    n_ready: outcomes.filter((o) => o.ready).length,
    n_refused: outcomes.filter((o) => !o.created).length,
    create_ms_p50: create.p50,
    create_ms_p95: create.p95,
    create_ms_max: create.max,
    create_to_first_query_ms_p50: c2q.p50,
    create_to_first_query_ms_p95: c2q.p95,
    create_to_first_query_ms_max: c2q.max,
    first_query_attempts_max: attempts.length ? Math.max(...attempts) : 0,
  };
  if (tokens.n) {
    out.token_ms_p50 = tokens.p50;
    out.token_ms_max = tokens.max;
  }
  const errs = errorSummary(outcomes.map((o) => o.error));
  if (errs) out.errors = errs.slice(0, 500);
  // NaN is not a useful cell: an empty sample reads as an empty string.
  for (const [k, v] of Object.entries(out)) if (typeof v === "number" && Number.isNaN(v)) out[k] = "";
  return out;
}

/** Delete timings for one backend: the uncontended single delete and the parallel burst delete. */
export function deleteColumns(singleMs: number | undefined, burstMs: readonly number[], failed: number): Record<string, number | string> {
  const s = summarize(burstMs);
  const out: Record<string, number | string> = {
    delete_single_ms: singleMs ?? "",
    n_burst_deleted: s.n,
    delete_burst_ms_p50: s.p50,
    delete_burst_ms_p95: s.p95,
    delete_burst_ms_max: s.max,
    n_delete_failed: failed,
  };
  for (const [k, v] of Object.entries(out)) if (typeof v === "number" && Number.isNaN(v)) out[k] = "";
  return out;
}

/** ms rounded to 0.01 for a measurement cell. */
export const r2 = (x: number) => Math.round(x * 100) / 100;
