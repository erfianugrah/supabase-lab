/**
 * CB04 - pg_cron across POST /v1/projects/{ref}/restart.
 *
 *   CB04a  downtime window (Management API probe and cb_tick), the
 *          every-minute and 10-second jobs: last run before, first after,
 *          instants missed, runs executed late or doubled after recovery
 *   CB04b  a pg_sleep(120) run in flight at the restart: its
 *          job_run_details status and return_message, and whether it re-runs
 *
 * Method and catch-up reading: ../lib/downtime.ts.
 */
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, scrub, skipWithout } from "../lib/cb.js";
import { observeEvent } from "../lib/downtime.js";

const mod: TestModule = {
  id: "CB04",
  title: "pg_cron across a project restart: missed runs, catch-up, a run in flight",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 40 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "CB04", this.title);
    if (skip) return skip;
    try {
      const p = await ensureProject(ctx);
      return await observeEvent(
        ctx,
        p,
        "CB04",
        "restart",
        async () => {
          const sentAt = Date.now();
          const r = await mgmt(ctx, "POST", `/projects/${p.ref}/restart`);
          return { status: r.status, text: r.text, sentAt, retries: 0 };
        },
        10 * 60_000,
      );
    } catch (e) {
      return [{ id: "CB04", title: this.title, status: "fail", detail: scrub(errText(e)) }];
    }
  },
};
export default mod;
