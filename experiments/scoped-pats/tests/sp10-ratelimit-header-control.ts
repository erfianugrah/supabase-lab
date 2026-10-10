/**
 * SP10 - what `x-ratelimit-remaining` counts, measured with one token before
 * any scoped-vs-owner comparison (SP04d) leans on it. Read-only.
 *
 * SP04d reads the header from two tokens to ask whether they share a counter.
 * The docs scope the limit "per user, per project or organization, per
 * endpoint", so that reading is only meaningful on one route; this control
 * checks the header against that wording with the same token:
 *
 *   SP10a  the same route four times: does `remaining` fall by one per call,
 *          and what are `limit` and `reset`.
 *   SP10b  two different routes alternated four times: one shared counter
 *          falls across both; per-route counters each fall by one per own call.
 *
 * Other callers on the same user make a shared counter fall faster than the
 * call count, so a drop larger than the number of own calls is read as
 * "shared with other traffic", and a sequence that stays flat or resets is
 * read as per-route. The module records the sequences; it does not decide.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { call, type Resp } from "../lib/http.js";

const h = (r: Resp, k: string) => r.headers.get(k) ?? "absent";

const mod: TestModule = {
  id: "SP10",
  title: "x-ratelimit-remaining semantics for one token (control for SP04d)",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const pat = ctx.pat ?? "";
    const same: Resp[] = [];
    for (let i = 0; i < 4; i++) same.push(await call(pat, "GET", "/organizations"));
    const alt: Resp[] = [];
    for (let i = 0; i < 4; i++) alt.push(await call(pat, "GET", i % 2 === 0 ? "/organizations" : "/projects"));
    const seq = (rs: Resp[], k: string) => rs.map((r) => h(r, k)).join(",");
    return [
      {
        id: "SP10a",
        title: "SP10a: one route four times, remaining and reset",
        status: same.every((r) => r.status === 200) ? "info" : "skip",
        detail: same.every((r) => r.status === 200) ? undefined : "a call did not return 200",
        measurements: {
          limit: h(same[0]!, "x-ratelimit-limit"),
          remaining_seq: seq(same, "x-ratelimit-remaining"),
          reset_seq: seq(same, "x-ratelimit-reset"),
        },
      },
      {
        id: "SP10b",
        title: "SP10b: /organizations and /projects alternated, remaining and reset",
        status: alt.every((r) => r.status === 200) ? "info" : "skip",
        measurements: {
          remaining_seq: seq(alt, "x-ratelimit-remaining"),
          reset_seq: seq(alt, "x-ratelimit-reset"),
        },
      },
    ];
  },
};
export default mod;
