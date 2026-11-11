/**
 * RR11 - tablesync slot names when several new Postgres 17 projects subscribe
 * to one source.
 *
 * RR10 (2026-11-10) found new 17.11 projects reporting one shared
 * system_identifier, and Postgres names a table-sync slot pg_<subscription
 * oid>_sync_<table oid>_<system identifier>, all three read on the subscriber
 * (tablesync.c, REL_17_STABLE). Two targets whose values match compute the same
 * slot name on the source; in RR10 one target's table never reached `r` (last
 * sample `f`) and missed later rows. RR11 groups targets by system_identifier
 * and table OID and runs a concurrent pair (RR11c) and a one-at-a-time pair
 * (RR11d).
 *
 *   RR11a  a source S on postgres_engine "15" and seven targets T1-T7 on the
 *          default, in the org of role PVLAB_RR11_ORG_ROLE (team), default
 *          size; system_identifier and the table OID on each
 *   RR11b  S: PVLAB_RR11_ROWS rows of ~1 KB loaded through the query endpoint,
 *          publication
 *   RR11c  two targets with the same system_identifier and table OID subscribe at the same
 *          time; a target with a different one, if any, subscribes alongside as
 *          a control
 *   RR11d  two more targets subscribe one after the other (every table r,
 *          or the PVLAB_RR11_SYNC_MIN bound, first): a second matching pair if
 *          there is one, otherwise two
 *          targets with differing values. Both subscriptions are created in a
 *          session-pooler session; only the second session first runs
 *          `set log_statement = 'none'`
 *   RR11e  1,000 rows inserted on S: counts on every subscribed target 30 s later
 *   RR11f  logs: log_statement on each subscribed target; per subscribed target,
 *          how many postgres_logs rows contain
 *          `create subscription`, how many contain the password, and all
 *          postgres_logs rows in the hour (counts only, nothing printed)
 *   RR11p  teardown
 *
 * DESTRUCTIVE and BILLABLE: eight projects at the default size; 32 minutes on
 * 2026-11-10 (run 4, this version, with three 10-minute bounds waited out).
 * Env: PVLAB_ORG_TEAM (or the role in PVLAB_RR11_ORG_ROLE).
 */
import { mgmt } from "../../../harness/src/mgmt";
import { logsQuery, sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
	connectSession,
	errText,
	forRef,
	PREFIX,
	poolerConfig,
	sleep,
	waitProjectHealthy,
} from "../lib/rr";

const REGION = process.env.PVLAB_RR11_REGION ?? "ap-southeast-1";
const ORG_ROLE = process.env.PVLAB_RR11_ORG_ROLE ?? "team";
const ROWS = Number(process.env.PVLAB_RR11_ROWS ?? 500_000);
const SYNC_MIN = Number(process.env.PVLAB_RR11_SYNC_MIN ?? 10);
const TABLE =
	"create table if not exists public.rr11_t (id bigint primary key, payload text not null)";

interface P {
	role: string;
	ref: string;
	ctx: Ctx;
	sysid: string;
	relid: string;
}

const mod: TestModule = {
	id: "RR11",
	title:
		"Tablesync slot names when several new Postgres 17 projects subscribe to one source: at once vs one at a time",
	where: "local",
	requires: ["pat"],
	destructive: true,

	async run(ctx: Ctx): Promise<TestResult[]> {
		const out: TestResult[] = [];
		const ps: P[] = [];
		const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
		const redact = (s: string) => {
			let r = s.split(dbPass).join("<password>");
			for (const p of ps) r = r.split(p.ref).join(`<ref-${p.role}>`);
			return r;
		};
		const push = (r: TestResult) => {
			r.detail = r.detail ? redact(r.detail) : r.detail;
			out.push(r);
			ctx.log(
				`${r.id} ${r.status}${r.detail ? `: ${r.detail.slice(0, 300)}` : ""}`,
			);
		};
		const org = ctx.orgs[ORG_ROLE];
		if (!org)
			return [
				{
					id: "RR11",
					title: this.title,
					status: "skip",
					detail: `PVLAB_ORG_${ORG_ROLE.toUpperCase()} not set`,
				},
			];
		const keep = process.env.PVLAB_RR_KEEP === "1";
		const stamp = Date.now();
		const one = async (c: Ctx, q: string, k: string) =>
			(await sql(c, q)).rows[0]?.[k];
		const state = async (c: Ctx) =>
			String(
				(await one(
					c,
					"select coalesce(string_agg(srsubstate::text, ''), '') as s from pg_subscription_rel",
					"s",
				)) ?? "",
			);
		const n = async (c: Ctx) =>
			Number(
				(await one(
					c,
					"select count(*)::bigint as n from public.rr11_t",
					"n",
				)) ?? -1,
			);
		const waitReady = async (c: Ctx, t0: number) => {
			while (Date.now() - t0 < SYNC_MIN * 60_000) {
				const s = await state(c);
				if (s && /^r+$/.test(s)) return Math.round((Date.now() - t0) / 1000);
				await sleep(5_000);
			}
			return "never" as const;
		};

		try {
			/* ---- RR11a ---- */
			const roles = ["S", "T1", "T2", "T3", "T4", "T5", "T6", "T7"];
			const made = await Promise.all(
				roles.map(async (role) => {
					const body: Record<string, unknown> = {
						organization_slug: org,
						name: `${PREFIX}${stamp}-11${role.toLowerCase()}`,
						db_pass: dbPass,
						region_selection: { type: "specific", code: REGION },
					};
					if (role === "S") body.postgres_engine = "15";
					const r = await mgmt(ctx, "POST", "/projects", body);
					const j = (r.json ?? {}) as { ref?: string; id?: string };
					return {
						role,
						ref: String(j.ref ?? j.id ?? ""),
						status: r.status,
						text: r.text.slice(0, 160),
					};
				}),
			);
			for (const m of made)
				if (m.ref)
					ps.push({
						role: m.role,
						ref: m.ref,
						ctx: forRef(ctx, m.ref),
						sysid: "",
						relid: "",
					});
			if (ps.length !== roles.length) {
				push({
					id: "RR11a",
					title: "create S (15) and T1-T7 (17)",
					status: "fail",
					detail: made
						.map((m) => `${m.role} HTTP ${m.status} ${m.text}`)
						.join(" | "),
				});
				return out;
			}
			await Promise.all(ps.map((p) => waitProjectHealthy(ctx, p.ref)));
			const vers: Record<string, string> = {};
			await Promise.all(
				ps.map(async (p) => {
					for (let i = 0; i < 36 && !p.sysid; i++) {
						const r = await sql(
							p.ctx,
							"select (select system_identifier::text from pg_control_system()) as id, current_setting('server_version') as v",
						);
						if (r.rows[0]?.id) {
							p.sysid = String(r.rows[0].id);
							vers[p.role] = String(r.rows[0].v);
						} else await sleep(5_000);
					}
				}),
			);
			for (const p of ps) {
				await sql(p.ctx, TABLE);
				p.relid = String(
					(await one(
						p.ctx,
						"select oid::text as o from pg_class where relname = 'rr11_t'",
						"o",
					)) ?? "",
				);
			}
			const S = ps[0] as P;
			const targets = ps.slice(1);
			// A slot name is pg_<subscription oid>_sync_<table oid>_<system identifier>: group on both values known before subscribing.
			const key = (t: P) => `${t.sysid}/${t.relid}`;
			const bySys = new Map<string, P[]>();
			for (const t of targets)
				bySys.set(key(t), [...(bySys.get(key(t)) ?? []), t]);
			const groups = [...bySys.values()].sort((a, b) => b.length - a.length);
			const shared = groups[0] ?? [];
			const others = targets.filter((t) => !shared.includes(t));
			push({
				id: "RR11a",
				title: `S on postgres_engine 15, T1-T7 on the default; default size, ${REGION}, ${ORG_ROLE} org; system_identifier and table OID`,
				status: ps.every((p) => p.sysid) ? "pass" : "fail",
				detail: `${ps.map((p) => `${p.role} ${vers[p.role] ?? "?"} ${p.sysid || "unread"} rr11_t ${p.relid || "?"}`).join("; ")}; ${shared.length} of ${targets.length} targets share system_identifier/table OID ${shared[0] ? key(shared[0]) : "-"}`,
				measurements: {
					targets_sharing: shared.length,
					targets: targets.length,
				},
			});

			/* ---- RR11b ---- */
			const tl = Date.now();
			let loadErr = "";
			for (let lo = 1; lo <= ROWS && !loadErr; lo += 100_000) {
				const r = await sql(
					S.ctx,
					`insert into public.rr11_t select g, repeat(md5(g::text), 30) from generate_series(${lo}, ${Math.min(ROWS, lo + 99_999)}) g`,
					180_000,
				);
				if (r.status >= 300) loadErr = `HTTP ${r.status} ${r.error}`;
			}
			const pub = await sql(
				S.ctx,
				"create publication rr11_pub for table public.rr11_t",
			);
			const nS = await n(S.ctx);
			push({
				id: "RR11b",
				title: `S: ${ROWS} rows of ~1 KB, publication`,
				status: !loadErr && nS === ROWS && pub.status < 300 ? "pass" : "fail",
				detail: `load ${Math.round((Date.now() - tl) / 1000)}s ${loadErr}; rows ${nS}; publication HTTP ${pub.status} ${pub.error}`,
			});
			if (loadErr || pub.status >= 300) return out;

			const conn = `host=db.${S.ref}.supabase.co port=5432 dbname=postgres user=postgres password=${dbPass} options=''-c statement_timeout=0''`;
			const subName = (t: P) => `rr11_sub_${t.role.toLowerCase()}`;
			const subSql = (t: P) =>
				`create subscription ${subName(t)} connection '${conn}' publication rr11_pub`;
			const oids = async (c: Ctx) =>
				String(
					(await one(
						c,
						"select (select string_agg(oid::text, ',') from pg_subscription) || '/' || (select oid::text from pg_class where relname = 'rr11_t') as o",
						"o",
					)) ?? "",
				);
			const slots = async () =>
				String(
					(await one(
						S.ctx,
						"select coalesce(string_agg(slot_name, ' ' order by slot_name), '') as s from pg_replication_slots",
						"s",
					)) ?? "",
				);

			/* ---- RR11c: same-sysid pair at once (+ a control) ---- */
			const conc = shared.slice(0, 2);
			const control = others[0];
			if (conc.length === 2) {
				const group = control ? [...conc, control] : conc;
				const t0 = Date.now();
				const subs = await Promise.all(group.map((t) => sql(t.ctx, subSql(t))));
				const ready = await Promise.all(group.map((t) => waitReady(t.ctx, t0)));
				const info = await Promise.all(
					group.map(async (t) => ({
						o: await oids(t.ctx),
						s: await state(t.ctx),
						r: await n(t.ctx),
					})),
				);
				const sl = await slots();
				push({
					id: "RR11c",
					title: `${conc.map((t) => t.role).join(" and ")} (same system_identifier and table OID) subscribe at the same time${control ? `, with ${control.role} (different) alongside` : ""}`,
					status:
						subs.every((s) => s.status < 300) &&
						ready.every((r) => r !== "never")
							? "pass"
							: "fail",
					detail: `${group.map((t, i) => `${t.role}${t === control ? " (control)" : ""}: create HTTP ${subs[i]?.status} ${subs[i]?.error}, OIDs ${info[i]?.o}, every table r ${ready[i]}${ready[i] === "never" ? "" : "s"}, state '${info[i]?.s}', rows ${info[i]?.r}`).join("; ")}; bound ${SYNC_MIN} min; slots on S: ${sl}`,
					measurements: Object.fromEntries(
						group.flatMap((t, i) => [
							[`${t.role}_ready_s`, ready[i] ?? "never"],
							[`${t.role}_state`, info[i]?.s ?? ""],
						]),
					),
				});
			} else
				push({
					id: "RR11c",
					title: "same-system_identifier pair at once",
					status: "skip",
					detail:
						"fewer than two targets share a system_identifier and table OID",
				});

			/* ---- RR11d: another same-sysid pair, one at a time ---- */
			// Prefer a second matching pair: more of the largest group, then the next group of two or more.
			const used = new Set<P>([...conc, ...(control ? [control] : [])]);
			const nextGroup = groups
				.slice(1)
				.find((g) => g.filter((t) => !used.has(t)).length >= 2);
			const seq =
				shared.slice(2, 4).length === 2
					? shared.slice(2, 4)
					: nextGroup
						? nextGroup.filter((t) => !used.has(t)).slice(0, 2)
						: targets.filter((t) => !used.has(t)).slice(0, 2);
			if (seq.length === 2) {
				const [first, second] = seq as [P, P];
				const t1 = Date.now();
				// Both through a session-pooler session, so only the `set` differs between them.
				const viaSession = async (t: P, withSet: boolean) => {
					const prim = (await poolerConfig(t.ctx, t.ref).catch(() => [])).find(
						(e) => e.database_type === "PRIMARY",
					);
					if (!prim) return { set: "no pooler entry", create: "not tried" };
					let set = "not run";
					let create = "not tried";
					const c = await connectSession(prim, dbPass);
					try {
						if (withSet) {
							try {
								await c.query("set log_statement = 'none'");
								set = "ok";
							} catch (e) {
								set = errText(e).slice(0, 160);
							}
						}
						try {
							await c.query(subSql(t));
							create = "ok";
						} catch (e) {
							create = errText(e).slice(0, 160);
						}
					} finally {
						await c.end().catch(() => {});
					}
					return { set, create };
				};
				const c1 = await viaSession(first, false);
				const r1 = await waitReady(first.ctx, t1);
				const t2 = Date.now();
				const c2 = await viaSession(second, true);
				const setLs = c2.set;
				const s2 = c2.create;
				const r2 = await waitReady(second.ctx, t2);
				const [o1, o2, n1, n2, sl] = await Promise.all([
					oids(first.ctx),
					oids(second.ctx),
					n(first.ctx),
					n(second.ctx),
					slots(),
				]);
				push({
					id: "RR11d",
					title: `${first.role} subscribes, every table r, then ${second.role}; both in session-pooler sessions, only ${second.role}'s runs set log_statement = 'none' first`,
					status:
						c1.create === "ok" && r1 !== "never" && r2 !== "never"
							? "pass"
							: "fail",
					detail: `system_identifier/table OID ${first.role} ${key(first)}, ${second.role} ${key(second)}; ${first.role}: create subscription ${c1.create} (no set), every table r after ${r1}${r1 === "never" ? "" : "s"}; ${second.role}: set log_statement ${setLs}, create subscription ${s2}, every table r after ${r2}${r2 === "never" ? "" : "s"}; OIDs ${first.role} ${o1}, ${second.role} ${o2}; rows ${first.role} ${n1}, ${second.role} ${n2}; slots on S: ${sl}`,
					measurements: {
						first_ready_s: r1,
						second_ready_s: r2,
						set_log_statement: setLs,
						same_values: String(key(first) === key(second)),
					},
				});
			} else
				push({
					id: "RR11d",
					title: "pair one at a time",
					status: "skip",
					detail: "not enough targets left",
				});

			/* ---- RR11e: later rows ---- */
			const ins = await sql(
				S.ctx,
				`insert into public.rr11_t select g, 'late' from generate_series(${ROWS + 1}, ${ROWS + 1000}) g`,
			);
			await sleep(30_000);
			const subscribed = [
				...conc,
				...(control && conc.length === 2 ? [control] : []),
				...seq,
			];
			const late = await Promise.all(
				subscribed.map(async (t) => ({
					t,
					n: await n(t.ctx),
					s: await state(t.ctx),
				})),
			);
			const want = ROWS + 1000;
			push({
				id: "RR11e",
				title: "1,000 rows inserted on S after the syncs; counts 30 s later",
				status:
					ins.status < 300 && late.every((x) => x.n === want) ? "pass" : "fail",
				detail: `insert HTTP ${ins.status}; ${late.map((x) => `${x.t.role} ${x.n} (state '${x.s}')`).join(", ")}; expected ${want}`,
				measurements: Object.fromEntries(
					late.map((x) => [`${x.t.role}_late`, x.n]),
				),
			});

			/* ---- RR11f: what the logs keep (counts only) ---- */
			await sleep(60_000);
			const ls = String(
				(await one(
					(subscribed[0] ?? S).ctx,
					"select current_setting('log_statement') as v",
					"v",
				)) ?? "unread",
			);
			const pwEsc = dbPass.replace(/'/g, "''");
			const logCounts = async (t: P) => {
				const r = await logsQuery(
					t.ctx,
					`select count() as n, countIf(position(event_message, '${pwEsc}') > 0) as pw from logs where source = 'postgres_logs' and event_message ilike '%create subscription%'`,
					1,
				);
				if (r.status >= 300) return `logs HTTP ${r.status} ${r.error}`;
				const row = (r.rows[0] ?? {}) as Record<string, unknown>;
				const all = await logsQuery(
					t.ctx,
					"select count() as n from logs where source = 'postgres_logs'",
					1,
				);
				const total = Number(
					((all.rows[0] ?? {}) as Record<string, unknown>).n ?? -1,
				);
				const tls = String(
					(await one(
						t.ctx,
						"select current_setting('log_statement') as v",
						"v",
					)) ?? "unread",
				);
				return `log_statement ${tls}, ${Number(row.n ?? -1)} rows with create subscription, ${Number(row.pw ?? -1)} with the password, ${total} postgres_logs rows in the hour`;
			};
			const lc = await Promise.all(
				subscribed.map(async (t) => `${t.role}: ${await logCounts(t)}`),
			);
			push({
				id: "RR11f",
				title:
					"postgres_logs rows containing create subscription, and how many hold the password (counts only)",
				status: "info",
				detail: `log_statement on ${(subscribed[0] ?? S).role} ${ls}; ${lc.join("; ")}${seq[0] && seq[1] ? `; ${seq[0].role} created its subscription in a session-pooler session with no set, ${seq[1].role} in one that ran set log_statement = 'none' first; the others through the query endpoint` : ""}`,
				measurements: { log_statement: ls },
			});
		} catch (e) {
			push({
				id: "RR11",
				title: "unexpected error",
				status: "fail",
				detail: errText(e).slice(0, 400),
			});
		} finally {
			if (!keep && ps.length) {
				const notes: string[] = [];
				for (const p of ps.slice(1)) {
					const nm = `rr11_sub_${p.role.toLowerCase()}`;
					for (const q of [
						`alter subscription ${nm} disable`,
						`alter subscription ${nm} set (slot_name = none)`,
						`drop subscription if exists ${nm}`,
					])
						await sql(p.ctx, q).catch(() => null);
				}
				for (const p of ps) {
					let del = await mgmt(ctx, "DELETE", `/projects/${p.ref}`).catch(
						() => null,
					);
					for (
						let i = 0;
						i < 6 && (del?.status ?? 0) >= 300 && del?.status !== 404;
						i++
					) {
						await sleep(30_000);
						del = await mgmt(ctx, "DELETE", `/projects/${p.ref}`).catch(
							() => null,
						);
					}
					notes.push(`${p.role} delete ${del?.status ?? 0}`);
				}
				push({
					id: "RR11p",
					title: "teardown",
					status: "info",
					detail: notes.join("; "),
				});
			}
		}
		return out;
	},
};

export default mod;
