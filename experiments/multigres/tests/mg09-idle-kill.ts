/**
 * MG09 - the MG02 fault with almost no client traffic.
 *
 * MG02 runs 8 closed-loop writers that reconnect in a tight loop; MG05's
 * pgbench clients all abort at the fault, leaving no traffic. A first run of
 * each showed the orchestrator starting its promotion at very different times
 * after the kill. This module separates "traffic speeds up detection" from
 * "pgbench is different" with one writer doing one INSERT every 100 ms, so
 * the stall is dominated by the orchestrator's own timers.
 */
import { killPostgres } from "../lib/faults";
import { preflight, repsOf } from "../lib/preflight";
import { runScenario } from "../lib/scenario";
import type { TestModule, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "MG09",
  title: "SIGKILL the primary's postgres under one 10 writes/s client",
  where: "local",
  destructive: true,
  async run(ctx): Promise<TestResult[]> {
    const skip = await preflight(ctx, "MG09", "idle kill");
    if (skip) return [skip];
    const out: TestResult[] = [];
    for (let i = 0; i < repsOf(ctx, 3); i++) {
      const id = `MG09${String.fromCharCode(97 + i)}`;
      out.push(
        await runScenario(ctx, {
          id,
          title: `SIGKILL primary postgres, 1 writer at 10 writes/s, run ${i + 1}`,
          fault: killPostgres,
          workers: 1,
          pauseMs: 100,
          fresh: i === 0,
        }),
      );
    }
    return out;
  },
};
export default mod;
