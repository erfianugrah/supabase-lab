/**
 * The wire contract between modules, the probe Worker and the local client.
 * Types and constants only: imported by worker/index.ts (bundled by wrangler),
 * lib/exec.ts, lib/client.ts and the TD modules, so nothing here may touch
 * node: APIs.
 *
 * One operation ("op") is one timed driver call:
 *   mode "each"  - one op per statement per iteration
 *   mode "batch" - one op per iteration: D1 `batch()`, libSQL `batch("write")`,
 *                  Postgres BEGIN; statements; COMMIT on one connection
 *                  (node-postgres has no batch primitive; for Postgres a
 *                  "batch" is the transaction a batch implies)
 *   mode "tx"    - one op per iteration: an INTERACTIVE transaction, one
 *                  round trip per statement. D1 has none through the binding;
 *                  the executor sends BEGIN TRANSACTION as a statement and the
 *                  error text D1 answers with is the measurement.
 * Timing is `performance.now()` around the driver call. In a Worker the clock
 * only advances across I/O (Spectre mitigation), which is what a driver call
 * is, so op timings are I/O wall time; CPU spent between I/O reads as zero.
 */

export const PREFIX = "sec-";

/** All three data planes sit in Sydney (see the plan for why not Singapore). */
export const SUPABASE_REGION = "ap-southeast-2";
export const TURSO_LOCATION = "aws-ap-southeast-2";
export const TURSO_GROUP = "sec-syd";
export const D1_LOCATION_HINT = "oc";

/**
 * Statement executions per Worker invocation before the client splits a
 * request (D1 documents 1000 queries per invocation on Paid; half of that
 * leaves headroom for /meta-style extras). Counted as iterations x statements
 * in every mode, since a D1 batch counts each statement as a query.
 */
export const OPS_PER_INVOCATION = 500;
export const MAX_CONCURRENCY = 64;
export const MAX_STATEMENTS = 100;

/** Backends reachable from inside the probe Worker. */
export type WorkerBackend = "d1" | "turso" | "pg" | "pg_cached" | "postgrest";
/** Backends reachable from the local vantage (lib/client.ts runLocal). */
export type LocalBackend = "turso_http" | "pg_pooler" | "pg_session" | "pg_direct" | "d1_rest" | "postgrest";
export type Backend = WorkerBackend | LocalBackend;
export type Mode = "each" | "batch" | "tx";

export const WORKER_BACKENDS: readonly WorkerBackend[] = ["d1", "turso", "pg", "pg_cached", "postgrest"];
export const LOCAL_BACKENDS: readonly LocalBackend[] = ["turso_http", "pg_pooler", "pg_session", "pg_direct", "d1_rest", "postgrest"];

export type Param = string | number | boolean | null;

/** A PostgREST call: `path` is relative to /rest/v1/ (e.g. "kv?id=eq.7"). */
export interface HttpStmt {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  /** Extra headers, e.g. { Prefer: "return=representation" }. apikey is added for you. */
  headers?: Record<string, string>;
}

/**
 * SQL backends read `sql` + `params` (placeholders are the backend's own:
 * `?` for D1/libSQL, `$1` for Postgres). `postgrest` reads `http` only.
 */
export interface Stmt {
  sql?: string;
  params?: Param[];
  http?: HttpStmt;
}

export interface RunRequest<B extends Backend = Backend> {
  backend: B;
  statements: Stmt[];
  /** Iterations; default 1. The client splits above OPS_PER_INVOCATION. */
  repeat?: number;
  /** Lanes inside one invocation pulling iterations from a shared counter; default 1, max 64. */
  concurrency?: number;
  /** Default "each". postgrest and d1_rest accept "each" only. */
  mode?: Mode;
  /** Attach rows (capped at rowsLimit per statement) to each op. Default false. */
  returnRows?: boolean;
  rowsLimit?: number;
  /** Attach driver meta (D1 meta, libSQL rowsAffected, pg command) to each op. Default true. */
  returnMeta?: boolean;
  /** D1 only: run through `env.DB.withSession(<this>)` ("first-primary", "first-unconstrained" or a bookmark). */
  d1Session?: string;
  /** Worker only: allow more than OPS_PER_INVOCATION in one invocation (TD02's deliberate ceiling row). */
  noSplit?: boolean;
  /** Free text echoed back, for the module's own bookkeeping. */
  label?: string;
  /** Set by runOnWorker when it splits: added to every op's `i` so indices stay global. */
  iOffset?: number;
}

/** What one statement produced. rows only when returnRows; meta only when returnMeta. */
export interface StmtOut {
  rowCount?: number;
  rows?: unknown[];
  meta?: Record<string, unknown>;
}

export interface OpResult {
  /** Which invocation (request) this came from; 0 inside the Worker, set by the client when it merges. */
  inv: number;
  lane: number;
  /** Iteration index, global across split invocations. */
  i: number;
  /** Statement index in "each" mode; -1 for a whole batch / tx. */
  stmt: number;
  /** ms since this invocation's executor started (op start). */
  t0: number;
  /** Timed driver call, ms. */
  ms: number;
  ok: boolean;
  /** Driver error text, verbatim, truncated to 500 chars. */
  error?: string;
  /** One entry per statement the op ran (length 1 in "each" mode). */
  out?: StmtOut[];
}

export interface LaneInfo {
  lane: number;
  /** Time to open the lane's connection (pg connect / client create); not part of any op. */
  connectMs: number;
  error?: string;
}

export interface RunResponse {
  ok: boolean;
  /** Present when the request itself was rejected (bad shape, missing key) or the executor threw. */
  error?: string;
  backend: Backend;
  mode: Mode;
  repeat: number;
  concurrency: number;
  label?: string;
  /** request.cf.colo of the invocation ("local" for runLocal). */
  colo: string;
  startedAt: string;
  /** Executor wall time in this invocation, ms. */
  wallMs: number;
  lanes: LaneInfo[];
  ops: OpResult[];
  /** Distinct error texts with counts. */
  errors: { text: string; count: number }[];
  driver: { name: string; version: string };
}

export interface MetaBackend {
  ok: boolean;
  ms: number;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface MetaResponse {
  ok: boolean;
  colo: string;
  compatibilityDate: string;
  drivers: Record<string, string>;
  backends: Record<WorkerBackend, MetaBackend>;
}
