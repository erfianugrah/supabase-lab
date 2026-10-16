/**
 * sqlite-edge-compare probe Worker. Workload-generic: modules send their own
 * SQL per backend; this file only knows how to reach each backend and time a
 * driver call. Contract: lib/contract.ts. Executor: lib/exec.ts (shared with
 * the local vantage).
 *
 *   POST /run   RunRequest  -> RunResponse   (X-Probe-Key required)
 *   GET  /meta              -> MetaResponse  (X-Probe-Key required)
 *
 * Bindings (rendered into wrangler.jsonc by lib/fixture.ts up):
 *   DB          D1 database (location hint oc, read replication at default)
 *   HD          Hyperdrive, caching disabled, on the Supabase direct string
 *   HD_CACHED   Hyperdrive, caching enabled (default max_age), same origin
 *   PDO         Durable Object namespace of ProbeDO (SQLite storage), objects
 *               reached by name with locationHint oc
 *   SUPABASE_URL, TURSO_URL, TURSODB_URL, DRIVER_PG, DRIVER_LIBSQL,
 *   COMPAT_DATE                                                     vars
 *   PROBE_KEY, TURSO_TOKEN, TURSODB_TOKEN, SUPABASE_SECRET_KEY      secrets
 * TURSODB_URL is "" when the org could not create a Turso-engine database.
 *
 * Timing: performance.now() around each driver call. Workers advance the
 * clock only across I/O, so a timing is I/O wall time; that is the quantity
 * of interest for a network database call. Six connections per invocation
 * may wait for response headers at once (Workers limits page), so fetch-based
 * backends (turso, postgrest) queue above concurrency 6 inside one
 * invocation; spread real contention over several invocations instead
 * (runOnWorker's `invocations` option).
 */
import { createClient } from "@libsql/client/web";
import { DurableObject } from "cloudflare:workers";
import { d1Lane, type D1Like, type DoStubLike, doLane, libsqlLane, pgLane, postgrestLane } from "../lib/adapters";
import { DO_LOCATION_HINT, type MetaBackend, type MetaResponse, type Stmt, type StmtOut, WORKER_BACKENDS, type WorkerBackend } from "../lib/contract";
import { errText, executeRun, type OpenLane, validateRunRequest } from "../lib/exec";

interface D1Database extends D1Like {
  withSession(constraint?: string): D1Like & { getBookmark(): string | null };
}
interface Hyperdrive {
  connectionString: string;
}
interface DoStub extends DoStubLike {
  colo(): Promise<string>;
  wipe(): Promise<void>;
}
interface DoNamespace {
  idFromName(name: string): unknown;
  get(id: unknown, opts?: { locationHint?: string }): DoStub;
}
interface Env {
  DB: D1Database;
  HD: Hyperdrive;
  HD_CACHED: Hyperdrive;
  PDO: DoNamespace;
  SUPABASE_URL: string;
  TURSO_URL: string;
  TURSODB_URL: string;
  DRIVER_PG: string;
  DRIVER_LIBSQL: string;
  COMPAT_DATE: string;
  PROBE_KEY: string;
  TURSO_TOKEN: string;
  TURSODB_TOKEN: string;
  SUPABASE_SECRET_KEY: string;
}

const enc = new TextEncoder();
async function keyOk(got: string | null, want: string): Promise<boolean> {
  if (!got || !want) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(got)), crypto.subtle.digest("SHA-256", enc.encode(want))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}

/**
 * The probe Durable Object: runs SQL on its own SQLite storage. Rows come back
 * as plain objects; rowsRead / rowsWritten from the cursor go in meta. Errors
 * (including the SQL API's refusal of BEGIN) propagate to the caller verbatim.
 */
export class ProbeDO extends DurableObject<Env> {
  run(stmts: Stmt[], mode: "each" | "batch"): StmtOut[] {
    const sql = this.ctx.storage.sql;
    const one = (s: Stmt): StmtOut => {
      // total_changes() before and after: rows this statement changed (changes() alone repeats the last write's
      // count after a SELECT). Read in-process, no extra round trip; rowsWritten also counts index writes.
      const tc = () => Number(sql.exec("select total_changes() as n").toArray()[0]?.n ?? 0);
      const before = tc();
      const c = sql.exec(s.sql ?? "", ...((s.params ?? []) as unknown[]));
      const rows = c.toArray();
      const changes = tc() - before;
      return { rowCount: rows.length, rows, meta: { rowsRead: c.rowsRead, rowsWritten: c.rowsWritten, changes } };
    };
    return mode === "batch" ? this.ctx.storage.transactionSync(() => stmts.map(one)) : stmts.map(one);
  }
  /** Where the object runs: the colo field of a /cdn-cgi/trace fetched from inside it (not a documented DO API). */
  async colo(): Promise<string> {
    const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
    return /^colo=(.+)$/m.exec(t)?.[1] ?? "unknown";
  }
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

const doStub = (env: Env, name = "main") => env.PDO.get(env.PDO.idFromName(name), { locationHint: DO_LOCATION_HINT });

function opener(env: Env, backend: WorkerBackend, d1Session?: string, doName?: string): { open: OpenLane; driver: { name: string; version: string } } {
  switch (backend) {
    case "d1": {
      const db: D1Like = d1Session ? env.DB.withSession(d1Session) : env.DB;
      return { open: async () => d1Lane(db), driver: { name: "d1-binding", version: env.COMPAT_DATE } };
    }
    case "turso":
      return {
        open: async () => libsqlLane(createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN, intMode: "number" })),
        driver: { name: "@libsql/client/web", version: env.DRIVER_LIBSQL },
      };
    case "tursodb":
      return {
        open: async () => {
          if (!env.TURSODB_URL) throw new Error("tursodb: not configured (no Turso-engine database in the fixture)");
          return libsqlLane(createClient({ url: env.TURSODB_URL, authToken: env.TURSODB_TOKEN, intMode: "number" }));
        },
        driver: { name: "@libsql/client/web (tursodb)", version: env.DRIVER_LIBSQL },
      };
    case "do":
      return { open: async () => doLane(doStub(env, doName)), driver: { name: "durable-object-rpc(sqlite)", version: env.COMPAT_DATE } };
    case "pg":
      return { open: () => pgLane(env.HD.connectionString), driver: { name: "pg+hyperdrive(nocache)", version: env.DRIVER_PG } };
    case "pg_cached":
      return { open: () => pgLane(env.HD_CACHED.connectionString), driver: { name: "pg+hyperdrive(cached)", version: env.DRIVER_PG } };
    case "postgrest":
      return { open: async () => postgrestLane(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY), driver: { name: "fetch+postgrest", version: "n/a" } };
  }
}

/* -------------------------------- routes -------------------------------- */

async function meta(env: Env, colo: string): Promise<MetaResponse> {
  const probe = async (b: WorkerBackend): Promise<MetaBackend> => {
    const t0 = performance.now();
    try {
      const { open } = opener(env, b);
      const lane = await open(0);
      try {
        let out: StmtOut;
        if (b === "postgrest") out = await lane.each({ http: { method: "GET", path: "" } });
        // D1 refuses sqlite_version(): "not authorized to use function" (2026-10-15).
        else if (b === "d1") out = await lane.each({ sql: "select 1 as one" });
        // The Durable Object SQL API refuses sqlite_version() ("not authorized to use function", 2026-10-16), as D1 does.
        else if (b === "do") out = { ...(await lane.each({ sql: "select 1 as one" })), meta: { do_colo: await doStub(env).colo() } };
        else if (b === "turso" || b === "tursodb") out = await lane.each({ sql: "select 1 as one, sqlite_version() as sqlite_version" });
        else out = await lane.each({ sql: "select 1 as one, current_setting('server_version') as server_version, family(inet_server_addr()) as addr_family" });
        const row = (out.rows?.[0] ?? {}) as Record<string, unknown>;
        const detail: Record<string, unknown> = b === "postgrest" ? { status: out.meta?.status } : { ...row };
        if (b === "d1") {
          for (const k of ["served_by_region", "served_by_primary", "served_by_colo", "duration"]) if (out.meta?.[k] !== undefined) detail[k] = out.meta[k];
        }
        if (b === "do") detail.do_colo = out.meta?.do_colo;
        return { ok: true, ms: performance.now() - t0, detail };
      } finally {
        await lane.close().catch(() => undefined);
      }
    } catch (e) {
      return { ok: false, ms: performance.now() - t0, error: errText(e) };
    }
  };
  const results = await Promise.all(WORKER_BACKENDS.map(async (b) => [b, await probe(b)] as const));
  const backends = Object.fromEntries(results) as Record<WorkerBackend, MetaBackend>;
  return {
    // An unconfigured tursodb (org refused use_tursodb) does not fail /meta.
    ok: results.every(([b, r]) => r.ok || (b === "tursodb" && !env.TURSODB_URL)),
    colo,
    compatibilityDate: env.COMPAT_DATE,
    drivers: { pg: env.DRIVER_PG, "@libsql/client": env.DRIVER_LIBSQL },
    backends,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const colo = String((request as unknown as { cf?: { colo?: string } }).cf?.colo ?? "unknown");
    if (!(await keyOk(request.headers.get("X-Probe-Key"), env.PROBE_KEY))) {
      return Response.json({ ok: false, error: "missing or wrong X-Probe-Key" }, { status: 401 });
    }
    if (url.pathname === "/meta" && request.method === "GET") {
      return Response.json(await meta(env, colo));
    }
    if (url.pathname === "/run" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "body is not JSON" }, { status: 400 });
      }
      const v = validateRunRequest(body, WORKER_BACKENDS);
      if (!v.ok) return Response.json({ ok: false, error: v.error }, { status: 400 });
      const req = v.req;
      try {
        const { open, driver } = opener(env, req.backend as WorkerBackend, req.d1Session, req.doName);
        const res = await executeRun(req, open, { colo, driver, iOffset: Number(req.iOffset) || 0 });
        if (req.backend === "do" && req.doWipe) await doStub(env, req.doName).wipe();
        return Response.json(res);
      } catch (e) {
        return Response.json({ ok: false, error: `executor threw: ${errText(e)}` }, { status: 500 });
      }
    }
    return Response.json({ ok: false, error: "routes: POST /run, GET /meta" }, { status: 404 });
  },
};
