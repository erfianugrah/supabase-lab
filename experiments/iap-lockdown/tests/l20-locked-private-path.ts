/**
 * L20 - the fully-locked end state, verified from both sides.
 *
 * PrivateLink up (association via Dashboard - the /platform routes reject
 * PATs categorically, privatelink-aws finding), network restrictions at
 * restrict-all, Data API off (L02 wedge). Then:
 *
 *   - runner vantage (inside the VPC): psql over the endpoint on 5432 and
 *     6543 still connects - the private path survives the HTTP lockdown.
 *     This closes the T22d/e/f gap http-tier-lockdown left open.
 *   - local vantage (public internet): full inventory shows exactly which
 *     HTTP surfaces still answer (expected: all of them except the wedged
 *     REST/GraphQL - network restrictions never touch the HTTP tier,
 *     platform-downtime finding).
 *
 * Requires the privatelink-aws tofu stack (vpc.tf, lattice.tf, runner.tf,
 * lambda.tf) applied with this experiment's project. Phase C wiring: copy
 * or reference that stack with the project ref swapped; the association is
 * a manual Dashboard step per the AGENTS.md finding.
 *
 * where: "runner" modules execute in-VPC via SSM (privatelink-aws suite.sh
 * is the orchestration reference).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L20",
  title: "fully-locked end state: private path alive, public inventory closed except levers",
  where: "runner",
  requires: ["pat", "db", "endpoint"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L20",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Needs the AWS stack; runner vantage via SSM (privatelink-aws/suite.sh).",
    };
  },
};
export default mod;
