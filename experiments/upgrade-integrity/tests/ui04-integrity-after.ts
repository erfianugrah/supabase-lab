/**
 * UI04 - Integrity after the upgrade.
 *
 *   UI04a  amcheck after: the same verify_heapam / bt_index_check /
 *          bt_index_parent_check sweep as UI02b, over whatever relations
 *          public, cron and pgmq hold now.
 *   UI04b  sequences at or above max(column), as UI02c.
 *   UI04c  data kept: every client write UI03 saw acknowledged (every path)
 *          is present, and the lost ones are listed with the time, server
 *          version and postmaster start time of their acknowledgement;
 *          tick, event and job_run_details rows that existed at the UI02
 *          baseline (id <= baseline max) are all still there.
 *   UI04d  catalog shape: cron and pgmq relations and cron.job rows before
 *          and after (the upgrade guide says pg_cron is dropped and
 *          recreated, its details table duplicated first).
 *   UI04e  lost and kept writes grouped by server identity (version,
 *          postmaster start, system_identifier, address label).
 *   UI04f  pg_cron rows in each restarted old-version postmaster's window
 *          (its start to its last acknowledgement).
 *
 * DESTRUCTIVE: runs against the shared project after UI03.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, okCount, redact, runAmcheck, sequenceCheck, skipWithoutPro, snapshot, sql, state } from "../lib/ui.js";

const mod: TestModule = {
  id: "UI04",
  title: "Post-upgrade amcheck, sequences, kept rows and catalog shape",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "UI04");
    if (skip) return skip;
    const b = state.baseline;
    const u = state.upgrade;
    if (!b || !u) return [{ id: "UI04", title: "UI04", status: "skip", detail: "no UI02 baseline or UI03 upgrade in this process" }];
    const p = await ensureProject(ctx);
    const ref = p.ref;
    const out: TestResult[] = [];

    const am = await runAmcheck(ctx, ref);
    const heap = am.rows.filter((r) => r.kind === "heap");
    const bt = am.rows.filter((r) => r.kind === "btree");
    const btp = am.rows.filter((r) => r.kind === "btree_parent");
    out.push({
      id: "UI04a",
      title: "UI04a: amcheck after the upgrade",
      status: !am.schema ? "fail" : am.rows.length && am.rows.every((r) => r.ok) ? "pass" : "fail",
      detail: am.schema
        ? `amcheck ${am.version} in ${am.schema}: heap ${okCount(heap)}, bt_index_check ${okCount(bt)}, bt_index_parent_check ${okCount(btp)} clean (before: heap ${okCount(b.amcheck.filter((r) => r.kind === "heap"))}, btree ${okCount(b.amcheck.filter((r) => r.kind === "btree"))})`
        : "amcheck extension absent after the upgrade",
      measurements: { amcheck_version: am.version, heap_ok: okCount(heap), btree_ok: okCount(bt), btree_parent_ok: okCount(btp) },
      evidence: redact(am.rows.map((r) => `${r.kind} ${r.rel}: ${r.result}`).join("\n")),
    });

    const sq = await sequenceCheck(ctx, ref);
    const below = sq.rows.filter((r) => !r.ok);
    out.push({
      id: "UI04b",
      title: "UI04b: sequences at or above max(column) after the upgrade",
      status: sq.error ? "fail" : sq.rows.length && !below.length ? "pass" : "fail",
      detail: sq.error ? `query failed: ${sq.error}` : `${okCount(sq.rows)} at or above their column max${below.length ? `; BELOW: ${below.map((r) => `${r.table}.${r.column} ${r.last_value} < ${r.max_value}`).join(", ")}` : ""}`,
      measurements: { seq_ok: okCount(sq.rows) },
      evidence: redact(sq.rows.map((r) => `${r.table}.${r.column} <- ${r.seq}: last_value ${r.last_value}, max ${r.max_value}${r.ok ? "" : "  BELOW"}`).join("\n")),
    });

    const present = await sql(ctx, ref, "select src, coalesce(array_agg(seq order by seq), '{}') as s from public.ui_client group by src");
    const have = new Map<string, Set<number>>();
    for (const r of present.rows ?? []) have.set(String(r.src), new Set(((r.s as number[] | undefined) ?? []).map(Number)));
    const acked = u.attempts.filter((a) => a.ok);
    const lost = acked.filter((a) => !have.get(a.src)?.has(a.seq));
    const kept = await sql(
      ctx,
      ref,
      `select (select count(*) from public.ui_ticks where id <= ${Number(b.snap.maxIds.ticks) || 0}) as ticks,
              (select count(*) from cron.job_run_details where runid <= ${Number(b.snap.maxIds.runid) || 0}) as runs,
              (select count(*) from pgmq.a_ui_q where msg_id <= ${Number(b.snap.maxIds.archive) || 0}) as archive`,
    );
    const k = kept.rows?.[0] ?? {};
    const bTicks = Number(b.snap.counts.ui_ticks ?? 0);
    const bRuns = Number(b.snap.counts.job_run_details ?? 0);
    const bArch = Number(b.snap.counts.archive ?? 0);
    const off = (t: number) => Math.round((t - u.postAt) / 1000);
    const srcs = ["mgmt", "pooler", "txn", "direct", "rest"] as const;
    const per = Object.fromEntries(srcs.map((src) => [src, { a: acked.filter((x) => x.src === src).length, l: lost.filter((x) => x.src === src).length }]));
    const lostLines = lost.map((a) => `${a.src} seq ${a.seq} start +${off(a.t)} s ack +${off(a.ackT)} s: ${a.version} postmaster ${a.pmStart} sysid ${a.sysid} addr ${a.addr} lsn ${a.lsn} xid ${a.xid} recovery ${a.recovery}`);
    out.push({
      id: "UI04c",
      title: "UI04c: acknowledged writes and baseline rows kept",
      status: !present.error && !kept.error && !lost.length && Number(k.ticks) === bTicks && Number(k.archive) === bArch ? "pass" : "fail",
      detail: `acknowledged writes present: ${srcs.filter((x) => per[x]!.a || u.unreachable?.[x]).map((x) => (u.unreachable?.[x] && !per[x]!.a ? `${x} unreachable` : `${x} ${per[x]!.a - per[x]!.l}/${per[x]!.a}`)).join(", ")}${lost.length ? ` (lost ones started +${off(lost[0]!.t)} s to +${off(lost.at(-1)!.t)} s after the POST)` : ""}; baseline rows still present: ticks ${String(k.ticks)}/${bTicks}, archive ${String(k.archive)}/${bArch}, job_run_details ${String(k.runs)}/${bRuns}`,
      measurements: {
        acked_mgmt: per.mgmt!.a,
        lost_mgmt: per.mgmt!.l,
        acked_pooler: per.pooler!.a,
        lost_pooler: per.pooler!.l,
        acked_txn: per.txn!.a,
        lost_txn: per.txn!.l,
        acked_direct: per.direct!.a,
        lost_direct: per.direct!.l,
        acked_rest: per.rest!.a,
        lost_rest: per.rest!.l,
        baseline_ticks_kept: `${String(k.ticks)}/${bTicks}`,
        baseline_archive_kept: `${String(k.archive)}/${bArch}`,
        baseline_job_runs_kept: `${String(k.runs)}/${bRuns}`,
      },
      evidence: redact(lostLines.length ? lostLines.join("\n") : (present.error ?? kept.error ?? "none lost")),
    });

    // Identity groups: which server acknowledged lost writes and which acknowledged surviving ones.
    const big = (x: string) => (/^\d+$/.test(x) ? BigInt(x) : null);
    const lsnNum = (x: string) => {
      const m = /^([0-9A-F]+)\/([0-9A-F]+)$/i.exec(x);
      return m ? (BigInt(`0x${m[1]}`) << 32n) + BigInt(`0x${m[2]}`) : null;
    };
    const groups = new Map<string, { lost: number; kept: number; srcs: Set<string>; lsnMin: string; lsnMax: string; xidMin: string; xidMax: string; ackFirst: number; ackLast: number }>();
    const lostSet = new Set(lost);
    for (const a of acked) {
      const key = `${a.version} postmaster ${a.pmStart} sysid ${a.sysid} addr ${a.addr}`;
      const g = groups.get(key) ?? { lost: 0, kept: 0, srcs: new Set<string>(), lsnMin: a.lsn, lsnMax: a.lsn, xidMin: a.xid, xidMax: a.xid, ackFirst: a.ackT, ackLast: a.ackT };
      if (lostSet.has(a)) g.lost++;
      else g.kept++;
      g.srcs.add(a.src);
      const ln = lsnNum(a.lsn);
      if (ln !== null && (lsnNum(g.lsnMin) ?? ln) >= ln) g.lsnMin = a.lsn;
      if (ln !== null && (lsnNum(g.lsnMax) ?? ln) <= ln) g.lsnMax = a.lsn;
      const xn = big(a.xid);
      if (xn !== null && (big(g.xidMin) ?? xn) >= xn) g.xidMin = a.xid;
      if (xn !== null && (big(g.xidMax) ?? xn) <= xn) g.xidMax = a.xid;
      g.ackFirst = Math.min(g.ackFirst, a.ackT);
      g.ackLast = Math.max(g.ackLast, a.ackT);
      groups.set(key, g);
    }
    const pre = u.preIdentity ?? {};
    const post = u.postIdentity ?? {};
    const maxXid = acked.reduce((m, a) => (big(a.xid) !== null && big(a.xid)! > m ? big(a.xid)! : m), 0n);
    const glines = [...groups.entries()].map(
      ([key, g]) =>
        `${key}: lost ${g.lost}, kept ${g.kept} (paths ${[...g.srcs].join("+")}); ack +${off(g.ackFirst)}..+${off(g.ackLast)} s; lsn ${g.lsnMin}..${g.lsnMax}; xid ${g.xidMin}..${g.xidMax}; sysid ${key.includes(`sysid ${String(pre.sysid)} `) ? "= original 15" : key.includes(`sysid ${String(post.sysid)} `) ? "= 17 instance" : "= neither"}`,
    );
    out.push({
      id: "UI04e",
      title: "UI04e: identity of the servers that acknowledged lost and kept writes",
      status: "info",
      detail: `${groups.size} server identities among acknowledged writes; original 15: postmaster ${String(pre.pm)} sysid ${String(pre.sysid)} addr ${String(pre.addr)} lsn ${String(pre.lsn)}; 17 after: postmaster ${String(post.pm)} sysid ${String(post.sysid)} addr ${String(post.addr)} lsn ${String(post.lsn)} txid_current ${String(post.xid)}; highest txid in any acknowledged write ${maxXid}`,
      measurements: { identities: groups.size, post_txid: String(post.xid), max_acked_txid: String(maxXid), post_lsn: String(post.lsn) },
      evidence: redact(glines.join("\n")),
    });

    // pg_cron rows inside each restarted old-version postmaster's window, one window per postmaster:
    // [its pg_postmaster_start_time(), its last acknowledgement]. Run 3 used one window from the first
    // restart to the last acknowledgement, which also covered the first runs on the new major.
    const fromV = u.fromVersion;
    const interim = new Map<string, { last: number; lost: number; kept: number }>();
    for (const a of acked) {
      if (a.version !== fromV || !a.pmStart || a.pmStart === String(pre.pm)) continue;
      const g = interim.get(a.pmStart) ?? { last: 0, lost: 0, kept: 0 };
      g.last = Math.max(g.last, a.ackT);
      if (lostSet.has(a)) g.lost++;
      else g.kept++;
      interim.set(a.pmStart, g);
    }
    const wl: string[] = [];
    const wm: Record<string, number> = {};
    for (const [pm, g] of [...interim.entries()].sort()) {
      const w = await sql(
        ctx,
        ref,
        `select (select count(*) from cron.job_run_details where start_time >= '${pm}'::timestamptz and start_time <= to_timestamp(${g.last / 1000})) as runs,
                (select count(*) from public.ui_ticks where at >= '${pm}'::timestamptz and at <= to_timestamp(${g.last / 1000})) as ticks,
                (select count(*) from public.ui_minute where at >= '${pm}'::timestamptz and at <= to_timestamp(${g.last / 1000})) as minute`,
      );
      const r = w.rows?.[0] ?? {};
      wl.push(`postmaster ${pm} to ${new Date(g.last).toISOString()} (writes lost ${g.lost}, kept ${g.kept}): ${w.error ?? `job_run_details ${String(r.runs)}, ui_ticks ${String(r.ticks)}, ui_minute ${String(r.minute)}`}`);
      wm[`runs_${pm.slice(11, 19)}`] = Number(r.runs ?? -1);
    }
    out.push({
      id: "UI04f",
      title: "UI04f: pg_cron rows present from each restarted old-version postmaster's window",
      status: "info",
      detail: wl.length ? wl.join("; ") : "no acknowledged write came from an old-version postmaster other than the original one",
      measurements: wm,
    });

    const after = await snapshot(ctx, ref);
    const jobsB = JSON.stringify(b.snap.cronJobs);
    const jobsA = JSON.stringify(after.cronJobs);
    out.push({
      id: "UI04d",
      title: "UI04d: cron and pgmq catalog before and after",
      status: "info",
      detail: `${after.serverVersion}; ${after.extensions}; cron.job ${jobsA === jobsB ? "identical" : "changed"}; cron relations ${after.cronTables === b.snap.cronTables ? "identical" : "changed"}; pgmq tables ${after.pgmqTables === b.snap.pgmqTables ? "identical" : "changed"}`,
      measurements: { server_version: after.serverVersion, extensions: after.extensions, cron_jobs_identical: jobsA === jobsB ? "yes" : "no" },
      evidence: redact(
        `before cron.job: ${jobsB}\nafter  cron.job: ${jobsA}\nbefore cron: ${b.snap.cronTables}\nafter  cron: ${after.cronTables}\nbefore pgmq: ${b.snap.pgmqTables}\nafter  pgmq: ${after.pgmqTables}\nbefore extensions: ${b.snap.extensions}\nafter counts: ${JSON.stringify(after.counts)} runs ${after.runStatus}`,
      ),
    });
    return out;
  },
};
export default mod;
