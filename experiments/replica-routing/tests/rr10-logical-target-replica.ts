/**
 * RR10 - read replicas around a Postgres 15 -> 17 move by logical replication.
 *
 * The question a team asks when it moves a database with replicas into a new
 * 17 project: does the source's replica have to go, and on the new project do
 * you add the replica before the initial copy or after every table is synced?
 * RR09 run 1 (2026-11-09) added a replica after a 3.9 GB load and it never
 * served in 45 minutes; runs 2 and 3 added it to an empty primary and loaded
 * afterwards, and both served. One explanation would be that a replica is
 * built from the latest completed physical backup plus WAL replay. This module
 * puts both orders side by side on two 17 targets subscribed to one 15 source.
 *
 *   RR10a  three Small projects in the org of role PVLAB_RR10_ORG_ROLE (team):
 *          source S on postgres_engine "15", targets A and B on the default 17;
 *          pitr_7 and a grown disk on each; physical backups listed
 *   RR10b  S: replica added while S is empty (as RR09 runs 2-3), then a table of
 *          PVLAB_RR10_ROWS rows of ~1 KB loaded (streams to S's replica), then a
 *          publication. Skipped with PVLAB_RR10_SRC_REPLICA=0
 *   RR10c  A: replica added while A is empty, before any subscription
 *   RR10d  subscriptions on A and B at the same time, over S's direct
 *          connection with statement_timeout=0; time to
 *          every table `r`; A's replica lag and S's replica lag sampled during
 *          the copy; row counts on A, A's replica and B
 *   RR10e  B: backups listed, then a replica added after the sync; time to a
 *          first session, or "never" within PVLAB_RR10_SERVE_MIN minutes, with
 *          the pooler entry and backups at the end
 *   RR10f  1,000 rows inserted on S after both syncs: arrival on A, A's replica,
 *          B and (if it served) B's replica
 *   RR10p  teardown: subscriptions dropped, replicas removed, projects deleted
 *
 * DESTRUCTIVE and BILLABLE: three Small projects, up to three Small replicas,
 * pitr_7 and a PVLAB_RR10_DISK_GB disk on each; 116 minutes on 2026-11-10.
 * Env: PVLAB_ORG_TEAM (or the role in PVLAB_RR10_ORG_ROLE).
 */
import { appendFileSync } from "node:fs";
import { mgmt } from "../../../harness/src/mgmt";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
	applyAddon,
	connectSession,
	errText,
	forRef,
	type PoolerEntry,
	PREFIX,
	poolerConfig,
	round,
	selectedAddons,
	sleep,
	waitProjectHealthy,
} from "../lib/rr";

const REGION = process.env.PVLAB_RR10_REGION ?? "ap-southeast-1";
const ORG_ROLE = process.env.PVLAB_RR10_ORG_ROLE ?? "team";
const ROWS = Number(process.env.PVLAB_RR10_ROWS ?? 4_000_000);
const DISK_GB = Number(process.env.PVLAB_RR10_DISK_GB ?? 24);
const SERVE_MIN = Number(process.env.PVLAB_RR10_SERVE_MIN ?? 60);
const SYNC_MIN = Number(process.env.PVLAB_RR10_SYNC_MIN ?? 40);
const SRC_REPLICA = (process.env.PVLAB_RR10_SRC_REPLICA ?? "1") !== "0";
const LOAD_CHUNK = 200_000;

const TABLE = `create table if not exists public.rr10_t (id bigint primary key, payload text not null)`;

interface Proj {
	role: "S" | "A" | "B";
	ref: string;
	ctx: Ctx;
	primary?: PoolerEntry;
	replica?: PoolerEntry;
}

interface BackupRow {
	is_physical_backup: boolean;
	status: string;
	inserted_at: string;
}

/** Completed physical backups, newest first, as "inserted_at" strings. */
async function physicalBackups(ctx: Ctx, ref: string): Promise<string[]> {
	const r = await mgmt(ctx, "GET", `/projects/${ref}/database/backups`).catch(
		() => null,
	);
	const rows = ((r?.json ?? {}) as { backups?: BackupRow[] }).backups ?? [];
	return rows
		.filter((b) => b.is_physical_backup && b.status === "COMPLETED")
		.map((b) => b.inserted_at)
		.sort()
		.reverse();
}

async function create(
	ctx: Ctx,
	org: string,
	name: string,
	dbPass: string,
	engine?: string,
): Promise<{ ref: string; status: number; text: string }> {
	const body: Record<string, unknown> = {
		organization_slug: org,
		name,
		db_pass: dbPass,
		region_selection: { type: "specific", code: REGION },
		desired_instance_size: "small",
	};
	if (engine) body.postgres_engine = engine;
	const r = await mgmt(ctx, "POST", "/projects", body);
	const j = (r.json ?? {}) as { ref?: string; id?: string };
	return {
		ref: String(j.ref ?? j.id ?? ""),
		status: r.status,
		text: r.text.slice(0, 300),
	};
}

async function growDisk(ctx: Ctx, ref: string): Promise<number | string> {
	const cur = await mgmt(ctx, "GET", `/projects/${ref}/config/disk`);
	const attrs =
		((cur.json ?? {}) as { attributes?: Record<string, unknown> }).attributes ??
		{};
	const grow = await mgmt(ctx, "POST", `/projects/${ref}/config/disk`, {
		attributes: { ...attrs, size_gb: DISK_GB },
	});
	if (grow.status >= 300) return `POST ${grow.status}`;
	const t0 = Date.now();
	while (Date.now() - t0 < 15 * 60_000) {
		const u = await mgmt(ctx, "GET", `/projects/${ref}/config/disk/util`).catch(
			() => null,
		);
		const fs =
			((u?.json ?? {}) as { metrics?: { fs_size_bytes?: number } }).metrics
				?.fs_size_bytes ?? 0;
		if (fs > (DISK_GB - 3) * 1024 ** 3)
			return Math.round((Date.now() - t0) / 1000);
		await sleep(15_000);
	}
	return "never";
}

/** POST read-replicas/setup (retried while the API refuses), then wait for a session on the replica's pooler entry. */
async function addReplica(
	p: Proj,
	dbPass: string,
	waitMin: number,
	onPoll?: (s: number) => Promise<void>,
): Promise<{
	setup: number;
	servedS: number | "never";
	text: string;
	entry?: PoolerEntry;
}> {
	const t1 = Date.now();
	let setup = await mgmt(
		p.ctx,
		"POST",
		`/projects/${p.ref}/read-replicas/setup`,
		{ read_replica_region: REGION },
	);
	while (
		setup.status >= 300 &&
		setup.status !== 402 &&
		Date.now() - t1 < 12 * 60_000
	) {
		await sleep(30_000);
		setup = await mgmt(
			p.ctx,
			"POST",
			`/projects/${p.ref}/read-replicas/setup`,
			{ read_replica_region: REGION },
		);
	}
	if (setup.status >= 300)
		return {
			setup: setup.status,
			servedS: "never",
			text: setup.text.slice(0, 200),
		};
	let entry: PoolerEntry | undefined;
	while (Date.now() - t1 < waitMin * 60_000) {
		entry = (await poolerConfig(p.ctx, p.ref).catch(() => [])).find(
			(e) => e.database_type === "READ_REPLICA",
		);
		if (entry) {
			try {
				const c = await connectSession(entry, dbPass, 1, 0);
				await c.end();
				p.replica = entry;
				return {
					setup: setup.status,
					servedS: Math.round((Date.now() - t1) / 1000),
					text: "",
					entry,
				};
			} catch {}
		}
		if (onPoll) await onPoll(Math.round((Date.now() - t1) / 1000));
		await sleep(15_000);
	}
	return { setup: setup.status, servedS: "never", text: "", entry };
}

async function count(e: PoolerEntry, dbPass: string): Promise<number | string> {
	try {
		const c = await connectSession(e, dbPass, 3, 5_000);
		try {
			await c.query("set statement_timeout = 0");
			const r = await c.query(
				"select count(*)::bigint as n from public.rr10_t",
			);
			return Number(r.rows[0]?.n ?? -1);
		} finally {
			await c.end().catch(() => {});
		}
	} catch (e) {
		return `error: ${errText(e).slice(0, 120)}`;
	}
}

/** Replica lag on a primary, from pg_stat_replication rows that are not walsenders for a subscription. */
async function replicaLag(
	ctx: Ctx,
	subPrefix: string,
): Promise<{ bytes: number; replayMs: number; rows: number }> {
	const r = await sql(
		ctx,
		`select coalesce(max(pg_wal_lsn_diff(sent_lsn, replay_lsn)), -1)::bigint as bytes,
            coalesce(max(extract(epoch from replay_lag) * 1000), -1)::bigint as ms, count(*)::int as n
       from pg_stat_replication where application_name not like '${subPrefix}%' and application_name not like 'pg_%sync%'`,
	);
	const row = r.rows[0] ?? {};
	return {
		bytes: Number(row.bytes ?? -1),
		replayMs: Number(row.ms ?? -1),
		rows: Number(row.n ?? 0),
	};
}

async function syncState(
	ctx: Ctx,
): Promise<{ states: string; ready: boolean }> {
	const r = await sql(
		ctx,
		"select coalesce(string_agg(srsubstate::text, ''), '') as s from pg_subscription_rel",
	);
	const s = String(r.rows[0]?.s ?? "");
	return {
		states: s || `none (${r.status} ${r.error.slice(0, 80)})`,
		ready: s.length > 0 && /^r+$/.test(s),
	};
}

async function dropSub(ctx: Ctx, name: string): Promise<string> {
	const out: string[] = [];
	for (const q of [
		`alter subscription ${name} disable`,
		`alter subscription ${name} set (slot_name = none)`,
		`drop subscription if exists ${name}`,
	]) {
		const r = await sql(ctx, q);
		out.push(String(r.status));
	}
	return out.join("/");
}

const mod: TestModule = {
	id: "RR10",
	title:
		"Read replicas around a 15 -> 17 move by logical replication: source replica, target replica before vs after the initial copy",
	where: "local",
	requires: ["pat"],
	destructive: true,

	async run(ctx: Ctx): Promise<TestResult[]> {
		const out: TestResult[] = [];
		const projs: Proj[] = [];
		const redact = (s: string) => {
			let r = s;
			for (const p of projs) {
				if (p.ref) r = r.split(p.ref).join(`<ref-${p.role}>`);
				if (p.replica?.identifier)
					r = r.split(p.replica.identifier).join(`<replica-${p.role}>`);
			}
			return r;
		};
		const push = (r: TestResult) => {
			r.detail = r.detail ? redact(r.detail) : r.detail;
			r.evidence = r.evidence ? redact(r.evidence) : r.evidence;
			out.push(r);
			ctx.log(
				`${r.id} ${r.status}${r.detail ? `: ${r.detail.slice(0, 300)}` : ""}`,
			);
		};
		const org = ctx.orgs[ORG_ROLE];
		if (!org)
			return [
				{
					id: "RR10",
					title: this.title,
					status: "skip",
					detail: `PVLAB_ORG_${ORG_ROLE.toUpperCase()} not set`,
				},
			];
		const keep = process.env.PVLAB_RR_KEEP === "1";
		const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
		const stamp = Date.now();

		try {
			/* ---- RR10a: three projects ---- */
			const made = await Promise.all([
				create(ctx, org, `${PREFIX}${stamp}-s`, dbPass, "15"),
				create(ctx, org, `${PREFIX}${stamp}-a`, dbPass),
				create(ctx, org, `${PREFIX}${stamp}-b`, dbPass),
			]);
			(["S", "A", "B"] as const).forEach((role, i) => {
				const m = made[i];
				if (m?.ref) {
					projs.push({ role, ref: m.ref, ctx: forRef(ctx, m.ref) });
					if (process.env.PVLAB_RR_REFS_FILE)
						appendFileSync(
							process.env.PVLAB_RR_REFS_FILE,
							`${m.ref} ${PREFIX}${stamp}-${role.toLowerCase()} ${new Date().toISOString()} RR10\n`,
						);
				}
			});
			if (projs.length !== 3) {
				push({
					id: "RR10a",
					title: "create S (15), A and B (17)",
					status: "fail",
					detail: made
						.map((m) => `HTTP ${m.status} ${m.text.slice(0, 120)}`)
						.join(" | "),
				});
				return out;
			}
			const [S, A, B] = projs as [Proj, Proj, Proj];
			const healthy = await Promise.all(
				projs.map((p) => waitProjectHealthy(ctx, p.ref)),
			);
			if (healthy.some((h) => h.status !== "ACTIVE_HEALTHY")) {
				push({
					id: "RR10a",
					title: "projects healthy",
					status: "fail",
					detail: healthy
						.map((h, i) => `${projs[i]?.role} ${h.status} ${h.waitedS}s`)
						.join("; "),
				});
				return out;
			}
			const prep = await Promise.all(
				projs.map(async (p) => {
					const have = await selectedAddons(p.ctx, p.ref);
					const pitr = have.includes("pitr_7")
						? 0
						: (await applyAddon(p.ctx, p.ref, "pitr", "pitr_7")).status;
					const grown = await growDisk(p.ctx, p.ref);
					let v = "";
					for (let i = 0; i < 30 && !v; i++) {
						v = String(
							(
								await sql(
									p.ctx,
									"select current_setting('server_version') as v",
								)
							).rows[0]?.v ?? "",
						);
						if (!v) await sleep(10_000);
					}
					await sql(p.ctx, TABLE);
					p.primary = (await poolerConfig(p.ctx, p.ref).catch(() => [])).find(
						(e) => e.database_type === "PRIMARY",
					);
					const backups = await physicalBackups(p.ctx, p.ref);
					return { pitr, grown, v, backups };
				}),
			);
			const prepOk =
				prep.every(
					(x) => x.v && x.grown !== "never" && typeof x.grown === "number",
				) && projs.every((p) => p.primary);
			push({
				id: "RR10a",
				title: `S on postgres_engine 15, A and B on the default; Small, ${REGION}, ${ORG_ROLE} org, pitr_7, disk ${DISK_GB} GB`,
				status: prepOk ? "pass" : "fail",
				detail: prep
					.map(
						(x, i) =>
							`${projs[i]?.role}: ${x.v}, healthy ${healthy[i]?.waitedS}s, pitr_7 ${x.pitr || "already"}, disk grown ${x.grown}s, completed physical backups ${x.backups.length} (newest ${x.backups[0] ?? "none"})`,
					)
					.join("; "),
				measurements: Object.fromEntries(
					prep.flatMap((x, i) => [
						[`${projs[i]?.role}_version`, x.v],
						[`${projs[i]?.role}_backups`, x.backups.length],
					]),
				),
			});
			if (!prepOk || !S.primary || !A.primary || !B.primary) return out;

			/* ---- RR10b: source replica (empty), load, publication ---- */
			let srcReplica: Awaited<ReturnType<typeof addReplica>> | undefined;
			if (SRC_REPLICA) srcReplica = await addReplica(S, dbPass, 30);
			const tl = Date.now();
			const loader = await connectSession(S.primary, dbPass);
			let loaded = 0;
			try {
				await loader.query("set statement_timeout = 0");
				for (let lo = 1; lo <= ROWS; lo += LOAD_CHUNK) {
					const hi = Math.min(ROWS, lo + LOAD_CHUNK - 1);
					await loader.query(
						`insert into public.rr10_t select g, repeat(md5(g::text), 30) from generate_series(${lo}, ${hi}) g`,
					);
					loaded = hi;
				}
			} finally {
				await loader.end().catch(() => {});
			}
			const loadS = Math.round((Date.now() - tl) / 1000);
			const size = await sql(
				S.ctx,
				"select pg_total_relation_size('public.rr10_t')::bigint as total",
			);
			const totalGb = round(Number(size.rows[0]?.total ?? 0) / 1024 ** 3, 2);
			const pub = await sql(
				S.ctx,
				"create publication rr10_pub for table public.rr10_t",
			);
			const sLagAfterLoad = SRC_REPLICA
				? await replicaLag(S.ctx, "rr10_sub")
				: undefined;
			push({
				id: "RR10b",
				title: `S: ${SRC_REPLICA ? "replica added while empty, then " : ""}${ROWS} rows of ~1 KB loaded, publication`,
				status:
					loaded === ROWS &&
					pub.status < 300 &&
					(!SRC_REPLICA || srcReplica?.servedS !== "never")
						? "pass"
						: "fail",
				detail: `${SRC_REPLICA ? `S replica setup HTTP ${srcReplica?.setup}, first session after ${srcReplica?.servedS}s; ` : ""}loaded ${loaded} rows in ${loadS}s, table ${totalGb} GB total; publication HTTP ${pub.status} ${pub.error}${sLagAfterLoad ? `; S replica lag after load ${sLagAfterLoad.bytes} bytes / ${sLagAfterLoad.replayMs} ms (${sLagAfterLoad.rows} standby rows)` : ""}`,
				measurements: {
					load_s: loadS,
					table_gb: totalGb,
					src_replica_served_s: srcReplica?.servedS ?? "skipped",
				},
			});
			if (loaded !== ROWS || pub.status >= 300) return out;

			/* ---- RR10c: A replica before any subscription ---- */
			const aRep = await addReplica(A, dbPass, 30);
			push({
				id: "RR10c",
				title: "A: replica added while A is empty, before the subscription",
				status: aRep.servedS !== "never" ? "pass" : "fail",
				detail: `setup HTTP ${aRep.setup} ${aRep.text}; first session after ${aRep.servedS}s; A's completed physical backups ${(await physicalBackups(A.ctx, A.ref)).length}`,
				measurements: { a_replica_served_s: aRep.servedS },
			});

			/* ---- RR10d: subscriptions on A and B together ---- */
			const conn = `host=db.${S.ref}.supabase.co port=5432 dbname=postgres user=postgres password=${dbPass} options=''-c statement_timeout=0''`;
			const tSub = Date.now();
			const subs = await Promise.all([
				sql(
					A.ctx,
					`create subscription rr10_sub_a connection '${conn}' publication rr10_pub`,
				),
				sql(
					B.ctx,
					`create subscription rr10_sub_b connection '${conn}' publication rr10_pub`,
				),
			]);
			let aReadyS: number | "never" = "never";
			let bReadyS: number | "never" = "never";
			let aLagMaxBytes = -1;
			let aLagMaxMs = -1;
			let sLagMaxBytes = -1;
			let samples = 0;
			let lastA = "";
			let lastB = "";
			while (
				(aReadyS === "never" || bReadyS === "never") &&
				Date.now() - tSub < SYNC_MIN * 60_000 &&
				subs.every((s) => s.status < 300)
			) {
				await sleep(15_000);
				samples++;
				const secs = Math.round((Date.now() - tSub) / 1000);
				const [sa, sb] = await Promise.all([
					syncState(A.ctx),
					syncState(B.ctx),
				]);
				lastA = sa.states;
				lastB = sb.states;
				if (aReadyS === "never" && sa.ready) aReadyS = secs;
				if (bReadyS === "never" && sb.ready) bReadyS = secs;
				const al = await replicaLag(A.ctx, "rr10_sub");
				aLagMaxBytes = Math.max(aLagMaxBytes, al.bytes);
				aLagMaxMs = Math.max(aLagMaxMs, al.replayMs);
				if (SRC_REPLICA)
					sLagMaxBytes = Math.max(
						sLagMaxBytes,
						(await replicaLag(S.ctx, "rr10_sub")).bytes,
					);
				if (samples % 4 === 0)
					ctx.log(
						`sync ${secs}s: A ${sa.states} B ${sb.states}; A replica lag ${al.bytes} B / ${al.replayMs} ms`,
					);
			}
			const tReady = Date.now();
			// Give A's replica up to 5 minutes to replay what the copy wrote.
			let aCaught: number | "never" = "never";
			for (let i = 0; i < 20; i++) {
				const al = await replicaLag(A.ctx, "rr10_sub");
				if (al.bytes === 0) {
					aCaught = Math.round((Date.now() - tReady) / 1000);
					break;
				}
				await sleep(15_000);
			}
			const [nA, nArep, nB] = await Promise.all([
				count(A.primary, dbPass),
				A.replica ? count(A.replica, dbPass) : Promise.resolve("no replica"),
				count(B.primary, dbPass),
			]);
			push({
				id: "RR10d",
				title:
					"subscriptions on A (replica present) and B (no replica) at the same time; initial copy; A's and S's replica lag during the copy",
				status:
					subs.every((s) => s.status < 300) &&
					aReadyS !== "never" &&
					bReadyS !== "never" &&
					nA === ROWS &&
					nB === ROWS &&
					nArep === ROWS
						? "pass"
						: "fail",
				detail: `create subscription HTTP A ${subs[0]?.status} ${subs[0]?.error} / B ${subs[1]?.status} ${subs[1]?.error}; all tables r after A ${aReadyS}s, B ${bReadyS}s (last states A '${lastA}' B '${lastB}'); A replica lag max ${aLagMaxBytes} bytes / ${aLagMaxMs} ms over ${samples} samples, 0 bytes ${aCaught === "never" ? "not reached in 300 s" : `${aCaught}s after both were ready`}${SRC_REPLICA ? `; S replica lag max ${sLagMaxBytes} bytes` : ""}; rows A ${nA}, A replica ${nArep}, B ${nB} (expected ${ROWS})`,
				measurements: {
					a_sync_s: aReadyS,
					b_sync_s: bReadyS,
					a_replica_lag_max_bytes: aLagMaxBytes,
					a_replica_lag_max_ms: aLagMaxMs,
					a_replica_caught_up_s: aCaught,
					s_replica_lag_max_bytes: sLagMaxBytes,
					rows_a: nA,
					rows_a_replica: nArep,
					rows_b: nB,
				},
			});

			/* ---- RR10e: B replica after the sync ---- */
			const bBackupsBefore = await physicalBackups(B.ctx, B.ref);
			const syncEndIso = new Date(tReady).toISOString();
			const polls: string[] = [];
			const bRep = await addReplica(B, dbPass, SERVE_MIN, async (s) => {
				if (s % 300 < 15) {
					const e = (await poolerConfig(B.ctx, B.ref).catch(() => [])).find(
						(x) => x.database_type === "READ_REPLICA",
					);
					polls.push(`${s}s:${e ? "entry" : "no-entry"}`);
				}
			});
			const bBackupsAfter = await physicalBackups(B.ctx, B.ref);
			const nBrep = B.replica ? await count(B.replica, dbPass) : "no session";
			push({
				id: "RR10e",
				title: `B: replica added after the initial copy; first session within ${SERVE_MIN} min`,
				status: bRep.servedS !== "never" && nBrep === ROWS ? "pass" : "fail",
				detail: `sync ended ${syncEndIso}; B's completed physical backups before setup ${bBackupsBefore.length} (newest ${bBackupsBefore[0] ?? "none"}), after the wait ${bBackupsAfter.length} (newest ${bBackupsAfter[0] ?? "none"}); setup HTTP ${bRep.setup} ${bRep.text}; first session after ${bRep.servedS}s; pooler entry ${bRep.entry ? "present" : "absent"}; polls ${polls.join(" ") || "-"}; rows on B's replica ${nBrep}`,
				measurements: {
					b_replica_served_s: bRep.servedS,
					b_backups_before: bBackupsBefore.length,
					b_backups_after: bBackupsAfter.length,
					rows_b_replica: nBrep,
				},
			});

			/* ---- RR10f: streaming after the sync ---- */
			const ins = await sql(
				S.ctx,
				`insert into public.rr10_t select g, 'late' from generate_series(${ROWS + 1}, ${ROWS + 1000}) g`,
			);
			await sleep(30_000);
			const want = ROWS + 1000;
			const late = await Promise.all([
				count(A.primary, dbPass),
				A.replica ? count(A.replica, dbPass) : Promise.resolve("no replica"),
				count(B.primary, dbPass),
				B.replica ? count(B.replica, dbPass) : Promise.resolve("no replica"),
			]);
			push({
				id: "RR10f",
				title: "1,000 rows inserted on S after both syncs; counts 30 s later",
				status:
					ins.status < 300 &&
					late[0] === want &&
					late[2] === want &&
					(late[1] === want || late[1] === "no replica")
						? "pass"
						: "fail",
				detail: `insert HTTP ${ins.status} ${ins.error}; A ${late[0]}, A replica ${late[1]}, B ${late[2]}, B replica ${late[3]} (expected ${want})`,
			});
		} catch (e) {
			push({
				id: "RR10",
				title: "unexpected error",
				status: "fail",
				detail: errText(e).slice(0, 400),
			});
		} finally {
			/* ---- RR10p ---- */
			if (!keep && projs.length) {
				const notes: string[] = [];
				for (const p of projs.filter((x) => x.role !== "S"))
					notes.push(
						`${p.role} sub ${await dropSub(p.ctx, `rr10_sub_${p.role.toLowerCase()}`).catch(() => "err")}`,
					);
				for (const p of projs) {
					const reps = (
						await poolerConfig(p.ctx, p.ref).catch(() => [])
					).filter((e) => e.database_type === "READ_REPLICA");
					for (const e of reps)
						notes.push(
							`${p.role} replica remove ${(await mgmt(p.ctx, "POST", `/projects/${p.ref}/read-replicas/remove`, { database_identifier: e.identifier }).catch(() => null))?.status ?? 0}`,
						);
				}
				for (const p of projs) {
					let del = await mgmt(p.ctx, "DELETE", `/projects/${p.ref}`).catch(
						() => null,
					);
					for (
						let i = 0;
						i < 6 && (del?.status ?? 0) >= 300 && del?.status !== 404;
						i++
					) {
						await sleep(30_000);
						del = await mgmt(p.ctx, "DELETE", `/projects/${p.ref}`).catch(
							() => null,
						);
					}
					notes.push(`${p.role} delete ${del?.status ?? 0}`);
				}
				push({
					id: "RR10p",
					title: "teardown: subscriptions, replicas, projects",
					status: "info",
					detail: notes.join("; "),
				});
			}
		}
		return out;
	},
};

export default mod;
