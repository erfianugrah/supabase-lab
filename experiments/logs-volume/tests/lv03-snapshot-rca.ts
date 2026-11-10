/**
 * LV03 - can a pg_cron job that snapshots pg_stat_statements and
 * pg_stat_activity name the query behind a slowdown, for a chosen time window,
 * without a log drain, and what does each snapshot cost?
 *
 * The question an operator asks in an incident is "which query made this
 * database slow in the last hour". Postgres-role slow-query logging misses
 * Data API traffic unless it is set on `authenticator` (LV02f), and the
 * Dashboard's Query Performance view is cumulative since the last reset. This
 * module tests the in-database alternative: a job every PVLAB_LV3_EVERY
 * (default '30 seconds') copies the counters into a table, so the difference
 * between two snapshots is the work done between them.
 *
 * One throwaway project in the org of role PVLAB_LV3_ORG_ROLE (team), default
 * size, ap-southeast-1. Workload over the Data API with the service_role key:
 *   baseline  BASE_S  s of point reads (rpc lv3_light) at about LIGHT_RPS/s
 *   incident  INC_S   s of the same plus HEAVY_CONC loops of rpc lv3_heavy,
 *                     a sequential scan over ROWS rows
 *   after     AFTER_S s of point reads only
 * Window boundaries are read from the database clock (`now()`).
 *
 *   LV03a  setup: pg_cron version, schedule accepted, pg_stat_statements rows
 *          readable by `postgres` (and how many show `<insufficient privilege>`)
 *   LV03b  top statements by execution time between the snapshots bracketing
 *          the baseline window, then the incident window; rank of lv3_heavy
 *   LV03c  pg_stat_activity samples that caught lv3_heavy in flight, per window
 *   LV03d  cost: job runs, failures, run duration, rows per snapshot, table
 *          size after the run
 *
 * Pass/fail: LV03b passes when lv3_heavy ranks first in the incident window
 * and is absent from the baseline top 5. Not settled: a busy production
 * pg_stat_statements (thousands of entries), statement eviction between
 * snapshots (pg_stat_statements.max), Postgres 17 column names, and the
 * snapshot job's effect on a database that is already saturated.
 *
 * DESTRUCTIVE and BILLABLE: creates and deletes one project; about 12-15 min.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
	dropProject,
	makeProject,
	sleep,
	sql,
} from "../../observability-surface/lib/ob";
import { PREFIX } from "../lib/lv";

const ORG_ROLE = (process.env.PVLAB_LV3_ORG_ROLE ?? "team") as "team" | "pro";
const EVERY = process.env.PVLAB_LV3_EVERY ?? "30 seconds";
const ROWS = Number(process.env.PVLAB_LV3_ROWS ?? 1_000_000);
const BASE_S = Number(process.env.PVLAB_LV3_BASE_S ?? 150);
const INC_S = Number(process.env.PVLAB_LV3_INC_S ?? 120);
const AFTER_S = Number(process.env.PVLAB_LV3_AFTER_S ?? 90);
const LIGHT_RPS = Number(process.env.PVLAB_LV3_LIGHT_RPS ?? 5);
const HEAVY_CONC = Number(process.env.PVLAB_LV3_HEAVY_CONC ?? 3);

const SETUP = `
create extension if not exists pg_cron;
create table public.lv3_items (id bigint primary key, payload text not null);
insert into public.lv3_items select g, md5(g::text) || md5((g * 7)::text) from generate_series(1, ${ROWS}) g;
analyze public.lv3_items;
create or replace function public.lv3_light(k bigint) returns text language sql stable as $$ select payload from public.lv3_items where id = k $$;
create or replace function public.lv3_heavy() returns bigint language sql stable as $$ select count(*) from public.lv3_items where payload like '%abc%' $$;
grant execute on function public.lv3_light(bigint), public.lv3_heavy() to service_role;
create schema rca;
create table rca.stmt_snap (ts timestamptz not null, userid oid, dbid oid, queryid bigint, calls bigint, total_exec_time double precision, rows bigint, shared_blks_read bigint);
create index on rca.stmt_snap (ts);
create table rca.stmt_text (queryid bigint primary key, query text);
create table rca.act_snap (ts timestamptz not null, pid int, usename name, state text, wait_event_type text, wait_event text, query_start timestamptz, query text);
create index on rca.act_snap (ts);
create or replace function rca.take() returns void language plpgsql as $f$
declare t timestamptz := now();
begin
  insert into rca.stmt_snap
    select t, userid, dbid, queryid, calls, total_exec_time, rows, shared_blks_read
    from extensions.pg_stat_statements where dbid = (select oid from pg_database where datname = current_database());
  insert into rca.stmt_text
    select queryid, left(query, 1000) from extensions.pg_stat_statements
    where dbid = (select oid from pg_database where datname = current_database()) on conflict (queryid) do nothing;
  insert into rca.act_snap
    select t, pid, usename, state, wait_event_type, wait_event, query_start, left(query, 1000)
    from pg_stat_activity where backend_type = 'client backend' and state <> 'idle' and pid <> pg_backend_pid();
  delete from rca.stmt_snap where ts < t - interval '3 hours';
  delete from rca.act_snap where ts < t - interval '3 hours';
end $f$;
notify pgrst, 'reload schema';`;

/** Top statements by execution time between the last snapshot at or before t0 and the last at or before t1. */
const topSql = (t0: string, t1: string) => `
with b as (select max(ts) t from rca.stmt_snap where ts <= '${t0}'),
     e as (select max(ts) t from rca.stmt_snap where ts <= '${t1}'),
     s0 as (select * from rca.stmt_snap where ts = (select t from b)),
     s1 as (select * from rca.stmt_snap where ts = (select t from e))
select s1.queryid::text as queryid, s1.calls - coalesce(s0.calls, 0) as dcalls,
       round((s1.total_exec_time - coalesce(s0.total_exec_time, 0))::numeric, 1) as dms,
       left(regexp_replace(coalesce(t.query, '?'), '\\s+', ' ', 'g'), 110) as q,
       (select t from b) as snap0, (select t from e) as snap1
from s1 left join s0 using (userid, dbid, queryid) left join rca.stmt_text t using (queryid)
order by dms desc nulls last limit 5`;

type Row = Record<string, unknown>;

async function q(pc: Ctx, s: string, timeoutMs = 60_000): Promise<Row[]> {
	const r = await sql(pc, s, timeoutMs);
	if (r.status >= 300)
		throw new Error(`sql HTTP ${r.status}: ${r.error.slice(0, 300)}`);
	return r.rows;
}

const dbNow = async (pc: Ctx) =>
	String((await q(pc, "select now()::text as t"))[0]?.t ?? "");

/** Call `f` every `gapMs` until `until`, counting HTTP statuses. */
async function loop(
	until: number,
	gapMs: number,
	f: () => Promise<Response>,
	h: Record<string, number>,
) {
	while (Date.now() < until) {
		const t = Date.now();
		const code = await f().then(
			(r) => (r.body?.cancel(), String(r.status)),
			() => "err",
		);
		h[code] = (h[code] ?? 0) + 1;
		const wait = gapMs - (Date.now() - t);
		if (wait > 0) await sleep(wait);
	}
}

const mod: TestModule = {
	id: "LV03",
	title:
		"pg_cron snapshots of pg_stat_statements and pg_stat_activity: naming the query behind a slowdown in a time window",
	where: "local",
	requires: ["pat"],
	destructive: true,
	async run(ctx: Ctx): Promise<TestResult[]> {
		const org = ctx.orgs[ORG_ROLE];
		if (!org)
			return [
				{
					id: "LV03",
					title: this.title,
					status: "skip",
					detail: `PVLAB_ORG_${ORG_ROLE.toUpperCase()} not set`,
				},
			];
		const out: TestResult[] = [];
		let ref = "";
		try {
			const proj = await makeProject(
				{ ...ctx, orgs: { ...ctx.orgs, pro: org } },
				"lv03",
				PREFIX,
			);
			ref = proj.ref;
			const pc = proj.ctx;
			await q(pc, SETUP, 300_000);
			const ver =
				(
					await q(
						pc,
						`select (select extversion from pg_extension where extname = 'pg_cron') as cron,
        (select extversion from pg_extension where extname = 'pg_stat_statements') as pss, current_setting('server_version') as pg,
        current_setting('pg_stat_statements.max', true) as pss_max, current_setting('pg_stat_statements.track', true) as pss_track`,
					)
				)[0] ?? {};
			const sched = await sql(
				pc,
				`select cron.schedule('lv3-snap', '${EVERY}', $c$select rca.take()$c$) as jobid`,
			);
			const jobid = String(sched.rows[0]?.jobid ?? "");
			const priv =
				(
					await q(
						pc,
						`select count(*)::int as n, count(*) filter (where query = '<insufficient privilege>')::int as hidden from extensions.pg_stat_statements`,
					)
				)[0] ?? {};
			out.push({
				id: "LV03a",
				title:
					"LV03a: setup, schedule and pg_stat_statements visibility for postgres",
				status: jobid ? "info" : "fail",
				detail: jobid
					? undefined
					: `cron.schedule HTTP ${sched.status}: ${sched.error.slice(0, 200)}`,
				measurements: {
					org_role: ORG_ROLE,
					healthy_ms: proj.healthyMs,
					server_version: String(ver.pg),
					pg_cron: String(ver.cron),
					pg_stat_statements: String(ver.pss),
					pss_max: String(ver.pss_max),
					pss_track: String(ver.pss_track),
					schedule: EVERY,
					jobid: jobid || "none",
					rows: ROWS,
					pss_rows_at_setup: Number(priv.n ?? -1),
					pss_rows_insufficient_privilege: Number(priv.hidden ?? -1),
				},
			});
			if (!jobid) return out;

			const url = `https://${pc.apiHost}/rest/v1/rpc`;
			const hdr = {
				apikey: pc.serviceKey!,
				authorization: `Bearer ${pc.serviceKey}`,
				"content-type": "application/json",
			};
			const light = () =>
				fetch(`${url}/lv3_light`, {
					method: "POST",
					headers: hdr,
					body: JSON.stringify({ k: 1 + Math.floor(Math.random() * ROWS) }),
				});
			const heavy = () =>
				fetch(`${url}/lv3_heavy`, { method: "POST", headers: hdr, body: "{}" });
			const hl: Record<string, number> = {};
			const hh: Record<string, number> = {};
			const heavyMs: number[] = [];

			await sleep(65_000); // at least two snapshots before the baseline starts
			const tBase = await dbNow(pc);
			const end = Date.now() + (BASE_S + INC_S + AFTER_S) * 1000;
			const lightLoop = loop(end, 1000 / LIGHT_RPS, light, hl);
			await sleep(BASE_S * 1000);
			const tInc = await dbNow(pc);
			const incEnd = Date.now() + INC_S * 1000;
			await Promise.all(
				Array.from({ length: HEAVY_CONC }, () =>
					loop(
						incEnd,
						0,
						async () => {
							const t = Date.now();
							const r = await heavy();
							heavyMs.push(Date.now() - t);
							return r;
						},
						hh,
					),
				),
			);
			const tAfter = await dbNow(pc);
			await lightLoop;
			const tEnd = await dbNow(pc);
			await sleep(40_000); // one more snapshot past the end

			const isHeavy = (r: Row) => /lv3_heavy/.test(String(r.q));
			const base = await q(pc, topSql(tBase, tInc));
			const inc = await q(pc, topSql(tInc, tAfter));
			const rank = inc.findIndex(isHeavy);
			const fmt = (rs: Row[]) =>
				rs
					.map((r, i) => `${i + 1}. ${r.dms} ms / ${r.dcalls} calls: ${r.q}`)
					.join(" | ");
			heavyMs.sort((a, b) => a - b);
			out.push({
				id: "LV03b",
				title:
					"LV03b: top statements by execution time per window, from snapshot differences",
				status: rank === 0 && !base.some(isHeavy) ? "pass" : "fail",
				measurements: {
					baseline_window_db: `${tBase} .. ${tInc}`,
					incident_window_db: `${tInc} .. ${tAfter}`,
					baseline_snapshots_used: `${base[0]?.snap0 ?? "-"} .. ${base[0]?.snap1 ?? "-"}`,
					incident_snapshots_used: `${inc[0]?.snap0 ?? "-"} .. ${inc[0]?.snap1 ?? "-"}`,
					baseline_top5: fmt(base),
					incident_top5: fmt(inc),
					heavy_rank_in_incident: rank < 0 ? "absent" : rank + 1,
					light_status: JSON.stringify(hl),
					heavy_status: JSON.stringify(hh),
					heavy_calls_client: heavyMs.length,
					heavy_client_ms_p50: heavyMs[Math.floor(heavyMs.length / 2)] ?? -1,
					heavy_client_ms_max: heavyMs.at(-1) ?? -1,
				},
			});

			const act =
				(
					await q(
						pc,
						`select
          count(*) filter (where ts > '${tBase}' and ts <= '${tInc}' and query ilike '%lv3_heavy%')::int as base_heavy,
          count(*) filter (where ts > '${tInc}' and ts <= '${tAfter}' and query ilike '%lv3_heavy%')::int as inc_heavy,
          count(distinct ts) filter (where ts > '${tInc}' and ts <= '${tAfter}')::int as inc_samples_with_rows,
          max(extract(epoch from (ts - query_start)) * 1000) filter (where query ilike '%lv3_heavy%')::int as heavy_max_age_ms,
          string_agg(distinct coalesce(usename::text, '?'), ',') filter (where query ilike '%lv3_heavy%') as heavy_users
        from rca.act_snap`,
					)
				)[0] ?? {};
			out.push({
				id: "LV03c",
				title:
					"LV03c: pg_stat_activity samples that caught lv3_heavy in flight",
				status: "info",
				measurements: {
					baseline_rows_with_heavy: Number(act.base_heavy ?? -1),
					incident_rows_with_heavy: Number(act.inc_heavy ?? -1),
					incident_snapshots_with_active_rows: Number(
						act.inc_samples_with_rows ?? -1,
					),
					heavy_query_age_at_sample_max_ms: Number(act.heavy_max_age_ms ?? -1),
					heavy_usename: String(act.heavy_users ?? "-"),
				},
			});

			const cost =
				(
					await q(
						pc,
						`select
          (select count(*)::int from cron.job_run_details where jobid = ${jobid}) as runs,
          (select count(*)::int from cron.job_run_details where jobid = ${jobid} and status <> 'succeeded') as not_ok,
          (select string_agg(distinct left(coalesce(return_message, ''), 120), ' | ') from cron.job_run_details where jobid = ${jobid} and status <> 'succeeded') as not_ok_msgs,
          (select round(avg(extract(epoch from end_time - start_time) * 1000)::numeric, 1) from cron.job_run_details where jobid = ${jobid} and status = 'succeeded') as run_ms_avg,
          (select round(max(extract(epoch from end_time - start_time) * 1000)::numeric, 1) from cron.job_run_details where jobid = ${jobid} and status = 'succeeded') as run_ms_max,
          (select count(distinct ts)::int from rca.stmt_snap) as snapshots,
          (select round(count(*)::numeric / greatest(count(distinct ts), 1), 1) from rca.stmt_snap) as stmt_rows_per_snapshot,
          (select count(*)::int from rca.stmt_text) as distinct_statements,
          (select count(*)::int from rca.act_snap) as act_rows,
          pg_total_relation_size('rca.stmt_snap')::bigint as stmt_snap_bytes,
          pg_total_relation_size('rca.stmt_text')::bigint as stmt_text_bytes,
          pg_total_relation_size('rca.act_snap')::bigint as act_snap_bytes,
          (select count(*)::int from extensions.pg_stat_statements) as pss_rows_at_end`,
					)
				)[0] ?? {};
			out.push({
				id: "LV03d",
				title: "LV03d: snapshot job cost over the run",
				status: Number(cost.not_ok ?? 1) === 0 ? "info" : "fail",
				measurements: {
					window_db: `${tBase} .. ${tEnd}`,
					...Object.fromEntries(
						Object.entries(cost).map(([k, v]) => [
							k,
							typeof v === "number" ? v : String(v ?? "-"),
						]),
					),
				},
			});
			await sql(pc, `select cron.unschedule('lv3-snap')`);
		} catch (e) {
			out.push({
				id: "LV03",
				title: "LV03",
				status: "fail",
				detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
			});
		} finally {
			await dropProject(ctx, ref);
		}
		return out;
	},
};
export default mod;
