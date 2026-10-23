/**
 * PC07 - does the pool size a project owner sets move the checkout timeout?
 *
 * `PATCH /v1/projects/{ref}/config/database/pooler` accepts `default_pool_size`
 * and `pool_mode` only (Management API OpenAPI, `UpdateSupavisorConfigBody`);
 * no checkout-timeout field exists there. This module sets the pool size to 5
 * and repeats the PC01c shape with a crowd:
 *
 *   PC07a  PATCH default_pool_size 5: HTTP status and the value read back.
 *   PC07b  12 transaction-mode clients run `pg_sleep(75)`; active sleepers at
 *          +6 s (Management API) is the effective pool; one extra client sends
 *          `select 1`. Time to its error, the text, and the crowd's errors.
 *          3 trials.
 *
 * Runs after PC05 and PC06 because it changes the project's pool.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { activeSleepers, holdPool, sharedTxn, timedQuery } from "../lib/pg";
import { acquireProject, type PoolerEntry, sleep, stallGuard } from "../lib/project";

const POOL = 5;
const CROWD = 12;
const HOLD_S = 75;

const mod: TestModule = {
  id: "PC07",
  title: "Pool size set through the Management API vs the checkout timeout",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "PC07", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    const guard = stallGuard("PC07");
    const p = await acquireProject(ctx);
    const path = `/projects/${p.ref}/config/database/pooler`;

    const patch = await mgmt(ctx, "PATCH", path, { default_pool_size: POOL });
    await sleep(20_000);
    const back = await mgmt(ctx, "GET", path);
    const entry = (Array.isArray(back.json) ? (back.json as PoolerEntry[]) : []).find((e) => e.database_type === "PRIMARY");
    out.push({
      id: "PC07a",
      title: `PC07a: PATCH default_pool_size ${POOL}`,
      status: patch.status < 300 && entry?.default_pool_size === POOL ? "pass" : "fail",
      detail: `PATCH HTTP ${patch.status}; read back default_pool_size ${entry?.default_pool_size ?? "null"}, max_client_conn ${entry?.max_client_conn ?? "null"}`,
      measurements: {
        patch_status: patch.status,
        read_back_default_pool_size: entry?.default_pool_size ?? "null",
        read_back_max_client_conn: entry?.max_client_conn ?? "null",
      },
      evidence: patch.status < 300 ? undefined : patch.text.slice(0, 300),
    });

    for (let k = 1; k <= 3; k++) {
      const t = sharedTxn(p);
      const crowd = holdPool(t, p.password, CROWD, HOLD_S);
      await sleep(6000);
      const act = await activeSleepers(p.ctx);
      const r = await timedQuery(t, p.password, "select 1", 120_000);
      const res = await crowd.done;
      const errs = res.filter((o) => !o.ok);
      const times = errs.map((o) => o.totalMs).sort((a, b) => a - b);
      out.push({
        id: `PC07b-${k}`,
        title: `PC07b trial ${k}: pool ${POOL}, ${CROWD} pg_sleep(${HOLD_S}) clients plus one select 1`,
        status: r.ok ? "fail" : "pass",
        detail: r.ok
          ? `extra client served after ${r.queryMs} ms`
          : `${act.active} active sleepers at +6 s; extra client: connect ${r.connectMs} ms, failed after ${r.queryMs} ms: ${r.code} ${r.error}; crowd: ${errs.length} of ${CROWD} errored after ${times[0] ?? "-"} to ${times.at(-1) ?? "-"} ms`,
        measurements: {
          trial: k,
          pool_size_set: POOL,
          active_sleepers_at_6s: act.active,
          extra_connect_ms: r.connectMs ?? "failed",
          extra_ok: r.ok ? "yes" : "no",
          extra_query_ms: r.queryMs ?? "n/a",
          extra_error: r.ok ? "none" : `${r.code} ${r.error}`,
          crowd_errored: errs.length,
          crowd_error_total_ms_min: times[0] ?? "n/a",
          crowd_error_total_ms_max: times.at(-1) ?? "n/a",
          crowd_error_texts: [...new Set(errs.map((o) => `${o.code} ${o.error}`))].join(" | ") || "none",
        },
      });
      await sleep(5000);
    }
    out.push(guard.result());
    return out;
  },
};

export default mod;
