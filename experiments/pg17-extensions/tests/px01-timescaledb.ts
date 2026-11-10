/**
 * PX01 - TimescaleDB hypertables before a move to Postgres 17.
 *
 * `timescaledb` is not available on Supabase Postgres 17. The docs say to drop
 * it before an in-place upgrade and point to a guide that converts each
 * hypertable to native partitioning managed by pg_partman
 * (guides/database/migrating-to-pg-partman). This module runs that guide as
 * written, a corrected order, and both shapes of a logical-replication move
 * into a 17 project.
 *
 *   PX01a  P on postgres_engine "15" and T on the default 17, default compute size, in the org
 *          of role PVLAB_PX_ORG_ROLE (team); extension availability on each
 *   PX01b  P: create extension timescaledb; version and license setting
 *   PX01c  P: hypertable `messages` (identity id, primary key (id, sent_at)) and
 *          hypertable `events` (no primary key), 1-day chunks over 30 days;
 *          compression, a continuous aggregate and a retention policy tried
 *   PX01d  P: GET upgrade/eligibility with timescaledb installed
 *   PX01e  logical move of a hypertable as-is: publication on `messages`, what
 *          pg_publication_tables lists, a subscription on T into a plain table,
 *          rows copied, rows inserted after into an existing and a new chunk
 *   PX01f  the guide verbatim: rename, create table (like ... including all,
 *          primary key (sent_at, id)) partition by range, insert select; on
 *          `messages` and on `events`
 *   PX01g  a corrected order: pg_partman create_parent before the copy,
 *          overriding system value for the identity column, the identity
 *          sequence after the copy, dropping the hypertables and the extension,
 *          maintenance and the guide's pg_cron line
 *   PX01h  P: upgrade/eligibility again after the extension is gone
 *   PX01i  logical move after the conversion: publication with
 *          publish_via_partition_root on the partitioned `messages`, T's plain
 *          table, rows inserted after into a premade and a default partition
 *   PX01p  teardown
 *
 * DESTRUCTIVE and BILLABLE: two projects at the default compute size; 3 minutes on 2026-11-10.
 * Env: PVLAB_ORG_TEAM (or the role in PVLAB_PX_ORG_ROLE).
 */
import { mgmt } from "../../../harness/src/mgmt";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
	errText,
	forRef,
	sleep,
	waitProjectHealthy,
} from "../../replica-routing/lib/rr";

const REGION = process.env.PVLAB_PX_REGION ?? "ap-southeast-1";
const ORG_ROLE = process.env.PVLAB_PX_ORG_ROLE ?? "team";
const ROWS = Number(process.env.PVLAB_PX_ROWS ?? 300_000);
const PREFIX = "px-";

interface Step {
	label: string;
	status: number;
	error: string;
	rows: Record<string, unknown>[];
	ms: number;
}

const mod: TestModule = {
	id: "PX01",
	title:
		"TimescaleDB before Postgres 17: the pg_partman guide as written, a corrected order, and logical replication of a hypertable",
	where: "local",
	requires: ["pat"],
	destructive: true,

	async run(ctx: Ctx): Promise<TestResult[]> {
		const out: TestResult[] = [];
		let pRef = "";
		let tRef = "";
		const redact = (s: string) =>
			(pRef ? s.split(pRef).join("<ref-P>") : s)
				.split(tRef || "\u0000")
				.join("<ref-T>");
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
					id: "PX01",
					title: this.title,
					status: "skip",
					detail: `PVLAB_ORG_${ORG_ROLE.toUpperCase()} not set`,
				},
			];
		const keep = process.env.PVLAB_PX_KEEP === "1";
		const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
		const stamp = Date.now();

		const q = async (
			c: Ctx,
			label: string,
			text: string,
			timeoutMs = 120_000,
		): Promise<Step> => {
			const t0 = Date.now();
			const r = await sql(c, text, timeoutMs);
			return {
				label,
				status: r.status,
				error: r.error.replace(/\s+/g, " ").slice(0, 220),
				rows: r.rows,
				ms: Date.now() - t0,
			};
		};
		const brief = (s: Step) =>
			`${s.label}: ${s.status < 300 ? "ok" : `HTTP ${s.status} ${s.error}`}${s.status < 300 && s.rows.length && s.rows.length <= 3 ? ` ${JSON.stringify(s.rows).slice(0, 160)}` : ""}`;
		const one = (s: Step, k: string) => s.rows[0]?.[k];

		try {
			/* ---- PX01a ---- */
			const mk = async (suffix: string, engine?: string) => {
				const body: Record<string, unknown> = {
					organization_slug: org,
					name: `${PREFIX}${stamp}-${suffix}`,
					db_pass: dbPass,
					region_selection: { type: "specific", code: REGION },
				};
				if (engine) body.postgres_engine = engine;
				const r = await mgmt(ctx, "POST", "/projects", body);
				const j = (r.json ?? {}) as { ref?: string; id?: string };
				return {
					ref: String(j.ref ?? j.id ?? ""),
					status: r.status,
					text: r.text.slice(0, 200),
				};
			};
			const [cp, ct] = await Promise.all([mk("p", "15"), mk("t")]);
			pRef = cp.ref;
			tRef = ct.ref;
			if (!pRef || !tRef) {
				push({
					id: "PX01a",
					title: "create P (15) and T (17)",
					status: "fail",
					detail: `P HTTP ${cp.status} ${cp.text} | T HTTP ${ct.status} ${ct.text}`,
				});
				return out;
			}
			const P = forRef(ctx, pRef);
			const T = forRef(ctx, tRef);
			const [hp, ht] = await Promise.all([
				waitProjectHealthy(ctx, pRef),
				waitProjectHealthy(ctx, tRef),
			]);
			const ready = async (c: Ctx) => {
				for (let i = 0; i < 36; i++) {
					const r = await q(
						c,
						"version",
						"select current_setting('server_version') as v",
					);
					if (r.status < 300 && one(r, "v")) return String(one(r, "v"));
					await sleep(5_000);
				}
				return "";
			};
			const [vp, vt] = await Promise.all([ready(P), ready(T)]);
			const avail =
				"select string_agg(name || ' ' || coalesce(default_version, '?'), ', ' order by name) as a from pg_available_extensions where name in ('timescaledb', 'pg_partman', 'pg_cron')";
			const [ap, at] = await Promise.all([
				q(P, "available", avail),
				q(T, "available", avail),
			]);
			push({
				id: "PX01a",
				title: `P on postgres_engine 15, T on the default; default compute size, ${REGION}, ${ORG_ROLE} org`,
				status:
					vp &&
					vt &&
					hp.status === "ACTIVE_HEALTHY" &&
					ht.status === "ACTIVE_HEALTHY"
						? "pass"
						: "fail",
				detail: `P ${vp} (healthy ${hp.waitedS}s), available: ${one(ap, "a") ?? ap.error}; T ${vt} (healthy ${ht.waitedS}s), available: ${one(at, "a") ?? at.error}`,
				measurements: {
					p_version: vp,
					t_version: vt,
					p_available: String(one(ap, "a") ?? ""),
					t_available: String(one(at, "a") ?? ""),
				},
			});
			if (!vp || !vt) return out;

			/* ---- PX01b ---- */
			const ext = await q(
				P,
				"create extension timescaledb",
				"create extension if not exists timescaledb with schema extensions",
			);
			const extv = await q(
				P,
				"version",
				"select extversion as v, current_setting('timescaledb.license', true) as license from pg_extension where extname = 'timescaledb'",
			);
			push({
				id: "PX01b",
				title: "P: create extension timescaledb",
				status: ext.status < 300 && one(extv, "v") ? "pass" : "fail",
				detail: `${brief(ext)}; version ${one(extv, "v") ?? "-"}, timescaledb.license ${one(extv, "license") ?? "-"}`,
				measurements: {
					timescaledb_version: String(one(extv, "v") ?? ""),
					license: String(one(extv, "license") ?? ""),
				},
			});
			if (ext.status >= 300) return out;

			/* ---- PX01c ---- */
			const fx: Step[] = [];
			fx.push(
				await q(
					P,
					"messages table",
					"create table public.messages (id bigint generated always as identity, sent_at timestamptz not null, body text, primary key (id, sent_at))",
				),
			);
			fx.push(
				await q(
					P,
					"messages hypertable",
					"select create_hypertable('public.messages', 'sent_at', chunk_time_interval => interval '1 day') as h",
				),
			);
			fx.push(
				await q(
					P,
					"events table",
					"create table public.events (id bigint not null, sent_at timestamptz not null, body text)",
				),
			);
			fx.push(
				await q(
					P,
					"events hypertable",
					"select create_hypertable('public.events', 'sent_at', chunk_time_interval => interval '1 day') as h",
				),
			);
			fx.push(
				await q(
					P,
					"messages rows",
					`insert into public.messages (sent_at, body) select now() - (g % 30) * interval '1 day' - (g % 86000) * interval '1 second', md5(g::text) from generate_series(1, ${ROWS}) g`,
				),
			);
			fx.push(
				await q(
					P,
					"events rows",
					`insert into public.events select g, now() - (g % 30) * interval '1 day' - (g % 86000) * interval '1 second', md5(g::text) from generate_series(1, ${ROWS}) g`,
				),
			);
			const chunks = await q(
				P,
				"chunks",
				"select (select count(*) from show_chunks('public.messages'))::int as m, (select count(*) from show_chunks('public.events'))::int as e",
			);
			const comp = await q(
				P,
				"compression",
				"alter table public.messages set (timescaledb.compress, timescaledb.compress_orderby = 'sent_at desc')",
			);
			const compN =
				comp.status < 300
					? await q(
							P,
							"compress chunks",
							"select count(*)::int as n from (select compress_chunk(c) from show_chunks('public.messages', older_than => now() - interval '7 days') c) x",
						)
					: undefined;
			const cagg = await q(
				P,
				"continuous aggregate",
				"create materialized view public.messages_daily with (timescaledb.continuous) as select time_bucket('1 day', sent_at) as day, count(*) as n from public.messages group by 1 with no data",
			);
			const ret = await q(
				P,
				"retention policy",
				"select add_retention_policy('public.events', interval '90 days') as job",
			);
			const jobs = await q(
				P,
				"jobs",
				"select count(*)::int as n from timescaledb_information.jobs",
			);
			const fxOk = fx.every((s) => s.status < 300);
			push({
				id: "PX01c",
				title: `P: hypertables messages (identity, primary key (id, sent_at)) and events (no primary key), ${ROWS} rows each over 30 days; TSL features tried`,
				status: fxOk ? "pass" : "fail",
				detail: `${
					fx
						.filter((s) => s.status >= 300)
						.map(brief)
						.join("; ") || "fixture ok"
				}; chunks messages ${one(chunks, "m")}, events ${one(chunks, "e")}; ${brief(comp)}${compN ? `; ${brief(compN)}` : ""}; ${brief(cagg)}; ${brief(ret)}; timescaledb_information.jobs ${one(jobs, "n") ?? jobs.error}`,
				measurements: {
					compression: comp.status < 300 ? "ok" : comp.error,
					continuous_aggregate: cagg.status < 300 ? "ok" : cagg.error,
					retention_policy: ret.status < 300 ? "ok" : ret.error,
				},
			});
			if (!fxOk) return out;

			/* ---- PX01d ---- */
			const elig = async () => {
				const r = await mgmt(P, "GET", `/projects/${pRef}/upgrade/eligibility`);
				const j = (r.json ?? {}) as {
					eligible?: boolean;
					validation_errors?: unknown[];
					warnings?: unknown[];
					duration_estimate_hours?: number;
				};
				const ve = JSON.stringify(j.validation_errors ?? []);
				return {
					status: r.status,
					eligible: j.eligible,
					ts: /timescale/i.test(ve),
					ve: ve.slice(0, 400),
					warn: JSON.stringify(j.warnings ?? []).slice(0, 200),
				};
			};
			const e1 = await elig();
			push({
				id: "PX01d",
				title: "P: upgrade/eligibility with timescaledb installed",
				status: e1.status === 200 ? "pass" : "fail",
				detail: `HTTP ${e1.status}; eligible ${e1.eligible}; timescaledb in validation_errors ${e1.ts}; validation_errors ${e1.ve}; warnings ${e1.warn}`,
				measurements: {
					eligible: String(e1.eligible),
					timescaledb_listed: String(e1.ts),
				},
			});

			/* ---- PX01e: hypertable as-is through logical replication ---- */
			const conn = `host=db.${pRef}.supabase.co port=5432 dbname=postgres user=postgres password=${dbPass} options=''-c statement_timeout=0''`;
			const pubHt = await q(
				P,
				"publication on hypertable",
				"create publication px_ht for table public.messages",
			);
			const pubTables = await q(
				P,
				"pg_publication_tables",
				"select count(*)::int as n, count(*) filter (where schemaname = '_timescaledb_internal')::int as chunks, min(schemaname || '.' || tablename) as first from pg_publication_tables where pubname = 'px_ht'",
			);
			const tTable = await q(
				T,
				"T table",
				"create table public.messages (id bigint, sent_at timestamptz not null, body text, primary key (sent_at, id))",
			);
			const subHt = await q(
				T,
				"subscription",
				`create subscription px_ht_sub connection '${conn}' publication px_ht`,
			);
			await sleep(60_000);
			const relHt = await q(
				T,
				"pg_subscription_rel",
				"select count(*)::int as n, string_agg(srrelid::regclass::text || ':' || srsubstate, ' ' order by srrelid::regclass::text) as rels from pg_subscription_rel",
			);
			const nT1 = await q(
				T,
				"rows on T",
				"select count(*)::int as n from public.messages",
			);
			const lateHt = await q(
				P,
				"late rows",
				"insert into public.messages (sent_at, body) select now() - interval '1 minute', 'late-existing' from generate_series(1, 100) union all select now() + interval '10 days', 'late-new-chunk' from generate_series(1, 100)",
			);
			await sleep(30_000);
			const nT2 = await q(
				T,
				"rows on T after",
				"select count(*)::int as n, count(*) filter (where body = 'late-existing')::int as ex, count(*) filter (where body = 'late-new-chunk')::int as nc from public.messages",
			);
			const nP = await q(
				P,
				"rows on P",
				"select count(*)::int as n from public.messages",
			);
			push({
				id: "PX01e",
				title:
					"logical move of the hypertable as-is: publication, pg_publication_tables, subscription on T into a plain table, rows after",
				status: subHt.status < 300 ? "pass" : "fail",
				detail: `${brief(pubHt)}; publication lists ${one(pubTables, "n")} tables (${one(pubTables, "chunks")} in _timescaledb_internal, first ${one(pubTables, "first")}); ${brief(tTable)}; ${brief(subHt)}; after 60 s pg_subscription_rel ${one(relHt, "n")} (${String(one(relHt, "rels") ?? "").slice(0, 300)}); rows on T ${one(nT1, "n")} of ${one(nP, "n")} on P; ${brief(lateHt)}; 30 s later T ${one(nT2, "n")} (late-existing ${one(nT2, "ex")}, late-new-chunk ${one(nT2, "nc")})`,
				measurements: {
					pub_tables: Number(one(pubTables, "n") ?? -1),
					pub_chunks: Number(one(pubTables, "chunks") ?? -1),
					rows_t: Number(one(nT1, "n") ?? -1),
					rows_p: Number(one(nP, "n") ?? -1),
					late_existing_t: Number(one(nT2, "ex") ?? -1),
					late_new_chunk_t: Number(one(nT2, "nc") ?? -1),
				},
			});
			for (const s of [
				"alter subscription px_ht_sub disable",
				"alter subscription px_ht_sub set (slot_name = none)",
				"drop subscription if exists px_ht_sub",
				"drop table if exists public.messages",
			])
				await q(T, s, s);
			await q(
				P,
				"drop slot",
				"select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name like 'px_ht_sub%'",
			);
			await q(
				P,
				"drop sync slots",
				"select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name like 'pg_%_sync_%' and not active",
			);
			await q(P, "drop publication", "drop publication if exists px_ht");

			/* ---- PX01f: the guide verbatim ---- */
			const gm1 = await q(
				P,
				"messages: rename",
				"alter table public.messages rename to ht_messages",
			);
			const gm2 = await q(
				P,
				"messages: create partitioned (like including all, primary key (sent_at, id))",
				"create table public.messages (like public.ht_messages including all, primary key (sent_at, id)) partition by range (sent_at)",
			);
			const ge1 = await q(
				P,
				"events: rename",
				"alter table public.events rename to ht_events",
			);
			const ge2 = await q(
				P,
				"events: create partitioned (like including all, primary key (sent_at, id))",
				"create table public.events (like public.ht_events including all, primary key (sent_at, id)) partition by range (sent_at)",
			);
			const ge3 =
				ge2.status < 300
					? await q(
							P,
							"events: insert select *",
							"insert into public.events select * from public.ht_events",
						)
					: undefined;
			push({
				id: "PX01f",
				title:
					"the guide verbatim: rename, create table (like ... including all, primary key (sent_at, id)) partition by range, insert select",
				status: gm1.status < 300 && ge1.status < 300 ? "pass" : "fail",
				detail: [gm1, gm2, ge1, ge2, ge3]
					.filter(Boolean)
					.map((s) => brief(s as Step))
					.join("; "),
				measurements: {
					messages_create: gm2.status < 300 ? "ok" : gm2.error,
					events_create: ge2.status < 300 ? "ok" : ge2.error,
					events_insert: ge3
						? ge3.status < 300
							? "ok"
							: ge3.error
						: "not reached",
				},
			});

			/* ---- PX01g: corrected order ---- */
			const g: Step[] = [];
			if (gm2.status < 300)
				g.push(await q(P, "drop guide messages", "drop table public.messages"));
			if (ge2.status < 300)
				g.push(await q(P, "drop guide events", "drop table public.events"));
			g.push(
				await q(P, "partman schema", "create schema if not exists partman"),
			);
			const pm = await q(
				P,
				"create extension pg_partman",
				"create extension if not exists pg_partman with schema partman",
			);
			g.push(pm);
			const pmv = await q(
				P,
				"partman version",
				"select extversion as v from pg_extension where extname = 'pg_partman'",
			);
			const startOf = async (t: string) =>
				String(
					one(
						await q(
							P,
							"start",
							`select to_char(date_trunc('day', min(sent_at)), 'YYYY-MM-DD HH24:MI:SSOF') as s from public.${t}`,
						),
						"s",
					) ?? "",
				);
			const sEv = await startOf("ht_events");
			const sMs = await startOf("ht_messages");
			const cp1 = async (t: string, start: string) =>
				q(
					P,
					`${t}: create_parent`,
					`select partman.create_parent(p_parent_table := 'public.${t}', p_control := 'sent_at', p_type := 'range', p_interval := '1 day', p_premake := 7, p_start_partition := '${start}') as ok`,
				);
			// events: no identity, the guide's create, then create_parent BEFORE the copy
			g.push(
				await q(
					P,
					"events: create partitioned",
					"create table public.events (like public.ht_events including all, primary key (sent_at, id)) partition by range (sent_at)",
				),
			);
			g.push(await cp1("events", sEv));
			const evCopy = await q(
				P,
				"events: insert select *",
				"insert into public.events select * from public.ht_events",
				300_000,
			);
			g.push(evCopy);
			// messages: without the copied primary key; identity kept
			g.push(
				await q(
					P,
					"messages: create partitioned",
					"create table public.messages (like public.ht_messages including defaults including constraints including identity including generated, primary key (sent_at, id)) partition by range (sent_at)",
				),
			);
			g.push(await cp1("messages", sMs));
			const msPlain = await q(
				P,
				"messages: insert select *",
				"insert into public.messages select * from public.ht_messages",
				300_000,
			);
			const msOver =
				msPlain.status < 300
					? undefined
					: await q(
							P,
							"messages: insert overriding system value",
							"insert into public.messages overriding system value select * from public.ht_messages",
							300_000,
						);
			const counts = await q(
				P,
				"counts",
				"select (select count(*) from public.ht_events)::int as he, (select count(*) from public.events)::int as e, (select count(*) from public.events_default)::int as ed, (select count(*) from pg_inherits where inhparent = 'public.events'::regclass)::int as ep, (select count(*) from public.ht_messages)::int as hm, (select count(*) from public.messages)::int as m, (select count(*) from public.messages_default)::int as md",
			);
			const maxId = Number(
				one(
					await q(
						P,
						"max id",
						"select max(id)::bigint as m from public.messages",
					),
					"m",
				) ?? -1,
			);
			const newRow1 = await q(
				P,
				"new row before setval",
				"insert into public.messages (sent_at, body) values (now(), 'after-copy-1') returning id",
			);
			const id1 = Number(one(newRow1, "id") ?? -1);
			const dup1 = Number(
				one(
					await q(
						P,
						"dup check",
						`select count(*)::int as n from public.messages where id = ${id1}`,
					),
					"n",
				) ?? -1,
			);
			const setv = await q(
				P,
				"setval",
				"select setval(pg_get_serial_sequence('public.messages', 'id'), (select max(id) from public.messages)) as v",
			);
			const newRow2 = await q(
				P,
				"new row after setval",
				"insert into public.messages (sent_at, body) values (now(), 'after-copy-2') returning id",
			);
			const dropHm = await q(
				P,
				"drop table ht_messages",
				"drop table public.ht_messages",
			);
			const dropCagg =
				dropHm.status >= 300 && cagg.status < 300
					? await q(
							P,
							"drop continuous aggregate",
							"drop materialized view public.messages_daily",
						)
					: undefined;
			const dropHm2 =
				dropHm.status >= 300
					? await q(
							P,
							"drop table ht_messages again",
							"drop table public.ht_messages",
						)
					: undefined;
			const dropHe = await q(
				P,
				"drop table ht_events",
				"drop table public.ht_events",
			);
			const dropExt = await q(
				P,
				"drop extension timescaledb",
				"drop extension if exists timescaledb",
			);
			const maint = await q(
				P,
				"run_maintenance_proc",
				"call partman.run_maintenance_proc()",
			);
			const cronExt = await q(
				P,
				"create extension pg_cron",
				"create extension if not exists pg_cron",
			);
			const cronJob = await q(
				P,
				"guide's cron.schedule",
				"select cron.schedule('@daily', $$call partman.run_maintenance_proc()$$) as job",
			);
			const c = counts.rows[0] ?? {};
			const copied =
				Number(c.e) === Number(c.he) &&
				Number(c.m) === Number(c.hm) &&
				Number(c.he) > 0;
			push({
				id: "PX01g",
				title:
					"corrected order: create_parent before the copy, overriding system value, identity sequence after the copy, drops, maintenance, the guide's pg_cron line",
				status: copied && dropExt.status < 300 ? "pass" : "fail",
				detail: `${
					g
						.filter((s) => s.status >= 300)
						.map(brief)
						.join("; ") || "setup ok"
				}; pg_partman ${one(pmv, "v") ?? pm.error}; events copy ${evCopy.status < 300 ? `${evCopy.ms} ms` : evCopy.error}; ${brief(msPlain)}${msOver ? `; ${brief(msOver)} (${msOver.ms} ms)` : ""}; counts events ${c.e}/${c.he} (default partition ${c.ed}, ${c.ep} partitions), messages ${c.m}/${c.hm} (default ${c.md}); max id ${maxId}; new row before setval got id ${id1}, rows with that id ${dup1}; ${brief(setv)}; new row after setval id ${one(newRow2, "id") ?? newRow2.error}; ${brief(dropHm)}${dropCagg ? `; ${brief(dropCagg)}` : ""}${dropHm2 ? `; ${brief(dropHm2)}` : ""}; ${brief(dropHe)}; ${brief(dropExt)}; ${brief(maint)}; ${brief(cronExt)}; ${brief(cronJob)}`,
				measurements: {
					events_copy_ms: evCopy.ms,
					messages_plain_insert: msPlain.status < 300 ? "ok" : msPlain.error,
					id_before_setval: id1,
					rows_with_that_id: dup1,
					max_id: maxId,
					drop_extension: dropExt.status < 300 ? "ok" : dropExt.error,
				},
			});

			/* ---- PX01h ---- */
			const e2 = await elig();
			push({
				id: "PX01h",
				title: "P: upgrade/eligibility after the extension is dropped",
				status: e2.status === 200 ? "pass" : "fail",
				detail: `HTTP ${e2.status}; eligible ${e2.eligible}; timescaledb in validation_errors ${e2.ts}; validation_errors ${e2.ve}`,
				measurements: {
					eligible_after: String(e2.eligible),
					timescaledb_listed_after: String(e2.ts),
				},
			});

			/* ---- PX01i: partitioned table through logical replication ---- */
			const pubNp = await q(
				P,
				"publication publish_via_partition_root",
				"create publication px_np for table public.messages with (publish_via_partition_root = true)",
			);
			const tTable2 = await q(
				T,
				"T plain table",
				"create table public.messages (id bigint, sent_at timestamptz not null, body text, primary key (sent_at, id))",
			);
			const subNp = await q(
				T,
				"subscription",
				`create subscription px_np_sub connection '${conn}' publication px_np`,
			);
			let readyS: number | "never" = "never";
			const tS = Date.now();
			while (subNp.status < 300 && Date.now() - tS < 5 * 60_000) {
				await sleep(10_000);
				const st = String(
					one(
						await q(
							T,
							"state",
							"select coalesce(string_agg(srsubstate::text, ''), '') as s from pg_subscription_rel",
						),
						"s",
					) ?? "",
				);
				if (st && /^r+$/.test(st)) {
					readyS = Math.round((Date.now() - tS) / 1000);
					break;
				}
			}
			const pBefore = Number(
				one(
					await q(
						P,
						"rows on P",
						"select count(*)::int as n from public.messages",
					),
					"n",
				) ?? -1,
			);
			const tBefore = Number(
				one(
					await q(
						T,
						"rows on T",
						"select count(*)::int as n from public.messages",
					),
					"n",
				) ?? -1,
			);
			const late = await q(
				P,
				"late rows",
				"insert into public.messages (sent_at, body) select now() + interval '3 days', 'late-premade' from generate_series(1, 100) union all select now() + interval '30 days', 'late-default' from generate_series(1, 100)",
			);
			await sleep(30_000);
			const tAfter = await q(
				T,
				"rows on T after",
				"select count(*)::int as n, count(*) filter (where body = 'late-premade')::int as pm, count(*) filter (where body = 'late-default')::int as df from public.messages",
			);
			const pDef = await q(
				P,
				"P default partition",
				"select count(*)::int as n from public.messages_default",
			);
			push({
				id: "PX01i",
				title:
					"logical move after the conversion: publish_via_partition_root on the partitioned table into a plain table on T, rows after",
				status:
					subNp.status < 300 &&
					readyS !== "never" &&
					tBefore === pBefore &&
					Number(one(tAfter, "pm")) === 100 &&
					Number(one(tAfter, "df")) === 100
						? "pass"
						: "fail",
				detail: `${brief(pubNp)}; ${brief(tTable2)}; ${brief(subNp)}; tables r after ${readyS}s; rows P ${pBefore}, T ${tBefore}; ${brief(late)}; P default partition holds ${one(pDef, "n")}; 30 s later T ${one(tAfter, "n")} (late-premade ${one(tAfter, "pm")}, late-default ${one(tAfter, "df")})`,
				measurements: { sync_s: readyS, rows_p: pBefore, rows_t: tBefore },
			});
			for (const s of [
				"alter subscription px_np_sub disable",
				"alter subscription px_np_sub set (slot_name = none)",
				"drop subscription if exists px_np_sub",
			])
				await q(T, s, s);
			await q(
				P,
				"drop slot",
				"select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name like 'px_np_sub%'",
			);
		} catch (e) {
			push({
				id: "PX01",
				title: "unexpected error",
				status: "fail",
				detail: errText(e).slice(0, 400),
			});
		} finally {
			if (!keep) {
				const notes: string[] = [];
				for (const r of [pRef, tRef].filter(Boolean)) {
					let del = await mgmt(ctx, "DELETE", `/projects/${r}`).catch(
						() => null,
					);
					for (
						let i = 0;
						i < 6 && (del?.status ?? 0) >= 300 && del?.status !== 404;
						i++
					) {
						await sleep(30_000);
						del = await mgmt(ctx, "DELETE", `/projects/${r}`).catch(() => null);
					}
					notes.push(`${r === pRef ? "P" : "T"} delete ${del?.status ?? 0}`);
				}
				push({
					id: "PX01p",
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
