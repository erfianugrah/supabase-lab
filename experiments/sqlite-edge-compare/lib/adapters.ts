/**
 * Backend adapters for lib/exec.ts, shared by the probe Worker and the local
 * vantage so the same driver code runs on both sides. No node: imports:
 * wrangler bundles this into the Worker.
 *
 *   d1Lane       a D1 binding (or a withSession() handle)
 *   libsqlLane   an @libsql/client client (web in the Worker, web locally too)
 *   pgLane       node-postgres; "batch" and "tx" are both BEGIN..COMMIT
 *   postgrestLane fetch to /rest/v1/ with the project's secret key as apikey
 *   d1RestLane   the D1 REST query endpoint (local admin path; "each" only)
 *   doLane       a SQLite-backed Durable Object stub; one RPC per op
 */
import type { createClient } from "@libsql/client/web";
import pg from "pg";
import type { Stmt, StmtOut } from "./contract";
import { jsonSafe, type LaneConn, sequentialTx } from "./exec";

export interface D1Result {
  results?: unknown[];
  meta?: Record<string, unknown>;
}
export interface D1Prepared {
  bind(...v: unknown[]): D1Prepared;
  all(): Promise<D1Result>;
}
export interface D1Like {
  prepare(sql: string): D1Prepared;
  batch(s: D1Prepared[]): Promise<D1Result[]>;
}

export function d1Lane(db: D1Like): LaneConn {
  const prep = (s: Stmt) => {
    const p = db.prepare(s.sql ?? "");
    return s.params?.length ? p.bind(...s.params) : p;
  };
  const out = (r: D1Result): StmtOut => ({ rowCount: r.results?.length ?? 0, rows: r.results ?? [], meta: r.meta ?? {} });
  const each = async (s: Stmt) => out(await prep(s).all());
  return {
    each,
    batch: async (ss) => (await db.batch(ss.map(prep))).map(out),
    // D1 has no interactive transaction through the binding; send it anyway
    // and let the error text be the measurement (TD07).
    tx: (ss) => sequentialTx(each, ss, "BEGIN TRANSACTION"),
    close: async () => undefined,
  };
}

/** The probe Durable Object's RPC surface (worker/index.ts ProbeDO). */
export interface DoStubLike {
  run(stmts: Stmt[], mode: "each" | "batch"): Promise<StmtOut[]>;
}

/**
 * One RPC per op: "each" sends one statement, "batch" all of them (the object
 * runs them inside transactionSync). The Durable Object SQL API refuses
 * BEGIN/COMMIT in sql.exec (Durable Objects SQLite storage API docs); "tx"
 * sends them anyway so the error text is the measurement, as for D1.
 */
export function doLane(stub: DoStubLike): LaneConn {
  const each = async (s: Stmt) => (await stub.run([s], "each"))[0] ?? {};
  return {
    each,
    batch: (ss) => stub.run(ss, "batch"),
    tx: (ss) => sequentialTx(each, ss, "BEGIN TRANSACTION"),
    close: async () => undefined,
  };
}

type LibsqlClient = ReturnType<typeof createClient>;
type LibsqlResult = Awaited<ReturnType<LibsqlClient["execute"]>>;
const libsqlOut = (r: LibsqlResult): StmtOut => ({
  rowCount: r.rows.length,
  rows: r.rows.map((row) => jsonSafe(Object.fromEntries(r.columns.map((c, k) => [c, row[k]])))),
  meta: { rowsAffected: r.rowsAffected, lastInsertRowid: r.lastInsertRowid === undefined ? null : String(r.lastInsertRowid) },
});
const libsqlStmt = (s: Stmt) => ({ sql: s.sql ?? "", args: (s.params ?? []) as (string | number | boolean | null)[] });

export function libsqlLane(client: LibsqlClient): LaneConn {
  return {
    each: async (s) => libsqlOut(await client.execute(libsqlStmt(s))),
    batch: async (ss) => (await client.batch(ss.map(libsqlStmt), "write")).map(libsqlOut),
    tx: async (ss) => {
      const tx = await client.transaction("write");
      const outs: StmtOut[] = [];
      try {
        for (const s of ss) outs.push(libsqlOut(await tx.execute(libsqlStmt(s))));
        await tx.commit();
      } catch (e) {
        await tx.rollback().catch(() => undefined);
        throw e;
      } finally {
        tx.close();
      }
      return outs;
    },
    close: async () => client.close(),
  };
}

export async function pgLane(config: string | pg.ClientConfig): Promise<LaneConn> {
  const client = new pg.Client(typeof config === "string" ? { connectionString: config } : config);
  try {
    await client.connect();
  } catch (e) {
    await client.end().catch(() => undefined);
    throw e;
  }
  const each = async (s: Stmt): Promise<StmtOut> => {
    const r = await client.query(s.sql ?? "", (s.params ?? []) as unknown[]);
    return { rowCount: r.rowCount ?? r.rows.length, rows: r.rows.map(jsonSafe), meta: { command: r.command } };
  };
  return {
    each,
    batch: (ss) => sequentialTx(each, ss),
    tx: (ss) => sequentialTx(each, ss),
    close: () => client.end(),
  };
}

export async function postgrestCall(baseUrl: string, key: string, s: Stmt): Promise<StmtOut> {
  const h = s.http;
  if (!h) throw new Error("postgrest statement needs http");
  const res = await fetch(`${baseUrl}/rest/v1/${h.path.replace(/^\/+/, "")}`, {
    method: h.method,
    headers: { apikey: key, ...(h.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(h.headers ?? {}) },
    ...(h.body !== undefined ? { body: JSON.stringify(h.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 300);
  }
  const rows = Array.isArray(body) ? body : body === null ? [] : [body];
  return { rowCount: rows.length, rows, meta: { status: res.status, contentRange: res.headers.get("content-range") } };
}

const unsupported = (what: string) => () => Promise.reject(new Error(`${what} unsupported`));

export function postgrestLane(baseUrl: string, key: string): LaneConn {
  return {
    each: (s) => postgrestCall(baseUrl, key, s),
    batch: unsupported("postgrest: batch"),
    tx: unsupported("postgrest: tx"),
    close: async () => undefined,
  };
}

/** A D1 REST query function: (sql, params) -> the endpoint's first result. Injected so this file stays credential-free. */
export type D1RestQuery = (sql: string, params: unknown[]) => Promise<D1Result>;

export function d1RestLane(q: D1RestQuery): LaneConn {
  return {
    each: async (s) => {
      const r = await q(s.sql ?? "", s.params ?? []);
      return { rowCount: r.results?.length ?? 0, rows: r.results ?? [], meta: r.meta ?? {} };
    },
    batch: unsupported("d1_rest: batch"),
    tx: unsupported("d1_rest: tx"),
    close: async () => undefined,
  };
}
