/**
 * D01 - client-visible outage across a project restart, per connection path.
 *
 * DESTRUCTIVE: restarts the project.
 *
 * Generalises t14-restart.ts (privatelink-aws), which measured ONE path (a
 * Lambda on 6543) at its PROBE_EVERY_MS = 5000 resolution, so every window
 * there is quantised to +/- 5s and a short one reports "no client-visible
 * failure observed". The result worth carrying forward from that run: the
 * failure mode was "timeout expired", not a refusal - a caller with a long
 * client timeout spends its whole budget on a single attempt.
 *
 * intervalMs / settleMs / maxWaitMs are chosen starting values, not measured
 * optima. The interval is recorded as a column so no number here is readable
 * without the resolution it was taken at.
 *
 * Since 2026-10-13 (work-supabase-lab#20, #67) the run also records what the
 * restart did to Postgres itself: `pg_postmaster_start_time()` and the
 * checkpointer's `stats_reset` before and after (D05's read), and the
 * shutdown/boot lines Postgres wrote to `postgres_logs` (lib/signal.ts). They
 * are measurements only; the pass/fail verdict is still the per-path outage.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { sampleDuring } from "../../../harness/src/sampler";
import {
  buildProbes,
  verdict,
  INTERVAL_MS,
  SETTLE_MS,
  readRestartSignal,
  readRestartSignalRetrying,
  readShutdownLog,
} from "../lib/setup";
import { shutdownMeasurements, signalMeasurements } from "../lib/signal";

const MAX_WAIT_MS = 420_000;
/** Log timestamps are the server's clock, and the stop may begin before the API call returns. */
const LOG_SLACK_MS = 30_000;

const mod: TestModule = {
  id: "D01",
  title: "Restart: client-visible outage per connection path",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx): Promise<TestResult> {
    const { probes, note } = await buildProbes(ctx);
    ctx.log(note);

    // Read before sampling starts, so the read is not inside the outage window.
    const before = await readRestartSignal(ctx);
    ctx.log(
      `before: postmaster_start=${before.startTime ?? "?"} ` +
        `${before.checkpointerSource ?? "checkpointer"}.stats_reset=${before.checkpointerStatsReset ?? "?"}` +
        (before.error ? ` (${before.error})` : ""),
    );

    let requestedMs = Date.now();
    const windows = await sampleDuring(
      probes,
      { intervalMs: INTERVAL_MS, maxWaitMs: MAX_WAIT_MS, settleMs: SETTLE_MS, log: ctx.log },
      async () => {
        requestedMs = Date.now();
        const res = await fetch(`https://api.supabase.com/v1/projects/${ctx.ref}/restart`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.pat}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`restart request failed: HTTP ${res.status}`);
        ctx.log(`restart API: HTTP ${res.status}`);
      },
    );

    const after = await readRestartSignalRetrying(ctx);
    ctx.log(
      `after: postmaster_start=${after.startTime ?? "?"} ` +
        `${after.checkpointerSource ?? before.checkpointerSource ?? "checkpointer"}.stats_reset=${after.checkpointerStatsReset ?? "?"}`,
    );
    const { reading, error } = await readShutdownLog(ctx, requestedMs - LOG_SLACK_MS);
    ctx.log(`postgres_logs: stop=${reading.stopMode} next_boot=${reading.nextBoot} lines=${reading.lines.length}${error ? ` error=${error}` : ""}`);

    const base = verdict("D01", mod.title, windows);
    const sig = signalMeasurements(before, after);
    return {
      ...base,
      detail:
        `${base.detail}; restart confirmed by pg_postmaster_start_time: ${sig.restart_confirmed}; ` +
        `${sig.checkpointer_source}.stats_reset changed: ${sig.checkpointer_stats_reset_changed}; ` +
        `postgres_logs: stop ${reading.stopMode}, next boot ${reading.nextBoot}` +
        (error ? ` (logs error: ${error.slice(0, 80)})` : ""),
      measurements: { ...base.measurements, ...sig, ...shutdownMeasurements(reading) },
      evidence: reading.lines.join("\n") || (error ? `logs error: ${error}` : "no matching postgres_logs lines"),
    } as TestResult;
  },
};
export default mod;
