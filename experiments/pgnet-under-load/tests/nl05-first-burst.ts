/**
 * NL05 - the first burst from a fresh project.
 *
 * NL04 runs 1 and 2 both showed, in their first mechanism only (idle, raw
 * pg_net, the first calls the project ever sent to the receiver), more
 * sender timeouts than held requests: 240 vs 81 and 277 vs 97, with 35 calls
 * never arriving in run 1. Later 200-call batches to the same receiver did
 * not. Two readings: the receiver is slow on a first burst (its Durable
 * Object, a cold Worker), or pg_net's first batch of 200 concurrent new
 * connections from a fresh worker is slow. A burst of 200 from the lab Mac to
 * a fresh ledger answered within 1.42 s (RUNLOG), which leans against the
 * first; this module repeats the shape from the database.
 *
 * One fresh Pro-org Large. Bursts of 200 calls to /echo (default 5000 ms
 * timeout), each enqueued in one transaction after the queue drained:
 * burst 1 is the first outbound call of the project, bursts 2 and 3 follow
 * at once, burst 4 after 120 s idle. Per burst: timed_out, calls that never
 * arrived, arrival delay, distinct error_msg shapes.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, fmt, ledger, scrub, skipWithout, sleep, sqlOk, summary, waitResponses } from "../lib/nl.js";

const mod: TestModule = {
  id: "NL05",
  title: "first burst of 200 pg_net calls from a fresh project vs later bursts",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "NL05", this.title);
    if (skip) return skip;
    const results: TestResult[] = [];
    try {
      const p = await ensureProject(ctx, "large");
      const recv = ctx.endpoints.receiver ?? "";
      for (let b = 1; b <= 4; b++) {
        if (b === 4) await sleep(120_000);
        for (let i = 0; i < 60; i++) {
          const q = await sqlOk(ctx, p.ref, "select count(*)::int as n from net.http_request_queue");
          if (Number(q[0]?.n) === 0) break;
          await sleep(3_000);
        }
        const run = `nl05-b${b}-${Date.now()}`;
        await sqlOk(ctx, p.ref, `select count(public.nl_post('${run}', 'b${b}', 'echo', '${recv}/echo', null)) from generate_series(1, 200)`);
        const rows = await waitResponses(ctx, p.ref, run, 120_000);
        await sleep(2_000);
        const led = await ledger(ctx, run);
        const byId = new Map(led.map((l) => [l.id, l]));
        const to = rows.filter((r) => r.timed_out === true);
        const ok = rows.filter((r) => Number(r.status_code) === 200);
        const never = rows.filter((r) => !byId.has(Number(r.id))).length;
        const toArrived = to.filter((r) => byId.has(Number(r.id))).length;
        const d = summary(led.filter((l) => l.enq_ms !== null).map((l) => l.arr_ms - (l.enq_ms ?? 0)));
        const shapes = [...new Set(to.map((r) => String(r.error_msg ?? "").replace(/[\d.]+ ms/g, "N ms")))];
        results.push({
          id: `NL05-b${b}`,
          title: `burst ${b}${b === 1 ? " (first outbound calls of the project)" : b === 4 ? " (after 120 s idle)" : ""}`,
          status: "info",
          detail: `200 calls: ${ok.length} 200, ${to.length} timed_out (${toArrived} of them arrived at the receiver), ${never} never arrived; arrival delay ${fmt(d)}; timeout shapes: ${scrub(ctx, shapes.join(" | ")).slice(0, 400)}; sample "${scrub(ctx, String(to[0]?.error_msg ?? "")).slice(0, 220)}"`,
          measurements: { run, ok: ok.length, timed_out: to.length, timed_out_arrived: toArrived, never_arrived: never, arrive_p50_ms: d.p50, arrive_max_ms: d.max },
        });
      }
    } catch (e) {
      results.push({ id: "NL05err", title: "NL05 aborted", status: "fail", detail: scrub(ctx, errText(e)) });
    }
    return results;
  },
};
export default mod;
