/**
 * EB03 - The same question as EB02 for the function -> rpc shape: does a
 * non-recursive single-function burst draw RATE_LIMIT_EXCEEDED when each
 * invocation makes one supabase-js rpc() to the project's Data API?
 *
 * `eb-rpc` creates one supabase-js 2.118.0 client per isolate (anon key from
 * the runtime environment) and calls `rpc("eb_ping")`, a `select 1` SQL
 * function, once per request. It answers HTTP 200 whatever the rpc returned
 * and reports the rpc status in its body (`rpc_histogram`), so a non-200 HTTP
 * status is the platform's, not the database's. The outbound call goes to
 * /rest/v1, not to /functions/v1: no function-to-function call.
 *
 *   EB03-r025 .. EB03-r800  open loop, same steps as EB02
 *   EB03-stop               present only if a step's non-200 share passed 20 %
 *   EB03-burst              1,000 requests at once through at most 450 sockets
 *
 * Not settled by this module: the Data API's own ceiling on Micro (rpc
 * failures are reported, not chased), user JWTs, other regions and vantages.
 *
 * DESTRUCTIVE: invokes the EB01 project's function about 189,000 times.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { runArm } from "../lib/arm.js";
import { RPC_SLUG, errText, scrub, skipWithout } from "../lib/eb.js";

const mod: TestModule = {
  id: "EB03",
  title: "function -> rpc: open-loop steps and a burst against one function, ap-northeast-1",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 45 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "EB03", this.title);
    if (skip) return skip;
    try {
      return await runArm(ctx, "EB03", RPC_SLUG, "eb-rpc");
    } catch (e) {
      return [{ id: "EB03", title: this.title, status: "fail", detail: `threw: ${scrub(errText(e))}` }];
    }
  },
};
export default mod;
