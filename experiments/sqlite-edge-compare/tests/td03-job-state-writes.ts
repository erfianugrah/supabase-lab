/**
 * TD03 - job-state write path per backend: insert, three status updates, read-your-write after each.
 *
 * Use case: a queue worker driving a transform-job state table. One table
 * `td03_jobs (id text primary key, status, attempts, payload, updated_at)` in
 * each fixture store (D1; Turso libSQL in aws-ap-southeast-2; the Supabase
 * Micro project in ap-southeast-2). A job is eight statements in order:
 * INSERT status 'queued', then the conditional transitions queued -> claimed
 * -> running -> done (`update ... where id = ? and status = <from>`), and a
 * read by id after every write. Each read checks it sees the status and
 * attempts just written (read-your-write); each write checks it changed
 * exactly one row (D1 meta.changes, libSQL rowsAffected, pg rowCount,
 * PostgREST 201 / returned rows). Statements are autocommit, one op each.
 *
 * Rows, each naming BACKEND and VANTAGE (code in the probe Worker at the colo
 * nearest this machine, or on this machine), with per-op p25/p50/p75/p95/p99
 * for insert, update and read, the whole-job sum, and the check counts:
 *
 *   TD03a  Worker -> D1 binding
 *   TD03b  Worker -> Turso libSQL over HTTP
 *   TD03o  Worker -> Turso-engine database over HTTP (when the fixture has one;
 *          printed as TD03undefined in the 2026-10-16 run, before the id existed)
 *   TD03c  Worker -> Hyperdrive (caching disabled) -> Postgres direct
 *   TD03d  Worker -> PostgREST (secret key)
 *   TD03e  local  -> Turso libSQL over HTTP
 *   TD03f  local  -> Supavisor transaction mode (6543)
 *   TD03g  local  -> Postgres direct (IPv6)
 *   TD03h  local  -> D1 REST query endpoint (admin path, not an app path)
 *   TD03l  ordering of whole-job p50 per vantage with the p25-p75 separation rule
 *
 * Schedule: jobs go out in blocks of TD03_BLOCK (one Worker invocation or one
 * local run per block, 8 x block statements in order on one lane), blocks
 * round-robin across backends with a rotating start. The first TD03_WARMUP
 * jobs per backend are dropped from the latency summaries (counted), but
 * their checks still count.
 *
 * n (env): TD03_N measured jobs per backend (100; TD_SMOKE=1: 10),
 * TD03_WARMUP (10; 2), TD03_BLOCK (10; 4), TD03_TARGETS (all eight).
 *
 * Pass means no errors, every read saw its write and every write changed one
 * row; fail quotes the errors or counts the misses.
 *
 * Not settled by this module: concurrent workers claiming the same job (TD04
 * contention, TD07 isolation); batched or transactional job updates; Hyperdrive
 * with caching on (a cached read after a write is TD07's question); D1 read
 * replicas (left disabled, the default); durability after a crash; other
 * regions or vantages.
 *
 * DESTRUCTIVE: creates table td03_jobs in each fixture store; dropped in
 * finally. Self-skips without the fixture (.fixture.json / PVLAB_ENDPOINT_FIXTURE).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { type Fixture, fixtureOrSkip, type RunResult } from "../lib/client";
import type { Stmt } from "../lib/contract";
import { roundRobin, summarize } from "../lib/stats";
import { withTursodb } from "../lib/td04-07-plan";
import { coloCounts, runTarget, setupSql, targetUnavailable, transportLost, vantageFacts, waitPostgrest } from "../lib/td02-03-io";
import {
  envInt,
  envList,
  JOBS_TABLE,
  type JobSample,
  jobPayload,
  jobSamples,
  jobStatements,
  jobStats,
  jobsDdl,
  latencyColumns,
  pickTargets,
  rankBySpread,
  shortErrors,
  type StepPlan,
  type Store,
  type Target,
  type TargetKey,
} from "../lib/td02-03-plan";

const ID = "TD03";
const SEED = 20261016;
const ALL: TargetKey[] = ["d1", "turso", "pg", "postgrest", "local_turso_http", "local_pg_pooler", "local_pg_direct", "local_d1_rest"];
const LETTER: Partial<Record<TargetKey, string>> = {
  d1: "a",
  turso: "b",
  pg: "c",
  postgrest: "d",
  local_turso_http: "e",
  local_pg_pooler: "f",
  local_pg_direct: "g",
  local_d1_rest: "h",
  tursodb: "o",
};
const STORES: Store[] = ["d1", "turso", "supabase"];

const mod: TestModule = {
  id: ID,
  title: "job-state write path per backend: insert, three status updates, read-your-write after each",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const fx: Fixture | { skip: string } = await fixtureOrSkip(ctx);
    if ("skip" in fx) return [{ id: ID, title: this.title, status: "skip", detail: fx.skip }];
    const env = process.env;
    const n = envInt(env, "TD03_N", 100, 10);
    const warmup = envInt(env, "TD03_WARMUP", 10, 2);
    const block = Math.min(12, Math.max(1, envInt(env, "TD03_BLOCK", 10, 4)));
    const all = withTursodb(fx, ALL);
    const stores = withTursodb(fx, STORES);
    const targets = pickTargets(envList(env, "TD03_TARGETS", all, all), all);

    const out: TestResult[] = [];
    const runnable: Target[] = [];
    for (const t of targets) {
      const why = targetUnavailable(t);
      if (why) out.push({ id: `${ID}${LETTER[t.key as TargetKey]}`, title: `${t.vantage} -> ${t.backend}: job-state writes`, status: "skip", detail: why });
      else runnable.push(t);
    }
    const touched: Store[] = [];
    const run = Date.now().toString(36);
    try {
      for (const store of stores) {
        touched.push(store);
        await setupSql(fx, store, jobsDdl(store === "supabase" ? "pg" : "sqlite"));
      }
      if (runnable.some((t) => t.dialect === "http")) await waitPostgrest(fx, JOBS_TABLE);

      const total = warmup + n;
      const nBlocks = Math.ceil(total / block);
      const samples = new Map<string, JobSample[]>(runnable.map((t) => [t.key, []]));
      const results = new Map<string, RunResult[]>(runnable.map((t) => [t.key, []]));
      const retries = new Map<string, number>(runnable.map((t) => [t.key, 0]));
      ctx.log(`${ID}: ${runnable.length} targets x ${total} jobs in blocks of ${block}`);
      for (const slot of roundRobin(runnable, nBlocks)) {
        const t = slot.item;
        const build = (attempt: number) => {
          const stmts: Stmt[] = [];
          const plan: StepPlan[] = [];
          for (let j = slot.iter * block; j < Math.min(total, (slot.iter + 1) * block); j++) {
            // Same payload and timestamps per job index on every backend; ids differ by backend key (and by attempt on a re-send).
            const js = jobStatements(t.dialect, `${run}-${t.key}-${j}${attempt ? `-r${attempt}` : ""}`, j, jobPayload(SEED, j), 1_700_000_000_000 + j * 10);
            for (const p of js.plan) plan.push({ ...p, step: plan.length });
            stmts.push(...js.stmts);
          }
          return { stmts, plan };
        };
        let { stmts, plan } = build(0);
        let res = await runTarget(fx, t, { statements: stmts, returnRows: true, rowsLimit: 1, returnMeta: true, label: `${ID}-${slot.iter}` });
        if (transportLost(res)) {
          // The client lost the request; the Worker may or may not have run it. Re-send once with fresh job ids
          // so a partial first attempt cannot collide; the loss is counted on the row.
          ctx.log(`${ID}: ${t.key} block ${slot.iter} lost in transport (${res.error}); re-sending once with fresh ids`);
          retries.set(t.key, retries.get(t.key)! + 1);
          ({ stmts, plan } = build(1));
          res = await runTarget(fx, t, { statements: stmts, returnRows: true, rowsLimit: 1, returnMeta: true, label: `${ID}-${slot.iter}-r1` });
        }
        results.get(t.key)!.push(res);
        samples.get(t.key)!.push(...jobSamples(t, res.ops, plan, res.error));
        if (slot.pos === runnable.length - 1 && (slot.iter + 1) % 3 === 0) ctx.log(`${ID}: block ${slot.iter + 1}/${nBlocks}`);
      }

      const ranks: { key: string; vantage: string; s: ReturnType<typeof summarize> }[] = [];
      for (const t of runnable) {
        const st = jobStats(samples.get(t.key)!, warmup);
        const res = results.get(t.key)!;
        const connect = summarize(res.flatMap((r) => r.lanes.filter((l) => !l.error).map((l) => l.connectMs)));
        const clean = st.errors === 0 && st.rywMisses === 0 && st.writeMisses === 0 && st.jobsMeasured > 0;
        const colos = coloCounts(res);
        const extra = `${t.vantage === "worker" ? `; colos ${colos}` : ""}${retries.get(t.key) ? `; ${retries.get(t.key)} block(s) re-sent after a client transport loss` : ""}`;
        ranks.push({ key: t.key, vantage: t.vantage, s: st.job });
        out.push({
          id: `${ID}${LETTER[t.key as TargetKey]}`,
          title: `${t.vantage} -> ${t.backend}: insert + 3 conditional updates, read after each`,
          status: clean ? "pass" : "fail",
          detail: clean
            ? `${st.jobsMeasured} jobs (${st.jobsDropped} warm-up dropped), all reads saw their write; p50 insert ${st.insert.p50} ms, update ${st.update.p50}, read ${st.read.p50}, whole job ${st.job.p50}${extra}`
            : `${st.errors} errors, ${st.rywMisses} read-your-write misses, ${st.writeMisses} writes not changing one row, ${st.jobsClean}/${st.jobsAttempted} jobs clean: ${shortErrors(st.errorTexts) || "see counts"}${extra}`,
          measurements: {
            ...vantageFacts(fx, t, res),
            n: st.jobsMeasured,
            jobs_attempted: st.jobsAttempted,
            jobs_dropped: st.jobsDropped,
            jobs_clean: st.jobsClean,
            errors: st.errors,
            ryw_misses: st.rywMisses,
            write_misses: st.writeMisses,
            ...latencyColumns("insert_ms", st.insert),
            ...latencyColumns("update_ms", st.update),
            ...latencyColumns("read_ms", st.read),
            ...latencyColumns("job_ms", st.job),
            invocations: res.length,
            transport_retries: retries.get(t.key)!,
            connect_ms_p50: connect.p50,
          },
          ...(st.errorTexts.length ? { evidence: st.errorTexts.map((e) => `${e.count}x ${e.text}`).join("\n") } : {}),
        });
      }
      const byVantage = (v: string) => rankBySpread(ranks.filter((x) => x.vantage === v));
      out.push({
        id: `${ID}l`,
        title: "ordering by whole-job p50 ('<' = p25-p75 spreads separate, '~' = they overlap)",
        status: "info",
        detail: `worker: ${byVantage("worker")}; local: ${byVantage("local")}`,
        measurements: Object.fromEntries(ranks.map((x) => [`${x.key}_job_p50`, x.s.p50])),
      });
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const dropped: string[] = [];
      const errs: string[] = [];
      for (const store of touched) {
        try {
          await setupSql(fx, store, store === "supabase" ? [`drop table if exists public.${JOBS_TABLE}`, `notify pgrst, 'reload schema'`] : [`drop table if exists ${JOBS_TABLE}`]);
          dropped.push(store);
        } catch (e) {
          errs.push(`drop on ${store}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      out.push({ id: `${ID}z`, title: "cleanup", status: errs.length ? "fail" : "pass", detail: `dropped ${JOBS_TABLE} on ${dropped.join(", ") || "nothing"}${errs.length ? `; ${errs.join("; ")}` : ""}` });
    }
    return out;
  },
};
export default mod;
