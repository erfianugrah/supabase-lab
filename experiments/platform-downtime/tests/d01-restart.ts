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
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { sampleDuring } from "../../../harness/src/sampler";
import { buildProbes, verdict, INTERVAL_MS, SETTLE_MS } from "../lib/setup";

const MAX_WAIT_MS = 420_000;

const mod: TestModule = {
  id: "D01",
  title: "Restart: client-visible outage per connection path",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx): Promise<TestResult> {
    const { probes, note } = await buildProbes(ctx);
    ctx.log(note);

    const windows = await sampleDuring(
      probes,
      { intervalMs: INTERVAL_MS, maxWaitMs: MAX_WAIT_MS, settleMs: SETTLE_MS, log: ctx.log },
      async () => {
        const res = await fetch(`https://api.supabase.com/v1/projects/${ctx.ref}/restart`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.pat}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`restart request failed: HTTP ${res.status}`);
        ctx.log(`restart API: HTTP ${res.status}`);
      },
    );

    return verdict("D01", mod.title, windows) as TestResult;
  },
};
export default mod;
