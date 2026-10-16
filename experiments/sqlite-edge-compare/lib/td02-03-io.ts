/**
 * Network side shared by TD02 and TD03: run one request against a target on
 * either vantage, run setup SQL against each store through the probe Worker,
 * wait for PostgREST to see a new table, and record per-row vantage facts.
 * Credentials come from the fixture (lib/client.ts) and, for the local D1
 * REST path only, the Cloudflare trio in env.
 */
import { postgrestCall } from "./adapters";
import { type Fixture, type RunResult, runLocal, runOnWorker } from "./client";
import { DO_LOCATION_HINT, type LocalBackend, type RunRequest, type WorkerBackend } from "./contract";
import { summarize } from "./stats";
import type { Store, Target } from "./td02-03-plan";
import { metaValues } from "./td02-03-plan";
import { cfCreds } from "./vendors";

type Req = Omit<RunRequest, "backend">;

function failed(t: Target, req: Req, error: string): RunResult {
  return {
    ok: false,
    error,
    backend: t.backend,
    mode: req.mode ?? "each",
    repeat: 0,
    concurrency: req.concurrency ?? 1,
    colo: t.vantage === "local" ? "local" : "",
    startedAt: new Date().toISOString(),
    wallMs: 0,
    lanes: [],
    ops: [],
    errors: [{ text: error, count: 1 }],
    driver: { name: "", version: "" },
    invocations: 1,
    colos: [],
    httpMs: [],
    summary: summarize([]),
  };
}

/**
 * A request the client lost before any op came back (Bun's fetch to the
 * Worker: "socket connection was closed unexpectedly", timeouts). Not a
 * backend outcome: the modules retry such a block once and count it.
 */
export function transportLost(res: RunResult): boolean {
  return res.ops.length === 0 && /^fetch: /.test(res.error ?? "");
}

/**
 * Colos that served the results with invocation counts, most frequent first
 * ("SIN:11,MRS:1"). The Worker runs where the caller's traffic lands, so a
 * second colo mid-run means the vantage moved for those invocations.
 */
export function coloCounts(results: readonly Pick<RunResult, "colos" | "invocations">[]): string {
  const m = new Map<string, number>();
  for (const r of results) for (const c of r.colos) if (c) m.set(c, (m.get(c) ?? 0) + (r.colos.length === 1 ? r.invocations : 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([c, k]) => `${c}:${k}`).join(",");
}

/** One request on the target's vantage. Never throws: a failure comes back as ok:false with the text. */
export async function runTarget(fx: Fixture, t: Target, req: Req, timeoutMs?: number): Promise<RunResult> {
  try {
    if (t.vantage === "worker") return await runOnWorker(fx, { ...req, backend: t.backend as WorkerBackend }, timeoutMs ? { timeoutMs } : {});
    return await runLocal(fx, { ...req, backend: t.backend as LocalBackend });
  } catch (e) {
    return failed(t, req, e instanceof Error ? e.message : String(e));
  }
}

/** Why a target cannot run on this machine, or null. */
export function targetUnavailable(t: Target): string | null {
  if (t.backend === "d1_rest" && !cfCreds()) return "CLOUDFLARE_EMAIL/CLOUDFLARE_API_KEY/CLOUDFLARE_ACCOUNT_ID not in env (local D1 REST path)";
  return null;
}

const setupBackend: Record<Store, WorkerBackend> = { d1: "d1", turso: "turso", tursodb: "tursodb", do: "do", supabase: "pg" };

/**
 * Setup / teardown SQL through the probe Worker, one store at a time, as a
 * batch (D1 batch, libSQL batch("write"), Postgres BEGIN..COMMIT). Throws with
 * the backend's verbatim error.
 */
export async function setupSql(fx: Fixture, store: Store, sqls: readonly string[]): Promise<RunResult> {
  const res = await runOnWorker(fx, { backend: setupBackend[store], statements: sqls.map((sql) => ({ sql })), mode: "batch", returnMeta: false, label: "setup" }, { timeoutMs: 180_000 });
  const op = res.ops[0];
  if (!res.ok || !op?.ok) throw new Error(`setup on ${store}: ${op?.error ?? res.error ?? "no op returned"}`);
  return res;
}

/** One query on a store through the Worker, returning its first row. */
export async function queryRow(fx: Fixture, store: Store, sql: string): Promise<Record<string, unknown> | null> {
  const res = await runOnWorker(fx, { backend: setupBackend[store], statements: [{ sql }], returnRows: true, rowsLimit: 1, returnMeta: false, label: "check" });
  const op = res.ops[0];
  if (!op?.ok) throw new Error(`query on ${store}: ${op?.error ?? res.error ?? "no op returned"}`);
  return (op.out?.[0]?.rows?.[0] as Record<string, unknown> | undefined) ?? null;
}

/** Poll PostgREST until it serves `table` (its schema cache reloads after DDL). Returns ms waited. */
export async function waitPostgrest(fx: Fixture, table: string, timeoutMs = 60_000): Promise<number> {
  const s = fx.supabase!;
  const t0 = performance.now();
  let last = "";
  while (performance.now() - t0 < timeoutMs) {
    try {
      await postgrestCall(s.url, s.secretKey!, { http: { method: "GET", path: `${table}?select=*&limit=1` } });
      return Math.round(performance.now() - t0);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`PostgREST did not serve ${table} within ${timeoutMs} ms: ${last}`);
}

/**
 * Vantage facts for a row: where the code ran (Worker colo or "local"),
 * where the data plane answered (D1 served_by_region / served_by_colo,
 * Turso location, Supabase region) and which driver. No hostnames or ids.
 */
export function vantageFacts(fx: Fixture, t: Target, results: readonly RunResult[]): Record<string, string> {
  const ops = results.flatMap((r) => r.ops);
  const drv = results.find((r) => r.driver?.name)?.driver;
  const region =
    t.store === "d1"
      ? `served_by_region=${metaValues(ops, "served_by_region") || "?"} served_by_colo=${metaValues(ops, "served_by_colo") || "?"} hint=${fx.d1?.locationHint ?? "?"}`
      : t.store === "do"
        ? `Durable Object locationHint=${DO_LOCATION_HINT}`
        : t.store === "turso" || t.store === "tursodb"
        ? (fx.turso?.location ?? "?")
        : (fx.supabase?.region ?? "?");
  return {
    backend: t.backend,
    vantage: t.vantage,
    colo: coloCounts(results) || (t.vantage === "local" ? "local" : "?"),
    data_region: region,
    driver: drv ? `${drv.name} ${drv.version}`.trim() : "?",
  };
}
