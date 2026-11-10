/**
 * LV04 - the open points behind LV02's slow-query logging on `authenticator`
 * and LV03's snapshot recipe, on one throwaway project:
 *
 *   LV04a  setup: the role the Management API query endpoint runs as, versions
 *   LV04b  a Data API call cancelled by statement_timeout: does postgres_logs
 *          carry the statement text?
 *   LV04c  PostgREST's pool, idle: after a burst of concurrent calls, how long
 *          until the extra `authenticator` connections close
 *   LV04d  the pool under steady traffic: how old do `authenticator`
 *          connections get before they are replaced, and how long after
 *          `alter role authenticator set log_min_duration_statement` are Data
 *          API calls first logged
 *   LV04e  `reset` by name, then pg_terminate_backend on the `authenticator`
 *          connections as the endpoint's role: allowed? requests failed?
 *          does logging stop?
 *   LV04f  LV03's snapshot job with pg_stat_statements full (PSS_FILL distinct
 *          statements against pg_stat_statements.max): run time and bytes per
 *          snapshot
 *   LV04g  default-privileges revoke from anon and authenticated only (DD01c
 *          also revoked service_role): new table refused for anon, readable by
 *          service_role; a table created before keeps its grants
 *   LV04h  the edge_logs query grouping REST requests by host and
 *          load_balancer_redirect_identifier, run as written
 *   LV04i  the comment postgres_logs shows on a failing statement sent through
 *          the v1 query endpoint and through the dashboard's pg-meta route,
 *          both with a PAT
 *
 * Steady traffic (LV04d/e): rpc lv4_light at LIGHT_RPS/s plus rpc lv4_slow
 * (SLOW_MS) every SLOW_GAP_MS, service_role key. The threshold set on
 * `authenticator` is 200 ms, so only lv4_slow crosses it. LV04f runs during
 * LV04d's wait.
 *
 * Not settled: pool behaviour under production concurrency (more connections,
 * more churn), PostgREST versions other than the one this project runs, and
 * snapshot cost on a larger compute size.
 *
 * DESTRUCTIVE and BILLABLE: creates and deletes one project; up to about 55 min.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
	dropProject,
	logs,
	makeProject,
	sleep,
	sql,
} from "../../observability-surface/lib/ob";
import { PREFIX } from "../lib/lv";

const ORG_ROLE = (process.env.PVLAB_LV4_ORG_ROLE ?? "team") as "team" | "pro";
const STEADY_MAX_S = Number(process.env.PVLAB_LV4_STEADY_MAX_S ?? 2400);
const LIGHT_RPS = Number(process.env.PVLAB_LV4_LIGHT_RPS ?? 2);
const SLOW_GAP_MS = Number(process.env.PVLAB_LV4_SLOW_GAP_MS ?? 10_000);
const SLOW_MS = 300;
const PSS_FILL = Number(process.env.PVLAB_LV4_PSS_FILL ?? 6000);
const SNAP_RUNS = Number(process.env.PVLAB_LV4_SNAP_RUNS ?? 10);
const WIDE_COLS = 100;

const RCA = `
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
end $f$;`;

const SETUP = `
create extension if not exists pg_cron;
create table public.lv4_items (id bigint primary key, payload text not null);
insert into public.lv4_items select g, md5(g::text) from generate_series(1, 10000) g;
create table public.lv4_wide (${Array.from({ length: WIDE_COLS }, (_, i) => `c${i + 1} int`).join(", ")});
create or replace function public.lv4_light(k bigint) returns text language sql stable as $$ select payload from public.lv4_items where id = k $$;
create or replace function public.lv4_slow(ms int) returns int language sql volatile as $$ select pg_sleep(ms / 1000.0); select ms $$;
grant execute on function public.lv4_light(bigint), public.lv4_slow(int) to anon, authenticated, service_role;
${RCA}
notify pgrst, 'reload schema';`;

/** REST requests per host and per load-balancer target. */
const HOST_SQL = `select log_attributes['request.host'] as host,
  log_attributes['load_balancer_redirect_identifier'] as served_by,
  count(*) as requests
from logs
where source = 'edge_logs' and log_attributes['request.path'] like '/rest/v1/%'
group by host, served_by
order by requests desc
limit 50`;

const ACT = `select pid, backend_start::text as bs, extract(epoch from now() - backend_start)::int as age_s, state, left(query, 60) as q
from pg_stat_activity where usename = 'authenticator' and backend_type = 'client backend'`;

type Row = Record<string, unknown>;

async function q(pc: Ctx, s: string, timeoutMs = 60_000): Promise<Row[]> {
	const r = await sql(pc, s, timeoutMs);
	if (r.status >= 300)
		throw new Error(`sql HTTP ${r.status}: ${r.error.slice(0, 300)}`);
	return r.rows;
}

const ts = (ms: number) =>
	new Date(ms).toISOString().slice(0, 23).replace("T", " ");

/** Logs query that waits out the endpoint's throttle. */
async function logsPatient(pc: Ctx, s: string, hours = 2) {
	let r = await logs(pc, s, hours);
	for (let i = 0; i < 8 && /Too Many|Throttler/i.test(r.error); i++) {
		await sleep(20_000);
		r = await logs(pc, s, hours);
	}
	return r;
}

const isListener = (r: Row) => /^listen/i.test(String(r.q ?? ""));

/** Call `f` every `gapMs` until `stop()`, counting HTTP statuses. */
async function loop(
	stop: () => boolean,
	gapMs: number,
	f: () => Promise<Response>,
	h: Record<string, number>,
) {
	while (!stop()) {
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

const diff = (a: Record<string, number>, b: Record<string, number>) =>
	Object.fromEntries(
		Object.keys(a)
			.map((k) => [k, (a[k] ?? 0) - (b[k] ?? 0)] as const)
			.filter(([, v]) => v !== 0),
	);

/** Count postgres_logs duration rows for lv4_slow with event time in [t0, t1). */
async function slowLogged(pc: Ctx, t0: number, t1: number) {
	const r = await logsPatient(
		pc,
		`select count(*) as n from logs where source = 'postgres_logs'
     and concat(event_message, toString(log_attributes)) like '%duration%'
     and concat(event_message, toString(log_attributes)) like '%lv4_slow%'
     and timestamp >= toDateTime64('${ts(t0)}', 6) and timestamp < toDateTime64('${ts(t1)}', 6)`,
	);
	return r.error ? `error: ${r.error}` : Number(r.rows[0]?.n ?? 0);
}

/** LV04f: fill pg_stat_statements, then run the snapshot job SNAP_RUNS times. */
async function snapshotCost(pc: Ctx): Promise<Record<string, number | string>> {
	const stmts: string[] = [];
	for (let i = 1; i <= WIDE_COLS && stmts.length < PSS_FILL; i++)
		for (let j = 1; j <= WIDE_COLS && stmts.length < PSS_FILL; j++)
			stmts.push(`select c${i} + c${j} from public.lv4_wide limit 0;`);
	let fillErrors = 0;
	let firstError = "";
	for (let k = 0; k < stmts.length; k += 500) {
		const r = await sql(pc, stmts.slice(k, k + 500).join("\n"), 120_000);
		if (r.status >= 300) {
			fillErrors++;
			firstError ||= `HTTP ${r.status}: ${r.error.slice(0, 160)}`;
		}
	}
	const filled =
		(
			await q(
				pc,
				`select (select count(*)::int from extensions.pg_stat_statements) as pss_rows,
        (select count(*)::int from extensions.pg_stat_statements where query like '%lv4_wide%') as wide_rows,
        (select dealloc::int from extensions.pg_stat_statements_info) as dealloc,
        current_setting('pg_stat_statements.max') as pss_max`,
			)
		)[0] ?? {};
	const sched = await q(
		pc,
		`select cron.schedule('lv4-snap', '30 seconds', $c$select rca.take()$c$) as jobid`,
	);
	const jobid = String(sched[0]?.jobid ?? "");
	await sleep(SNAP_RUNS * 30_000 + 15_000);
	await sql(pc, `select cron.unschedule('lv4-snap')`);
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
      (select count(*)::int from rca.stmt_text) as stmt_text_rows,
      pg_total_relation_size('rca.stmt_snap')::bigint as stmt_snap_bytes,
      pg_total_relation_size('rca.stmt_text')::bigint as stmt_text_bytes,
      pg_total_relation_size('rca.act_snap')::bigint as act_snap_bytes,
      (select count(*)::int from extensions.pg_stat_statements) as pss_rows_at_end,
      (select dealloc::int from extensions.pg_stat_statements_info) as dealloc_at_end`,
			)
		)[0] ?? {};
	const snaps = Number(cost.snapshots ?? 0);
	return {
		fill_statements: stmts.length,
		fill_batch_errors: fillErrors,
		fill_first_error: firstError || "-",
		pss_max: String(filled.pss_max),
		pss_rows_after_fill: Number(filled.pss_rows ?? -1),
		pss_wide_rows_after_fill: Number(filled.wide_rows ?? -1),
		dealloc_after_fill: Number(filled.dealloc ?? -1),
		jobid: jobid || "none",
		...Object.fromEntries(
			Object.entries(cost).map(([k, v]) => [
				k,
				typeof v === "number" ? v : String(v ?? "-"),
			]),
		),
		stmt_snap_bytes_per_snapshot: snaps
			? Math.round(Number(cost.stmt_snap_bytes) / snaps)
			: -1,
	};
}

const mod: TestModule = {
	id: "LV04",
	title:
		"PostgREST pool lifetime, timeout logging, terminate-to-apply, full pg_stat_statements snapshots, anon-only revoke, host query",
	where: "local",
	requires: ["pat"],
	destructive: true,
	async run(ctx: Ctx): Promise<TestResult[]> {
		const org = ctx.orgs[ORG_ROLE];
		if (!org)
			return [
				{
					id: "LV04",
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
				"lv04",
				PREFIX,
			);
			ref = proj.ref;
			const pc = proj.ctx;
			const tStart = Date.now();
			await q(pc, SETUP, 300_000);
			const info =
				(
					await q(
						pc,
						`select current_user::text as endpoint_role, current_setting('server_version') as pg,
        (select extversion from pg_extension where extname = 'pg_cron') as cron,
        (select extversion from pg_extension where extname = 'pg_stat_statements') as pss,
        current_setting('pg_stat_statements.track', true) as pss_track,
        current_setting('log_min_error_statement') as lmes,
        (select coalesce(array_to_string(setconfig, ', '), '') from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'authenticator') as authenticator_cfg,
        pg_has_role(current_user, 'pg_signal_backend', 'member') as signal_backend`,
					)
				)[0] ?? {};
			const rest = await fetch(`https://${pc.apiHost}/rest/v1/`, {
				headers: { apikey: pc.anonKey ?? "" },
			});
			out.push({
				id: "LV04a",
				title: "LV04a: setup",
				status: "info",
				measurements: {
					org_role: ORG_ROLE,
					healthy_ms: proj.healthyMs,
					...Object.fromEntries(
						Object.entries(info).map(([k, v]) => [k, String(v)]),
					),
					postgrest_server_header: rest.headers.get("server") ?? "-",
				},
			});
			await rest.body?.cancel();

			const url = `https://${pc.apiHost}/rest/v1`;
			const svc = {
				apikey: pc.serviceKey ?? "",
				authorization: `Bearer ${pc.serviceKey}`,
				"content-type": "application/json",
			};
			const anonH = {
				apikey: pc.anonKey ?? "",
				authorization: `Bearer ${pc.anonKey}`,
				"content-type": "application/json",
			};
			const light = () =>
				fetch(`${url}/rpc/lv4_light`, {
					method: "POST",
					headers: svc,
					body: JSON.stringify({ k: 1 + Math.floor(Math.random() * 10000) }),
				});
			const slow = (ms: number, h: Record<string, string> = svc) =>
				fetch(`${url}/rpc/lv4_slow`, {
					method: "POST",
					headers: h,
					body: JSON.stringify({ ms }),
				});

			// LV04b fire: anon's statement_timeout is lower than 5 s.
			const tTimeout = Date.now();
			const tr = await slow(5000, anonH);
			const trBody = (await tr.text()).slice(0, 200);
			const tTimeoutMs = Date.now() - tTimeout;

			// LV04i fire: one failing statement per route.
			const v1Probe = await sql(pc, "select 1/0 as lv4_v1_probe");
			const plat = await fetch(
				`https://api.supabase.com/platform/pg-meta/${ref}/query`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${ctx.pat}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ query: "select 1/0 as lv4_platform_probe" }),
				},
			).catch((e: Error) => new Response(e.message, { status: 599 }));
			const platBody = (await plat.text()).slice(0, 200);

			// LV04c: burst opens connections, then watch them close while idle.
			const burstH: Record<string, number> = {};
			await Promise.all(
				Array.from({ length: 8 }, () =>
					slow(1500).then(
						(r) => {
							r.body?.cancel();
							burstH[r.status] = (burstH[r.status] ?? 0) + 1;
						},
						() => {
							burstH.err = (burstH.err ?? 0) + 1;
						},
					),
				),
			);
			const tBurst = Date.now();
			const idle: string[] = [];
			let peak = 0;
			let floor = Number.POSITIVE_INFINITY;
			let floorAt = -1;
			for (let i = 0; i < 30; i++) {
				const rows = await q(pc, ACT).catch(() => [] as Row[]);
				const n = rows.filter((r) => !isListener(r)).length;
				const t = Math.round((Date.now() - tBurst) / 1000);
				idle.push(`${t}s:${n}`);
				peak = Math.max(peak, n);
				if (n < floor) {
					floor = n;
					floorAt = t;
				}
				await sleep(5000);
			}
			const listeners = (await q(pc, ACT)).filter(isListener).length;
			out.push({
				id: "LV04c",
				title: "LV04c: authenticator pool connections after a burst, idle",
				status: "info",
				measurements: {
					burst_status: JSON.stringify(burstH),
					pool_peak_after_burst: peak,
					pool_floor: floor,
					first_reached_floor_s: floorAt,
					listener_connections: listeners,
					samples: idle.join(" "),
				},
			});

			// LV04g: revoke from anon and authenticated only, then a new table.
			await q(
				pc,
				`alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;
create table public.lv4_after (id int primary key);
insert into public.lv4_after values (1);
notify pgrst, 'reload schema';`,
			);
			await sleep(8000);
			const get = async (table: string, h: Record<string, string>) => {
				const r = await fetch(`${url}/${table}?select=id&limit=1`, {
					headers: h,
				});
				return `${r.status} ${(await r.text()).slice(0, 140)}`;
			};
			const privs =
				(
					await q(
						pc,
						`select has_table_privilege('anon', 'public.lv4_after', 'select') as anon_new,
        has_table_privilege('authenticated', 'public.lv4_after', 'select') as authenticated_new,
        has_table_privilege('service_role', 'public.lv4_after', 'select') as service_role_new,
        has_table_privilege('anon', 'public.lv4_items', 'select') as anon_old,
        (select tableowner::text from pg_tables where schemaname = 'public' and tablename = 'lv4_after') as owner`,
					)
				)[0] ?? {};
			const anonNew = await get("lv4_after", anonH);
			const svcNew = await get("lv4_after", svc);
			const anonOld = await get("lv4_items", anonH);
			out.push({
				id: "LV04g",
				title:
					"LV04g: default-privileges revoke from anon and authenticated only",
				status:
					anonNew.startsWith("401") &&
					svcNew.startsWith("200") &&
					anonOld.startsWith("200")
						? "pass"
						: "fail",
				measurements: {
					...Object.fromEntries(
						Object.entries(privs).map(([k, v]) => [k, String(v)]),
					),
					anon_get_new_table: anonNew,
					service_role_get_new_table: svcNew,
					anon_get_table_created_before: anonOld,
				},
			});

			// LV04d: steady traffic, then set the threshold on authenticator.
			let stop = false;
			const hl: Record<string, number> = {};
			const hs: Record<string, number> = {};
			const lightLoop = loop(() => stop, 1000 / LIGHT_RPS, light, hl);
			const slowLoop = loop(
				() => stop,
				SLOW_GAP_MS,
				() => slow(SLOW_MS),
				hs,
			);
			await sleep(60_000);
			const t0 = Date.now();
			await q(
				pc,
				"alter role authenticator set log_min_duration_statement = '200ms'",
			);
			const snapP = snapshotCost(pc).catch(
				(e: Error) => ({ error: e.message }) as Record<string, string>,
			);
			const pids = new Map<
				number,
				{ bs: string; first: number; last: number; age: number }
			>();
			const initial = new Set<number>();
			let firstLogged = -1;
			let firstLoggedMsg = "";
			let nextPoll = t0 + 60_000;
			let samples = 0;
			let seeded = false;
			while (Date.now() - t0 < STEADY_MAX_S * 1000) {
				const rows = (await q(pc, ACT).catch(() => [] as Row[])).filter(
					(r) => !isListener(r),
				);
				const off = Math.round((Date.now() - t0) / 1000);
				for (const r of rows) {
					const pid = Number(r.pid);
					if (seeded === false) initial.add(pid);
					const p = pids.get(pid) ?? {
						bs: String(r.bs),
						first: off,
						last: off,
						age: 0,
					};
					p.last = off;
					p.age = Math.max(p.age, Number(r.age_s));
					pids.set(pid, p);
				}
				samples++;
				if (rows.length) seeded = true;
				if (firstLogged < 0 && Date.now() >= nextPoll) {
					const lr = await logsPatient(
						pc,
						`select toUnixTimestamp(timestamp) as s, event_message as m, toString(log_attributes) as a from logs
             where source = 'postgres_logs'
               and concat(event_message, toString(log_attributes)) like '%duration%'
               and concat(event_message, toString(log_attributes)) like '%lv4_slow%'
               and timestamp >= toDateTime64('${ts(t0)}', 6)
             order by timestamp asc limit 1`,
					);
					const row = lr.rows[0] as Row | undefined;
					if (row) {
						firstLogged = Math.round(Number(row.s) - t0 / 1000);
						firstLoggedMsg = `${String(row.m).slice(0, 160)} || ${String(row.a).slice(0, 240)}`;
					} else if (lr.error) firstLoggedMsg = `logs error: ${lr.error}`;
					nextPoll = Date.now() + 60_000;
				}
				const initialLeft = [...initial].filter((p) =>
					rows.some((r) => Number(r.pid) === p),
				);
				if (firstLogged >= 0 && initialLeft.length === 0) break;
				await sleep(15_000);
			}
			const lastOff = Math.round((Date.now() - t0) / 1000);
			const gone = [...pids.entries()].filter(([, p]) => p.last < lastOff - 20);
			out.push({
				id: "LV04d",
				title:
					"LV04d: authenticator connection age under steady traffic, and delay until the new threshold logs",
				status: firstLogged >= 0 ? "info" : "fail",
				measurements: {
					steady_seconds: lastOff,
					samples,
					first_logged_after_set_s: firstLogged,
					first_logged_row: firstLoggedMsg || "-",
					initial_pids: [...initial].join(","),
					pids_seen: pids.size,
					max_age_seen_s: Math.max(0, ...[...pids.values()].map((p) => p.age)),
					max_age_of_replaced_s: Math.max(0, ...gone.map(([, p]) => p.age)),
					pid_table: [...pids.entries()]
						.map(
							([pid, p]) =>
								`${pid}:start=${p.bs.slice(11, 19)},seen=${p.first}..${p.last}s,age<=${p.age}s${initial.has(pid) ? ",initial" : ""}`,
						)
						.join(" | "),
					light_status: JSON.stringify(hl),
					slow_status: JSON.stringify(hs),
				},
			});
			const snap = await snapP;

			// LV04e: undo by name, then terminate the pool's connections.
			await q(pc, "alter role authenticator reset log_min_duration_statement");
			const tReset = Date.now();
			await sleep(60_000);
			const hlB = { ...hl };
			const hsB = { ...hs };
			const tTerm = Date.now();
			const term = await sql(
				pc,
				`select count(*)::int as targeted, count(*) filter (where pg_terminate_backend(pid))::int as terminated
       from pg_stat_activity where usename = 'authenticator' and backend_type = 'client backend' and query not ilike 'listen%'`,
			);
			await sleep(150_000);
			const tEnd = Date.now();
			stop = true;
			await Promise.all([lightLoop, slowLoop]);
			const after = (await q(pc, ACT)).filter((r) => !isListener(r));
			await sleep(60_000); // ingestion
			const beforeTerm = await slowLogged(pc, tReset + 5000, tTerm);
			const afterTerm = await slowLogged(pc, tTerm + 10_000, tEnd);
			out.push({
				id: "LV04e",
				title:
					"LV04e: reset by name, then pg_terminate_backend on the pool connections",
				status: "info",
				measurements: {
					terminate_status: term.status,
					terminate_error: term.error.slice(0, 200) || "-",
					targeted: Number(term.rows[0]?.targeted ?? -1),
					terminated: Number(term.rows[0]?.terminated ?? -1),
					slow_logged_after_reset_before_terminate: beforeTerm,
					slow_logged_after_terminate: afterTerm,
					light_status_terminate_window: JSON.stringify(diff(hl, hlB)),
					slow_status_terminate_window: JSON.stringify(diff(hs, hsB)),
					pool_after: after
						.map((r) => `${r.pid}:start=${String(r.bs).slice(11, 19)}`)
						.join(","),
				},
			});

			out.push({
				id: "LV04f",
				title:
					"LV04f: snapshot job with pg_stat_statements filled to pg_stat_statements.max",
				status: Number(snap.not_ok ?? 1) === 0 ? "info" : "fail",
				measurements: snap,
			});

			// LV04b check, LV04i check, LV04h: all read postgres_logs / edge_logs.
			const hours = Math.ceil((Date.now() - tStart) / 3600_000) + 1;
			const to = await logsPatient(
				pc,
				`select event_message as m, log_attributes['parsed.query'] as pq, log_attributes['parsed.error_severity'] as sev
         from logs where source = 'postgres_logs' and concat(event_message, toString(log_attributes)) like '%statement timeout%'
         and timestamp >= toDateTime64('${ts(tTimeout - 5000)}', 6) and timestamp < toDateTime64('${ts(tTimeout + 60_000)}', 6)
         order by timestamp asc limit 3`,
				hours,
			);
			const toRow = to.rows[0] as Row | undefined;
			out.push({
				id: "LV04b",
				title:
					"LV04b: Data API call cancelled by statement_timeout, statement text in postgres_logs",
				status:
					toRow && /lv4_slow/.test(String(toRow.pq ?? "")) ? "pass" : "fail",
				measurements: {
					http: `${tr.status} ${trBody}`,
					client_ms: tTimeoutMs,
					log_rows: to.rows.length,
					logs_error: to.error || "-",
					event_message: String(toRow?.m ?? "-").slice(0, 200),
					parsed_query: String(toRow?.pq ?? "-").slice(0, 400),
					severity: String(toRow?.sev ?? "-"),
				},
			});

			const pr = await logsPatient(
				pc,
				`select event_message as m, log_attributes['parsed.query'] as pq
         from logs where source = 'postgres_logs' and concat(event_message, toString(log_attributes)) like '%lv4_%_probe%'
         order by timestamp asc limit 6`,
				hours,
			);
			out.push({
				id: "LV04i",
				title:
					"LV04i: comment on a failing statement, v1 query endpoint and pg-meta route, PAT caller",
				status: "info",
				measurements: {
					v1_http: `${v1Probe.status} ${v1Probe.error.slice(0, 120)}`,
					platform_http: `${plat.status} ${platBody}`,
					log_rows: pr.rows.length,
					logs_error: pr.error || "-",
					rows: pr.rows
						.map((r) => String((r as Row).pq || (r as Row).m).slice(0, 300))
						.join(" || "),
				},
			});

			const hq = await logsPatient(pc, HOST_SQL, hours);
			out.push({
				id: "LV04h",
				title: "LV04h: edge_logs REST requests by host and served_by",
				status:
					hq.status < 300 && !hq.error && hq.rows.length > 0 ? "pass" : "fail",
				measurements: {
					http: hq.status,
					error: hq.error || "-",
					rows: hq.rows
						.map(
							(r) =>
								`${(r as Row).host} | ${(r as Row).served_by} | ${(r as Row).requests}`,
						)
						.join(" || "),
				},
			});
		} catch (e) {
			out.push({
				id: "LV04",
				title: "LV04",
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
