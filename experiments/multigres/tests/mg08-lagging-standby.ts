/**
 * MG08 - can the failover lose acknowledged commits when a standby is behind?
 *
 * The blog claim is that commits that succeeded are not lost. MG02..MG04 never
 * give the orchestrator a chance to get that wrong, because every standby is
 * current when the primary dies. Here one standby is SIGSTOPped for 20 s under
 * load, so it falls far behind (the other standby keeps acknowledging the
 * synchronous commits); the primary's own pg_stat_replication lag for it is
 * recorded in the evidence. Then the primary and the current standby are
 * SIGKILLed while the lagging one is resumed. If the lagging standby is
 * promoted without the missing WAL, those commits are gone and
 * `acked_but_lost` is non-zero.
 *
 * An earlier 5 s version of this module left a lag of about 5.5 MB, which can
 * sit entirely in the stopped standby's socket receive buffer and arrive after
 * SIGCONT even though the primary is dead, so it did not prove anything about
 * the orchestrator. The lag here is meant to exceed the socket buffers; the
 * flush_lag_bytes in the evidence is the check.
 */
import { lagThenDoubleKill } from "../lib/faults";
import { preflight, repsOf } from "../lib/preflight";
import { runScenario } from "../lib/scenario";
import type { TestModule, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "MG08",
  title: "Lagging standby, then primary and current standby SIGKILLed under write load",
  where: "local",
  destructive: true,
  async run(ctx): Promise<TestResult[]> {
    const skip = await preflight(ctx, "MG08", "lagging standby double kill");
    if (skip) return [skip];
    const out: TestResult[] = [];
    for (let i = 0; i < repsOf(ctx, 3); i++) {
      const id = `MG08${String.fromCharCode(97 + i)}`;
      out.push(await runScenario(ctx, { id, title: `lagging standby + double kill, run ${i + 1}`, fault: lagThenDoubleKill(20_000), fresh: i === 0 }));
    }
    return out;
  },
};
export default mod;
