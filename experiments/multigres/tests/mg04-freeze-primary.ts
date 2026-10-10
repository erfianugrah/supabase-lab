/**
 * MG04 - SIGSTOP the primary's cell for 45 s under write load, then SIGCONT.
 *
 * A hung primary rather than a dead one: nothing closes its sockets, so the
 * detection path is the one that matters, and the stale primary comes back
 * afterwards holding writes it may not have replicated. Acknowledged-but-lost
 * commits are counted against the final table as in MG02. The client bounds
 * each statement at 20 s (a Query read timeout is recorded as an error).
 */
import { freezeCell } from "../lib/faults";
import { preflight, repsOf } from "../lib/preflight";
import { runScenario } from "../lib/scenario";
import type { TestModule, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "MG04",
  title: "SIGSTOP the primary's cell for 45 s under write load, then SIGCONT",
  where: "local",
  destructive: true,
  async run(ctx): Promise<TestResult[]> {
    const skip = await preflight(ctx, "MG04", "SIGSTOP primary cell");
    if (skip) return [skip];
    const out: TestResult[] = [];
    for (let i = 0; i < repsOf(ctx, 2); i++) {
      const id = `MG04${String.fromCharCode(97 + i)}`;
      out.push(await runScenario(ctx, { id, title: `SIGSTOP primary cell 45 s, run ${i + 1}`, fault: freezeCell(45_000), fresh: i === 0 }));
    }
    return out;
  },
};
export default mod;
