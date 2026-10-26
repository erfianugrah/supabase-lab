/**
 * DC15 - What happens to an explicitly set `db_pool` when the compute size
 * changes: is it kept, re-derived from the new size, or clamped, and what
 * does a pool larger than the new size's `max_connections` allow do?
 *
 * Measured before: `db_pool` unset follows the size (DC01: Small 30, Large
 * 50); PATCHed values read back and were what Postgres saw (DC02a); a pool
 * above `max_connections` turned PGRST003 into 503 PGRST002 under a burst
 * (DC02, one burst). Not measured: a set value across a resize.
 *
 * PVLAB_DC15_ARM selects one of two projects, run as separate processes:
 *   custom   Small: PATCH db_pool 45 -> read; resize to Large -> read;
 *            PATCH db_pool 120 -> read; resize to Small (max_connections
 *            90) -> read.
 *   control  Small read; resize to Large -> read; resize to Small -> read
 *            (db_pool never PATCHed).
 * A "read" is lib/tier.ts readPool: GET /postgrest, pgrst_db_pool_max over
 * 90 s, two bursts of K concurrent 12 s sleeps with the mid-burst PgSleep
 * count of `authenticator` (K = 70 while the pool can be 45, 150 after 120),
 * `max_connections`. After the last read: client backends by role, a
 * Management API query, and 5 consecutive Data API pings.
 *
 * DESTRUCTIVE: creates the shared project (lib/dc.ts); DC99 deletes it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, patchPostgrest, postgrestConfig, redact, resize, skipWithoutPro, sleep, sql, untilHealthy, waitRestart } from "../lib/dc.js";
import { backendsByRole, poolColumns, poolLine, readPool } from "../lib/tier.js";

const ARM = process.env.PVLAB_DC15_ARM || "custom";

const mod: TestModule = {
  id: "DC15",
  title: "A set db_pool across a resize (custom 45 Small->Large, 120 Large->Small; control unset)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC15");
    if (skip) return skip;
    const out: TestResult[] = [];
    const put = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id}: ${r.detail ?? ""}`.slice(0, 500));
    };
    try {
      const p = await ensureProject(ctx);
      const custom = ARM === "custom";

      const patch = async (id: string, v: number) => {
        const t0 = Date.now();
        const pr = await patchPostgrest(ctx, p.ref, { db_pool: v });
        const rs = await waitRestart(ctx, p.ref, t0);
        const cfg = await postgrestConfig(ctx, p.ref);
        put({
          id,
          title: `PATCH db_pool ${v}`,
          status: pr.status < 300 ? "info" : "fail",
          detail: `PATCH ${pr.status} ${pr.status >= 300 ? redact(pr.text) : ""}; restart ${rs.delayS} s after; read back ${cfg.dbPool}`,
          measurements: { arm: ARM, patch_status: pr.status, restart_delay_s: rs.delayS, db_pool_readback: cfg.dbPool },
        });
        await sleep(15_000);
      };
      const read = async (id: string, label: string, k: number) => {
        const r = await readPool(ctx, p, k);
        put({ id, title: `${ARM}: ${label}`, status: "info", detail: poolLine(r), measurements: { arm: ARM, step: label, ...poolColumns(r) } });
        return r;
      };
      const rsz = async (id: string, variant: string, want: number) => {
        const rz = await resize(ctx, p, variant, want, 25 * 60_000, 60);
        put({
          id,
          title: `${ARM}: resize to ${variant}`,
          status: rz.settledS >= 0 ? "info" : "fail",
          detail: `PATCH ${rz.status} after ${rz.retries429 ?? 0} x 429; settled ${rz.settledS} s; max_connections ${rz.maxConn}; watch failures ${rz.watch?.failed ?? -1} of ${rz.watch?.samples ?? -1} (${rz.watch?.failStatuses ?? ""}) ${redact(rz.watch?.sampleFail ?? rz.text)}`,
          measurements: { arm: ARM, variant, resize_status: rz.status, addon_429_retries: rz.retries429 ?? 0, settled_s: rz.settledS, max_connections: rz.maxConn, watch_failed: rz.watch?.failed ?? -1, watch_samples: rz.watch?.samples ?? -1, watch_fail_statuses: rz.watch?.failStatuses ?? "" },
        });
        return rz.settledS >= 0;
      };

      if (custom) await patch("DC15a-patch45", 45);
      await read("DC15a-small", custom ? "Small, db_pool 45" : "Small, db_pool unset", 70);
      if (!(await rsz("DC15b-resize", "ci_large", 160))) return out;
      await read("DC15b-large", custom ? "Large after resize, db_pool 45 set on Small" : "Large after resize, unset", 70);
      if (custom) await patch("DC15c-patch120", 120);
      await read("DC15c-large", custom ? "Large, db_pool 120" : "Large, unset (second read)", 150);
      if (!(await rsz("DC15d-resize", "ci_small", 90))) return out;
      await read("DC15d-small", custom ? "Small after resize, db_pool 120 set on Large" : "Small after resize, unset", 150);

      const roles = await backendsByRole(ctx, p.ref);
      const q = await sql(ctx, p.ref, "select 1 as ok", 30_000);
      const healthyS = await untilHealthy(p, 5, 120);
      put({
        id: "DC15e-after",
        title: `${ARM}: after the last read`,
        status: "info",
        detail: `client backends ${roles?.clients ?? -1}/${roles?.maxConnections ?? -1} (${roles?.byRoleApp ?? ""}); Management query ${q.status} ${q.error ?? ""}; 5 good pings after ${healthyS} s`,
        measurements: { arm: ARM, client_backends: roles?.clients ?? -1, max_connections: roles?.maxConnections ?? -1, by_role_app: (roles?.byRoleApp ?? "").slice(0, 500), mgmt_query_status: q.status, mgmt_query_error: q.error ?? "", healthy_after_s: healthyS },
      });
    } catch (e) {
      put({ id: "DC15", title: this.title, status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
