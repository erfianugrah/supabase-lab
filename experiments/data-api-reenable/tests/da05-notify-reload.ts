/**
 * DA05 - does `notify pgrst, 'reload config'` right after re-enabling make the
 * Data API serve sooner?
 *
 * It is PostgREST's documented way to re-read configuration, and it is the step
 * an operator would be told to run in the SQL Editor after flipping the toggle
 * back. Whether it shortens anything on the managed platform is untested:
 * the platform applies `db_schema` itself, and a NOTIFY can only help if the
 * process is otherwise waiting on a retry timer.
 *
 * Alternating pairs (plain, then with NOTIFY) over PVLAB_DA_TRIALS trials
 * (default 3), each with the same hold (PVLAB_DA_NOTIFY_HOLD s, default 60), so
 * drift over the run lands on both arms instead of on one.
 *
 * DESTRUCTIVE: switches the Data API off. Restores the exact baseline config.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys, sql } from "../../../harness/src/platform.js";
import {
  APP_PATHS,
  dataApiProbes,
  fmtTransitions,
  getPostgrest,
  setSchemas,
  timeline,
} from "../lib/reenable.js";

const mod: TestModule = {
  id: "DA05",
  title: "Re-enable with and without an immediate NOTIFY reload config",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const trials = Number(process.env.PVLAB_DA_TRIALS ?? 3);
    const hold = Number(process.env.PVLAB_DA_NOTIFY_HOLD ?? 60);
    const keys = await fetchKeys(ctx);
    const probes = dataApiProbes(ctx, keys).filter((p) => p.name !== "mgmt_health_rest");
    const base = await getPostgrest(ctx);
    const out: TestResult[] = [];
    const arms: Record<string, number[]> = { plain: [], notify: [] };

    try {
      for (let t = 1; t <= trials; t++) {
        for (const arm of ["plain", "notify"] as const) {
          await setSchemas(ctx, base, "");
          const t1 = Date.now();
          while (Date.now() - t1 < 60_000 && (await probes[0]!.run()).ok) await Bun.sleep(500);
          await Bun.sleep(Math.max(0, hold * 1000 - (Date.now() - t1)));

          // Re-check right before enabling. 2026-09-24 trial 3 (plain) answered
          // 200 16 ms after t0 - the API was serving at the end of the hold, so
          // the "recovery" it timed never happened. Such a trial is excluded.
          const offBeforeEnable = !(await probes[0]!.run()).ok;
          let notifyStatus = "-";
          const on = await timeline(
            probes,
            { maxWaitMs: 300_000, settleMs: 10_000, stopOn: APP_PATHS, log: ctx.log },
            async () => {
              await setSchemas(ctx, base, base.db_schema);
              if (arm === "notify") {
                const r = await sql(ctx, `notify pgrst, 'reload config'`);
                notifyStatus = String(r.status);
              }
            },
          );
          const rest = on.paths.find((p) => p.name === "rest_table");
          const ready = on.paths.find((p) => p.name === "rest_admin_ready");
          const v = rest?.sustainedOkMs ?? -1;
          if (offBeforeEnable) arms[arm]!.push(v);
          out.push({
            id: `DA05-t${t}-${arm}`,
            title: `trial ${t}, ${arm}`,
            status: !offBeforeEnable ? "skip" : v >= 0 ? "info" : "fail",
            detail: `${offBeforeEnable ? "" : "EXCLUDED - API was serving before the enable PATCH; "}rest_table sustained-ok ${v} ms; rest_admin_ready first ok ${ready?.firstOkMs ?? "never"} ms`,
            measurements: {
              arm,
              hold_s: hold,
              off_before_enable: String(offBeforeEnable),
              notify_status: notifyStatus,
              rest_table_first_ok_ms: rest?.firstOkMs ?? "never",
              rest_table_sustained_ms: v,
              rest_admin_ready_first_ok_ms: ready?.firstOkMs ?? "never",
            },
            evidence: on.paths.map(fmtTransitions).join("\n"),
          });
        }
      }
    } finally {
      const back = await setSchemas(ctx, base, base.db_schema);
      out.push({
        id: "DA05z",
        title: "restore PostgREST config",
        status: back.status === 200 ? "pass" : "fail",
        detail: back.status === 200 ? "restored" : `restore HTTP ${back.status}`,
      });
    }
    const fmt = (xs: number[]) => xs.join("/");
    out.push({
      id: "DA05",
      title: this.title,
      status: "info",
      detail: `rest_table sustained-ok ms - plain ${fmt(arms.plain!)}; notify ${fmt(arms.notify!)}`,
      measurements: { plain_ms: fmt(arms.plain!), notify_ms: fmt(arms.notify!) },
    });
    return out;
  },
};
export default mod;
