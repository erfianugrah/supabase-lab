/**
 * The runtime-agnostic executor behind POST /run (Worker) and runLocal
 * (lib/client.ts). Same lane/iteration/timing logic on both vantages, so a
 * Worker row and a local row differ only in the adapter. No node: imports:
 * wrangler bundles this file into the probe Worker.
 */
import {
  type Backend,
  type LaneInfo,
  MAX_CONCURRENCY,
  MAX_STATEMENTS,
  type Mode,
  OPS_PER_INVOCATION,
  type OpResult,
  type RunRequest,
  type RunResponse,
  type Stmt,
  type StmtOut,
} from "./contract";

/** One open connection (or client) for one lane. Adapters throw on driver errors. */
export interface LaneConn {
  each(stmt: Stmt): Promise<StmtOut>;
  batch(stmts: Stmt[]): Promise<StmtOut[]>;
  tx(stmts: Stmt[]): Promise<StmtOut[]>;
  close(): Promise<void>;
}
export type OpenLane = (lane: number) => Promise<LaneConn>;

export type Validated = { ok: true; req: Required<Pick<RunRequest, "repeat" | "concurrency" | "mode">> & RunRequest } | { ok: false; error: string };

/** Shape checks shared by both vantages. `backends` is the set this vantage accepts. */
export function validateRunRequest(body: unknown, backends: readonly string[]): Validated {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
  const b = body as RunRequest;
  if (!backends.includes(b.backend)) return { ok: false, error: `backend must be one of ${backends.join("|")}` };
  if (!Array.isArray(b.statements) || b.statements.length === 0) return { ok: false, error: "statements must be a non-empty array" };
  if (b.statements.length > MAX_STATEMENTS) return { ok: false, error: `at most ${MAX_STATEMENTS} statements` };
  const mode: Mode = b.mode ?? "each";
  if (!["each", "batch", "tx"].includes(mode)) return { ok: false, error: "mode must be each|batch|tx" };
  const http = b.backend === "postgrest";
  for (const [k, s] of b.statements.entries()) {
    if (http && (typeof s?.http?.path !== "string" || !s.http.method)) return { ok: false, error: `statements[${k}].http.path required for postgrest` };
    if (!http && typeof s?.sql !== "string") return { ok: false, error: `statements[${k}].sql required` };
    if (s.params !== undefined && !Array.isArray(s.params)) return { ok: false, error: `statements[${k}].params must be an array` };
  }
  if ((b.backend === "postgrest" || b.backend === "d1_rest") && mode !== "each") {
    return { ok: false, error: `${b.backend} supports mode "each" only` };
  }
  const repeat = b.repeat ?? 1;
  const concurrency = b.concurrency ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) return { ok: false, error: "repeat must be a positive integer" };
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    return { ok: false, error: `concurrency must be an integer 1..${MAX_CONCURRENCY}` };
  }
  if (!b.noSplit && repeat * b.statements.length > OPS_PER_INVOCATION) {
    return { ok: false, error: `repeat x statements > ${OPS_PER_INVOCATION}: split across invocations (runOnWorker does) or set noSplit` };
  }
  return { ok: true, req: { ...b, repeat, concurrency, mode } };
}

export function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    const cause = e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
    return `${code ? `[${String(code)}] ` : ""}${e.message}${cause}`.slice(0, 500);
  }
  return String(e).slice(0, 500);
}

function trim(out: StmtOut, rows: boolean, meta: boolean, limit: number): StmtOut {
  const t: StmtOut = {};
  if (out.rowCount !== undefined) t.rowCount = out.rowCount;
  if (rows && out.rows) t.rows = out.rows.slice(0, limit);
  if (meta && out.meta) t.meta = out.meta;
  return t;
}

export function countErrors(ops: OpResult[], lanes: LaneInfo[] = []): { text: string; count: number }[] {
  const m = new Map<string, number>();
  for (const o of ops) if (o.error) m.set(o.error, (m.get(o.error) ?? 0) + 1);
  for (const l of lanes) if (l.error) m.set(`connect: ${l.error}`, (m.get(`connect: ${l.error}`) ?? 0) + 1);
  return [...m.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count);
}

export interface ExecOpts {
  colo: string;
  driver: { name: string; version: string };
  /** Iteration index offset (the client passes the chunk start when it splits). */
  iOffset?: number;
  now?: () => number;
}

/**
 * Run a validated request. Lanes open concurrently, then each pulls the next
 * iteration from a shared counter until `repeat` is exhausted. A failed op is
 * recorded and the lane carries on: failure shape is data. A lane whose
 * connection fails to open records the error and runs nothing.
 */
export async function executeRun(req: RunRequest & { repeat: number; concurrency: number; mode: Mode }, openLane: OpenLane, o: ExecOpts): Promise<RunResponse> {
  const now = o.now ?? (() => performance.now());
  const rows = req.returnRows ?? false;
  const meta = req.returnMeta ?? true;
  const limit = req.rowsLimit ?? 100;
  const startedAt = new Date().toISOString();
  const tStart = now();
  const ops: OpResult[] = [];
  const lanes: LaneInfo[] = [];
  let next = 0;

  const runLane = async (lane: number): Promise<void> => {
    const c0 = now();
    let conn: LaneConn;
    try {
      conn = await openLane(lane);
    } catch (e) {
      lanes.push({ lane, connectMs: now() - c0, error: errText(e) });
      return;
    }
    lanes.push({ lane, connectMs: now() - c0 });
    try {
      while (next < req.repeat) {
        const i = next++;
        const gi = i + (o.iOffset ?? 0);
        if (req.mode === "each") {
          for (const [k, s] of req.statements.entries()) {
            const t0 = now();
            try {
              const out = await conn.each(s);
              ops.push({ inv: 0, lane, i: gi, stmt: k, t0: t0 - tStart, ms: now() - t0, ok: true, out: [trim(out, rows, meta, limit)] });
            } catch (e) {
              ops.push({ inv: 0, lane, i: gi, stmt: k, t0: t0 - tStart, ms: now() - t0, ok: false, error: errText(e) });
            }
          }
        } else {
          const t0 = now();
          try {
            const outs = req.mode === "batch" ? await conn.batch(req.statements) : await conn.tx(req.statements);
            ops.push({ inv: 0, lane, i: gi, stmt: -1, t0: t0 - tStart, ms: now() - t0, ok: true, out: outs.map((x) => trim(x, rows, meta, limit)) });
          } catch (e) {
            ops.push({ inv: 0, lane, i: gi, stmt: -1, t0: t0 - tStart, ms: now() - t0, ok: false, error: errText(e) });
          }
        }
      }
    } finally {
      await conn.close().catch(() => undefined);
    }
  };

  await Promise.all(Array.from({ length: req.concurrency }, (_, lane) => runLane(lane)));
  ops.sort((a, b) => a.i - b.i || a.stmt - b.stmt);
  lanes.sort((a, b) => a.lane - b.lane);
  return {
    ok: true,
    backend: req.backend as Backend,
    mode: req.mode,
    repeat: req.repeat,
    concurrency: req.concurrency,
    ...(req.label ? { label: req.label } : {}),
    colo: o.colo,
    startedAt,
    wallMs: now() - tStart,
    lanes,
    ops,
    errors: countErrors(ops, lanes),
    driver: o.driver,
  };
}

/**
 * Interactive transaction over a statement-at-a-time connection: BEGIN, each
 * statement, COMMIT; ROLLBACK (best effort) and rethrow on the first error.
 * `begin` is the dialect's opener (Postgres "BEGIN", SQLite "BEGIN TRANSACTION").
 */
export async function sequentialTx(exec: (s: Stmt) => Promise<StmtOut>, stmts: Stmt[], begin = "BEGIN"): Promise<StmtOut[]> {
  await exec({ sql: begin });
  const outs: StmtOut[] = [];
  try {
    for (const s of stmts) outs.push(await exec(s));
    await exec({ sql: "COMMIT" });
  } catch (e) {
    await exec({ sql: "ROLLBACK" }).catch(() => undefined);
    throw e;
  }
  return outs;
}

/** Turn a libSQL/pg result into plain JSON-safe rows (bigint -> string). */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof ArrayBuffer) return `<blob ${v.byteLength} bytes>`;
  if (ArrayBuffer.isView(v)) return `<blob ${v.byteLength} bytes>`;
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonSafe(x)]));
  }
  return v;
}
