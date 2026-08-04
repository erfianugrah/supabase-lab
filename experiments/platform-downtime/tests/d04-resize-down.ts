/**
 * D04 - the same resize in reverse (small -> micro).
 *
 * DESTRUCTIVE and BILLABLE. It also returns the project to the size D03 took it
 * from, so running the pair leaves no compute change behind.
 *
 * The hypothesis worth stating BEFORE the run, so the result can contradict it:
 * down-sizing is not symmetric with up-sizing. Growing an instance can be done
 * by attaching more capacity and moving; shrinking has to fit the working set
 * into less. If the two windows come back the same, that is a finding too - it
 * says the operation is dominated by something neither direction escapes,
 * most likely the restart both ends in.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { sampleDuring } from "../../../harness/src/sampler";
import { buildProbes, verdict, setComputeSize, INTERVAL_MS, SETTLE_MS } from "../lib/setup";

const MAX_WAIT_MS = 900_000;

const mod: TestModule = {
  id: "D04",
  title: "Resize down (small -> micro): outage per connection path",
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
        await setComputeSize(ctx, "ci_micro");
      },
    );

    return verdict("D04", mod.title, windows) as TestResult;
  },
};
export default mod;
