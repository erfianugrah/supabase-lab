/**
 * RR13 - RR12 with the IPv4 add-on on the source.
 *
 * With the add-on, the source's db host resolves to an A record only, so a
 * subscription from another project connects over IPv4, and the docs say a
 * database's outbound address "is not static and cannot be guaranteed"
 * (guides/platform/ipv4-address). Open: which IPv4 address the source sees
 * for a target, whether two targets in one region present the same address
 * (a shared egress), whether allowing that address lets the subscription
 * through, and whether it holds across a reconnect.
 *
 *   RR13a  S on postgres_engine "15", T and T2 on the default, default size,
 *          PVLAB_RR13_REGION (ap-southeast-1), org of PVLAB_RR13_ORG_ROLE
 *          (team); the IPv4 add-on enabled on S; A and AAAA records of each
 *          db host polled with dig until S has an A and no AAAA.
 *   RR13b  S: 1,000 rows and a publication; T and T2: the table.
 *   RR13c  S open: T subscribes; once every T table is r, T2 subscribes (one
 *          at a time); S's pg_stat_replication client_addr for each.
 *   RR13c2 S's walsenders and xid holders sampled while each create runs;
 *          then a logical slot created directly on S.
 *   RR13c3 each target's pg_net request to an IP echo service: does its
 *          egress address equal the address S saw.
 *   RR13d  S allows only the address S saw for T (/32) beside 2001:db8::/32;
 *          T and T2 disable and enable their subscriptions; 100 rows inserted
 *          on S: which targets catch up in 120 s, and client_addr again.
 *   RR13f  T restarted (POST /restart) under RR13d's restriction: does it
 *          reconnect, and from which address (S opened to read it if not).
 *   RR13e  S restricted to 192.0.2.0/24 and 2001:db8::/32; T disables and
 *          enables; 100 more rows: does T get them in 60 s (the control that
 *          the restriction bites on this path).
 *   RR13p  teardown.
 *
 * Addresses are written as roles (<v4-a>, <v4-S>), not values.
 * Env: PVLAB_ORG_TEAM (or the role in PVLAB_RR13_ORG_ROLE).
 */
import { mgmt } from "../../../harness/src/mgmt";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { errText, forRef, PREFIX, sleep, waitProjectHealthy } from "../lib/rr";

const REGION = process.env.PVLAB_RR13_REGION ?? "ap-southeast-1";
const ORG_ROLE = process.env.PVLAB_RR13_ORG_ROLE ?? "team";
const TABLE =
	"create table if not exists public.rr13_t (id bigint primary key, note text not null)";
const DOC_V4 = "192.0.2.0/24";
const DOC_V6 = "2001:db8::/32";

interface P {
	role: string;
	ref: string;
	ctx: Ctx;
}

async function dig(type: "A" | "AAAA", host: string): Promise<string[]> {
	const p = Bun.spawn(["dig", "+short", type, host, "@1.1.1.1"], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out
		.split("\n")
		.map((l) => l.trim())
		.filter(
			(l) => /^[0-9a-f:.]+$/i.test(l) && (l.includes(".") || l.includes(":")),
		);
}

const mod: TestModule = {
	id: "RR13",
	title:
		"A logical subscription between two projects when the source has the IPv4 add-on and network restrictions: the address the source sees, shared or not, and allowing it",
	where: "local",
	requires: ["pat"],
	destructive: true,

	async run(ctx: Ctx): Promise<TestResult[]> {
		const out: TestResult[] = [];
		const ps: P[] = [];
		const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
		const addrRole = new Map<string, string>();
		let next = 0;
		const role = (a: string) => {
			if (!addrRole.has(a))
				addrRole.set(
					a,
					`${a.includes(":") ? "v6" : "v4"}-${String.fromCharCode(97 + next++)}`,
				);
			return addrRole.get(a) as string;
		};
		const redact = (s: string) => {
			let r = s.split(dbPass).join("<password>");
			for (const p of ps) r = r.split(p.ref).join(`<ref-${p.role}>`);
			for (const [a, rl] of addrRole) r = r.split(a).join(`<${rl}>`);
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
					id: "RR13",
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
					"select count(*)::bigint as n from public.rr13_t",
					"n",
				)) ?? -1,
			);
		const allR = async (c: Ctx) =>
			/^r+$/.test(
				String(
					(await one(
						c,
						"select coalesce(string_agg(srsubstate::text, ''), '') as s from pg_subscription_rel",
						"s",
					)) ?? "",
				),
			);
		const restrict = async (S: P, v4: string[], v6: string[]) =>
			(
				await mgmt(
					ctx,
					"POST",
					`/projects/${S.ref}/network-restrictions/apply`,
					{
						dbAllowedCidrs: v4,
						dbAllowedCidrsV6: v6,
					},
				)
			).status;
		const walsenders = async (S: P) =>
			(
				await sql(
					S.ctx,
					"select host(client_addr) as a, application_name as app, state from pg_stat_replication order by application_name",
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
		// The address an HTTP request from the target's own pg_net worker leaves from.
		const egress = async (t: P) => {
			await sql(t.ctx, "create extension if not exists pg_net");
			const id = (
				await sql(t.ctx, "select net.http_get('https://api.ipify.org') as id")
			).rows[0]?.id;
			for (let i = 0; i < 12; i++) {
				await sleep(5_000);
				const r = (
					await sql(
						t.ctx,
						`select status_code as c, trim(content) as b, coalesce(error_msg, '') as e from net._http_response where id = ${Number(id)}`,
					)
				).rows[0];
				if (r)
					return Number(r.c) === 200
						? String(r.b)
						: `error ${r.c} ${String(r.e).slice(0, 80)}`;
			}
			return "no response";
		};
		const bounce = async (t: P) => {
			const nm = `rr13_sub_${t.role.toLowerCase()}`;
			await sql(t.ctx, `alter subscription ${nm} disable`);
			await sleep(5_000);
			await sql(t.ctx, `alter subscription ${nm} enable`);
		};

		try {
			/* ---- RR13a ---- */
			const roles = ["S", "T", "T2"];
			const made = await Promise.all(
				roles.map(async (r) => {
					const body: Record<string, unknown> = {
						organization_slug: org,
						name: `${PREFIX}${stamp}-13${r.toLowerCase()}`,
						db_pass: dbPass,
						region_selection: { type: "specific", code: REGION },
					};
					if (r === "S") body.postgres_engine = "15";
					const res = await mgmt(ctx, "POST", "/projects", body);
					const j = (res.json ?? {}) as { ref?: string; id?: string };
					return {
						role: r,
						ref: String(j.ref ?? j.id ?? ""),
						status: res.status,
						text: res.text.slice(0, 160),
					};
				}),
			);
			for (const m of made)
				if (m.ref)
					ps.push({ role: m.role, ref: m.ref, ctx: forRef(ctx, m.ref) });
			if (ps.length !== roles.length) {
				push({
					id: "RR13a",
					title: "create S (15), T and T2 (17)",
					status: "fail",
					detail: made
						.map((m) => `${m.role} HTTP ${m.status} ${m.text}`)
						.join(" | "),
				});
				return out;
			}
			await Promise.all(ps.map((p) => waitProjectHealthy(ctx, p.ref)));
			const [S, T, T2] = ps as [P, P, P];
			const vers: Record<string, string> = {};
			for (const p of ps) {
				for (let i = 0; i < 36 && !vers[p.role]; i++) {
					const r = await sql(
						p.ctx,
						"select current_setting('server_version') as v",
					);
					if (r.rows[0]?.v) vers[p.role] = String(r.rows[0].v);
					else await sleep(5_000);
				}
			}
			let add = await mgmt(ctx, "PATCH", `/projects/${S.ref}/billing/addons`, {
				addon_variant: "ipv4_default",
				addon_type: "ipv4",
			});
			for (let i = 0; add.status === 429 && i < 5; i++) {
				await sleep(65_000);
				add = await mgmt(ctx, "PATCH", `/projects/${S.ref}/billing/addons`, {
					addon_variant: "ipv4_default",
					addon_type: "ipv4",
				});
			}
			const tAdd = Date.now();
			let sA: string[] = [];
			let sAAAA: string[] = ["?"];
			while (Date.now() - tAdd < 15 * 60_000) {
				sA = await dig("A", `db.${S.ref}.supabase.co`);
				sAAAA = await dig("AAAA", `db.${S.ref}.supabase.co`);
				if (sA.length && !sAAAA.length) break;
				await sleep(10_000);
			}
			const dnsS = Math.round((Date.now() - tAdd) / 1000);
			for (const a of sA) addrRole.set(a, "v4-S");
			const recs: string[] = [];
			for (const p of [T, T2]) {
				const a = await dig("A", `db.${p.ref}.supabase.co`);
				const q = await dig("AAAA", `db.${p.ref}.supabase.co`);
				for (const x of a) addrRole.set(x, `v4-db-${p.role}`);
				recs.push(`${p.role} A ${a.length} AAAA ${q.length}`);
			}
			push({
				id: "RR13a",
				title: `S on postgres_engine 15 with the IPv4 add-on, T and T2 on the default; default size, ${REGION}, ${ORG_ROLE} org; db host records`,
				status: sA.length && !sAAAA.length ? "pass" : "fail",
				detail: `versions S ${vers.S ?? "?"}, T ${vers.T ?? "?"}, T2 ${vers.T2 ?? "?"}; add-on PATCH HTTP ${add.status} ${add.status >= 300 ? add.text.slice(0, 120) : ""}; S A ${sA.length} AAAA ${sAAAA.length} after ${dnsS} s; ${recs.join("; ")}`,
				measurements: { s_dns_s: dnsS, s_a: sA.length, s_aaaa: sAAAA.length },
			});
			if (!sA.length || sAAAA.length) return out;

			/* ---- RR13b ---- */
			const ins = await sql(
				S.ctx,
				`${TABLE}; insert into public.rr13_t select g, 'seed' from generate_series(1, 1000) g`,
			);
			const pub = await sql(
				S.ctx,
				"create publication rr13_pub for table public.rr13_t",
			);
			for (const t of [T, T2]) await sql(t.ctx, TABLE);
			push({
				id: "RR13b",
				title: "S: 1,000 rows and a publication; T and T2: the table",
				status: ins.status < 300 && pub.status < 300 ? "pass" : "fail",
				detail: `insert HTTP ${ins.status} ${ins.error}; publication HTTP ${pub.status} ${pub.error}`,
			});
			if (ins.status >= 300 || pub.status >= 300) return out;

			/* ---- RR13c ---- */
			const conn = `host=db.${S.ref}.supabase.co port=5432 dbname=postgres user=postgres password=${dbPass}`;
			const subs: string[] = [];
			const probes: string[] = [];
			for (const t of [T, T2]) {
				const t0 = Date.now();
				// Probe S while the create runs: does the target's walsender arrive, what does it
				// wait on, and does any backend on S hold an xid (slot creation waits for those).
				let settled = false;
				const pending = sql(
					t.ctx,
					`create subscription rr13_sub_${t.role.toLowerCase()} connection '${conn}' publication rr13_pub`,
					150_000,
				).finally(() => {
					settled = true;
				});
				const seen = new Set<string>();
				while (!settled) {
					await sleep(5_000);
					if (settled) break;
					const w = await sql(
						S.ctx,
						"select host(client_addr) as a, application_name as app, state, coalesce(wait_event_type, '-') as wt, coalesce(wait_event, '-') as we, left(query, 60) as q from pg_stat_activity where backend_type = 'walsender'",
					);
					for (const r of w.rows)
						seen.add(
							`walsender ${r.app} from ${r.a ? role(String(r.a)) : "?"} ${r.state} ${r.wt}/${r.we} "${r.q}"`,
						);
					const x = await sql(
						S.ctx,
						"select backend_type as bt, backend_xid::text as xid, coalesce(application_name, '') as app, left(query, 50) as q from pg_stat_activity where backend_xid is not null and pid <> pg_backend_pid()",
					);
					for (const r of x.rows)
						seen.add(`xid holder ${r.bt} ${r.app} "${r.q}"`);
				}
				probes.push(`${t.role}: ${[...seen].join(" | ") || "nothing on S"}`);
				// The subscriber resolves S's host itself; retry while its resolver has not seen the A record yet.
				let c = await pending;
				for (
					let i = 0;
					i < 6 &&
					c.status >= 300 &&
					/translate host name|could not connect/i.test(c.error);
					i++
				) {
					await sleep(30_000);
					c = await sql(
						t.ctx,
						`create subscription rr13_sub_${t.role.toLowerCase()} connection '${conn}' publication rr13_pub`,
						150_000,
					);
				}
				let ready: number | "never" = "never";
				while (Date.now() - t0 < 300_000) {
					if (await allR(t.ctx)) {
						ready = Math.round((Date.now() - t0) / 1000);
						break;
					}
					await sleep(5_000);
				}
				subs.push(
					`${t.role} create HTTP ${c.status} ${c.error} every table r ${ready}${ready === "never" ? "" : "s"} rows ${await count(t.ctx)}`,
				);
			}
			const ws1 = await walsenders(S);
			const seenT = ws1.find((w) => w.app === "rr13_sub_t")?.a ?? "";
			const seenT2 = ws1.find((w) => w.app === "rr13_sub_t2")?.a ?? "";
			const rT = seenT ? role(seenT) : "unread";
			const rT2 = seenT2 ? role(seenT2) : "unread";
			push({
				id: "RR13c",
				title:
					"S open: T subscribes, then T2 once T has every table r; the addresses S sees",
				status: seenT && seenT2 ? "pass" : "fail",
				detail: `${subs.join("; ")}; S pg_stat_replication: ${ws1.map((w) => `${w.app} ${w.a} ${w.state}`).join(", ") || "none"}; T seen as ${rT} (${seenT.includes(":") ? "IPv6" : "IPv4"}), T2 seen as ${rT2}; T and T2 ${seenT && seenT === seenT2 ? "share" : "do not share"} an address`,
				measurements: {
					same_addr: seenT && seenT === seenT2 ? 1 : 0,
					seen_t_v4: seenT && !seenT.includes(":") ? 1 : 0,
				},
			});
			const tp = Date.now();
			const slotTry = await sql(
				S.ctx,
				"select slot_name::text as s from pg_create_logical_replication_slot('rr13_probe', 'pgoutput')",
				90_000,
			).catch((e) => ({ status: 0, rows: [], error: errText(e) }));
			const slotS = Math.round((Date.now() - tp) / 1000);
			if (slotTry.status < 300)
				await sql(S.ctx, "select pg_drop_replication_slot('rr13_probe')").catch(
					() => null,
				);
			push({
				id: "RR13c2",
				title:
					"probe: S's walsenders and xid holders while each create ran; a logical slot created directly on S",
				status: "info",
				detail: `${probes.join("; ")}; direct pg_create_logical_replication_slot on S: HTTP ${slotTry.status} after ${slotS} s ${slotTry.error ?? ""}`,
				measurements: { direct_slot_s: slotS },
			});
			if (!seenT) return out;

			/* ---- RR13c3 ---- */
			const eg: string[] = [];
			const egMatch: Record<string, number> = {};
			for (const [t, seenAddr] of [
				[T, seenT],
				[T2, seenT2],
			] as [P, string][]) {
				const e = await egress(t);
				const isAddr = /^[0-9.]+$/.test(e);
				egMatch[`${t.role}_egress_equals_seen`] =
					isAddr && e === seenAddr ? 1 : 0;
				eg.push(
					`${t.role} pg_net egress ${isAddr ? role(e) : e}, S saw ${seenAddr ? role(seenAddr) : "unread"}`,
				);
			}
			push({
				id: "RR13c3",
				title:
					"each target's own pg_net request to an IP echo service, against the address S saw",
				status: "info",
				detail: eg.join("; "),
				measurements: egMatch,
			});

			/* ---- RR13d ---- */
			const a1 = await restrict(S, [`${seenT}/32`], [DOC_V6]);
			await sleep(20_000);
			for (const t of [T, T2]) await bounce(t);
			await sql(
				S.ctx,
				"insert into public.rr13_t select g, 'allow-t' from generate_series(1001, 1100) g",
			);
			const [dT, dT2] = await Promise.all([
				waitRows(T.ctx, 1100, 120),
				waitRows(T2.ctx, 1100, 120),
			]);
			const ws2 = await walsenders(S);
			push({
				id: "RR13d",
				title: `S allows only the address S saw for T (/32) beside ${DOC_V6}; both targets reconnect`,
				status: dT.s !== "never" ? "pass" : "fail",
				detail: `apply HTTP ${a1}; after disable/enable and 100 rows: T ${dT.got} (${dT.s === "never" ? "not all in 120 s" : `all after ${dT.s}s`}), T2 ${dT2.got} (${dT2.s === "never" ? "not all in 120 s" : `all after ${dT2.s}s`}); S walsenders now: ${ws2.map((w) => `${w.app} ${w.a ? role(w.a) : "?"}`).join(", ") || "none"}`,
				measurements: {
					t_caught_up: dT.s === "never" ? 0 : 1,
					t2_caught_up: dT2.s === "never" ? 0 : 1,
				},
			});

			/* ---- RR13f ---- */
			const tr = Date.now();
			const rs = await mgmt(ctx, "POST", `/projects/${T.ref}/restart`);
			await sleep(30_000);
			const hl = await waitProjectHealthy(ctx, T.ref);
			await sql(
				S.ctx,
				"insert into public.rr13_t select g, 'after-restart' from generate_series(1101, 1200) g",
			);
			const fT = await waitRows(T.ctx, 1200, 180);
			let wsF = await walsenders(S);
			let afterAddr = wsF.find((w) => w.app === "rr13_sub_t")?.a ?? "";
			let opened = false;
			if (!afterAddr) {
				// Blocked: open S to read the address T now comes from.
				await restrict(S, ["0.0.0.0/0"], ["::/0"]);
				opened = true;
				for (let i = 0; i < 24 && !afterAddr; i++) {
					await sleep(5_000);
					wsF = await walsenders(S);
					afterAddr = wsF.find((w) => w.app === "rr13_sub_t")?.a ?? "";
				}
			}
			const egAfter = await egress(T);
			push({
				id: "RR13f",
				title:
					"T restarted under RR13d's restriction (only T's /32): does T reconnect, and from which address",
				status: "info",
				detail: `restart HTTP ${rs.status}; healthy ${hl.status} after ${30 + hl.waitedS} s (30 s fixed wait plus the health poll); step ended ${Math.round((Date.now() - tr) / 1000)} s after the call; 100 rows inserted on S: T ${fT.got} (${fT.s === "never" ? "not all in 180 s" : `all after ${fT.s}s`}); S then saw T as ${afterAddr ? role(afterAddr) : "unread"}${opened ? " (read after opening S)" : ""}, before the restart ${role(seenT)}; T's pg_net egress after the restart ${/^[0-9.]+$/.test(egAfter) ? role(egAfter) : egAfter}`,
				measurements: {
					same_after_restart: afterAddr && afterAddr === seenT ? 1 : 0,
					caught_up_under_old_rule: fT.s === "never" ? 0 : 1,
				},
			});

			/* ---- RR13e ---- */
			const a2 = await restrict(S, [DOC_V4], [DOC_V6]);
			await sleep(20_000);
			await bounce(T);
			await sql(
				S.ctx,
				"insert into public.rr13_t select g, 'blocked' from generate_series(1201, 1300) g",
			);
			const eT = await waitRows(T.ctx, 1300, 60);
			const ws3 = await walsenders(S);
			push({
				id: "RR13e",
				title: `S restricted to ${DOC_V4} and ${DOC_V6}; T reconnects (control)`,
				status: eT.s === "never" ? "pass" : "fail",
				detail: `apply HTTP ${a2}; T ${eT.got} after 60 s (${eT.s === "never" ? "the 100 rows did not arrive" : `all after ${eT.s}s`}); S walsenders: ${ws3.map((w) => `${w.app} ${w.a ? role(w.a) : "?"}`).join(", ") || "none"}`,
			});
		} catch (e) {
			push({
				id: "RR13",
				title: "unexpected error",
				status: "fail",
				detail: errText(e).slice(0, 400),
			});
		} finally {
			if (!keep && ps.length) {
				const notes: string[] = [];
				for (const p of ps.slice(1)) {
					const nm = `rr13_sub_${p.role.toLowerCase()}`;
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
					id: "RR13p",
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
