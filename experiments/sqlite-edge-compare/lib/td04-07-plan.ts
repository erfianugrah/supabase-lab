/**
 * Module-private helpers for TD04 (write contention) and TD07 (transaction
 * semantics). Pure: sizes from env, how a concurrency level is spread over
 * Worker invocations, throughput and error shape from a RunResult's ops, the
 * per-dialect SQL both modules send, and the Turso engine check on a DbId.
 */
import type { Backend, OpResult, RunResponse } from "./contract";

export type Dialect = "sqlite" | "pg";

/** D1 and libSQL speak SQLite with `?` placeholders; Postgres paths use `$1`. */
export function dialectOf(b: Backend): Dialect {
  return b === "d1" || b === "turso" || b === "turso_http" || b === "d1_rest" ? "sqlite" : "pg";
}

const intList = (s: string | undefined): number[] | null => {
  if (!s) return null;
  const xs = s.split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
  return xs.length ? xs : null;
};
const posInt = (s: string | undefined): number | null => {
  const n = Number(s);
  return s && Number.isInteger(n) && n > 0 ? n : null;
};

export interface Td04Sizes {
  smoke: boolean;
  /** Concurrency levels for the Worker rows. */
  levels: number[];
  /** Attempted ops per (workload, backend, level) cell. */
  opsPerCell: number;
  /** Concurrency levels for the local Turso-engine (BEGIN CONCURRENT) rows. */
  mvccLevels: number[];
  /** Committed transactions wanted per local MVCC cell. */
  mvccOps: number;
  /** Attempts per local transaction before it is counted as given up. */
  mvccMaxAttempts: number;
}

/**
 * Full sizes by default (the battery); TD_SMOKE=1 for a quick live check.
 * TD04_LEVELS / TD04_OPS / TD04_MVCC_LEVELS / TD04_MVCC_OPS override either.
 * 256 = 4 x 64, so every level divides it evenly and no Worker chunk exceeds
 * the 500-op split; at about 250 ms per sequential write from the SIN colo to
 * Sydney (smoke run, 2026-10-15) a C=1 cell takes about a minute.
 */
export function td04Sizes(env: Record<string, string | undefined> = process.env): Td04Sizes {
  const smoke = env.TD_SMOKE === "1";
  return {
    smoke,
    levels: intList(env.TD04_LEVELS) ?? (smoke ? [1, 4] : [1, 4, 16, 64]),
    opsPerCell: posInt(env.TD04_OPS) ?? (smoke ? 16 : 256),
    mvccLevels: intList(env.TD04_MVCC_LEVELS) ?? (smoke ? [1, 4] : [1, 4, 16]),
    mvccOps: posInt(env.TD04_MVCC_OPS) ?? (smoke ? 8 : 64),
    mvccMaxAttempts: 25,
  };
}

export interface Td07Sizes {
  smoke: boolean;
  /** Write-then-read pairs per read-your-write row. */
  ryw: number;
  /** Filler reads inside the transaction that a concurrent writer races (each a round trip). */
  fillers: number;
  /** Concurrent writer's updates. */
  writerOps: number;
}

export function td07Sizes(env: Record<string, string | undefined> = process.env): Td07Sizes {
  const smoke = env.TD_SMOKE === "1";
  return {
    smoke,
    ryw: posInt(env.TD07_RYW) ?? (smoke ? 5 : 30),
    fillers: posInt(env.TD07_FILLERS) ?? (smoke ? 4 : 8),
    writerOps: posInt(env.TD07_WRITER_OPS) ?? (smoke ? 3 : 6),
  };
}

/**
 * Spread `concurrency` over Worker invocations with at most `maxLanes` lanes
 * each. Workers let six connections per invocation wait for headers at once
 * (fetch-based backends queue past that) and TCP sockets count against the
 * same limit, so every backend gets the same shape: 64 = 16 invocations x 4
 * lanes. A level that does not divide evenly rounds the invocation count up.
 */
export function laneSplit(concurrency: number, maxLanes = 4): { invocations: number; lanes: number } {
  const c = Math.max(1, Math.floor(concurrency));
  const lanes = Math.min(c, Math.max(1, maxLanes));
  return { invocations: Math.ceil(c / lanes), lanes };
}

/** Iterations each invocation runs so the cell attempts at least `total` ops. */
export function perInvocation(total: number, invocations: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, invocations)));
}

export interface Throughput {
  attempted: number;
  ok: number;
  failed: number;
  /** Lanes whose connection never opened (they ran nothing). */
  laneErrors: number;
  errorRate: number;
  /** Longest invocation span (first op start to last op end), ms. Parallel invocations overlap. */
  spanMs: number;
  /** ok ops per second over spanMs. */
  opsPerSec: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Throughput and failure shape over a merged result's ops (op.inv tells the invocations apart). */
export function throughput(ops: readonly OpResult[], lanes: RunResponse["lanes"] = []): Throughput {
  const span = new Map<number, number>();
  for (const o of ops) span.set(o.inv, Math.max(span.get(o.inv) ?? 0, o.t0 + o.ms));
  const spanMs = Math.max(0, ...span.values());
  const ok = ops.filter((o) => o.ok).length;
  const failed = ops.length - ok;
  return {
    attempted: ops.length,
    ok,
    failed,
    laneErrors: lanes.filter((l) => l.error).length,
    errorRate: ops.length ? r2(failed / ops.length) : 0,
    spanMs: r2(spanMs),
    opsPerSec: spanMs > 0 ? r2((ok * 1000) / spanMs) : 0,
  };
}

/** The k most frequent error texts, each with its count, for `detail` / `evidence`. */
export function topErrors(errors: readonly { text: string; count: number }[], k = 3, width = 220): string {
  return errors
    .slice(0, k)
    .map((e) => `${e.count}x ${e.text.length > width ? `${e.text.slice(0, width)}...` : e.text}`)
    .join(" | ");
}

/** First non-empty value of a meta key across ops (D1 served_by_region, served_by_colo). */
export function firstMeta(ops: readonly OpResult[], key: string): string {
  for (const o of ops) for (const s of o.out ?? []) if (s.meta?.[key] !== undefined && s.meta[key] !== null) return String(s.meta[key]);
  return "";
}

/** First row's first column value, or null (for count / counter reads). */
export function scalar(res: Pick<RunResponse, "ops">, stmt = 0): unknown {
  const op = res.ops.find((o) => o.ok && (o.stmt === stmt || o.stmt === -1));
  const out = op?.out?.[op.stmt === -1 ? stmt : 0];
  const row = out?.rows?.[0] as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] ?? null : null;
}

/* ---------------------------------- SQL --------------------------------- */

/** TD04 schema and statements per dialect. Tables are prefixed td04_ so other modules' tables are never touched. */
export const TD04_SQL: Record<Dialect, { create: string[]; reset: string[]; insert: string; incr: string; countIns: string; readCtr: string; drop: string[] }> = {
  sqlite: {
    create: [
      "CREATE TABLE IF NOT EXISTS td04_ins (id INTEGER PRIMARY KEY, v TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS td04_ctr (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
    ],
    reset: ["DELETE FROM td04_ins", "DELETE FROM td04_ctr", "INSERT INTO td04_ctr (id, n) VALUES (1, 0)"],
    insert: "INSERT INTO td04_ins (v) VALUES (?)",
    incr: "UPDATE td04_ctr SET n = n + 1 WHERE id = 1",
    countIns: "SELECT count(*) AS c FROM td04_ins",
    readCtr: "SELECT n FROM td04_ctr WHERE id = 1",
    drop: ["DROP TABLE IF EXISTS td04_ins", "DROP TABLE IF EXISTS td04_ctr"],
  },
  pg: {
    create: [
      "CREATE TABLE IF NOT EXISTS td04_ins (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text NOT NULL)",
      "CREATE TABLE IF NOT EXISTS td04_ctr (id int PRIMARY KEY, n bigint NOT NULL)",
    ],
    reset: ["TRUNCATE td04_ins", "DELETE FROM td04_ctr", "INSERT INTO td04_ctr (id, n) VALUES (1, 0)"],
    insert: "INSERT INTO td04_ins (v) VALUES ($1)",
    incr: "UPDATE td04_ctr SET n = n + 1 WHERE id = 1",
    countIns: "SELECT count(*)::int AS c FROM td04_ins",
    readCtr: "SELECT n::int AS n FROM td04_ctr WHERE id = 1",
    drop: ["DROP TABLE IF EXISTS td04_ins", "DROP TABLE IF EXISTS td04_ctr"],
  },
};

/** A fixed 64-byte payload: the same row for every backend (seed is the constant itself). */
export const TD04_PAYLOAD = "td04-".padEnd(64, "x");

/** TD07 schema: one key/value table. Duplicate-key inserts are the deliberate error. */
export const TD07_SQL: Record<Dialect, { create: string[]; drop: string[]; ins: string; get: string; set: string; incr: string; count: string; del: string }> = {
  sqlite: {
    create: ["CREATE TABLE IF NOT EXISTS td07_kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL)"],
    drop: ["DROP TABLE IF EXISTS td07_kv"],
    ins: "INSERT INTO td07_kv (k, v) VALUES (?, ?)",
    get: "SELECT v FROM td07_kv WHERE k = ?",
    set: "UPDATE td07_kv SET v = ? WHERE k = ?",
    incr: "UPDATE td07_kv SET v = v + 1 WHERE k = ?",
    count: "SELECT count(*) AS c FROM td07_kv WHERE k LIKE ?",
    del: "DELETE FROM td07_kv",
  },
  pg: {
    create: ["CREATE TABLE IF NOT EXISTS td07_kv (k text PRIMARY KEY, v int NOT NULL)"],
    drop: ["DROP TABLE IF EXISTS td07_kv"],
    ins: "INSERT INTO td07_kv (k, v) VALUES ($1, $2)",
    get: "SELECT v FROM td07_kv WHERE k = $1",
    set: "UPDATE td07_kv SET v = $1 WHERE k = $2",
    incr: "UPDATE td07_kv SET v = v + 1 WHERE k = $1",
    count: "SELECT count(*)::int AS c FROM td07_kv WHERE k LIKE $1",
    del: "DELETE FROM td07_kv",
  },
};

/* ------------------------------ Turso engine ----------------------------- */

/**
 * turso-cli (internal/cmd/db_show.go isTursoDB) classifies a database as the
 * Turso engine when byte 5 of its DbId UUID is 0x10, else "SQLite" (libSQL).
 * Null when the id is not a UUID.
 */
export function tursoEngineOf(dbId: string | undefined | null): "tursodb" | "libsql" | null {
  const hex = String(dbId ?? "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  return Number.parseInt(hex.slice(10, 12), 16) === 0x10 ? "tursodb" : "libsql";
}

/** MVCC write-write conflict texts are retried; anything else is a real failure. */
export function isConflict(text: string): boolean {
  return /conflict|busy|locked|SQLITE_BUSY|write-write|snapshot/i.test(text);
}

/** Replace Turso hostnames and JWTs in free text before it lands in a result. */
export function scrub(text: string, literals: readonly string[] = []): string {
  let s = text.replace(/ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "<jwt>").replace(/[a-z0-9-]+\.[a-z0-9-]+\.turso\.io/gi, "<turso-host>");
  for (const l of literals) if (l) s = s.split(l).join("<redacted>");
  return s;
}
