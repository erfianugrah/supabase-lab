/**
 * CB05 - pg_cron across a compute resize, Micro to Small
 * (PATCH /v1/projects/{ref}/billing/addons, compute_instance ci_small).
 *
 *   CB05a  downtime window and the every-minute and 10-second jobs across it
 *   CB05b  a pg_sleep(120) run in flight at the resize
 *
 * Same method as CB04 (../lib/downtime.ts). Runs after CB01-CB04, so those
 * measure Micro. A 429 on the PATCH is retried after the minutes it names
 * (at most 3 times, 5 minutes each).
 */
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, scrub, skipWithout, sleep } from "../lib/cb.js";
import { observeEvent } from "../lib/downtime.js";

const retryMinutes = (body: string) => Math.min(Math.max(Number(/try again in (\d+) minute/.exec(body)?.[1] ?? 1), 1), 5);

const mod: TestModule = {
  id: "CB05",
  title: "pg_cron across a compute resize Micro -> Small: missed runs, catch-up, a run in flight",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 60 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "CB05", this.title);
    if (skip) return skip;
    try {
      const p = await ensureProject(ctx);
      return await observeEvent(
        ctx,
        p,
        "CB05",
        "resize",
        async () => {
          const body = { addon_type: "compute_instance", addon_variant: "ci_small" };
          let sentAt = Date.now();
          let r = await mgmt(ctx, "PATCH", `/projects/${p.ref}/billing/addons`, body);
          let retries = 0;
          while (r.status === 429 && retries < 3) {
            retries++;
            await sleep(retryMinutes(r.text) * 60_000);
            sentAt = Date.now();
            r = await mgmt(ctx, "PATCH", `/projects/${p.ref}/billing/addons`, body);
          }
          return { status: r.status, text: r.text, sentAt, retries };
        },
        20 * 60_000,
      );
    } catch (e) {
      return [{ id: "CB05", title: this.title, status: "fail", detail: scrub(errText(e)) }];
    }
  },
};
export default mod;
