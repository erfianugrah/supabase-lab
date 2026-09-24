/**
 * DA02 - recovery time after re-enabling, as a function of how long the Data
 * API was off.
 *
 * http-tier-lockdown measured restore at 1-2 s (API) and ~8 s (Dashboard click),
 * but never held the API off longer than 120 s. A maintenance window is longer
 * than that. If anything in the path backs off while the API is off - PostgREST
 * retrying its schema-cache load, a gateway health check marking the upstream
 * down - recovery would grow with the hold, and a short test would never show
 * it. So: off, hold H, on, and time every path from the moment of the PATCH.
 *
 * Holds come from PVLAB_DA_HOLDS (seconds, comma-separated; default 30,300,900).
 * Also records what each readiness candidate reports WHILE off, and pulls the
 * PostgREST log lines for the run so "no errors in the logs" can be checked.
 *
 * DESTRUCTIVE: switches the Data API off. Restores the exact baseline config.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys, logsAllQuery } from "../../../harness/src/platform.js";
import {
  APP_PATHS,
  dataApiProbes,
  fmtTransitions,
  getPostgrest,
  setSchemas,
  snapshot,
  timeline,
} from "../lib/reenable.js";


const mod: TestModule = {
  id: "DA02",
  title: "Re-enable recovery vs how long the Data API was off",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const holds = (process.env.PVLAB_DA_HOLDS ?? "30,300,900")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0);
    const keys = await fetchKeys(ctx);
    const probes = dataApiProbes(ctx, keys);
    const base = await getPostgrest(ctx);
    const runStart = new Date();
    const out: TestResult[] = [];
    const marks: string[] = [];

    try {
      for (const hold of holds) {
        const id = `DA02-h${hold}`;
        // --- off ---
        // With stopOn [] the timeline runs to maxWait: up to 60 s is enough to
        // see the switch-off land (6-8 s in http-tier-lockdown) and settle, and
        // it counts toward the hold.
        const offWindowMs = Math.min(hold * 1000, 60_000);
        let offStatus = 0;
        const off = await timeline(
          probes,
          { maxWaitMs: offWindowMs, settleMs: 0, stopOn: [], log: ctx.log },
          async () => {
            marks.push(`${id} off PATCH ${new Date().toISOString()}`);
            offStatus = (await setSchemas(ctx, base, "")).status;
          },
        );
        const offAt = Object.fromEntries(
          off.paths.map((p) => [p.name, p.transitions.find(([, s]) => s !== "200")?.[0] ?? -1]),
        );
        const whileOff = await snapshot(probes);

        // --- hold ---
        const holdRemainMs = Math.max(0, hold * 1000 - offWindowMs);
        await Bun.sleep(holdRemainMs);
        const endOfHold = await snapshot(probes);

        // --- on ---
        let onStatus = 0;
        const on = await timeline(
          probes,
          { maxWaitMs: 600_000, settleMs: 10_000, stopOn: APP_PATHS, log: ctx.log },
          async () => {
            marks.push(`${id} on PATCH ${new Date().toISOString()}`);
            onStatus = (await setSchemas(ctx, base, base.db_schema)).status;
          },
        );
        const get = (n: string) => on.paths.find((p) => p.name === n);
        const m: Record<string, number | string> = {
          hold_s: hold,
          off_patch: offStatus,
          on_patch: onStatus,
        };
        for (const p of on.paths) {
          m[`${p.name}_first_ok_ms`] = p.firstOkMs ?? "never";
          m[`${p.name}_sustained_ms`] = p.sustainedOkMs ?? "never";
          m[`${p.name}_samples`] = p.samples;
        }
        for (const [k, v] of Object.entries(offAt)) m[`off_${k}_ms`] = v;
        const appMax = Math.max(...APP_PATHS.map((n) => get(n)?.sustainedOkMs ?? Infinity));
        out.push({
          id,
          title: `off ${hold}s, then on: time to serve`,
          status: Number.isFinite(appMax) ? "info" : "fail",
          detail: Number.isFinite(appMax)
            ? `app paths sustained-ok ${appMax} ms after the enable PATCH`
            : "an app path never recovered within 600 s",
          measurements: m,
          evidence: [
            `while off (+${offWindowMs / 1000}s): ${JSON.stringify(whileOff)}`,
            `end of hold: ${JSON.stringify(endOfHold)}`,
            "switch-off:",
            ...off.paths.map(fmtTransitions),
            "switch-on:",
            ...on.paths.map(fmtTransitions),
          ].join("\n"),
        });
      }
    } finally {
      const back = await setSchemas(ctx, base, base.db_schema);
      out.push({
        id: "DA02z",
        title: "restore PostgREST config",
        status: back.status === 200 ? "pass" : "fail",
        detail: back.status === 200 ? "restored" : `restore HTTP ${back.status} - PROJECT LEFT WITH DATA API OFF`,
      });
    }

    // Server-side view. Log rows land 15-60 s late (edge-resilience W27). The
    // stream endpoint answers `Table "postgrest_logs" does not exist.`; logs.all
    // has it (2026-09-24).
    await Bun.sleep(60_000);
    const hours = Math.min(24, Math.ceil((Date.now() - runStart.getTime()) / 3600_000) + 1);
    const logs = await logsAllQuery(
      ctx,
      // Filter in SQL: `order by ... asc limit` over the whole window returned
      // the OLDEST 1000 rows (earlier runs) and the client-side filter then
      // dropped all of them - DA02L reported 0 lines on 2026-09-24.
      `select timestamp, event_message from postgrest_logs where timestamp >= timestamp '${runStart.toISOString().replace("T", " ").replace("Z", "")}' order by timestamp asc limit 2000`,
      hours,
    );
    const lines = logs.rows
      .map((r) => {
        const ts = Number(r.timestamp);
        const iso = Number.isFinite(ts) ? new Date(ts / 1000).toISOString() : String(r.timestamp);
        return `${iso} ${String(r.event_message ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
      })
      .filter((l) => l.slice(0, 24) >= runStart.toISOString());
    out.push({
      id: "DA02L",
      title: "postgrest_logs across the run",
      status: logs.error ? "fail" : "info",
      detail: logs.error || `${lines.length} lines since run start`,
      measurements: { log_lines: lines.length },
      evidence: [...marks, "---", ...lines].join("\n"),
    });
    return out;
  },
};
export default mod;
