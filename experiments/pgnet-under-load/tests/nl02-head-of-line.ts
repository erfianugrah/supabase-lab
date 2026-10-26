/**
 * NL02 - head-of-line blocking in pg_net's batch loop.
 *
 * Source read (pg_net 0.20.4, not measured until here): the background worker
 * takes up to pg_net.batch_size rows from net.http_request_queue, runs them
 * in one curl multi loop, and takes the next batch only when every request
 * of the current one has finished. Predictions:
 *   - one slow call in batch 1 delays every call of batch 2 by about the slow
 *     call's duration, with no timeouts (the timeout clock starts at send);
 *   - one call to a receiver that never answers in time, with
 *     timeout_milliseconds 30000, delays batch 2 by about 30 s, and batch 2's
 *     calls (default 5 s timeout) still do not time out.
 *
 * Three parts on the NL01 Micro, each one transaction enqueuing 400 calls in
 * id order, run after the queue is empty:
 *   control  400 calls to /echo;
 *   slow     call 1 to /sleep?ms=4500 (default timeout), 399 to /echo;
 *   hang     call 1 to /sleep?ms=60000 with timeout 30000, 399 to /echo.
 * The receiver records each arrival; delay = arrival - enqueue time carried in
 * the body (database clock vs Cloudflare clock, offset not separated).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, fmt, ledger, scrub, skipWithout, sleep, sqlOk, summary, waitResponses } from "../lib/nl.js";

const N = 400;

interface Part {
  name: string;
  firstUrl: string;
  firstTmo: string;
}

const mod: TestModule = {
  id: "NL02",
  title: "pg_net head-of-line blocking between batches",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "NL02", this.title);
    if (skip) return skip;
    const results: TestResult[] = [];
    try {
      const p = await ensureProject(ctx, "micro");
      const recv = ctx.endpoints.receiver ?? "";
      const bs = await sqlOk(ctx, p.ref, "select coalesce(current_setting('pg_net.batch_size', true), 'unset') as b");
      const parts: Part[] = [
        { name: "control", firstUrl: `${recv}/echo`, firstTmo: "null" },
        { name: "slow", firstUrl: `${recv}/sleep?ms=4500`, firstTmo: "null" },
        { name: "hang", firstUrl: `${recv}/sleep?ms=60000`, firstTmo: "30000" },
      ];
      for (const part of parts) {
        // Start from an empty queue so batch boundaries belong to this part.
        for (let i = 0; i < 60; i++) {
          const q = await sqlOk(ctx, p.ref, "select count(*)::int as n from net.http_request_queue");
          if (Number(q[0]?.n) === 0) break;
          await sleep(3_000);
        }
        const run = `nl02-${part.name}-${Date.now()}`;
        await sqlOk(ctx, p.ref, `select count(public.nl_post('${run}', case when g = 1 then 'first' else 'fast' end, case when g = 1 then '${part.name}' else 'echo' end,
            case when g = 1 then '${part.firstUrl}' else '${recv}/echo' end, case when g = 1 then ${part.firstTmo}::int else null end)) as n
          from generate_series(1, ${N}) g`);
        const rows = await waitResponses(ctx, p.ref, run, 180_000);
        await sleep(2_000);
        const led = await ledger(ctx, run);
        const byId = new Map(led.map((l) => [l.id, l]));
        const ids = rows.map((r) => Number(r.id));
        const first = rows[0] ?? {};
        const g1 = rows.slice(1, 200);
        const g2 = rows.slice(200);
        const delay = (rs: typeof rows) => rs.map((r) => byId.get(Number(r.id))).filter((l) => l && l.enq_ms !== null).map((l) => (l?.arr_ms ?? 0) - (l?.enq_ms ?? 0));
        const d1 = summary(delay(g1));
        const d2 = summary(delay(g2));
        const arr1 = g1.map((r) => byId.get(Number(r.id))?.arr_ms ?? NaN).filter(Number.isFinite);
        const arr2 = g2.map((r) => byId.get(Number(r.id))?.arr_ms ?? NaN).filter(Number.isFinite);
        // Lag: first arrival of calls 201-400 after the last arrival of calls 2-200.
        const lag = arr1.length && arr2.length ? Math.min(...arr2) - Math.max(...arr1) : -1;
        const to1 = g1.filter((r) => r.timed_out).length;
        const to2 = g2.filter((r) => r.timed_out).length;
        const noResp = rows.filter((r) => !r.has_resp).length;
        const firstLed = byId.get(Number(first.id));
        const firstOut = first.timed_out ? "timed_out" : first.status_code ? String(first.status_code) : `error ${String(first.error_msg ?? "none")}`;
        // How many calls 201-400 arrived before the first call's response was stored (would mean no batch barrier).
        const firstResp = Number(first.resp_ms ?? 0);
        const g2BeforeFirstDone = firstResp ? arr2.filter((a) => a < firstResp).length : -1;
        results.push({
          id: `NL02${part.name === "control" ? "a" : part.name === "slow" ? "b" : "c"}`,
          title: `${part.name}: call 1 ${part.name === "control" ? "fast" : part.name === "slow" ? "4.5 s receiver" : "60 s receiver, timeout 30000"}, calls 2-400 fast`,
          status: "info",
          detail: `batch_size ${bs[0]?.b}; ${rows.length} calls (ids ${ids[0]}..${ids[ids.length - 1]}), ${noResp} without a response row, ${led.length} arrivals at the receiver. Call 1 -> ${firstOut}${first.error_msg ? ` (${scrub(ctx, String(first.error_msg)).slice(0, 220)})` : ""}, arrived ${firstLed ? firstLed.arr_ms - (firstLed.enq_ms ?? 0) : "never"} ms after enqueue, response row created ${firstResp ? firstResp - Number(first.enq_ms) : -1} ms after enqueue. Calls 2-200 delay ${fmt(d1)}, timed_out ${to1}. Calls 201-400 delay ${fmt(d2)}, timed_out ${to2}; first of them arrived ${lag} ms after the last of 2-200; ${g2BeforeFirstDone} of them arrived before call 1.s response row created time.`,
          measurements: {
            run,
            calls: rows.length,
            no_response: noResp,
            first_outcome: firstOut,
            first_resp_after_enq_ms: firstResp ? firstResp - Number(first.enq_ms) : -1,
            g1_delay_p50_ms: d1.p50, g1_delay_max_ms: d1.max, g1_timed_out: to1,
            g2_delay_min_ms: d2.min, g2_delay_p50_ms: d2.p50, g2_delay_max_ms: d2.max, g2_timed_out: to2,
            g2_lag_after_g1_ms: lag,
            g2_arrived_before_first_done: g2BeforeFirstDone,
            receiver_arrivals: led.length,
          },
        });
      }
    } catch (e) {
      results.push({ id: "NL02err", title: "NL02 aborted", status: "fail", detail: scrub(ctx, errText(e)) });
    }
    return results;
  },
};
export default mod;
