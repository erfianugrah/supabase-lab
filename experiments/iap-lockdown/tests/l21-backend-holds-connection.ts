/**
 * L21 - backend-holds-the-connection: the real "IAP over Supabase"
 * architecture, end to end.
 *
 * A Lambda inside the VPC runs the only data query over the PrivateLink
 * endpoint; invocation is fronted by a gated URL (IAM/sigv4 Lambda URL, or
 * an Access-gated worker that invokes it). Measures:
 *
 *   - the Lambda answers a data read through its gate;
 *   - the same read attempted directly against the public API host with the
 *     strongest non-backend credential available is refused (because L02 +
 *     L05 + L08 already closed every public path);
 *   - latency overhead of gate + Lambda + PrivateLink vs a direct public
 *     Data-API read (the cost of the architecture, in numbers).
 *
 * This is the deliverable architecture for "Supabase as database only": the
 * proxy really is the only path to the data, and this module is the proof.
 *
 * Requires the full Phase C stack. Reference: privatelink-aws/tests/
 * t15-lambda.ts for the Lambda probe pattern.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L21",
  title: "backend-holds-connection: Lambda over PrivateLink behind a gate is the only data path",
  where: "local",
  requires: ["pat", "lambda"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L21",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Lambda probe pattern: privatelink-aws/tests/t15-lambda.ts.",
    };
  },
};
export default mod;
