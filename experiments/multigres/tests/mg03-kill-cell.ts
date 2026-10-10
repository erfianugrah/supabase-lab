/**
 * MG03 - SIGKILL postgres, multipooler and pgctld of the primary's cell under
 * write load: the pod-loss shape. The cell's gateway and multiorch keep
 * running, so clients still have a gateway to talk to.
 *
 * Every repeat starts from a freshly created container, because the local
 * provisioner does not restart a killed cell and a degraded 2-node cluster
 * would not be a like-for-like start for the next run. Whether the cluster
 * returns to 3 nodes on its own is recorded (healed_to_1p2s) with a 45 s wait.
 */
import { killCell } from "../lib/faults";
import { preflight, repsOf } from "../lib/preflight";
import { runScenario } from "../lib/scenario";
import type { TestModule, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "MG03",
  title: "SIGKILL the primary's whole cell (postgres + multipooler + pgctld) under write load",
  where: "local",
  destructive: true,
  async run(ctx): Promise<TestResult[]> {
    const skip = await preflight(ctx, "MG03", "SIGKILL primary cell");
    if (skip) return [skip];
    const out: TestResult[] = [];
    for (let i = 0; i < repsOf(ctx, 3); i++) {
      const id = `MG03${String.fromCharCode(97 + i)}`;
      out.push(
        await runScenario(ctx, {
          id,
          title: `SIGKILL primary cell, run ${i + 1}`,
          fault: killCell,
          fresh: true,
          healMaxMs: 45_000,
        }),
      );
    }
    return out;
  },
};
export default mod;
