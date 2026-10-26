/**
 * NL04 - delivery counts for three ways of sending 1,000 messages out of
 * Postgres to an unreliable receiver.
 *
 * The receiver's /flaky answers 20% of requests 503, holds 10% for 8 s before
 * a 200, and answers the rest 200 at once; it records every arrival (with the
 * message id) before answering, so a held request whose caller timed out is
 * still a processed message. Every call uses timeout_milliseconds 5000, so a
 * held request is a pg_net timeout on the sender side.
 *
 *   raw    1,000 net.http_post, nothing else;
 *   retry  the same, plus a pg_cron job every 5 s that re-enqueues every
 *          message whose latest call has a 5xx, a timeout or an error
 *          (at most 10 calls per message);
 *   pgmq   Supabase Queues: 1,000 messages in a pgmq queue, a pg_cron
 *          consumer every 5 s that acknowledges (pgmq.delete) messages whose
 *          call got a 2xx and reads up to 200 more with vt 30 s (>= the 5 s
 *          timeout) and posts them; an unacknowledged message comes back
 *          after its vt.
 * Each mechanism runs until the sender sees all 1,000 confirmed or
 * PVLAB_NL_MECH_S (default 180) passes. Counted from the receiver ledger:
 * delivered (processed at least once), duplicates, lost. Two arms: database
 * idle, and CPU saturated as in NL03. Runs on the NL03 Large.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, ledger, scrub, skipWithout, sleep, sqlOk, startBurn, cpuScrape, busyFrac } from "../lib/nl.js";

const MSGS = 1000;
const MECH_S = Number(process.env.PVLAB_NL_MECH_S || 180);

const SETUP_SQL = `
create extension if not exists pg_cron;
create extension if not exists pgmq;
create table if not exists public.nl_inflight (run text not null, q_msg_id bigint not null, call_id bigint not null, state text not null, read_ct int);
alter table public.nl_inflight enable row level security;
create or replace function public.nl_retry_tick(p_run text, p_url text) returns int language sql as $r$
  with latest as (
    select distinct on (c.msg) c.msg, c.req_id from public.nl_calls c where c.run = p_run order by c.msg, c.id desc),
  bad as (
    select l.msg from latest l join net._http_response r on r.id = l.req_id
    where r.timed_out or r.status_code is null or r.status_code < 200 or r.status_code >= 300)
  select count(public.nl_post(p_run, 'retry', 'flaky', p_url, 5000, b.msg))::int from bad b
  where (select count(*) from public.nl_calls c2 where c2.run = p_run and c2.msg = b.msg) < 10 $r$;
create or replace function public.nl_pgmq_tick(p_run text, p_q text, p_url text) returns int language plpgsql as $t$
declare r record; m record; n int := 0;
begin
  for r in select i.q_msg_id, i.call_id, resp.status_code, resp.timed_out from public.nl_inflight i
      join public.nl_calls c on c.id = i.call_id join net._http_response resp on resp.id = c.req_id
      where i.run = p_run and i.state = 'inflight' loop
    if r.status_code between 200 and 299 and not coalesce(r.timed_out, false) then
      perform pgmq.delete(p_q, r.q_msg_id);
      update public.nl_inflight set state = 'acked' where call_id = r.call_id;
    else
      update public.nl_inflight set state = 'failed' where call_id = r.call_id;
    end if;
  end loop;
  for m in select * from pgmq.read(p_q, 30, 200) loop
    insert into public.nl_inflight (run, q_msg_id, call_id, state, read_ct)
      values (p_run, m.msg_id, public.nl_post(p_run, 'pgmq', 'flaky', p_url, 5000, (m.message ->> 'msg')::int), 'inflight', m.read_ct);
    n := n + 1;
  end loop;
  return n;
end $t$;
`;

interface Tally {
  delivered: number;
  dupMsgs: number;
  extra: number;
  lost: number;
  arrivals: number;
  fivexx: number;
  hangs: number;
}

function tally(led: { msg: number | null; outcome: string }[]): Tally {
  const per = new Map<number, number>();
  let fivexx = 0;
  let hangs = 0;
  for (const l of led) {
    if (l.msg === null) continue;
    if (l.outcome === "5xx") { fivexx++; continue; }
    if (l.outcome === "hang") hangs++;
    per.set(l.msg, (per.get(l.msg) ?? 0) + 1);
  }
  let dupMsgs = 0;
  let extra = 0;
  for (const c of per.values()) if (c > 1) { dupMsgs++; extra += c - 1; }
  return { delivered: per.size, dupMsgs, extra, lost: MSGS - per.size, arrivals: led.length, fivexx, hangs };
}

const mod: TestModule = {
  id: "NL04",
  title: "delivery of 1,000 messages: raw pg_net, pg_net + retry, pgmq + consumer",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "NL04", this.title);
    if (skip) return skip;
    const results: TestResult[] = [];
    try {
      const p = await ensureProject(ctx, "large");
      const url = `${ctx.endpoints.receiver}/flaky`;
      await sqlOk(ctx, p.ref, SETUP_SQL);
      const ver = await sqlOk(ctx, p.ref, "select extversion from pg_extension where extname = 'pgmq'");
      const c0 = await cpuScrape(p);
      const nBurn = Math.max(4, (c0.cpus > 0 ? c0.cpus : 2) * 2);
      for (const arm of ["idle", "saturated"] as const) {
        const burn = arm === "saturated" ? await startBurn(ctx, p, nBurn, MECH_S * 3 + 400) : null;
        if (burn) await sleep(20_000);
        const cpuA = await cpuScrape(p);
        for (const mech of ["raw", "retry", "pgmq"] as const) {
          const run = `nl04-${arm}-${mech}-${Date.now()}`;
          const q = `nl_q_${arm}`;
          const t0 = Date.now();
          if (mech === "pgmq") {
            await sqlOk(ctx, p.ref, `select pgmq.create('${q}'); select pgmq.send_batch('${q}', array(select jsonb_build_object('msg', g) from generate_series(1, ${MSGS}) g));
              select cron.schedule('nl-consume', '5 seconds', $c$select public.nl_pgmq_tick('${run}', '${q}', '${url}')$c$);`);
          } else {
            await sqlOk(ctx, p.ref, `select count(public.nl_post('${run}', '${mech}', 'flaky', '${url}', 5000, g)) from generate_series(1, ${MSGS}) g`);
            if (mech === "retry") await sqlOk(ctx, p.ref, `select cron.schedule('nl-retry', '5 seconds', $c$select public.nl_retry_tick('${run}', '${url}')$c$)`);
          }
          // Sender-side view, polled until all confirmed or the deadline.
          const senderSql = mech === "pgmq"
            ? `select (select count(distinct c.msg) from public.nl_inflight i join public.nl_calls c on c.id = i.call_id where i.run = '${run}' and i.state = 'acked')::int as confirmed,
                 (select queue_length from pgmq.metrics('${q}'))::int as left_in_queue, (select count(*) from public.nl_calls where run = '${run}')::int as calls,
                 (select count(*) from net.http_request_queue)::int as pg_net_queue`
            : `select count(*) filter (where ok)::int as confirmed, -1 as left_in_queue, (select count(*) from public.nl_calls where run = '${run}')::int as calls,
                 (select count(*) from net.http_request_queue)::int as pg_net_queue
               from (select distinct on (c.msg) c.msg, (r.status_code between 200 and 299 and not r.timed_out) as ok
                     from public.nl_calls c left join net._http_response r on r.id = c.req_id where c.run = '${run}' order by c.msg, c.id desc) x`;
          let s: Record<string, unknown> = {};
          let doneS = -1;
          const limit = mech === "raw" ? 90 : MECH_S;
          while (Date.now() - t0 < limit * 1000) {
            await sleep(10_000);
            s = (await sqlOk(ctx, p.ref, senderSql))[0] ?? {};
            const pending = await sqlOk(ctx, p.ref, `select count(*)::int as n from public.nl_calls c left join net._http_response r on r.id = c.req_id where c.run = '${run}' and r.id is null`);
            if (Number(s.confirmed) >= MSGS && Number(pending[0]?.n) === 0) { doneS = Math.round((Date.now() - t0) / 1000); break; }
            if (mech === "raw" && Number(pending[0]?.n) === 0 && Number(s.calls) >= MSGS) break;
          }
          if (mech === "retry") await sqlOk(ctx, p.ref, "select cron.unschedule('nl-retry')");
          if (mech === "pgmq") await sqlOk(ctx, p.ref, "select cron.unschedule('nl-consume')");
          await sleep(15_000);
          s = (await sqlOk(ctx, p.ref, senderSql))[0] ?? {};
          const led = await ledger(ctx, run);
          const t = tally(led);
          const timeouts = await sqlOk(ctx, p.ref, `select count(*) filter (where r.timed_out)::int as to, count(*) filter (where r.status_code >= 500)::int as s5, count(*) filter (where r.id is null)::int as nr
            from public.nl_calls c left join net._http_response r on r.id = c.req_id where c.run = '${run}'`);
          const tt = timeouts[0] ?? {};
          results.push({
            id: `NL04-${arm}-${mech}`,
            title: `${arm}: ${mech}`,
            status: "info",
            detail: `${MSGS} messages; receiver: delivered ${t.delivered}, lost ${t.lost}, messages processed more than once ${t.dupMsgs} (${t.extra} extra deliveries), arrivals ${t.arrivals} (503 ${t.fivexx}, held 8 s ${t.hangs}). Sender: ${s.calls} calls, ${s.confirmed} messages confirmed${mech === "pgmq" ? `, ${s.left_in_queue} left in the queue` : ""}, ${tt.to} timed_out, ${tt.s5} 5xx, ${tt.nr} without a response row; ${doneS >= 0 ? `all confirmed after ${doneS} s` : `not all confirmed within ${limit} s`}.`,
            measurements: {
              delivered: t.delivered, lost: t.lost, dup_msgs: t.dupMsgs, extra_deliveries: t.extra, arrivals: t.arrivals,
              rx_503: t.fivexx, rx_held: t.hangs, calls: Number(s.calls ?? -1), sender_confirmed: Number(s.confirmed ?? -1),
              left_in_queue: Number(s.left_in_queue ?? -1), timed_out: Number(tt.to ?? -1), done_s: doneS,
            },
          });
        }
        const cpuB = await cpuScrape(p);
        const out = burn ? await burn.stop() : null;
        results.push({
          id: `NL04-${arm}-cpu`,
          title: `${arm}: CPU busy over the three mechanisms`,
          status: "info",
          detail: `node CPU busy ${busyFrac(cpuA, cpuB)}${out ? `; burners started ${out.started}${out.errors.length ? `, errors ${out.errors.slice(0, 2).join(" | ")}` : ""}` : ""}; pgmq ${ver[0]?.extversion}`,
          measurements: { cpu_busy: busyFrac(cpuA, cpuB), pgmq_version: String(ver[0]?.extversion ?? "") },
        });
      }
    } catch (e) {
      results.push({ id: "NL04err", title: "NL04 aborted", status: "fail", detail: scrub(ctx, errText(e)) });
    }
    return results;
  },
};
export default mod;
