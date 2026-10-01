/**
 * D05 - does a password-reset-triggered restart cost the client what D01's
 * direct restart costs, and does it reset `pg_stat_checkpointer` the way a
 * crash does, even though Postgres's own log calls it a clean shutdown?
 *
 * DESTRUCTIVE: changes the project's real database password twice (once to a
 * throwaway value to trigger the restart, once back to `ctx.dbPassword` in a
 * `finally`, mirroring D02's "restore inside the sampled operation, `finally`
 * as an idempotent safety net" lesson). BILLABLE in the sense that it costs a
 * real outage window, not money.
 *
 * Motivation: on a managed PG 17 project, `pg_stat_checkpointer.stats_reset`
 * can move to a restart timestamp even though the server's own log called the
 * shutdown mode "fast shutdown request" - normally a CLEAN shutdown, which a
 * local docker.exe control (postgres:17.4-alpine, `docker restart` vs
 * `kill -9`) showed does NOT reset checkpointer stats. That is the
 * discrepancy this module was written to probe, on the hypothesis that a
 * database-password change is one way a restart gets triggered.
 *
 * This module calls `PATCH /v1/projects/{ref}/database/password` on an
 * ordinary OpenTofu-provisioned project. The one run so far (2026-10-01,
 * RUNLOG.md) found no restart: pg_postmaster_start_time() did not move, so
 * on a plain project the PATCH alone does not restart Postgres and the
 * checkpointer question goes unanswered. Projects provisioned through an
 * integration were not tested (a Vercel-Marketplace project cannot be stood
 * up from OpenTofu or the Supabase API - Vercel's CLI needs one
 * human-confirmed `accept-terms` step per team, RUNLOG.md). The cheaper route
 * to "does a MANAGED restart reset pg_stat_checkpointer" is reading the same
 * restart signal around D01's direct `/restart`.
 *
 * Reuses D01-D04's shared assembly (lib/setup.ts) for the per-path outage
 * measurement, with ONE deliberate deviation: the pooler probe is NOT
 * included. `buildProbes()`'s pooler probe authenticates with
 * `ctx.dbPassword` for the WHOLE sampling window, but this module changes the
 * real password partway through that same window - so a pooler probe would
 * start failing on a STALE CREDENTIAL partway through, indistinguishable from
 * a true service outage in the `sampleDuring` data. Publishing that column
 * anyway would be exactly the kind of unlabelled-ambiguous-signal result the
 * repo's methodology exists to avoid. rest/auth/storage/realtime all
 * authenticate with the anon key, which the password change does not affect.
 *
 * Not settled by this module: whether the result is specific to the
 * password-reset path or is true of every platform-triggered restart (D01
 * already samples a direct restart on the same paths - diff the two runs for
 * that question); whether a TRUE Vercel-Marketplace-provisioned project
 * behaves any differently (see above).
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import type { Probe } from "../../../harness/src/sampler";
import { sampleDuring } from "../../../harness/src/sampler";
import { restProbe, authProbe, storageProbe, realtimeProbe } from "../lib/probes";
import {
  AUTH_PATH,
  INTERVAL_MS,
  SETTLE_MS,
  flatten,
  readRestartSignal,
  readRestartSignalRetrying,
  setDatabasePassword,
  randomPassword,
} from "../lib/setup";

/** No prior measurement exists for THIS trigger; borrowed from D01 as the starting point. */
const MAX_WAIT_MS = 420_000;

const mod: TestModule = {
  id: "D05",
  title: "DB password reset: per-path outage, and does the restart reset pg_stat_checkpointer?",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx): Promise<TestResult> {
    const anon = ctx.anonKey as string;
    const probes: Probe[] = [
      restProbe(ctx.apiHost, anon),
      authProbe(ctx.apiHost, anon, AUTH_PATH),
      storageProbe(ctx.apiHost, anon),
      realtimeProbe(ctx.apiHost, anon),
    ];
    ctx.log("probes: rest, auth, storage, realtime (pooler deliberately excluded - see module doc comment)");

    const before = await readRestartSignal(ctx);
    ctx.log(
      `before: postmaster_start=${before.startTime ?? "?"} ` +
        `${before.checkpointerSource ?? "checkpointer"}.stats_reset=${before.checkpointerStatsReset ?? "?"}`,
    );
    if (!before.startTime || !before.checkpointerStatsReset) {
      return {
        id: "D05",
        title: mod.title,
        status: "skip",
        detail: `could not read a baseline restart signal: ${before.error || "pg_postmaster_start_time/checkpointer stats unreadable"}`,
      };
    }

    const newPassword = randomPassword();
    const windows = await sampleDuring(
      probes,
      { intervalMs: INTERVAL_MS, maxWaitMs: MAX_WAIT_MS, settleMs: SETTLE_MS, log: ctx.log },
      async () => {
        await setDatabasePassword(ctx, newPassword);
        ctx.log("database/password PATCH: accepted (new value withheld from every log/evidence path)");
      },
    ).finally(async () => {
      if (!ctx.dbPassword) {
        ctx.log(
          "RESTORE SKIPPED - no DB_PASSWORD supplied to this run; the project is left on the " +
            "throwaway password this module generated, and secrets.tfvars/tofu state are now " +
            "stale for this ref. Destroy the project rather than reusing it.",
        );
        return;
      }
      try {
        await setDatabasePassword(ctx, ctx.dbPassword);
        ctx.log("password restored to the Terraform-managed value");
      } catch (e) {
        ctx.log(
          `RESTORE FAILED - project may still be on the throwaway password this run generated: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });

    const unhealthy = windows.filter((w) => !w.healthyAtStart).map((w) => w.name);
    if (unhealthy.length > 0) {
      return {
        id: "D05",
        title: mod.title,
        status: "skip",
        detail: `path(s) already failing before the operation: ${unhealthy.join(", ")}`,
        measurements: flatten(windows),
      };
    }

    const after = await readRestartSignalRetrying(ctx);
    ctx.log(
      `after: postmaster_start=${after.startTime ?? "?"} ` +
        `${after.checkpointerSource ?? before.checkpointerSource ?? "checkpointer"}.stats_reset=${after.checkpointerStatsReset ?? "?"}`,
    );

    const measurements = {
      ...flatten(windows),
      postmaster_start_before: before.startTime,
      postmaster_start_after: after.startTime ?? "n/a",
      checkpointer_source: after.checkpointerSource ?? before.checkpointerSource ?? "n/a",
      checkpointer_stats_reset_before: before.checkpointerStatsReset,
      checkpointer_stats_reset_after: after.checkpointerStatsReset ?? "n/a",
    };

    if (!after.startTime) {
      return {
        id: "D05",
        title: mod.title,
        status: "fail",
        detail: `postmaster_start_time unreadable after the operation: ${after.error}`,
        measurements,
      };
    }
    if (after.startTime === before.startTime) {
      return {
        id: "D05",
        title: mod.title,
        status: "fail",
        detail:
          "pg_postmaster_start_time() never changed within the probe window - no restart was " +
          "confirmed, so the checkpointer question is moot for this run (raise MAX_WAIT_MS or re-run)",
        measurements,
      };
    }
    if (!after.checkpointerStatsReset) {
      return {
        id: "D05",
        title: mod.title,
        status: "fail",
        detail: `restart confirmed (postmaster_start_time changed) but checkpointer stats unreadable afterward: ${after.error}`,
        measurements,
      };
    }

    const stuck = windows.filter((w) => w.firstFailMs !== null && w.recoveredMs === null);
    const resetChanged = after.checkpointerStatsReset !== before.checkpointerStatsReset;
    const stuckNote = stuck.length > 0 ? `; also never recovered on: ${stuck.map((w) => w.name).join(", ")}` : "";

    return {
      id: "D05",
      title: mod.title,
      status: "pass",
      detail: resetChanged
        ? `restart confirmed; ${after.checkpointerSource}.stats_reset CHANGED ` +
          `(${before.checkpointerStatsReset} -> ${after.checkpointerStatsReset}) - ` +
          `this restart behaved like a crash for checkpointer stats${stuckNote}`
        : `restart confirmed; ${after.checkpointerSource}.stats_reset UNCHANGED ` +
          `(${before.checkpointerStatsReset}) - this restart preserved checkpointer stats, ` +
          `unlike the managed reading that motivated this module${stuckNote}`,
      measurements,
    };
  },
};
export default mod;
