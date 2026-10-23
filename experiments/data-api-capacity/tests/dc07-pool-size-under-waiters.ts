/**
 * DC07 - Once requests are queuing for the Data API's pool, does a bigger
 * `db_pool` raise throughput, lower it, or change nothing?
 *
 * DC04b (Small, shared CPU, pool 30) stopped at about 920 req/s from 256
 * concurrent point reads, with Postgres backends mostly idle; one metrics
 * snapshot in that step read 139 waiting with 11 available.
 * `pgrst_db_pool_waiting` counts requests from asking the pool to the end of
 * their session (queued plus holding, PostgREST v14.18 AppState.hs), so that
 * is at least 109 queued, if the snapshot is internally consistent. Upstream
 * PostgREST issue #5336 reports hasql-pool's acquisition burning CPU when
 * requests wait for a connection, worse with more PostgREST cores, with a
 * pool large enough that nobody waits as the workaround; the competing
 * reading is that the node's CPU is the limit either way and a bigger pool
 * only adds idle connections.
 *
 * Arms on the start size (Small by default, `max_connections` 90): `db_pool`
 * PVLAB_DC07_POOLS (default 15,30,60), each PATCHed, its restart waited for,
 * then the DC04 step (closed-loop `oha`, 40 s, GET dc_items?id=eq.4242, anon
 * key) at PVLAB_DC07_C (default 128,256,512). Pool series are coarse (DC05):
 * read the pg_stat_activity states and throughput first.
 *
 * DESTRUCTIVE: uses the shared project (lib/dc.ts), PATCHes PostgREST
 * config; DC99 deletes it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureItems, ensureProject, errText, patchPostgrest, postgrestConfig, redact, skipWithoutPro, sleep, waitRestart } from "../lib/dc.js";
import { step, stepResult } from "./dc04-throughput-stall.js";

const POOLS = (process.env.PVLAB_DC07_POOLS || "15,30,60").split(",").map(Number);
const CS = (process.env.PVLAB_DC07_C || "128,256,512").split(",").map(Number);

const mod: TestModule = {
  id: "DC07",
  title: "Pool size once requests queue: throughput at db_pool 15, 30, 60 on Small",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC07");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      await ensureItems(ctx, p);
      for (const pool of POOLS) {
        const t0 = Date.now();
        const patch = await patchPostgrest(ctx, p.ref, { db_pool: pool });
        const rs = await waitRestart(ctx, p.ref, t0);
        const cfg = await postgrestConfig(ctx, p.ref);
        // Let the edge and the pool settle between arms (DC04d met throttling carried over from the step before).
        await sleep(30_000);
        for (const c of CS) {
          const r = await step(ctx, p, c);
          const res = stepResult("DC07", `db_pool ${pool} (PATCH ${patch.status}, readback ${cfg.dbPool}, restart ${rs.delayS} s)`, r);
          res.measurements = { ...res.measurements, db_pool_set: pool, db_pool_readback: cfg.dbPool, patch_status: patch.status, restart_delay_s: rs.delayS };
          out.push(res);
          ctx.log(`DC07 pool ${pool} c=${c}: ${r.oha.rps} rps p50 ${r.oha.p50} waiting ${r.waitingMax}/${r.availableAtWaitingMax} of ${r.poolMax} cpu ${r.cpuPct}% ${r.backends}`);
          await sleep(20_000);
        }
      }
    } catch (e) {
      out.push({ id: "DC07", title: "DC07", status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
