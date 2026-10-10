/**
 * PC01 - reproduce Supavisor `ECHECKOUTTIMEOUT` on a Micro project.
 *
 * A transaction-mode pooler hands a backend to a client for the length of one
 * statement. Fill every backend in the pool with a long statement and the next
 * client's statement has to queue; the question is what that client sees and
 * after how long. Rows (one throwaway Micro project, ap-southeast-1 unless
 * PVLAB_PC_REGION says otherwise, Supavisor transaction pooler on 6543):
 *
 *   PC01a  surface: compute size, the pooler config the API reports (pool size
 *          and client cap are `null` there), hostname prefix, max_connections.
 *   PC01b  effective pool size: 40 clients each run `select pg_sleep(25)`; the
 *          number of ACTIVE sleeping backends at t+6 s, read through the
 *          Management API (not through the pooler), is the pool size. The
 *          other clients' completion times show how the queue drains.
 *   PC01c  the reproduction: hold exactly that many backends with
 *          `pg_sleep(75)`, then run client N+1 (`select 1`) three times, each
 *          against freshly started holders. Records whether connect() works,
 *          after how long the statement fails, and the verbatim error.
 *   PC01d  the queue is not the error: holders sleep 8 s, client N+1 sends
 *          `select 1` 2 s in. It waits and succeeds; the wait is the holders'
 *          remaining time.
 *
 * Not settled: whether the checkout timeout is per tenant, per region or per
 * Supavisor version (a public status-page mirror quotes 15000 ms; this project
 * answered 60000 ms), and other compute sizes.
 */
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { activeSleepers, holdPool, sharedTxn, timedQuery } from "../lib/pg";
import { acquireProject, sleep, stallGuard } from "../lib/project";

const mod: TestModule = {
  id: "PC01",
  title: "Supavisor transaction pool exhausted: what client N+1 sees (ECHECKOUTTIMEOUT)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "PC01", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    const guard = stallGuard("PC01");
    const p = await acquireProject(ctx);
    const t = sharedTxn(p);

    // ---- PC01a
    const mc = await sql(p.ctx, "show max_connections");
    const maxConn = String((mc.rows[0] as { max_connections?: string } | undefined)?.max_connections ?? "?");
    out.push({
      id: "PC01a",
      title: "PC01a: project surface",
      status: "info",
      detail: `compute ${p.instanceSize}, pooler host prefix ${p.poolerHost.split("-").slice(0, 2).join("-")}, healthy ${Math.round(p.healthyMs / 1000)} s after create`,
      measurements: {
        compute: p.instanceSize,
        region: p.region,
        pooler_prefix: p.poolerHost.split("-").slice(0, 2).join("-"),
        pooler_mode: p.poolerEntry.pool_mode ?? "?",
        api_default_pool_size: p.poolerEntry.default_pool_size ?? "null",
        api_max_client_conn: p.poolerEntry.max_client_conn ?? "null",
        max_connections: maxConn,
        create_to_healthy_s: Math.round(p.healthyMs / 1000),
      },
    });

    // ---- PC01b: effective pool size
    const N = 40;
    const SLEEP_S = 25;
    const t0 = Date.now();
    const crowd = holdPool(t, p.password, N, SLEEP_S);
    await sleep(6000);
    const act = await activeSleepers(p.ctx);
    const outcomes = await crowd.done;
    const okOutcomes = outcomes.filter((o) => o.ok);
    const waves = new Map<number, number>();
    for (const o of okOutcomes) {
      const w = Math.round(o.totalMs / (SLEEP_S * 1000));
      waves.set(w, (waves.get(w) ?? 0) + 1);
    }
    const waveStr = [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([w, n]) => `${n} done at ~${w * SLEEP_S}s`).join(", ");
    const failedB = outcomes.filter((o) => !o.ok);
    const maxWaitOk = Math.max(0, ...okOutcomes.map((o) => o.totalMs - SLEEP_S * 1000));
    out.push({
      id: "PC01b",
      title: `PC01b: effective pool size under ${N} concurrent pg_sleep(${SLEEP_S}) clients`,
      status: act.active > 0 ? "info" : "fail",
      detail: `${act.active} active sleeping backends at t+6 s (read via the Management API); completion waves: ${waveStr}; ${failedB.length} of ${N} clients errored`,
      measurements: {
        clients: N,
        active_sleepers_at_6s: act.active,
        idle_sleepers_at_6s: act.idle,
        clients_ok: okOutcomes.length,
        clients_errored: failedB.length,
        longest_queue_wait_that_succeeded_s: Math.round(maxWaitOk / 1000),
        first_error: failedB[0] ? `${failedB[0].code}: ${failedB[0].error}` : "none",
        wall_s: Math.round((Date.now() - t0) / 1000),
      },
      evidence: act.error || undefined,
    });
    const pool = act.active > 0 ? act.active : 16;
    await sleep(3000);

    // ---- PC01c: the reproduction, three trials
    const HOLD_S = 75;
    const trials: TestResult["measurements"][] = [];
    for (let k = 1; k <= 3; k++) {
      const holders = holdPool(t, p.password, pool, HOLD_S);
      await sleep(4000);
      const held = await activeSleepers(p.ctx);
      const r = await timedQuery(t, p.password, "select 1", 120_000);
      const recoverAt = Date.now();
      await holders.done;
      const after = await timedQuery(t, p.password, "select 1", 30_000);
      trials.push({
        trial: k,
        holders_active: held.active,
        n_plus_1_connect_ms: r.connectMs ?? "failed",
        n_plus_1_ok: r.ok ? "yes" : "no",
        n_plus_1_query_ms: r.queryMs ?? "n/a",
        error_code: r.code || "none",
        error_text: r.error || "none",
        select1_after_holders_ended_ms: after.ok ? (after.queryMs ?? 0) : "failed",
        recovery_wait_s: Math.round((Date.now() - recoverAt) / 1000),
      });
      out.push({
        id: `PC01c-${k}`,
        title: `PC01c trial ${k}: client N+1 (N=${pool}) while ${pool} backends are held ${HOLD_S} s`,
        status: r.ok ? "fail" : "pass",
        detail: r.ok
          ? `N+1 was served after ${r.queryMs} ms - no timeout reproduced`
          : `connect ok in ${r.connectMs} ms; statement failed after ${r.queryMs} ms: ${r.code} ${r.error}`,
        measurements: trials[k - 1] as Record<string, number | string>,
      });
      await sleep(5000);
    }

    // ---- PC01d: shorter hold -> queue wait, success
    const waits: number[] = [];
    for (let k = 1; k <= 2; k++) {
      const holders = holdPool(t, p.password, pool, 8);
      await sleep(2000);
      const r = await timedQuery(t, p.password, "select 1", 60_000);
      await holders.done;
      waits.push(r.ok ? (r.queryMs ?? -1) : -1);
      out.push({
        id: `PC01d-${k}`,
        title: `PC01d trial ${k}: client N+1 queues behind 8 s holders`,
        status: r.ok ? "pass" : "fail",
        detail: r.ok ? `served after queueing ${r.queryMs} ms (holders had ~6 s left)` : `${r.code} ${r.error}`,
        measurements: { trial: k, queue_wait_ms: r.queryMs ?? "n/a", ok: r.ok ? "yes" : "no", error: r.error || "none" },
      });
      await sleep(3000);
    }
    out.push(guard.result());
    return out;
  },
};

export default mod;
