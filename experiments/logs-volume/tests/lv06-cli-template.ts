/**
 * LV06 - the query-history template (templates/query_history.sql) applied
 * with the Supabase CLI, the way a team with many projects would roll it out:
 *
 *   supabase projects list -o json | jq -r '.[] | select(...) | .ref' |
 *     while read ref; do supabase db query --remote="$ref" -f query_history.sql --yes; done
 *
 *   LV06a  install through that loop: exit status, role the statements ran as,
 *          objects created (schema, tables, functions, one cron job)
 *   LV06b  install again: exit status, still exactly one `rca-snap` job, no error
 *   LV06c  rca.top() after a quiet window then a slow RPC: the slow RPC ranks
 *          first for the incident window (read through the CLI, write mode)
 *   LV06d  the same rca.top() call through `supabase db query --read-only`
 *   LV06e  anon / authenticated / service_role privileges on the rca schema and
 *          rca.top(), and a REST call to /rpc/top with Accept-Profile: rca
 *   LV06f  uninstall through the CLI: job and schema gone; install once more
 *
 * One throwaway project in the org of role PVLAB_LV6_ORG_ROLE (team), default
 * size, ap-southeast-1. Workload over the Data API with the service_role key.
 *
 * DESTRUCTIVE and BILLABLE: creates and deletes one project; about 10 min.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
	dropProject,
	makeProject,
	sleep,
	sql,
} from "../../observability-surface/lib/ob";
import { PREFIX } from "../lib/lv";

const ORG_ROLE = (process.env.PVLAB_LV6_ORG_ROLE ?? "team") as "team" | "pro";
const ROWS = Number(process.env.PVLAB_LV6_ROWS ?? 500_000);
const BASE_S = Number(process.env.PVLAB_LV6_BASE_S ?? 90);
const INC_S = Number(process.env.PVLAB_LV6_INC_S ?? 90);
const TEMPLATES = resolve(import.meta.dir, "../templates");
const INSTALL = join(TEMPLATES, "query_history.sql");
const UNINSTALL = join(TEMPLATES, "query_history_uninstall.sql");

const FIXTURE = `
create table public.lv6_items (id bigint primary key, payload text not null);
insert into public.lv6_items select g, md5(g::text) || md5((g * 7)::text) from generate_series(1, ${ROWS}) g;
analyze public.lv6_items;
create or replace function public.lv6_light(k bigint) returns text language sql stable as $$ select payload from public.lv6_items where id = k $$;
create or replace function public.lv6_heavy() returns bigint language sql stable as $$ select count(*) from public.lv6_items where payload like '%abc%' $$;
grant execute on function public.lv6_light(bigint), public.lv6_heavy() to service_role;
notify pgrst, 'reload schema';`;

type Row = Record<string, unknown>;

async function q(pc: Ctx, s: string, timeoutMs = 60_000): Promise<Row[]> {
	const r = await sql(pc, s, timeoutMs);
	if (r.status >= 300)
		throw new Error(`sql HTTP ${r.status}: ${r.error.slice(0, 300)}`);
	return r.rows;
}

/** Run a shell command with the PAT as SUPABASE_ACCESS_TOKEN, outside any linked project dir. */
function sh(ctx: Ctx, cmd: string, cwd: string) {
	const p = Bun.spawnSync(["sh", "-c", cmd], {
		cwd,
		env: { ...process.env, SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}

/** Pull `rows` out of `supabase db query -o json` output. */
function rowsOf(out: string): Row[] {
	try {
		const j = JSON.parse(out) as { rows?: Row[] };
		return Array.isArray(j.rows) ? j.rows : [];
	} catch {
		return [];
	}
}

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
	id: "LV06",
	title:
		"Query-history SQL template applied with `supabase db query`: install, re-run, rca.top(), read-only, privileges, uninstall",
	where: "local",
	requires: ["pat"],
	destructive: true,
	async run(ctx: Ctx): Promise<TestResult[]> {
		const org = ctx.orgs[ORG_ROLE];
		if (!org)
			return [
				{
					id: "LV06",
					title: this.title,
					status: "skip",
					detail: `PVLAB_ORG_${ORG_ROLE.toUpperCase()} not set`,
				},
			];
		const out: TestResult[] = [];
		let ref = "";
		const cwd = mkdtempSync(join(tmpdir(), "lv06-"));
		try {
			const proj = await makeProject(
				{ ...ctx, orgs: { ...ctx.orgs, pro: org } },
				"lv06",
				PREFIX,
			);
			ref = proj.ref;
			const pc = proj.ctx;
			await q(pc, FIXTURE, 300_000);

			const objects = async () =>
				(
					await q(
						pc,
						`select (select count(*)::int from pg_namespace where nspname = 'rca') as schema,
            (select count(*)::int from pg_tables where schemaname = 'rca') as tables,
            (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'rca') as functions,
            (select count(*)::int from cron.job where jobname = 'rca-snap') as jobs,
            (select string_agg(schedule || ' | ' || command, '; ') from cron.job where jobname = 'rca-snap') as job`,
					)
				)[0] ?? {};

			// LV06a: the rollout loop, filtered to this project by name.
			const loopCmd = (file: string) =>
				`supabase projects list -o json | jq -r '.[] | select(.name == "${proj.name}") | .ref' | ` +
				`while read ref; do supabase db query --remote="$ref" -f "${file}" --yes -o json || exit 1; done`;
			const a = sh(ctx, loopCmd(INSTALL), cwd);
			const who = sh(
				ctx,
				`supabase db query --remote=${ref} --yes -o json "select current_user::text as u"`,
				cwd,
			);
			const objA = await objects();
			out.push({
				id: "LV06a",
				title: "LV06a: install through the projects-list loop",
				status:
					a.code === 0 && Number(objA.jobs) === 1 && Number(objA.tables) === 3
						? "pass"
						: "fail",
				measurements: {
					exit: a.code ?? -1,
					stderr: a.err.trim().slice(0, 300) || "-",
					write_mode_role: String(
						rowsOf(who.out)[0]?.u ?? who.err.slice(0, 120),
					),
					...Object.fromEntries(
						Object.entries(objA).map(([k, v]) => [k, String(v)]),
					),
				},
			});

			// LV06b: run it again.
			const b = sh(ctx, loopCmd(INSTALL), cwd);
			const objB = await objects();
			out.push({
				id: "LV06b",
				title: "LV06b: second install is a no-op apart from the job upsert",
				status: b.code === 0 && Number(objB.jobs) === 1 ? "pass" : "fail",
				measurements: {
					exit: b.code ?? -1,
					stderr: b.err.trim().slice(0, 300) || "-",
					jobs: Number(objB.jobs),
					tables: Number(objB.tables),
					functions: Number(objB.functions),
				},
			});

			// LV06c: quiet window, then a slow RPC, then rca.top() over the incident window.
			const url = `https://${pc.apiHost}/rest/v1/rpc`;
			const hdr = {
				apikey: pc.serviceKey ?? "",
				authorization: `Bearer ${pc.serviceKey}`,
				"content-type": "application/json",
			};
			const light = () =>
				fetch(`${url}/lv6_light`, {
					method: "POST",
					headers: hdr,
					body: JSON.stringify({ k: 1 + Math.floor(Math.random() * ROWS) }),
				});
			const heavy = () =>
				fetch(`${url}/lv6_heavy`, {
					method: "POST",
					headers: hdr,
					body: "{}",
				});
			const hl: Record<string, number> = {};
			const hh: Record<string, number> = {};
			await sleep(65_000); // two snapshots before the quiet window
			const end = Date.now() + (BASE_S + INC_S) * 1000;
			const lightLoop = loop(end, 200, light, hl);
			await sleep(BASE_S * 1000);
			const incEnd = Date.now() + INC_S * 1000;
			await Promise.all([
				loop(incEnd, 0, heavy, hh),
				loop(incEnd, 0, heavy, hh),
			]);
			await lightLoop;
			await sleep(40_000); // one more snapshot past the end
			const win = `${INC_S + 40} seconds`;
			const topCmd = (ro: boolean) =>
				`supabase db query --remote=${ref} ${ro ? "--read-only" : "--yes"} -o json "select calls, exec_ms, query from rca.top('${win}', 5)"`;
			const c = sh(ctx, topCmd(false), cwd);
			const cRows = rowsOf(c.out);
			const rank = cRows.findIndex((r) => /lv6_heavy/.test(String(r.query)));
			const fmt = (rs: Row[]) =>
				rs
					.map(
						(r, i) =>
							`${i + 1}. ${r.exec_ms} ms / ${r.calls} calls: ${String(r.query).replace(/\s+/g, " ").slice(0, 90)}`,
					)
					.join(" | ");
			out.push({
				id: "LV06c",
				title: "LV06c: rca.top() over the incident window, via the CLI",
				status: c.code === 0 && rank === 0 ? "pass" : "fail",
				measurements: {
					exit: c.code ?? -1,
					stderr: c.err.trim().slice(0, 300) || "-",
					window: win,
					top5: fmt(cRows),
					heavy_rank: rank < 0 ? "absent" : rank + 1,
					light_status: JSON.stringify(hl),
					heavy_status: JSON.stringify(hh),
				},
			});

			// LV06d: the same call through --read-only.
			const d = sh(ctx, topCmd(true), cwd);
			const dRows = rowsOf(d.out);
			out.push({
				id: "LV06d",
				title: "LV06d: rca.top() through supabase db query --read-only",
				status:
					d.code === 0 &&
					dRows.findIndex((r) => /lv6_heavy/.test(String(r.query))) === 0
						? "pass"
						: "fail",
				measurements: {
					exit: d.code ?? -1,
					stderr: d.err.trim().slice(0, 300) || "-",
					top1: fmt(dRows.slice(0, 1)) || "-",
				},
			});

			// LV06e: the Data API roles cannot reach it.
			const priv =
				(await q(
					pc,
					`select r.rolname,
            has_schema_privilege(r.rolname, 'rca', 'usage') as schema_usage,
            has_table_privilege(r.rolname, 'rca.stmt_snap', 'select') as select_snap,
            has_function_privilege(r.rolname, 'rca.top(interval, integer)', 'execute') as exec_top
          from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') order by 1`,
				)) ?? [];
			const rest = await fetch(`${url}/top`, {
				method: "POST",
				headers: {
					apikey: pc.anonKey ?? "",
					authorization: `Bearer ${pc.anonKey}`,
					"content-type": "application/json",
					"accept-profile": "rca",
					"content-profile": "rca",
				},
				body: "{}",
			});
			const restBody = (await rest.text()).slice(0, 160);
			const anyOpen = priv.some(
				(r) =>
					(r.rolname === "anon" || r.rolname === "authenticated") &&
					(r.schema_usage || r.select_snap || r.exec_top),
			);
			out.push({
				id: "LV06e",
				title: "LV06e: Data API roles on the rca schema",
				status: !anyOpen && rest.status >= 400 ? "pass" : "fail",
				measurements: {
					privileges: priv
						.map(
							(r) =>
								`${r.rolname}: usage=${r.schema_usage} select=${r.select_snap} exec_top=${r.exec_top}`,
						)
						.join(" | "),
					anon_rest_rpc_top: `${rest.status} ${restBody}`,
				},
			});

			// LV06f: uninstall, then install once more.
			const f1 = sh(ctx, loopCmd(UNINSTALL), cwd);
			const objF = await objects();
			const f2 = sh(ctx, loopCmd(INSTALL), cwd);
			const objF2 = await objects();
			out.push({
				id: "LV06f",
				title: "LV06f: uninstall through the loop, then reinstall",
				status:
					f1.code === 0 &&
					Number(objF.schema) === 0 &&
					Number(objF.jobs) === 0 &&
					f2.code === 0 &&
					Number(objF2.jobs) === 1
						? "pass"
						: "fail",
				measurements: {
					uninstall_exit: f1.code ?? -1,
					uninstall_stderr: f1.err.trim().slice(0, 200) || "-",
					after_uninstall: `schema=${objF.schema} jobs=${objF.jobs}`,
					reinstall_exit: f2.code ?? -1,
					after_reinstall: `schema=${objF2.schema} tables=${objF2.tables} jobs=${objF2.jobs}`,
				},
			});
		} catch (e) {
			out.push({
				id: "LV06",
				title: "LV06",
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
