/**
 * CR01 - does a CLEAN container restart reset pg_stat_checkpointer, and does
 * that differ between the self-hosted Supabase Postgres image and vanilla
 * Postgres at the same major version?
 *
 * Background: on a managed PG 17 project, pg_stat_checkpointer.stats_reset
 * can move to the time of a restart whose server log reads "fast shutdown
 * request" - a clean shutdown mode. An ad-hoc `docker restart` vs `kill -9` probe against a throwaway
 * postgres:17.4-alpine showed vanilla Postgres does NOT reset the
 * checkpointer across a clean restart - only a crash/unclean one zeroes it.
 * This module re-verifies that on reusable infra and asks the open question:
 * is the self-hosted Supabase image/entrypoint any different from vanilla
 * here, or is the discrepancy purely something the managed platform's own
 * orchestration does?
 *
 * Per-target protocol, run on BOTH images (identical code path, so any
 * difference in the result is attributable to the image, not the harness):
 *   1. CHECKPOINT a few times, read pg_stat_checkpointer (baseline).
 *   2. CLEAN restart (`docker restart`, which sends the image's STOPSIGNAL -
 *      SIGINT on both pinned tags here, Postgres's fast-shutdown signal).
 *      Read pg_stat_checkpointer again.
 *   3. UNCLEAN restart (`docker kill -s SIGKILL` then `docker start`). Read
 *      pg_stat_checkpointer again.
 *
 * "Reset" is read off BOTH signals, because stats_reset alone is not
 * decisive: num_timed/num_requested could both independently reset to 0
 * while stats_reset carries a stale timestamp if a plane only partially
 * reset (not expected, but the discriminator costs nothing to carry).
 *
 * Local vantage only: two throwaway containers (compose.yml), no managed
 * project, no PAT. Self-skips without `make local-up` having been run.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  cleanRestart,
  isRunning,
  logsSince,
  readCheckpointer,
  rigUp,
  runCheckpoints,
  TARGETS,
  unclean_kill_then_start,
  waitUp,
  type CheckpointerRow,
} from "../lib/rig";

const ID = "CR01";

function sameReset(before: CheckpointerRow, after: CheckpointerRow): boolean {
  return before.stats_reset === after.stats_reset && after.num_timed >= before.num_timed && after.num_requested >= before.num_requested;
}

const mod: TestModule = {
  id: ID,
  title: "Checkpointer stats across a clean vs unclean container restart: self-hosted image vs vanilla Postgres",
  where: "local",
  requires: [],
  destructive: true,

  async run(_ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];

    for (const t of TARGETS) {
      if (!(await rigUp(t.port))) {
        out.push({
          id: `${ID}-${t.role}`,
          title: this.title,
          status: "skip",
          detail: `${t.role} target not answering on 127.0.0.1:${t.port} (run \`make local-up\` first)`,
        });
      }
    }
    if (out.some((r) => r.status === "skip")) return out;

    for (const t of TARGETS) {
      try {
        // ---- baseline -----------------------------------------------------
        await runCheckpoints(t.port, t.checkpointRole, 3);
        const baseline = await readCheckpointer(t.port);
        out.push({
          id: `${ID}-${t.role}-baseline`,
          title: `${t.role}: baseline pg_stat_checkpointer after 3x CHECKPOINT`,
          status: "info",
          detail: `num_timed=${baseline.num_timed} num_requested=${baseline.num_requested} stats_reset=${baseline.stats_reset}`,
          measurements: {
            num_timed: baseline.num_timed,
            num_requested: baseline.num_requested,
            stats_reset: baseline.stats_reset,
          },
        });

        // ---- clean restart --------------------------------------------------
        const cleanSince = new Date().toISOString();
        await cleanRestart(t.container, 30);
        const cleanUp = await waitUp(t.port, 60_000);
        if (!cleanUp) {
          out.push({ id: `${ID}-${t.role}-clean`, title: `${t.role}: clean restart`, status: "fail", detail: "did not come back up within 60s" });
          continue;
        }
        const afterClean = await readCheckpointer(t.port);
        const running = await isRunning(t.container);
        const cleanLog = await logsSince(t.container, cleanSince);
        const cleanMatches = sameReset(baseline, afterClean);
        out.push({
          id: `${ID}-${t.role}-clean`,
          title: `${t.role}: CLEAN restart (docker restart / SIGINT) - does pg_stat_checkpointer reset?`,
          // pass = matches the documented vanilla behaviour (no reset);
          // fail = the stats DID reset on a nominally clean restart - that
          // IS the reproduction this module exists to look for, recorded as
          // a measured fail per AGENTS.md ("a measured fail is data").
          status: cleanMatches ? "pass" : "fail",
          detail:
            `container running=${running}; stats_reset before=${baseline.stats_reset} after=${afterClean.stats_reset}; ` +
            `num_timed ${baseline.num_timed}->${afterClean.num_timed}, num_requested ${baseline.num_requested}->${afterClean.num_requested}` +
            (cleanMatches ? " - counters kept accumulating (NOT reset)" : " - RESET despite a clean restart"),
          measurements: {
            stats_reset_before: baseline.stats_reset,
            stats_reset_after: afterClean.stats_reset,
            stats_reset_changed: String(baseline.stats_reset !== afterClean.stats_reset),
            num_timed_after: afterClean.num_timed,
            num_requested_after: afterClean.num_requested,
          },
          evidence: cleanLog || "(no log output since the restart was issued)",
        });

        // ---- unclean restart --------------------------------------------------
        await runCheckpoints(t.port, t.checkpointRole, 2); // give it something fresh to lose
        const beforeUnclean = await readCheckpointer(t.port);
        const uncleanSince = new Date().toISOString();
        await unclean_kill_then_start(t.container);
        const uncleanUp = await waitUp(t.port, 60_000);
        if (!uncleanUp) {
          out.push({ id: `${ID}-${t.role}-unclean`, title: `${t.role}: unclean restart`, status: "fail", detail: "did not come back up within 60s" });
          continue;
        }
        const afterUnclean = await readCheckpointer(t.port);
        const uncleanLog = await logsSince(t.container, uncleanSince);
        const uncleanMatches = !sameReset(beforeUnclean, afterUnclean); // expect a reset here
        out.push({
          id: `${ID}-${t.role}-unclean`,
          title: `${t.role}: UNCLEAN restart (SIGKILL then start) - does pg_stat_checkpointer reset?`,
          // pass = matches documented crash-recovery behaviour (DOES reset).
          status: uncleanMatches ? "pass" : "fail",
          detail:
            `stats_reset before=${beforeUnclean.stats_reset} after=${afterUnclean.stats_reset}; ` +
            `num_timed ${beforeUnclean.num_timed}->${afterUnclean.num_timed}, num_requested ${beforeUnclean.num_requested}->${afterUnclean.num_requested}` +
            (uncleanMatches ? " - RESET as expected after a crash" : " - did NOT reset despite SIGKILL (unexpected)"),
          measurements: {
            stats_reset_before: beforeUnclean.stats_reset,
            stats_reset_after: afterUnclean.stats_reset,
            stats_reset_changed: String(beforeUnclean.stats_reset !== afterUnclean.stats_reset),
            num_timed_after: afterUnclean.num_timed,
            num_requested_after: afterUnclean.num_requested,
          },
          evidence: uncleanLog || "(no log output since the restart was issued)",
        });
      } catch (e) {
        out.push({ id: `${ID}-${t.role}`, title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    return out;
  },
};
export default mod;
