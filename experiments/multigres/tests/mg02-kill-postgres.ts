/**
 * MG02 - SIGKILL the primary's postgres under a write load; failover window and
 * acknowledged-but-lost commits.
 *
 * The cell's multipooler and pgctld stay up, so this is a postgres crash, not
 * a node loss. 8 workers insert (w, n) rows through the zone1 multigateway;
 * the client-side commit log is compared with the table after recovery.
 * Repeats (PVLAB_ENDPOINT_REPS, default 3) run back to back on the same
 * cluster; each starts only once the cluster is back to 1 primary + 2
 * standbys; which cell holds the primary at the start is read from the
 * cluster each time and recorded in the evidence.
 */
import { killPostgres } from "../lib/faults";
import { preflight, repsOf } from "../lib/preflight";
import { runScenario } from "../lib/scenario";
import type { TestModule, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "MG02",
  title: "SIGKILL the primary's postgres under write load",
  where: "local",
  destructive: true,
  async run(ctx): Promise<TestResult[]> {
    const skip = await preflight(ctx, "MG02", "SIGKILL primary postgres");
    if (skip) return [skip];
    const out: TestResult[] = [];
    for (let i = 0; i < repsOf(ctx, 3); i++) {
      const id = `MG02${String.fromCharCode(97 + i)}`;
      out.push(await runScenario(ctx, { id, title: `SIGKILL primary postgres, run ${i + 1}`, fault: killPostgres }));
    }
    return out;
  },
};
export default mod;
