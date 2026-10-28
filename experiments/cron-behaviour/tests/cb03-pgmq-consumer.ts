/**
 * CB03 - a pgmq queue drained by a pg_cron consumer, on Micro.
 *
 *   CB03a  storage: 10,000 messages (jsonb, about 120 bytes each) sent to two
 *          queues, then all read and archived (queue A) or deleted (queue D) in
 *          batches of 1,000. pg_total_relation_size of the queue and archive
 *          tables before, after the send and after the drain (no VACUUM run).
 *   CB03b  consumer run duration by batch size: a pg_cron job ('10 seconds',
 *          the schedule does not change what one run does) calling
 *          cb_consume(queue, n, mode) = pgmq.read(q, 30, n) then pgmq.archive
 *          or pgmq.delete of the ids read; n = 10, 100, 1000, archive and
 *          delete, 4 runs each. Per config: the function's own time
 *          (clock_timestamp inside it) and job_run_details end - start.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, pct, r1, schedule, scrub, skipWithout, sqlOk, unschedule, waitRuns } from "../lib/cb.js";

const SETUP = `
create extension if not exists pgmq;
create table if not exists public.cb_consume_log (
  id bigserial primary key, q text not null, n int not null, mode text not null,
  got int not null, ms numeric not null, at timestamptz not null default clock_timestamp());
alter table public.cb_consume_log enable row level security;
create or replace function public.cb_consume(p_q text, p_n int, p_mode text) returns int language plpgsql as $f$
declare t0 timestamptz := clock_timestamp(); ids bigint[];
begin
  select coalesce(array_agg(msg_id), '{}') into ids from pgmq.read(p_q, 30, p_n);
  if cardinality(ids) > 0 then
    if p_mode = 'archive' then perform pgmq.archive(p_q, ids); else perform pgmq.delete(p_q, ids); end if;
  end if;
  insert into public.cb_consume_log(q, n, mode, got, ms) values (p_q, p_n, p_mode, cardinality(ids), extract(epoch from clock_timestamp() - t0) * 1000);
  return cardinality(ids);
end $f$;
`;
const MSG = "jsonb_build_object('i', g, 'kind', 'order.created', 'body', repeat('x', 80))";
const send = (q: string, n: number) => `select count(*)::int as sent from pgmq.send_batch('${q}', array(select ${MSG} from generate_series(1, ${n}) g))`;
const sizes = (q: string) =>
  `select pg_total_relation_size('pgmq.q_${q}')::bigint as q_bytes, pg_total_relation_size('pgmq.a_${q}')::bigint as a_bytes,
     (select count(*)::int from pgmq.q_${q}) as q_rows, (select count(*)::int from pgmq.a_${q}) as a_rows`;

const mod: TestModule = {
  id: "CB03",
  title: "pgmq + pg_cron consumer: archive vs delete storage, run duration by batch size (Micro)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 40 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "CB03", this.title);
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      await sqlOk(ctx, p.ref, SETUP);
      const ver = await sqlOk(ctx, p.ref, "select extversion from pg_extension where extname = 'pgmq'");
      const msgBytes = await sqlOk(ctx, p.ref, `select pg_column_size(${MSG})::int as b from generate_series(1, 1) g`);

      // --- CB03a storage
      const m: Record<string, string | number> = { pgmq_version: String(ver[0]?.extversion), message_jsonb_bytes: Number(msgBytes[0]?.b ?? -1) };
      for (const [q, mode] of [["cb_sa", "archive"], ["cb_sd", "delete"]] as const) {
        await sqlOk(ctx, p.ref, `select pgmq.create('${q}')`);
        const s0 = (await sqlOk(ctx, p.ref, sizes(q)))[0] ?? {};
        await sqlOk(ctx, p.ref, send(q, 10_000));
        const s1 = (await sqlOk(ctx, p.ref, sizes(q)))[0] ?? {};
        const t0 = Date.now();
        const got = await sqlOk(ctx, p.ref, `select sum(public.cb_consume('${q}', 1000, '${mode}'))::int as got from generate_series(1, 10)`);
        const drainMs = Date.now() - t0;
        const s2 = (await sqlOk(ctx, p.ref, sizes(q)))[0] ?? {};
        const k = mode === "archive" ? "arch" : "del";
        m[`${k}_q_bytes_empty`] = Number(s0.q_bytes);
        m[`${k}_a_bytes_empty`] = Number(s0.a_bytes);
        m[`${k}_q_bytes_10k_queued`] = Number(s1.q_bytes);
        m[`${k}_drained`] = Number(got[0]?.got ?? -1);
        m[`${k}_drain_wall_ms`] = drainMs;
        m[`${k}_q_bytes_after_drain`] = Number(s2.q_bytes);
        m[`${k}_a_bytes_after_drain`] = Number(s2.a_bytes);
        m[`${k}_q_rows_after`] = Number(s2.q_rows);
        m[`${k}_a_rows_after`] = Number(s2.a_rows);
      }
      const aGrowth = Number(m.arch_a_bytes_after_drain) - Number(m.arch_a_bytes_empty);
      m.archive_growth_bytes_per_10k = aGrowth;
      out.push({
        id: "CB03a",
        title: "queue and archive table size per 10,000 messages, archive vs delete",
        status: "info",
        detail: `pgmq ${String(m.pgmq_version)}, message ${String(m.message_jsonb_bytes)} B jsonb; archive table grew ${aGrowth} B (${r1(aGrowth / 1024 / 1024)} MiB) for 10k archived, ${String(m.arch_a_rows_after)} rows; queue table ${String(m.arch_q_bytes_10k_queued)} B with 10k queued, ${String(m.arch_q_bytes_after_drain)} B after archiving (archive) / ${String(m.del_q_bytes_after_drain)} B after deleting (delete), archive table ${String(m.del_a_bytes_after_drain)} B in delete mode; no VACUUM run`,
        measurements: m,
      });

      // --- CB03b durations
      const mm: Record<string, string | number> = {};
      const lines: string[] = [];
      for (const [q, mode] of [["cb_ta", "archive"], ["cb_td", "delete"]] as const) {
        await sqlOk(ctx, p.ref, `select pgmq.create('${q}')`);
        await sqlOk(ctx, p.ref, send(q, 6_000));
        for (const n of [10, 100, 1000]) {
          const name = `cb03-${mode}-${n}`;
          const s = await schedule(ctx, p.ref, name, "10 seconds", `select public.cb_consume('${q}', ${n}, '${mode}')`);
          const rs = await waitRuns(ctx, p.ref, s.jobid, 4, 120_000);
          await unschedule(ctx, p.ref, name);
          const done = rs.filter((r) => r.status === "succeeded" && r.endMs > 0);
          const jrd = done.map((r) => r.endMs - r.startMs);
          const log = await sqlOk(ctx, p.ref, `select ms::float8 as ms, got from public.cb_consume_log where q = '${q}' and n = ${n} order by id`);
          const fn = log.map((r) => Number(r.ms));
          const got = log.map((r) => Number(r.got));
          const k = `${mode}_n${n}`;
          mm[`${k}_runs`] = done.length;
          mm[`${k}_got`] = got.join(",");
          mm[`${k}_fn_ms_p50`] = r1(pct(fn, 50));
          mm[`${k}_fn_ms_max`] = r1(fn.length ? Math.max(...fn) : -1);
          mm[`${k}_run_ms_p50`] = pct(jrd, 50);
          mm[`${k}_run_ms_max`] = jrd.length ? Math.max(...jrd) : -1;
          mm[`${k}_status`] = [...new Set(rs.map((r) => r.status))].join("+");
          lines.push(`${mode} n=${n}: ${done.length} runs, got ${got.join(",")}, fn p50 ${r1(pct(fn, 50))} ms, run p50 ${pct(jrd, 50)} ms (max ${mm[`${k}_run_ms_max`]})`);
        }
      }
      out.push({
        id: "CB03b",
        title: "pg_cron consumer run duration by batch size (read + archive/delete)",
        status: "info",
        detail: lines.join(" | "),
        measurements: mm,
      });
      for (const q of ["cb_sa", "cb_sd", "cb_ta", "cb_td"]) await sqlOk(ctx, p.ref, `select pgmq.drop_queue('${q}')`).catch(() => {});
    } catch (e) {
      out.push({ id: "CB03", title: this.title, status: "fail", detail: scrub(errText(e)) });
    }
    return out;
  },
};
export default mod;
