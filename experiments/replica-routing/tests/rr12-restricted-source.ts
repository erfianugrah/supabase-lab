/**
 * RR12 - a logical subscription from one project to another when the source
 * has network restrictions on.
 *
 * The docs say restrictions cover direct and pooled Postgres connections, and
 * that a database's outbound address "is not static and cannot be guaranteed"
 * (guides/platform/ipv4-address). Open: which address the source sees when
 * another project's subscription connects to the source's direct host, whether
 * that is the address the target's own db host resolves to, whether allowing
 * that address alone lets the subscription through, and what a restriction
 * does to a subscription that is already streaming.
 *
 *   RR12a  S on postgres_engine "15", T and T2 on the default, default size,
 *          PVLAB_RR12_REGION (ap-southeast-1), org of PVLAB_RR12_ORG_ROLE
 *          (team); the A and AAAA records of each db host, read from the
 *          orchestrator.
 *   RR12b  S: 1,000 rows and a publication; T and T2: the table.
 *   RR12c  open: T subscribes to S's direct host; every table r; on S,
 *          pg_stat_replication client_addr compared with T's AAAA record.
 *   RR12d  S restricted to the documentation ranges 192.0.2.0/24 and
 *          2001:db8::/32: is T's walsender still on S after 20 s, do 100 rows
 *          inserted on S reach T, and after T disables and enables the
 *          subscription do 100 more reach T.
 *   RR12e  S allows only the address RR12c saw (a /128 in the IPv6 list beside
 *          192.0.2.0/24, or a /32 in the IPv4 list beside 2001:db8::/32): do
 *          the rows still missing on T (up to 200) reach T, and how long it
 *          takes.
 *   RR12f  under RR12e's restriction, T2 runs create subscription with
 *          connect_timeout=10: refused, accepted, or still waiting when the
 *          client gives up after PVLAB_RR12_F_BUDGET_S (240) seconds.
 *   RR12g  T's and T2's postgres_logs lines from the last hour that mention
 *          the connection to the publisher (counts and the first message).
 *   RR12p  teardown.
 *
 * Addresses are written to the artifact as roles (<v6-T>), not values.
 * Env: PVLAB_ORG_TEAM (or the role in PVLAB_RR12_ORG_ROLE).
 */
import { resolve4, resolve6 } from "node:dns/promises";
import { mgmt } from "../../../harness/src/mgmt";
import { logsQuery, sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { errText, forRef, PREFIX, sleep, waitProjectHealthy } from "../lib/rr";

const REGION = process.env.PVLAB_RR12_REGION ?? "ap-southeast-1";
const ORG_ROLE = process.env.PVLAB_RR12_ORG_ROLE ?? "team";
const TABLE =
	"create table if not exists public.rr12_t (id bigint primary key, note text not null)";
const DOC_V4 = "192.0.2.0/24";
const DOC_V6 = "2001:db8::/32";
const F_BUDGET_S = Number(process.env.PVLAB_RR12_F_BUDGET_S ?? 240);

interface P {
	role: string;
	ref: string;
	ctx: Ctx;
	v4: string[];
	v6: string[];
}

const mod: TestModule = {
	id: "RR12",
	title:
		"A logical subscription between two projects when the source has network restrictions on: the address the source sees, and allowing it",
	where: "local",
	requires: ["pat"],
	destructive: true,

	async run(ctx: Ctx): Promise<TestResult[]> {
		const out: TestResult[] = [];
		const ps: P[] = [];
		const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
		const addrRole = new Map<string, string>();
		const redact = (s: string) => {
			let r = s.split(dbPass).join("<password>");
			for (const p of ps) r = r.split(p.ref).join(`<ref-${p.role}>`);
			for (const [a, role] of addrRole) r = r.split(a).join(`<${role}>`);
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
					id: "RR12",
					title: this.title,
					status: "skip",
					detail: `PVLAB_ORG_${ORG_ROLE.toUpperCase()} not set`,
				},
			];
		const keep = process.env.PVLAB_RR_KEEP === "1";
		const stamp = Date.now();
		const one = async (c: Ctx, q: string, k: string) =>
			(await sql(c, q)).rows[0]?.[k];
		const count = async (c: Ctx) =>
			Number(
				(await one(
					c,
					"select count(*)::bigint as n from public.rr12_t",
					"n",
				)) ?? -1,
			);
		const restrict = async (S: P, v4: string[], v6: string[]) => {
			const r = await mgmt(
				ctx,
				"POST",
				`/projects/${S.ref}/network-restrictions/apply`,
				{ dbAllowedCidrs: v4, dbAllowedCidrsV6: v6 },
			);
			return r.status;
		};
		const walsenders = async (S: P) =>
			(
				await sql(
					S.ctx,
					"select client_addr::text as a, application_name as app, state from pg_stat_replication order by application_name",
				)
			).rows.map((r) => ({
				a: String(r.a ?? ""),
				app: String(r.app ?? ""),
				state: String(r.state ?? ""),
			}));
		const waitRows = async (c: Ctx, want: number, maxS: number) => {
			const t0 = Date.now();
			let got = -1;
			while (Date.now() - t0 < maxS * 1000) {
				got = await count(c);
				if (got >= want)
					return { s: Math.round((Date.now() - t0) / 1000), got };
				await sleep(5_000);
			}
			return { s: "never" as const, got };
		};
		let S: P | undefined;

		try {
			/* ---- RR12a ---- */
			const roles = ["S", "T", "T2"];
			const made = await Promise.all(
				roles.map(async (role) => {
					const body: Record<string, unknown> = {
						organization_slug: org,
						name: `${PREFIX}${stamp}-12${role.toLowerCase()}`,
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
						v4: [],
						v6: [],
					});
			if (ps.length !== roles.length) {
				push({
					id: "RR12a",
					title: "create S (15), T and T2 (17)",
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
					for (let i = 0; i < 36 && !vers[p.role]; i++) {
						const r = await sql(
							p.ctx,
							"select current_setting('server_version') as v",
						);
						if (r.rows[0]?.v) vers[p.role] = String(r.rows[0].v);
						else await sleep(5_000);
					}
				}),
			);
			for (const p of ps) {
				const host = `db.${p.ref}.supabase.co`;
				p.v4 = await resolve4(host).catch(() => []);
				p.v6 = await resolve6(host).catch(() => []);
				for (const [i, a] of p.v4.entries())
					addrRole.set(a, `v4-${p.role}${i ? i : ""}`);
				for (const [i, a] of p.v6.entries())
					addrRole.set(a, `v6-${p.role}${i ? i : ""}`);
			}
			S = ps[0] as P;
			const T = ps[1] as P;
			const T2 = ps[2] as P;
			push({
				id: "RR12a",
				title: `S on postgres_engine 15, T and T2 on the default; default size, ${REGION}, ${ORG_ROLE} org; db host records`,
				status: ps.every((p) => vers[p.role]) ? "pass" : "fail",
				detail: ps
					.map(
						(p) =>
							`${p.role} ${vers[p.role] ?? "?"} A ${p.v4.length} AAAA ${p.v6.length}`,
					)
					.join("; "),
				measurements: Object.fromEntries(
					ps.flatMap((p) => [
						[`${p.role}_a_records`, p.v4.length],
						[`${p.role}_aaaa_records`, p.v6.length],
					]),
				),
			});

			/* ---- RR12b ---- */
			const ins = await sql(
				S.ctx,
				`${TABLE}; insert into public.rr12_t select g, 'seed' from generate_series(1, 1000) g`,
			);
			const pub = await sql(
				S.ctx,
				"create publication rr12_pub for table public.rr12_t",
			);
			for (const t of [T, T2]) await sql(t.ctx, TABLE);
			push({
				id: "RR12b",
				title: "S: 1,000 rows and a publication; T and T2: the table",
				status: ins.status < 300 && pub.status < 300 ? "pass" : "fail",
				detail: `insert HTTP ${ins.status} ${ins.error}; publication HTTP ${pub.status} ${pub.error}; S rows ${await count(S.ctx)}`,
			});
			if (ins.status >= 300 || pub.status >= 300) return out;

			const conn = (extra = "") =>
				`host=db.${S?.ref}.supabase.co port=5432 dbname=postgres user=postgres password=${dbPass}${extra}`;

			/* ---- RR12c ---- */
			const t0 = Date.now();
			const sub = await sql(
				T.ctx,
				`create subscription rr12_sub_t connection '${conn()}' publication rr12_pub`,
			);
			const synced = await waitRows(T.ctx, 1000, 300);
			const ws = await walsenders(S);
			const seen = ws.find((w) => w.app === "rr12_sub_t")?.a ?? "";
			const seenAddr = seen.replace(/\/\d+$/, "");
			if (seenAddr && !addrRole.has(seenAddr))
				addrRole.set(seenAddr, "addr-seen-by-S");
			const isV6 = seenAddr.includes(":");
			const matchT = isV6 ? T.v6.includes(seenAddr) : T.v4.includes(seenAddr);
			push({
				id: "RR12c",
				title:
					"open: T subscribes to S's direct host; the address S sees for T's walsender",
				status:
					sub.status < 300 && synced.s !== "never" && seenAddr
						? "pass"
						: "fail",
				detail: `create subscription HTTP ${sub.status} ${sub.error}; T rows ${synced.got} after ${synced.s}${synced.s === "never" ? "" : "s"} (${Math.round((Date.now() - t0) / 1000)} s with the walsender read); S pg_stat_replication: ${ws.map((w) => `${w.app} ${w.a} ${w.state}`).join(", ") || "none"}; seen address is ${isV6 ? "IPv6" : seenAddr ? "IPv4" : "unread"} and ${matchT ? "equals" : "does not equal"} a record of T's db host`,
				measurements: {
					seen_is_v6: isV6 ? 1 : 0,
					seen_equals_T_record: matchT ? 1 : 0,
				},
			});
			if (!seenAddr) return out;

			/* ---- RR12d ---- */
			const a1 = await restrict(S, [DOC_V4], [DOC_V6]);
			await sleep(20_000);
			const wsAfter = await walsenders(S);
			const still = wsAfter.some((w) => w.app === "rr12_sub_t");
			await sql(
				S.ctx,
				"insert into public.rr12_t select g, 'during-restrict' from generate_series(1001, 1100) g",
			);
			const d1 = await waitRows(T.ctx, 1100, 45);
			await sql(T.ctx, "alter subscription rr12_sub_t disable");
			await sleep(5_000);
			await sql(T.ctx, "alter subscription rr12_sub_t enable");
			await sql(
				S.ctx,
				"insert into public.rr12_t select g, 'after-reconnect' from generate_series(1101, 1200) g",
			);
			const d2 = await waitRows(T.ctx, 1200, 60);
			const subStat = (
				await sql(
					T.ctx,
					"select coalesce(pid::text, 'none') as pid, coalesce(last_msg_receipt_time::text, '') as rx from pg_stat_subscription where subname = 'rr12_sub_t'",
				)
			).rows[0];
			const wsLocked = await walsenders(S);
			push({
				id: "RR12d",
				title: `S restricted to ${DOC_V4} and ${DOC_V6}: the streaming subscription, then a reconnect`,
				status: "info",
				detail: `apply HTTP ${a1}; T's walsender on S 20 s later: ${still ? "present" : "gone"} (${wsAfter.map((w) => `${w.app} ${w.state}`).join(", ") || "none"}); 100 rows inserted on S: T rows ${d1.got} after 45 s (${d1.s === "never" ? "not all arrived" : `all after ${d1.s}s`}); after disable/enable and 100 more: T rows ${d2.got} (${d2.s === "never" ? "not all arrived in 60 s" : `all after ${d2.s}s`}); T pg_stat_subscription worker pid ${subStat?.pid ?? "?"}; S walsenders now: ${wsLocked.map((w) => w.app).join(", ") || "none"}`,
				measurements: {
					walsender_survived_20s: still ? 1 : 0,
					rows_before_reconnect: d1.got,
					rows_after_reconnect: d2.got,
				},
			});

			/* ---- RR12e ---- */
			const allowV4 = isV6 ? [DOC_V4] : [`${seenAddr}/32`];
			const allowV6 = isV6 ? [`${seenAddr}/128`] : [DOC_V6];
			const a2 = await restrict(S, allowV4, allowV6);
			const nr = await mgmt(
				ctx,
				"GET",
				`/projects/${S.ref}/network-restrictions`,
			);
			const nrj = (nr.json ?? {}) as {
				status?: string;
				config?: { dbAllowedCidrs?: string[]; dbAllowedCidrsV6?: string[] };
			};
			const e1 = await waitRows(T.ctx, 1200, 180);
			const wsOpen = await walsenders(S);
			push({
				id: "RR12e",
				title: `S allows ${DOC_V4} and only the address RR12c saw: T catches up`,
				status: e1.s !== "never" ? "pass" : "fail",
				detail: `apply HTTP ${a2} (${isV6 ? `${DOC_V4} + <addr-seen-by-S>/128` : `<addr-seen-by-S>/32 + ${DOC_V6}`}); GET network-restrictions status ${nrj.status ?? nr.status}, v4 ${nrj.config?.dbAllowedCidrs?.length ?? "?"} entries, v6 ${nrj.config?.dbAllowedCidrsV6?.length ?? "?"} entries; T rows ${e1.got} (${e1.s === "never" ? "not all in 180 s" : `all after ${e1.s}s`}); S walsenders: ${wsOpen.map((w) => `${w.app} ${w.a}`).join(", ") || "none"}`,
				measurements: { catch_up_s: e1.s === "never" ? -1 : e1.s },
			});

			/* ---- RR12f ---- */
			const tf = Date.now();
			let f = "";
			let fStatus: TestResult["status"] = "fail";
			try {
				const sub2 = await sql(
					T2.ctx,
					`create subscription rr12_sub_t2 connection '${conn(" connect_timeout=10")}' publication rr12_pub`,
					F_BUDGET_S * 1000,
				);
				f = `create subscription HTTP ${sub2.status} after ${Math.round((Date.now() - tf) / 1000)} s: ${sub2.error || "accepted"}`;
				fStatus = sub2.status >= 300 ? "pass" : "fail";
			} catch (e) {
				f = `create subscription had not returned when the client gave up after ${Math.round((Date.now() - tf) / 1000)} s (${errText(e).slice(0, 80)})`;
				fStatus = "pass";
			}
			push({
				id: "RR12f",
				title: "T2 subscribes under RR12e's restriction (connect_timeout=10)",
				status: fStatus,
				detail: `${f}; T2's AAAA ${T2.v6.some((a) => T.v6.includes(a)) ? "shares" : "does not share"} an address with T's`,
			});

			/* ---- RR12g ---- */
			await sleep(20_000);
			for (const t of [T, T2]) {
				const lg = await logsQuery(
					t.ctx,
					"select event_message from logs where source = 'postgres_logs' and (event_message ilike '%publisher%' or event_message ilike '%timeout expired%' or event_message ilike '%could not connect%' or event_message ilike '%timed out%') order by timestamp asc limit 50",
					1,
				);
				const msgs = lg.rows.map((r) => String(r.event_message ?? ""));
				push({
					id: `RR12g-${t.role}`,
					title: `${t.role}'s postgres_logs lines about the connection to the publisher during the run`,
					status: "info",
					detail: `logs HTTP ${lg.status} ${lg.error}; ${msgs.length} lines; first: ${msgs[0]?.slice(0, 240) ?? "-"}; distinct starts: ${[...new Set(msgs.map((m) => m.slice(0, 70)))].slice(0, 6).join(" | ")}`,
					measurements: { log_lines: msgs.length },
				});
			}
		} catch (e) {
			push({
				id: "RR12",
				title: "unexpected error",
				status: "fail",
				detail: errText(e).slice(0, 400),
			});
		} finally {
			if (!keep && ps.length) {
				const notes: string[] = [];
				for (const p of ps.slice(1)) {
					const nm = `rr12_sub_${p.role.toLowerCase()}`;
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
					id: "RR12p",
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
