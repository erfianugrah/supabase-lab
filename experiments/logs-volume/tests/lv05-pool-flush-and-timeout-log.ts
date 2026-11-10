/**
 * LV05 - follow-up to LV04 on one throwaway project:
 *
 *   LV05a  a Data API call cancelled by statement_timeout (anon, 3 s): is the
 *          statement text in postgres_logs? (LV04b called before the schema
 *          cache had the function; here the call waits until it answers 200)
 *   LV05b  idle pool with no DDL or NOTIFY: after a burst of concurrent calls,
 *          how long until the extra `authenticator` connections close (LV04c
 *          saw 8 open for 150 s, gone after a `notify pgrst, 'reload schema'`)
 *   LV05c  under steady traffic, `alter role authenticator set
 *          log_min_duration_statement`, then `notify pgrst, 'reload config'`:
 *          are the pool's connections replaced, is the slow call logged?
 *   LV05d  if not, `notify pgrst, 'reload schema'`: same questions
 *
 * Steady traffic: rpc lv5_light at 2/s plus rpc lv5_slow (300 ms) every 5 s,
 * service_role key; threshold 200 ms. Pool connections are `authenticator`
 * client backends other than the LISTEN connection.
 *
 * DESTRUCTIVE and BILLABLE: creates and deletes one project; about 15 min.
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

const ORG_ROLE = (process.env.PVLAB_LV5_ORG_ROLE ?? "team") as "team" | "pro";
const IDLE_S = Number(process.env.PVLAB_LV5_IDLE_S ?? 330);
const STEP_S = Number(process.env.PVLAB_LV5_STEP_S ?? 90);

const SETUP = `
create table public.lv5_items (id bigint primary key, payload text not null);
insert into public.lv5_items select g, md5(g::text) from generate_series(1, 10000) g;
create or replace function public.lv5_light(k bigint) returns text language sql stable as $$ select payload from public.lv5_items where id = k $$;
create or replace function public.lv5_slow(ms int) returns int language sql volatile as $$ select pg_sleep(ms / 1000.0); select ms $$;
grant execute on function public.lv5_light(bigint), public.lv5_slow(int) to anon, authenticated, service_role;
notify pgrst, 'reload schema';`;

const ACT = `select pid, backend_start::text as bs, state, left(query, 60) as q
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

async function logsPatient(pc: Ctx, s: string, hours = 2) {
	let r = await logs(pc, s, hours);
	for (let i = 0; i < 8 && /Too Many|Throttler/i.test(r.error); i++) {
		await sleep(20_000);
		r = await logs(pc, s, hours);
	}
	return r;
}

const pool = async (pc: Ctx) =>
	(await q(pc, ACT).catch(() => [] as Row[])).filter(
		(r) => !/^listen/i.test(String(r.q ?? "")),
	);

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

/** postgres_logs duration rows for lv5_slow with event time in [t0, t1). */
async function slowLogged(pc: Ctx, t0: number, t1: number) {
	const r = await logsPatient(
		pc,
		`select count(*) as n, any(log_attributes['parsed.detail']) as detail from logs where source = 'postgres_logs'
     and concat(event_message, toString(log_attributes)) like '%duration%'
     and concat(event_message, toString(log_attributes)) like '%lv5_slow%'
     and timestamp >= toDateTime64('${ts(t0)}', 6) and timestamp < toDateTime64('${ts(t1)}', 6)`,
	);
	return r.error
		? { n: -1, detail: `error: ${r.error}` }
		: {
				n: Number(r.rows[0]?.n ?? 0),
				detail: String(r.rows[0]?.detail ?? "-").slice(0, 160),
			};
}

const mod: TestModule = {
	id: "LV05",
	title:
		"PostgREST pool: idle close without NOTIFY, reload config vs reload schema; timeout logging",
	where: "local",
	requires: ["pat"],
	destructive: true,
	async run(ctx: Ctx): Promise<TestResult[]> {
		const org = ctx.orgs[ORG_ROLE];
		if (!org)
			return [
				{
					id: "LV05",
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
				"lv05",
				PREFIX,
			);
			ref = proj.ref;
			const pc = proj.ctx;
			await q(pc, SETUP, 120_000);
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
				fetch(`${url}/rpc/lv5_light`, {
					method: "POST",
					headers: svc,
					body: JSON.stringify({ k: 1 + Math.floor(Math.random() * 10000) }),
				});
			const slow = (ms: number, h: Record<string, string> = svc) =>
				fetch(`${url}/rpc/lv5_slow`, {
					method: "POST",
					headers: h,
					body: JSON.stringify({ ms }),
				});

			// Wait until the schema cache has the functions.
			let ready = 0;
			for (let i = 0; i < 30 && ready !== 200; i++) {
				const r = await slow(1);
				ready = r.status;
				await r.body?.cancel();
				if (ready !== 200) await sleep(2000);
			}

			// LV05a fire.
			const tTimeout = Date.now();
			const tr = await slow(5000, anonH);
			const trBody = (await tr.text()).slice(0, 160);
			const tTimeoutMs = Date.now() - tTimeout;

			// LV05b: burst, then idle with nothing else touching PostgREST.
			await sleep(5000);
			await Promise.all(
				Array.from({ length: 8 }, () =>
					slow(1500).then(
						(r) => r.body?.cancel(),
						() => undefined,
					),
				),
			);
			const tBurst = Date.now();
			const idle: string[] = [];
			let peak = 0;
			let closedAllExtraAt = -1;
			while (Date.now() - tBurst < IDLE_S * 1000) {
				const n = (await pool(pc)).length;
				const t = Math.round((Date.now() - tBurst) / 1000);
				idle.push(`${t}s:${n}`);
				peak = Math.max(peak, n);
				if (closedAllExtraAt < 0 && peak > 1 && n <= 1) closedAllExtraAt = t;
				await sleep(10_000);
			}
			out.push({
				id: "LV05b",
				title: "LV05b: pool after a burst, idle, no DDL or NOTIFY",
				status: "info",
				measurements: {
					ready_status: ready,
					idle_window_s: IDLE_S,
					pool_peak: peak,
					down_to_one_or_zero_at_s: closedAllExtraAt,
					samples: idle.join(" "),
				},
			});

			// LV05c/d: steady traffic, set the threshold, then each NOTIFY.
			let stop = false;
			const hl: Record<string, number> = {};
			const hs: Record<string, number> = {};
			const loops = Promise.all([
				loop(() => stop, 500, light, hl),
				loop(
					() => stop,
					5000,
					() => slow(300),
					hs,
				),
			]);
			await sleep(45_000);
			await q(
				pc,
				"alter role authenticator set log_min_duration_statement = '200ms'",
			);
			const tSet = Date.now();
			await sleep(STEP_S * 1000);
			const steps: {
				id: string;
				cmd: string;
				t: number;
				before: Row[];
				after: Row[];
				hl: Record<string, number>;
				hs: Record<string, number>;
			}[] = [];
			for (const [id, cmd] of [
				["LV05c", "notify pgrst, 'reload config'"],
				["LV05d", "notify pgrst, 'reload schema'"],
			] as const) {
				const before = await pool(pc);
				const hlB = { ...hl };
				const hsB = { ...hs };
				const t = Date.now();
				await q(pc, cmd);
				await sleep(STEP_S * 1000);
				steps.push({
					id,
					cmd,
					t,
					before,
					after: await pool(pc),
					hl: diff(hl, hlB),
					hs: diff(hs, hsB),
				});
			}
			const tEnd = Date.now();
			stop = true;
			await loops;
			await sleep(60_000); // ingestion
			const setOnly = await slowLogged(pc, tSet + 2000, steps[0]?.t ?? tEnd);
			const fmt = (rs: Row[]) =>
				rs.map((r) => `${r.pid}@${String(r.bs).slice(11, 19)}`).join(",");
			for (const [i, s] of steps.entries()) {
				const next = steps[i + 1]?.t ?? tEnd;
				const logged = await slowLogged(pc, s.t + 3000, next);
				const kept = s.after.filter((a) =>
					s.before.some((b) => b.pid === a.pid),
				).length;
				out.push({
					id: s.id,
					title: `${s.id}: ${s.cmd} after setting the threshold on authenticator`,
					status: "info",
					measurements: {
						slow_logged_after_set_before_any_notify: setOnly.n,
						pool_before: fmt(s.before),
						pool_after: fmt(s.after),
						connections_kept: kept,
						slow_logged_after_this_notify: logged.n,
						sample_detail: logged.detail,
						light_status: JSON.stringify(s.hl),
						slow_status: JSON.stringify(s.hs),
					},
				});
			}

			// LV05a check.
			const to = await logsPatient(
				pc,
				`select event_message as m, log_attributes['parsed.query'] as pq, log_attributes['parsed.detail'] as d,
                log_attributes['parsed.user_name'] as u, log_attributes['parsed.sql_state_code'] as code
         from logs where source = 'postgres_logs' and concat(event_message, toString(log_attributes)) like '%statement timeout%'
         and timestamp >= toDateTime64('${ts(tTimeout - 5000)}', 6) and timestamp < toDateTime64('${ts(tTimeout + 60_000)}', 6)
         order by timestamp asc limit 3`,
			);
			const row = to.rows[0] as Row | undefined;
			out.push({
				id: "LV05a",
				title:
					"LV05a: Data API call cancelled by statement_timeout, statement text in postgres_logs",
				status:
					tr.status >= 500 && row && /lv5_slow/.test(String(row.pq ?? ""))
						? "pass"
						: "fail",
				measurements: {
					http: `${tr.status} ${trBody}`,
					client_ms: tTimeoutMs,
					log_rows: to.rows.length,
					logs_error: to.error || "-",
					event_message: String(row?.m ?? "-").slice(0, 160),
					parsed_query: String(row?.pq ?? "-").slice(0, 300),
					parsed_detail: String(row?.d ?? "-").slice(0, 160),
					user_name: String(row?.u ?? "-"),
					sqlstate: String(row?.code ?? "-"),
				},
			});
		} catch (e) {
			out.push({
				id: "LV05",
				title: "LV05",
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
