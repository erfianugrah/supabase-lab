/**
 * TD02 - PK point-read latency per backend, Worker and local vantage, plus the per-invocation query ceiling.
 *
 * Use case: a session or config lookup, one row by primary key. One table
 * `td02_kv (id integer primary key, k, v, n)` seeded with the same
 * TD02_ROWS rows (default 10,000, generated from SEED) in each of the
 * fixture's three stores: the D1 database, the Turso libSQL database
 * (aws-ap-southeast-2) and the Supabase Micro project (ap-southeast-2). Every
 * backend reads the same id sequence. Rows, each naming its BACKEND and
 * VANTAGE (code running in the probe Worker at the colo nearest this machine,
 * or on this machine), with n after the warm-up is dropped:
 *
 *   TD02s  seed check: count, sum(n), max(id) equal across the three stores
 *   TD02a  Worker -> D1 binding
 *   TD02b  Worker -> Turso libSQL over HTTP (@libsql/client/web)
 *   TD02c  Worker -> Hyperdrive (caching disabled) -> Postgres direct
 *   TD02d  Worker -> Hyperdrive (caching enabled, default max_age) -> Postgres;
 *          the same uniform ids as the others, so mostly cache misses
 *   TD02e  Worker -> PostgREST (secret key)
 *   TD02f  local  -> Turso libSQL over HTTP
 *   TD02g  local  -> Supavisor transaction mode (6543)
 *   TD02h  local  -> Postgres direct (IPv6, resolved AAAA)
 *   TD02i  local  -> D1 REST query endpoint (admin path, not an app path)
 *   TD02j  Worker -> Hyperdrive caching disabled, hot set of 10 ids
 *   TD02k  Worker -> Hyperdrive caching enabled, the same hot ids (cache hits
 *          after the first read of each id within max_age)
 *   TD02l  ordering by p50 per vantage with the p25-p75 separation rule
 *   TD02m  D1 binding: queries per Worker invocation, ladder until one fails
 *          (default steps 1001, one past the D1 limits page's 1000 on Paid,
 *          and 10001; if the limit is a per-invocation counter, the failing
 *          step's ok count is the exact ceiling)
 *   TD02n  Turso from the Worker: same ladder (each execute is a fetch subrequest)
 *
 * Schedule: reads go out in blocks of TD02_BLOCK (one Worker invocation or one
 * local run per block, sequential statements on one lane). Blocks round-robin
 * across backends with a rotating start, so drift hits all of them equally.
 * The first TD02_WARMUP attempts per backend are dropped and counted. Each
 * row also splits the first read of an invocation (fresh client / Hyperdrive
 * connection) from the rest. Timing is the executor's per-op
 * performance.now() (I/O wall time in a Worker).
 *
 * n (env): TD02_N measured reads per backend (300; TD_SMOKE=1: 10),
 * TD02_WARMUP (20; 2), TD02_BLOCK (10; 5), TD02_ROWS (10000; 1000),
 * TD02_HOT_N (100; 10), TD02_TARGETS (all nine; smoke the same),
 * TD02_CEIL (1001,10001; 1001), TD02_CEIL_BACKENDS (d1,turso; d1),
 * TD02_CEIL_CONC (16).
 *
 * Pass on a latency row means every attempted read succeeded and returned the
 * seeded row; fail means errors or wrong rows, quoted verbatim. Ceiling rows
 * are info: they report the highest step with no failures and, if one failed,
 * the verbatim error and how many queries succeeded in that invocation.
 *
 * Not settled by this module: other regions or vantages (one Worker colo, one
 * local machine, data planes in Sydney); behaviour under concurrent load
 * (TD04); D1 read replicas (replication left at its default, disabled);
 * Hyperdrive cache behaviour beyond hit vs miss on unchanging rows; whether
 * the ceiling is a D1 limit or a Workers subrequest limit when both could
 * apply (the error text is the evidence); plan-specific ceilings on other
 * Cloudflare accounts.
 *
 * DESTRUCTIVE: creates table td02_kv in each fixture store; dropped in finally.
 * Self-skips without the fixture (.fixture.json / PVLAB_ENDPOINT_FIXTURE).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { type Fixture, fixtureOrSkip, type RunResult, runOnWorker } from "../lib/client";
import { roundRobin, summarize, summaryColumns } from "../lib/stats";
import { coloCounts, queryRow, runTarget, setupSql, targetUnavailable, transportLost, vantageFacts, waitPostgrest } from "../lib/td02-03-io";
import {
  blocks,
  blockSamples,
  ceilingHit,
  type CeilingStep,
  ceilingStep,
  envInt,
  envList,
  genKv,
  KV_CHECK_SQL,
  KV_TABLE,
  kvDdl,
  kvExpected,
  kvInserts,
  keySequence,
  latencyColumns,
  pickTargets,
  pointRead,
  type ReadSample,
  rankBySpread,
  readStats,
  shortErrors,
  type Store,
  type Target,
  TARGETS,
  type TargetKey,
} from "../lib/td02-03-plan";

const ID = "TD02";
const SEED = 20261015;
const LETTER: Partial<Record<TargetKey, string>> = {
  d1: "a",
  turso: "b",
  pg: "c",
  pg_cached: "d",
  postgrest: "e",
  local_turso_http: "f",
  local_pg_pooler: "g",
  local_pg_direct: "h",
  local_d1_rest: "i",
};
const ALL: TargetKey[] = ["d1", "turso", "pg", "pg_cached", "postgrest", "local_turso_http", "local_pg_pooler", "local_pg_direct", "local_d1_rest"];
const STORES: Store[] = ["d1", "turso", "supabase"];

interface Pass {
  samples: Map<string, ReadSample[]>;
  results: Map<string, RunResult[]>;
  /** Blocks re-sent once because the client lost the request (transportLost). */
  retries: Map<string, number>;
}

/** Round-robin blocks across targets; every target reads the same ids in the same block order. */
async function readPass(fx: Fixture, targets: readonly Target[], ids: readonly number[], block: number, rows: ReturnType<typeof genKv>, log: (m: string) => void, tag: string): Promise<Pass> {
  const bl = blocks(ids, block);
  const samples = new Map<string, ReadSample[]>(targets.map((t) => [t.key, []]));
  const results = new Map<string, RunResult[]>(targets.map((t) => [t.key, []]));
  const retries = new Map<string, number>(targets.map((t) => [t.key, 0]));
  const slots = roundRobin(targets, bl.length);
  for (const slot of slots) {
    const t = slot.item;
    const bIds = bl[slot.iter]!;
    const req = { statements: bIds.map((id) => pointRead(t.dialect, id)), returnRows: true, rowsLimit: 1, returnMeta: true, label: `${ID}-${tag}-${slot.iter}` };
    let res = await runTarget(fx, t, req);
    if (transportLost(res)) {
      // Reads are idempotent: re-send once; the loss is counted on the row.
      log(`${ID} ${tag}: ${t.key} block ${slot.iter} lost in transport (${res.error}); retrying once`);
      retries.set(t.key, retries.get(t.key)! + 1);
      res = await runTarget(fx, t, req);
    }
    results.get(t.key)!.push(res);
    samples.get(t.key)!.push(...blockSamples(res.ops, bIds, rows, res.error));
    if (slot.pos === targets.length - 1 && (slot.iter + 1) % 5 === 0) log(`${ID} ${tag}: block ${slot.iter + 1}/${bl.length}`);
  }
  return { samples, results, retries };
}

function latencyRow(fx: Fixture, id: string, title: string, t: Target, samples: ReadSample[], results: RunResult[], warmup: number, retries: number): TestResult {
  const st = readStats(samples, warmup);
  const connect = summarize(results.flatMap((r) => r.lanes.filter((l) => !l.error).map((l) => l.connectMs)));
  const http = summarize(results.flatMap((r) => r.httpMs));
  const clean = st.errors === 0 && st.mismatches === 0 && st.all.n > 0;
  const colos = coloCounts(results);
  const extra = `${t.vantage === "worker" ? `; colos ${colos}` : ""}${retries ? `; ${retries} block(s) re-sent after a client transport loss` : ""}`;
  return {
    id,
    title,
    status: clean ? "pass" : "fail",
    detail: clean
      ? `n=${st.all.n} (${st.all.dropped} warm-up dropped) p50 ${st.all.p50} ms, p25-p75 ${st.all.p25}-${st.all.p75}, p95 ${st.all.p95}, p99 ${st.all.p99}; first-in-invocation p50 ${st.first.p50} vs rest ${st.rest.p50}${extra}`
      : `${st.errors} errors, ${st.mismatches} wrong rows of ${st.attempted}: ${shortErrors(st.errorTexts) || "rows did not match the seed"}${extra}`,
    measurements: {
      ...vantageFacts(fx, t, results),
      n: st.all.n,
      attempted: st.attempted,
      errors: st.errors,
      mismatches: st.mismatches,
      ...summaryColumns("ms", st.all),
      ...latencyColumns("first_ms", st.first),
      ...latencyColumns("rest_ms", st.rest),
      invocations: results.length,
      transport_retries: retries,
      connect_ms_p50: connect.p50,
      http_rtt_ms_p50: http.p50,
    },
    ...(st.errorTexts.length ? { evidence: st.errorTexts.map((e) => `${e.count}x ${e.text}`).join("\n") } : {}),
  };
}

async function ceilingRow(fx: Fixture, id: string, t: Target, ladder: number[], conc: number, log: (m: string) => void): Promise<TestResult> {
  const steps: (CeilingStep & { colo: string; wallMs: number; httpMs: number })[] = [];
  let retries = 0;
  let transport = false;
  for (const repeat of ladder) {
    log(`${ID} ceiling ${t.key}: ${repeat} queries in one invocation, concurrency ${conc}`);
    const send = () => runOnWorker(fx, { backend: t.backend as "d1" | "turso", statements: [{ sql: "select 1 as one" }], repeat, concurrency: conc, noSplit: true, returnMeta: false, label: `${ID}-ceiling` }, { timeoutMs: 600_000 });
    let res = await send();
    if (transportLost(res)) {
      log(`${ID} ceiling ${t.key}: lost in transport (${res.error}); retrying once`);
      retries++;
      res = await send();
      transport = transportLost(res);
    }
    const s = ceilingStep(repeat, res.ops, res.error);
    steps.push({ ...s, colo: res.colos.join(","), wallMs: Math.round(res.wallMs), httpMs: Math.round(res.httpMs[0] ?? 0) });
    if (ceilingHit(s)) break;
  }
  const hit = steps.find(ceilingHit);
  const okSteps = steps.filter((s) => !ceilingHit(s));
  const highestOk = okSteps.length ? okSteps[okSteps.length - 1]!.repeat : 0;
  const m: Record<string, number | string> = {
    backend: t.backend,
    vantage: "worker",
    colo: [...new Set(steps.map((s) => s.colo).filter(Boolean))].join(","),
    concurrency: conc,
    ladder: ladder.join(","),
    highest_ok_queries: highestOk,
    ceiling_found: hit && !transport ? 1 : 0,
    transport_retries: retries,
  };
  if (hit) {
    m.failing_step_queries = hit.repeat;
    m.failing_step_ok = hit.okOps;
    m.failing_step_failed = hit.failedOps;
    m.failing_step_missing = hit.missing;
    m.first_fail_i = hit.firstFailI ?? -1;
  }
  steps.forEach((s, k) => {
    m[`step${k}_queries`] = s.repeat;
    m[`step${k}_ok`] = s.okOps;
    m[`step${k}_wall_ms`] = s.wallMs;
  });
  return {
    id,
    title: `${t.backend} from the Worker: queries per invocation until one fails`,
    status: transport ? "fail" : "info",
    detail: transport
      ? `client lost the ${hit?.repeat}-query request twice (${hit?.firstError}); no ceiling inferred, highest ok ${highestOk}`
      : hit
      ? `${highestOk || "no"} queries ok in one invocation; at ${hit.repeat}: ${hit.okOps} ok, ${hit.failedOps} failed, ${hit.missing} missing; first error: ${hit.firstError ?? "?"}`
      : `no failure up to ${highestOk} queries in one invocation (ladder ${ladder.join(",")}, concurrency ${conc})`,
    measurements: m,
    ...(hit?.firstError ? { evidence: hit.firstError } : {}),
  };
}

const mod: TestModule = {
  id: ID,
  title: "PK point-read latency per backend, Worker and local vantage, plus the per-invocation query ceiling",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const fx = await fixtureOrSkip(ctx);
    if ("skip" in fx) return [{ id: ID, title: this.title, status: "skip", detail: fx.skip }];
    const env = process.env;
    const n = envInt(env, "TD02_N", 300, 10);
    const warmup = envInt(env, "TD02_WARMUP", 20, 2);
    const block = Math.min(100, Math.max(1, envInt(env, "TD02_BLOCK", 10, 5)));
    const nRows = Math.max(1, envInt(env, "TD02_ROWS", 10_000, 1000));
    const hotN = envInt(env, "TD02_HOT_N", 100, 10);
    const ladder = envList(env, "TD02_CEIL", ["1001", "10001"], ["1001"]).map(Number).filter((x) => Number.isInteger(x) && x > 0);
    const ceilKeys = envList(env, "TD02_CEIL_BACKENDS", ["d1", "turso"], ["d1"]);
    const conc = Math.min(64, Math.max(1, envInt(env, "TD02_CEIL_CONC", 16, 16)));
    const targets = pickTargets(envList(env, "TD02_TARGETS", ALL, ALL), ALL);
    const ceilTargets = pickTargets(ceilKeys, ["d1", "turso"]);

    const out: TestResult[] = [];
    const runnable: Target[] = [];
    for (const t of targets) {
      const why = targetUnavailable(t);
      if (why) out.push({ id: `${ID}${LETTER[t.key as TargetKey]}`, title: `${t.vantage} -> ${t.backend}: point read`, status: "skip", detail: why });
      else runnable.push(t);
    }
    const rows = genKv(nRows, SEED);
    const touched: Store[] = [];
    try {
      // Seed: same rows, same literal INSERT text, in all three stores.
      const t0 = performance.now();
      const inserts = kvInserts(rows);
      for (const store of STORES) {
        touched.push(store);
        await setupSql(fx, store, kvDdl(store === "supabase" ? "pg" : "sqlite"));
        for (const chunk of blocks(inserts, 4)) await setupSql(fx, store, chunk);
      }
      const want = kvExpected(rows);
      const got: Record<string, string> = {};
      let same = true;
      for (const store of STORES) {
        const r = await queryRow(fx, store, KV_CHECK_SQL);
        got[store] = `${Number(r?.c)}/${Number(r?.s)}/${Number(r?.m)}`;
        if (Number(r?.c) !== want.c || Number(r?.s) !== want.s || Number(r?.m) !== want.m) same = false;
      }
      const pgrstWaitMs = runnable.some((t) => t.dialect === "http") ? await waitPostgrest(fx, KV_TABLE) : 0;
      out.push({
        id: `${ID}s`,
        title: "seed check: identical rows in D1, Turso and Postgres",
        status: same ? "pass" : "fail",
        detail: `expected count/sum(n)/max(id) ${want.c}/${want.s}/${want.m}; d1 ${got.d1}, turso ${got.turso}, supabase ${got.supabase}`,
        measurements: { rows: nRows, seed: SEED, seed_ms: Math.round(performance.now() - t0), postgrest_visible_ms: pgrstWaitMs, d1: got.d1!, turso: got.turso!, supabase: got.supabase! },
      });
      if (!same) return out;

      // Main pass: uniform ids, every runnable target.
      const ids = keySequence(warmup + n, nRows, SEED + 1);
      ctx.log(`${ID}: ${runnable.length} targets x ${ids.length} reads in blocks of ${block}`);
      const main = await readPass(fx, runnable, ids, block, rows, ctx.log, "main");
      const summaries: { key: string; vantage: string; s: ReturnType<typeof readStats>["all"] }[] = [];
      for (const t of runnable) {
        const row = latencyRow(fx, `${ID}${LETTER[t.key as TargetKey]}`, `${t.vantage} -> ${t.backend}: point read by PK`, t, main.samples.get(t.key)!, main.results.get(t.key)!, warmup, main.retries.get(t.key)!);
        out.push(row);
        summaries.push({ key: t.key, vantage: t.vantage, s: readStats(main.samples.get(t.key)!, warmup).all });
      }

      // Hot pass: Hyperdrive with and without caching on 10 hot ids.
      const hotTargets = runnable.filter((t) => t.key === "pg" || t.key === "pg_cached");
      if (hotN > 0 && hotTargets.length) {
        const hotIds = keySequence(warmup + hotN, nRows, SEED + 2, 10);
        const hot = await readPass(fx, hotTargets, hotIds, block, rows, ctx.log, "hot");
        for (const t of hotTargets) {
          out.push(latencyRow(fx, `${ID}${t.key === "pg" ? "j" : "k"}`, `worker -> ${t.backend}: point read, hot set of 10 ids`, t, hot.samples.get(t.key)!, hot.results.get(t.key)!, warmup, hot.retries.get(t.key)!));
        }
      }

      // Ordering per vantage under the separation rule.
      const byVantage = (v: string) => rankBySpread(summaries.filter((x) => x.vantage === v));
      out.push({
        id: `${ID}l`,
        title: "ordering by p50 ('<' = p25-p75 spreads separate, '~' = they overlap)",
        status: "info",
        detail: `worker: ${byVantage("worker")}; local: ${byVantage("local")}`,
        measurements: Object.fromEntries(summaries.map((x) => [`${x.key}_p50`, x.s.p50])),
      });

      // Ceiling ladder.
      const ceilLetter: Record<string, string> = { d1: "m", turso: "n" };
      for (const t of ceilTargets) {
        if (ladder.length === 0) break;
        out.push(await ceilingRow(fx, `${ID}${ceilLetter[t.key]}`, t, ladder, conc, ctx.log));
      }
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const dropped: string[] = [];
      const errs: string[] = [];
      for (const store of touched) {
        try {
          await setupSql(fx, store, store === "supabase" ? [`drop table if exists public.${KV_TABLE}`, `notify pgrst, 'reload schema'`] : [`drop table if exists ${KV_TABLE}`]);
          dropped.push(store);
        } catch (e) {
          errs.push(`drop on ${store}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      out.push({ id: `${ID}z`, title: "cleanup", status: errs.length ? "fail" : "pass", detail: `dropped ${KV_TABLE} on ${dropped.join(", ") || "nothing"}${errs.length ? `; ${errs.join("; ")}` : ""}` });
    }
    return out;
  },
};
export default mod;
