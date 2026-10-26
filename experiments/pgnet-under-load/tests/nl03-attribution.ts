/**
 * NL03 - where pg_net timeouts come from when the database is busy.
 *
 * Question: when pg_net calls time out under load, is it the pg_net side (the
 * worker starved of CPU), the receiver waiting on the same database, or a
 * function cold start? Three targets in the same window separate them:
 *   worker    the external Cloudflare Worker /echo (no Supabase in the path);
 *   ef_echo   a trivial Edge Function in the project;
 *   ef_query  an Edge Function running one query (rpc nl_work, a count over
 *             2M rows) against the same database through the Data API.
 * Reading key: worker times out under saturation -> pg_net side; only
 * ef_query -> the function waiting on the database; ef_echo with Boot events
 * -> cold start.
 *
 * One fresh Pro-org Large (dedicated CPU; shared with NL04). A pg_cron job
 * every 10 s enqueues 17 calls per target (about 100/min per target) with
 * timeout_milliseconds 5000, for PVLAB_NL_ARM_S (default 600) per arm:
 *   idle       nothing else running;
 *   saturated  2 x vCPU session-pooler backends spinning a PL/pgSQL loop,
 *              CPU confirmed from node_cpu_seconds_total on the project's
 *              metrics endpoint.
 * A second job every 1 s samples the pg_net worker's row in pg_stat_activity.
 * Function Boot events come from the logs endpoint (function_logs).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  busyFrac, cpuScrape, deployFunction, ensureProject, errText, fmt, functionEvents, ledger, phases, type Row, scrub,
  skipWithout, sleep, sqlOk, startBurn, summary, warmFunction,
} from "../lib/nl.js";

const ARM_S = Number(process.env.PVLAB_NL_ARM_S || 600);
const PER_TICK = 17;

const EF_ECHO = `Deno.serve(async (req) => {
  const arr = Date.now();
  let b = {};
  try { b = await req.json(); } catch { /* not JSON */ }
  return Response.json({ arr_ms: arr, id: b.id ?? null });
});`;

const EF_QUERY = `Deno.serve(async (req) => {
  const arr = Date.now();
  let b = {};
  try { b = await req.json(); } catch { /* not JSON */ }
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const t = Date.now();
  let qs = 0;
  try {
    const r = await fetch(Deno.env.get("SUPABASE_URL") + "/rest/v1/rpc/nl_work", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: "{}",
    });
    qs = r.status;
    await r.text();
  } catch { qs = -1; }
  return Response.json({ arr_ms: arr, id: b.id ?? null, q_ms: Date.now() - t, q_status: qs }, { status: qs === 200 ? 200 : 502 });
});`;

export const SETUP_SQL = `
create extension if not exists pg_cron;
create table if not exists public.nl_data (id bigint primary key, v int not null);
insert into public.nl_data select g, ((g::bigint * 7919) % 100000)::int from generate_series(1, 2000000) g on conflict do nothing;
analyze public.nl_data;
alter table public.nl_data enable row level security;
create or replace function public.nl_work() returns bigint language sql stable as $w$
  select count(*) from public.nl_data where (v * 13) % 97 = 3 $w$;
revoke execute on function public.nl_work() from public, anon, authenticated;
grant execute on function public.nl_work() to service_role;
create table if not exists public.nl_cfg (k text primary key, v text not null);
alter table public.nl_cfg enable row level security;
create table if not exists public.nl_waits (ts timestamptz not null default clock_timestamp(), arm text, backend_type text, state text,
  wait_event_type text, wait_event text, queue_len int);
alter table public.nl_waits enable row level security;
create or replace function public.nl_fire() returns int language plpgsql as $f$
declare
  run text := (select v from public.nl_cfg where k = 'run');
  arm text := (select v from public.nl_cfg where k = 'arm');
  w text := (select v from public.nl_cfg where k = 'worker_url');
  e1 text := (select v from public.nl_cfg where k = 'ef_echo_url');
  e2 text := (select v from public.nl_cfg where k = 'ef_query_url');
begin
  for i in 1..${PER_TICK} loop
    perform public.nl_post(run, arm, 'worker', w, 5000);
    perform public.nl_post(run, arm, 'ef_echo', e1, 5000);
    perform public.nl_post(run, arm, 'ef_query', e2, 5000);
  end loop;
  return ${PER_TICK} * 3;
end $f$;
create or replace function public.nl_wait_sample() returns void language sql as $s$
  insert into public.nl_waits (arm, backend_type, state, wait_event_type, wait_event, queue_len)
  select (select v from public.nl_cfg where k = 'arm'), a.backend_type, a.state, a.wait_event_type, a.wait_event,
    (select count(*) from net.http_request_queue)
  from pg_stat_activity a where a.backend_type ilike '%pg_net%' or a.backend_type ilike '%pg net%' $s$;
notify pgrst, 'reload schema';
`;

const TARGETS = ["worker", "ef_echo", "ef_query"] as const;

const mod: TestModule = {
  id: "NL03",
  title: "pg_net timeouts under DB CPU saturation: worker side, receiver side or cold start",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "NL03", this.title);
    if (skip) return skip;
    const results: TestResult[] = [];
    try {
      const p = await ensureProject(ctx, "large");
      const recv = ctx.endpoints.receiver ?? "";
      await sqlOk(ctx, p.ref, SETUP_SQL, 300_000);
      const idEcho = await deployFunction(ctx, p.ref, "nl-echo", EF_ECHO);
      const idQuery = await deployFunction(ctx, p.ref, "nl-query", EF_QUERY);
      const efEcho = `https://${p.host}/functions/v1/nl-echo`;
      const efQuery = `https://${p.host}/functions/v1/nl-query`;
      await warmFunction(efEcho);
      await warmFunction(efQuery);
      // nl_work cost on the idle database, timed inside Postgres.
      const wq = await sqlOk(ctx, p.ref, `explain (analyze, format json) select public.nl_work()`);
      const workMs = Number(/"Execution Time":\s*([\d.]+)/.exec(JSON.stringify(wq[0] ?? {}))?.[1] ?? -1);
      const ver = await sqlOk(ctx, p.ref, "select (select extversion from pg_extension where extname = 'pg_net') as net, (select extversion from pg_extension where extname = 'pg_cron') as cron");
      const c0 = await cpuScrape(p);
      const cpus = c0.cpus > 0 ? c0.cpus : 2;
      const nBurn = Math.max(4, cpus * 2);
      const run = `nl03-${Date.now()}`;
      await sqlOk(ctx, p.ref, `insert into public.nl_cfg values ('run', '${run}'), ('arm', 'setup'), ('worker_url', '${recv}/echo'),
        ('ef_echo_url', '${efEcho}'), ('ef_query_url', '${efQuery}') on conflict (k) do update set v = excluded.v;
        select cron.schedule('nl-wait', '1 seconds', $c$select public.nl_wait_sample()$c$);`);
      results.push({
        id: "NL03a",
        title: "setup: Large, receivers warm, nl_work cost, CPU count",
        status: "info",
        detail: `${p.pgVersion}; pg_net ${ver[0]?.net}, pg_cron ${ver[0]?.cron}; CPUs in node_cpu_seconds_total ${c0.cpus} (metrics HTTP ${c0.status}); burners per saturated arm ${nBurn}; nl_work() on the idle database ${workMs} ms (EXPLAIN ANALYZE); arm length ${ARM_S} s; ${PER_TICK} calls per target every 10 s, timeout_milliseconds 5000`,
        measurements: { cpus: c0.cpus, burners: nBurn, nl_work_idle_ms: workMs, arm_s: ARM_S, create_s: p.createS },
      });

      const windows: Record<string, [number, number]> = {};
      for (const arm of ["idle", "saturated"] as const) {
        await sqlOk(ctx, p.ref, `update public.nl_cfg set v = '${arm}' where k = 'arm'`);
        let burn: Awaited<ReturnType<typeof startBurn>> | null = null;
        if (arm === "saturated") {
          burn = await startBurn(ctx, p, nBurn, ARM_S + 120);
          await sleep(20_000);
        }
        const cpuA = await cpuScrape(p);
        const t0 = Date.now();
        await sqlOk(ctx, p.ref, `select cron.schedule('nl-fire', '10 seconds', $c$select public.nl_fire()$c$)`);
        const cpuSamples: number[] = [];
        let prev = cpuA;
        let burners = -1;
        while (Date.now() - t0 < ARM_S * 1000) {
          await sleep(60_000);
          const c = await cpuScrape(p);
          const f = busyFrac(prev, c);
          if (f >= 0) { cpuSamples.push(f); prev = c; }
          if (burners < 0) {
            const b = await sqlOk(ctx, p.ref, "select count(*)::int as n from pg_stat_activity where query like '/* nl-burn */%' and state = 'active'").catch(() => []);
            burners = Number(b[0]?.n ?? -1);
          }
        }
        await sqlOk(ctx, p.ref, "select cron.unschedule('nl-fire')");
        const t1 = Date.now();
        const cpuB = await cpuScrape(p);
        windows[arm] = [t0, t1];
        // Drain: let the last calls finish before the burners stop, so the tail is measured under the same load.
        await sleep(30_000);
        const burnOut = burn ? await burn.stop() : { started: 0, errors: [] as string[] };

        const rows = await sqlOk(ctx, p.ref, `select c.id, c.target, c.enq_ms, r.id is not null as has_resp, r.status_code, r.timed_out, r.error_msg,
            (public.nl_json(r.content) ->> 'arr_ms')::bigint as arr_ms_body, (public.nl_json(r.content) ->> 'q_ms')::int as q_ms,
            (extract(epoch from r.created) * 1000)::bigint as resp_ms
          from public.nl_calls c left join net._http_response r on r.id = c.req_id where c.run = '${run}' and c.tag = '${arm}'`, 300_000);
        const led = await ledger(ctx, run);
        const ledById = new Map(led.map((l) => [l.id, l]));
        const cron = await sqlOk(ctx, p.ref, `select status, count(*)::int as n, round(avg(extract(epoch from end_time - start_time)) * 1000)::int as avg_ms,
            round(max(extract(epoch from end_time - start_time)) * 1000)::int as max_ms
          from cron.job_run_details where command like '%nl_fire%' and start_time >= to_timestamp(${t0 / 1000}) and start_time < to_timestamp(${t1 / 1000}) group by status`);
        const waits = await sqlOk(ctx, p.ref, `select coalesce(state, '-') as state, coalesce(wait_event_type, '-') || '/' || coalesce(wait_event, '-') as ev, count(*)::int as n, max(queue_len) as max_q
          from public.nl_waits where arm = '${arm}' group by 1, 2 order by 3 desc`);
        const cpuOverall = busyFrac(cpuA, cpuB);

        const per: Record<string, number | string> = {};
        const lines: string[] = [];
        for (const t of TARGETS) {
          const rs = rows.filter((r) => r.target === t);
          const ok = rs.filter((r) => r.status_code !== null && Number(r.status_code) >= 200 && Number(r.status_code) < 300);
          const to = rs.filter((r) => r.timed_out === true);
          const other = rs.filter((r) => r.has_resp && !r.timed_out && !(Number(r.status_code) >= 200 && Number(r.status_code) < 300));
          const noResp = rs.filter((r) => !r.has_resp);
          // Arrival delay: Worker from its ledger (covers timed-out calls too); functions from the body they returned.
          const arrDelay = t === "worker"
            ? rs.map((r) => ledById.get(Number(r.id))).filter((l) => l && l.enq_ms !== null).map((l) => (l?.arr_ms ?? 0) - (l?.enq_ms ?? 0))
            : rs.filter((r) => r.arr_ms_body !== null).map((r) => Number(r.arr_ms_body) - Number(r.enq_ms));
          const stored = rs.filter((r) => r.resp_ms !== null).map((r) => Number(r.resp_ms) - Number(r.enq_ms));
          const q = rs.filter((r) => r.q_ms !== null).map((r) => Number(r.q_ms));
          const ph: Record<string, number[]> = {};
          for (const r of to) for (const [k, v] of Object.entries(phases(String(r.error_msg ?? "")))) (ph[k] ??= []).push(v);
          const phText = Object.entries(ph).map(([k, v]) => `${k} p50 ${summary(v).p50} max ${summary(v).max}`).join(", ");
          const sa = summary(arrDelay);
          const ss = summary(stored);
          per[`${t}_n`] = rs.length;
          per[`${t}_2xx`] = ok.length;
          per[`${t}_timed_out`] = to.length;
          per[`${t}_other_err`] = other.length;
          per[`${t}_no_resp`] = noResp.length;
          per[`${t}_arrive_p50_ms`] = sa.p50;
          per[`${t}_arrive_p95_ms`] = sa.p95;
          per[`${t}_arrive_max_ms`] = sa.max;
          per[`${t}_created_p50_ms`] = ss.p50;
          per[`${t}_created_p95_ms`] = ss.p95;
          if (t === "ef_query") { per.ef_query_q_p50_ms = summary(q).p50; per.ef_query_q_p95_ms = summary(q).p95; per.ef_query_q_max_ms = summary(q).max; }
          lines.push(`${t}: ${ok.length}/${rs.length} 2xx, ${to.length} timed_out, ${other.length} other (${[...new Set(other.map((r) => `${r.status_code ?? "null"} ${String(r.error_msg ?? "").slice(0, 60)}`))].slice(0, 3).join(" | ")}), ${noResp.length} no response; enqueue-to-arrival ${fmt(sa)}; enqueue-to-created (net._http_response.created) ${fmt(ss)}${t === "ef_query" ? `; query inside function ${fmt(summary(q))}` : ""}${to.length ? `; timeout phases ${phText}; sample "${scrub(ctx, String(to[0]?.error_msg ?? "")).slice(0, 200)}"` : ""}`);
        }
        results.push({
          id: `NL03${arm === "idle" ? "b" : "c"}`,
          title: `${arm} arm: ${ARM_S} s, three targets`,
          status: "info",
          detail: `CPU busy ${cpuOverall} over the arm (60 s samples ${cpuSamples.join(", ")}), burners active ${burners} (started ${burnOut.started}${burnOut.errors.length ? `, errors ${burnOut.errors.slice(0, 2).join(" | ")}` : ""}). nl-fire runs: ${cron.map((c) => `${c.status} ${c.n} (avg ${c.avg_ms} ms, max ${c.max_ms} ms)`).join(", ")}. ${lines.join(" || ")}. pg_net worker in pg_stat_activity (1 s samples): ${waits.map((w) => `${w.state} ${w.ev} x${w.n}`).join(", ")}; max queue ${Math.max(0, ...waits.map((w) => Number(w.max_q ?? 0)))}.`,
          measurements: {
            cpu_busy: cpuOverall,
            burners_active: burners,
            fire_runs: cron.reduce((a, c) => a + Number(c.n), 0),
            fire_max_ms: Math.max(-1, ...cron.map((c) => Number(c.max_ms ?? -1))),
            ...per,
          },
          evidence: scrub(ctx, JSON.stringify({ cron, waits, cpuSamples })).slice(0, 3000),
        });
      }
      await sqlOk(ctx, p.ref, "select cron.unschedule('nl-wait')");

      // Boot events land in function_logs with ingestion lag: read after both arms.
      await sleep(90_000);
      const boots: Record<string, number | string> = {};
      const bootLines: string[] = [];
      for (const [arm, [t0, t1]] of Object.entries(windows)) {
        for (const [name, fid] of [["ef_echo", idEcho], ["ef_query", idQuery]] as const) {
          const ev = await functionEvents(ctx, p.ref, fid, t0, t1 + 30_000);
          const get = (k: string) => Number((ev.rows as Row[]).find((r) => String(r.et).toLowerCase() === k)?.n ?? 0);
          boots[`${arm}_${name}_boot`] = get("boot");
          boots[`${arm}_${name}_shutdown`] = get("shutdown");
          bootLines.push(`${arm} ${name}: ${(ev.rows as Row[]).map((r) => `${r.et}=${r.n}`).join(" ") || "no rows"}${ev.error ? ` (logs error ${ev.error.slice(0, 80)})` : ""}`);
        }
      }
      results.push({
        id: "NL03d",
        title: "function_logs event types per arm (Boot = a new isolate)",
        status: "info",
        detail: bootLines.join("; "),
        measurements: boots,
      });
    } catch (e) {
      results.push({ id: "NL03err", title: "NL03 aborted", status: "fail", detail: scrub(ctx, errText(e)) });
    }
    return results;
  },
};
export default mod;
