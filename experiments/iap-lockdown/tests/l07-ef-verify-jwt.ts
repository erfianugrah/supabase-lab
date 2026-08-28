/**
 * L07 - Edge Function verify_jwt.
 *
 * Same trivial function deployed twice (POST /v1/projects/{ref}/functions,
 * slug iap-probe-locked, body identical to the open one):
 *
 *   L07a - verify_jwt: false (the L01 fixture function): anonymous 200.
 *          Baseline: an EF is public-by-default, no key needed.
 *   L07b - verify_jwt: true: anonymous probe -> measure the refusal verbatim
 *          (401 shape, time to effect after deploy - W18 measured ~1.4s cold
 *          start, W25 measured ~10.6s deploy propagation; the 401 may precede
 *          the function being live, so probe until stable).
 *   L07c - verify_jwt: true + anon key: does the anon JWT satisfy the gate?
 *          (Expected yes - the gateway verifies ANY valid project JWT. If
 *          true, verify_jwt is not an authorization control, only a
 *          key-possession check - that distinction matters for the IAP story.)
 *
 * DESTRUCTIVE: deploys/deletes functions; deletes iap-probe-locked in finally
 * (DELETE /v1/projects/{ref}/functions/{slug}).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L07",
  title: "Edge Function verify_jwt: public-by-default, and what the gate actually checks",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L07",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Lever: POST /v1/projects/{ref}/functions { verify_jwt }. Deploy pattern: edge-resilience/tests/w18-function-coldstart.ts.",
    };
  },
};
export default mod;
