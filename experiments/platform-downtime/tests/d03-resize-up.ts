/**
 * D03 - client-visible outage across a compute resize UP (micro -> small).
 *
 * DESTRUCTIVE and BILLABLE: the compute change persists until D04 puts it back.
 * Ids sort within the destructive tier, so D03 runs before D04 and the pair
 * reads as a comparison. If the suite is interrupted between them the project
 * is left on the larger instance - destroy it or run D04.
 *
 * The lever is `PATCH /v1/projects/{ref}/billing/addons`, not a resize endpoint.
 * That is worth stating because a previous investigation on a related question
 * concluded a size could not be changed programmatically after searching only
 * for resize-shaped and branch-shaped endpoints; the actual control is an addon
 * mutation, and its GET sibling is what F02 already reads for the compute
 * catalogue. Verb and body shape were read off the published OpenAPI document
 * on 2026-08-04, not recalled.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { sampleDuring } from "../../../harness/src/sampler";
import { buildProbes, verdict, setComputeSize, INTERVAL_MS, SETTLE_MS } from "../lib/setup";

const MAX_WAIT_MS = 900_000;

const mod: TestModule = {
  id: "D03",
  title: "Resize up (micro -> small): outage per connection path",
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
        await setComputeSize(ctx, "ci_small");
      },
    );

    return verdict("D03", mod.title, windows) as TestResult;
  },
};
export default mod;
