/**
 * EB02 - The docs attribute RATE_LIMIT_EXCEEDED to recursive calls; does a
 * non-recursive single-function burst draw it? Arm 1: a no-op function.
 *
 * Every request is a plain GET from this lab's Mac (Singapore, IPv4,
 * keep-alive HTTP/1.1) to ONE function, `eb-noop`, pinned with
 * `x-region: ap-northeast-1`; the function makes no outbound call, so
 * nothing here is nested or recursive.
 *
 *   EB02-r025 .. EB02-r800  open loop at 25/50/100/200/400/800 req/s for 120 s
 *                           each (PVLAB_EB_RATES, PVLAB_EB_STEP_S), 20 s apart
 *   EB02-stop               present only if a step's non-200 share passed 20 %
 *   EB02-burst              1,000 requests at once through at most 450 sockets
 *
 * Per row: requested vs achieved send rate (client_limited flags a step the
 * client did not deliver), status and class histograms (429_RATE_LIMIT_EXCEEDED,
 * 503_BOOT_ERROR, 546_WORKER_RESOURCE_LIMIT, html_<status>, client_*),
 * latency p50/p95/p99, x-sb-edge-region and cf-ray colo, first body per
 * non-200 class verbatim, non-200 per 10 s of send time.
 *
 * Not settled by this module: rates above what the Mac delivers, other
 * regions, verify_jwt true, other vantages, functions that call functions.
 *
 * DESTRUCTIVE: invokes the EB01 project's function about 189,000 times.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { runArm } from "../lib/arm.js";
import { NOOP_SLUG, errText, scrub, skipWithout } from "../lib/eb.js";

const mod: TestModule = {
  id: "EB02",
  title: "no-op function: open-loop steps and a burst against one function, ap-northeast-1",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 45 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "EB02", this.title);
    if (skip) return skip;
    try {
      return await runArm(ctx, "EB02", NOOP_SLUG, "eb-noop");
    } catch (e) {
      return [{ id: "EB02", title: this.title, status: "fail", detail: `threw: ${scrub(errText(e))}` }];
    }
  },
};
export default mod;
