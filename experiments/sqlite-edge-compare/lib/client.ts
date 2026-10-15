/**
 * What TD modules import. Two vantages, one result shape (RunResponse):
 *
 *   runOnWorker(ctx, req, opts)  POST /run on the probe Worker. Splits
 *                                `repeat` into invocations of at most
 *                                OPS_PER_INVOCATION statement executions,
 *                                runs them in sequence, and merges; or fans
 *                                out `opts.invocations` parallel copies for
 *                                contention rows.
 *   runLocal(ctx, req)           the same executor from this machine:
 *                                turso_http, pg_pooler (6543), pg_session
 *                                (5432 pooler), pg_direct, d1_rest, postgrest.
 *   metaOnWorker(ctx)            GET /meta.
 *
 * Plus the fixture loader and direct helpers (pgConfig, tursoClient,
 * d1Query) for setup SQL a module runs before it measures.
 */
import { createClient } from "@libsql/client/web";
import type pg from "pg";
import type { Ctx } from "../../../harness/src/types";
import { d1RestLane, libsqlLane, pgLane, postgrestLane } from "./adapters";
import { LOCAL_BACKENDS, type LocalBackend, type MetaResponse, OPS_PER_INVOCATION, type OpResult, type RunRequest, type RunResponse, type WorkerBackend } from "./contract";
import { countErrors, executeRun, type OpenLane, validateRunRequest } from "./exec";
import { directAddress, FIXTURE_FILE, type Fixture, readFixture } from "./fixture";
import { type Summary, summarize } from "./stats";
import { cfCreds, d1Rest } from "./vendors";

export type { Fixture } from "./fixture";

/* -------------------------------- fixture ------------------------------- */

/** The fixture `make probe` pointed at (PVLAB_ENDPOINT_FIXTURE), else the default path. Null when absent. */
export async function loadFixture(ctx?: Pick<Ctx, "endpoints">): Promise<Fixture | null> {
  return readFixture(ctx?.endpoints?.fixture || FIXTURE_FILE);
}

/** For a module's first lines: `const fx = await fixtureOrSkip(ctx); if ("skip" in fx) return skip(fx.skip);` */
export async function fixtureOrSkip(ctx: Pick<Ctx, "endpoints">): Promise<Fixture | { skip: string }> {
  const f = await loadFixture(ctx).catch((e) => ({ skip: `.fixture.json unreadable: ${e instanceof Error ? e.message : String(e)}` }));
  if (!f) return { skip: "no .fixture.json: run `make up` (sqlite-edge-compare) first" };
  if ("skip" in f) return f;
  if (!f.worker?.deployedAt || !f.supabase?.secretKey || !f.turso?.token || !f.d1?.id) return { skip: "fixture incomplete: re-run `make up`" };
  return f;
}

/* ------------------------------ split / merge ---------------------------- */

/** Iterations per invocation so that iterations x statements <= cap. */
export function chunkPlan(repeat: number, statements: number, cap = OPS_PER_INVOCATION): number[] {
  const per = Math.max(1, Math.floor(cap / Math.max(1, statements)));
  const out: number[] = [];
  for (let left = repeat; left > 0; left -= per) out.push(Math.min(per, left));
  return out;
}

export interface RunResult extends RunResponse {
  /** Invocations (HTTP requests) this result merges. */
  invocations: number;
  /** Distinct colos that served them, in order of first appearance. */
  colos: string[];
  /** Client-side HTTP round trip per invocation, ms (includes the Worker's own wall time). */
  httpMs: number[];
  /** Summary of op.ms over successful ops, no warm-up dropped (use summarize() with your own warm-up). */
  summary: Summary;
}

/** Merge invocation responses: ops get `inv`, iteration indices are kept (the Worker already offset them). */
export function mergeRuns(parts: RunResponse[], httpMs: number[] = []): RunResult {
  if (parts.length === 0) throw new Error("mergeRuns: nothing to merge");
  const first = parts[0]!;
  const ops: OpResult[] = [];
  const lanes: RunResponse["lanes"] = [];
  const colos: string[] = [];
  let repeat = 0;
  let wall = 0;
  const errs: string[] = [];
  parts.forEach((p, inv) => {
    if (!p.ok && p.error) errs.push(p.error);
    for (const o of p.ops ?? []) ops.push({ ...o, inv });
    for (const l of p.lanes ?? []) lanes.push({ ...l, lane: l.lane + inv * 1000 });
    if (p.colo && !colos.includes(p.colo)) colos.push(p.colo);
    repeat += p.repeat ?? 0;
    wall += p.wallMs ?? 0;
  });
  return {
    ...first,
    ok: parts.every((p) => p.ok),
    ...(errs.length ? { error: [...new Set(errs)].join("; ") } : {}),
    repeat,
    wallMs: wall,
    ops,
    lanes,
    errors: countErrors(ops, lanes),
    invocations: parts.length,
    colos,
    httpMs,
    summary: summarize(ops.filter((o) => o.ok).map((o) => o.ms)),
  };
}

/* --------------------------------- Worker -------------------------------- */

export interface WorkerOpts {
  /** Parallel copies of the whole request (separate invocations). Default 1. */
  invocations?: number;
  timeoutMs?: number;
}

type FxLike = Fixture | Pick<Ctx, "endpoints">;
async function fxOf(x: FxLike): Promise<Fixture> {
  if ("stamp" in x) return x as Fixture;
  const f = await loadFixture(x as Pick<Ctx, "endpoints">);
  if (!f?.worker) throw new Error("no fixture / worker: run `make up`");
  return f;
}

async function post(f: Fixture, body: RunRequest, timeoutMs: number): Promise<{ res: RunResponse; ms: number }> {
  const t0 = performance.now();
  let res: RunResponse;
  try {
    const r = await fetch(`${f.worker!.url}/run`, {
      method: "POST",
      headers: { "X-Probe-Key": f.worker!.probeKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // Bun's socket idle timeout (5 min default) otherwise fires before
      // timeoutMs on a long silent /run (TD02 turso 10001-query ceiling,
      // 330912 ms in the re-run, lost twice on 2026-10-15); the AbortSignal
      // is the deadline.
      timeout: false,
    } as RequestInit);
    const text = await r.text();
    try {
      res = JSON.parse(text) as RunResponse;
    } catch {
      res = { ok: false, error: `HTTP ${r.status} non-JSON: ${text.slice(0, 300)}` } as RunResponse;
    }
  } catch (e) {
    res = { ok: false, error: `fetch: ${e instanceof Error ? e.message : String(e)}` } as RunResponse;
  }
  const blank = { backend: body.backend, mode: body.mode ?? "each", repeat: 0, concurrency: body.concurrency ?? 1, colo: "", startedAt: "", wallMs: 0, lanes: [], ops: [], errors: [], driver: { name: "", version: "" } };
  return { res: { ...blank, ...res }, ms: performance.now() - t0 };
}

/**
 * POST /run. Requests above OPS_PER_INVOCATION statement executions are split
 * into sequential invocations (iteration indices stay global) unless
 * `req.noSplit`. With `opts.invocations = k`, k copies of each chunk run in
 * parallel as separate invocations (true concurrency for fetch-based backends,
 * which queue above six connections inside one invocation).
 */
export async function runOnWorker(x: FxLike, req: RunRequest<WorkerBackend>, opts: WorkerOpts = {}): Promise<RunResult> {
  const f = await fxOf(x);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const k = Math.max(1, opts.invocations ?? 1);
  const chunks = req.noSplit ? [req.repeat ?? 1] : chunkPlan(req.repeat ?? 1, req.statements.length);
  const parts: RunResponse[] = [];
  const http: number[] = [];
  let offset = 0;
  for (const n of chunks) {
    const batch = await Promise.all(Array.from({ length: k }, () => post(f, { ...req, repeat: n, ...(offset ? { iOffset: offset } : {}) }, timeoutMs)));
    for (const b of batch) {
      parts.push(b.res);
      http.push(b.ms);
    }
    offset += n;
  }
  return mergeRuns(parts, http);
}

export async function metaOnWorker(x: FxLike, timeoutMs = 60_000): Promise<MetaResponse> {
  const f = await fxOf(x);
  const r = await fetch(`${f.worker!.url}/meta`, { headers: { "X-Probe-Key": f.worker!.probeKey }, signal: AbortSignal.timeout(timeoutMs) });
  return (await r.json()) as MetaResponse;
}

/* --------------------------------- local --------------------------------- */

export type PgPath = "pooler" | "session" | "direct";

/**
 * node-postgres config for a local path: pooler 6543 (transaction mode),
 * pooler 5432 (session), direct 5432. TLS without CA pinning. The direct host
 * is IPv6-only and this vantage's getaddrinfo does not resolve it (see
 * fixture.ts directAddress), so "direct" connects to the resolved AAAA address.
 */
export async function pgConfig(f: Fixture, path: PgPath): Promise<pg.ClientConfig> {
  const s = f.supabase!;
  const base = { password: s.dbPass, database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 };
  if (path === "direct") return { ...base, host: await directAddress(s.directHost), port: 5432, user: "postgres" };
  return { ...base, host: s.poolerHost, port: path === "pooler" ? 6543 : 5432, user: s.poolerUser };
}

/** @libsql/client over HTTP (the same `web` entry the Worker bundles). */
export function tursoClient(f: Fixture) {
  return createClient({ url: f.turso!.url, authToken: f.turso!.token!, intMode: "number" });
}

/** One D1 REST query (admin path). Needs the Cloudflare trio in env. Throws on !success. */
export async function d1Query(f: Fixture, sql: string, params: unknown[] = []) {
  const c = cfCreds();
  if (!c) throw new Error("d1Query: CLOUDFLARE_EMAIL/CLOUDFLARE_API_KEY/CLOUDFLARE_ACCOUNT_ID not set");
  const r = await d1Rest(c, f.d1!.id, sql, params);
  if (!r.success) throw new Error(`D1 REST HTTP ${r.status}: ${r.errors.map((e) => e.message).join("; ") || r.text.slice(0, 200)}`);
  return r.result?.[0] ?? {};
}

function localOpener(f: Fixture, b: LocalBackend): { open: OpenLane; driver: { name: string; version: string } } {
  switch (b) {
    case "turso_http":
      return { open: async () => libsqlLane(tursoClient(f)), driver: { name: "@libsql/client/web", version: "local" } };
    case "pg_pooler":
      return { open: async () => pgLane(await pgConfig(f, "pooler")), driver: { name: "pg pooler:6543", version: "local" } };
    case "pg_session":
      return { open: async () => pgLane(await pgConfig(f, "session")), driver: { name: "pg pooler:5432", version: "local" } };
    case "pg_direct":
      return { open: async () => pgLane(await pgConfig(f, "direct")), driver: { name: "pg direct:5432", version: "local" } };
    case "d1_rest":
      return { open: async () => d1RestLane((sql, params) => d1Query(f, sql, params)), driver: { name: "d1 REST /query", version: "v4" } };
    case "postgrest":
      return { open: async () => postgrestLane(f.supabase!.url, f.supabase!.secretKey!), driver: { name: "fetch+postgrest", version: "local" } };
  }
}

/** The /run executor on this machine. No split ceiling applies locally (noSplit is implied). */
export async function runLocal(x: FxLike, req: RunRequest<LocalBackend>): Promise<RunResult> {
  const f = await fxOf(x);
  const v = validateRunRequest({ ...req, noSplit: true }, LOCAL_BACKENDS);
  if (!v.ok) throw new Error(`runLocal: ${v.error}`);
  const { open, driver } = localOpener(f, req.backend);
  const t0 = performance.now();
  const res = await executeRun(v.req, open, { colo: "local", driver });
  return mergeRuns([res], [performance.now() - t0]);
}
