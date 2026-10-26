/**
 * UI02 - Fixture and pre-upgrade baseline.
 *
 *   UI02a  pg_cron, pgmq and amcheck enabled; tables with a bigserial, an
 *          identity and btree indexes; queue `ui_q`; job `ui-tick` scheduled
 *          at '5 seconds' (pg_cron interval syntax; falls back to every
 *          minute and says so if refused) runs public.ui_tick(): one tick row,
 *          20 inserts, 10 updates, 5 deletes, 3 pgmq sends, a read of 3, each
 *          read message archived or deleted. Job `ui-minute` ('* * * * *')
 *          inserts one row a minute. Warm-up PVLAB_UI_WARMUP_S (default 180).
 *   UI02b  amcheck before: verify_heapam on every table in public, cron and
 *          pgmq; bt_index_check and bt_index_parent_check (heapallindexed)
 *          on their btree indexes.
 *   UI02c  every column sequence in those schemas against max() of its column.
 *   UI02d  age(relfrozenxid) / mxid_age(relminmxid) of the cron and pgmq
 *          tables and the two busy public tables.
 *
 * DESTRUCTIVE: writes to the shared project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  FIXTURE_SQL,
  QUEUE_SQL,
  ensureProject,
  errText,
  frozenAges,
  okCount,
  redact,
  runAmcheck,
  sequenceCheck,
  skipWithoutPro,
  sleep,
  snapshot,
  sql,
  sqlOk,
  state,
} from "../lib/ui.js";

const WARMUP_S = Number(process.env.PVLAB_UI_WARMUP_S || 180);

const mod: TestModule = {
  id: "UI02",
  title: "Fixture (pg_cron every 5 s, pgmq) and pre-upgrade integrity baseline",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "UI02");
    if (skip) return skip;
    const p = await ensureProject(ctx);
    const ref = p.ref;
    const out: TestResult[] = [];
    try {
      await sqlOk(ctx, ref, FIXTURE_SQL, "fixture");
      await sqlOk(ctx, ref, QUEUE_SQL, "pgmq.create");
    } catch (e) {
      return [{ id: "UI02a", title: "UI02a: fixture", status: "fail", detail: redact(errText(e)) }];
    }
    // Idempotent for a reused project: drop our jobs first.
    await sql(ctx, ref, "select cron.unschedule(jobid) from cron.job where jobname in ('ui-tick','ui-minute')");
    let cronSchedule = "5 seconds";
    const s5 = await sql(ctx, ref, "select cron.schedule('ui-tick', '5 seconds', 'select public.ui_tick()') as id");
    let scheduleNote = `'5 seconds' accepted (jobid ${String(s5.rows?.[0]?.id ?? "?")})`;
    if (s5.error) {
      cronSchedule = "* * * * *";
      const s1 = await sql(ctx, ref, "select cron.schedule('ui-tick', '* * * * *', 'select public.ui_tick()') as id");
      scheduleNote = `'5 seconds' refused (${s5.error}); every minute: ${s1.error ?? "accepted"}`;
    }
    const sm = await sql(ctx, ref, "select cron.schedule('ui-minute', '* * * * *', 'insert into public.ui_minute default values') as id");
    ctx.log(`UI02: scheduled (${scheduleNote}); warming up ${WARMUP_S} s`);
    await sleep(WARMUP_S * 1000);

    const snap = await snapshot(ctx, ref);
    const cad = await sql(
      ctx,
      ref,
      `select count(*) as n, percentile_cont(0.5) within group (order by g) as med, max(g) as mx
       from (select extract(epoch from at - lag(at) over (order by id)) as g from public.ui_ticks) x where g is not null`,
    );
    const ticks = Number(snap.counts.ui_ticks ?? 0);
    const med = Number(cad.rows?.[0]?.med ?? 0);
    out.push({
      id: "UI02a",
      title: "UI02a: fixture up, cron firing, queue moving",
      status: ticks > 0 && Number(snap.counts.archive ?? 0) > 0 ? "pass" : "fail",
      detail: `${snap.serverVersion}; ${snap.extensions}; ${scheduleNote}; ui-minute ${sm.error ?? "accepted"}; after ${WARMUP_S} s: ${ticks} ticks (median gap ${med.toFixed(2)} s), ${snap.counts.ui_minute} minute rows, archive ${snap.counts.archive}, queue ${snap.counts.queue}, job_run_details ${snap.counts.job_run_details} (${snap.runStatus})`,
      measurements: {
        server_version: snap.serverVersion,
        extensions: snap.extensions,
        sql_user: snap.whoami,
        tick_schedule: cronSchedule,
        ticks,
        tick_median_gap_s: Number(med.toFixed(2)),
        minute_rows: Number(snap.counts.ui_minute ?? 0),
        events: Number(snap.counts.ui_events ?? 0),
        archive_rows: Number(snap.counts.archive ?? 0),
        queue_rows: Number(snap.counts.queue ?? 0),
        job_run_details: Number(snap.counts.job_run_details ?? 0),
        run_status: snap.runStatus,
      },
      evidence: redact(JSON.stringify({ cronJobs: snap.cronJobs, cronTables: snap.cronTables, pgmqTables: snap.pgmqTables, counts: snap.counts, maxIds: snap.maxIds }, null, 1)),
    });

    const am = await runAmcheck(ctx, ref);
    out.push({
      id: "UI02b",
      title: "UI02b: amcheck before the upgrade",
      status: !am.schema ? "fail" : am.rows.length && am.rows.every((r) => r.ok) ? "pass" : "fail",
      detail: am.schema
        ? `amcheck ${am.version} in ${am.schema}: heap ${okCount(am.rows.filter((r) => r.kind === "heap"))}, bt_index_check ${okCount(am.rows.filter((r) => r.kind === "btree"))}, bt_index_parent_check ${okCount(am.rows.filter((r) => r.kind === "btree_parent"))} clean`
        : "amcheck extension absent",
      measurements: {
        amcheck_version: am.version,
        heap_ok: okCount(am.rows.filter((r) => r.kind === "heap")),
        btree_ok: okCount(am.rows.filter((r) => r.kind === "btree")),
        btree_parent_ok: okCount(am.rows.filter((r) => r.kind === "btree_parent")),
      },
      evidence: redact(am.rows.map((r) => `${r.kind} ${r.rel}: ${r.result}`).join("\n")),
    });

    const sq = await sequenceCheck(ctx, ref);
    out.push({
      id: "UI02c",
      title: "UI02c: sequences at or above max(column) before the upgrade",
      status: sq.error ? "fail" : sq.rows.length && sq.rows.every((r) => r.ok) ? "pass" : "fail",
      detail: sq.error ? `query failed: ${sq.error}` : `${okCount(sq.rows)} sequences at or above their column max`,
      measurements: { seq_ok: okCount(sq.rows) },
      evidence: redact(sq.rows.map((r) => `${r.table}.${r.column} <- ${r.seq}: last_value ${r.last_value}, max ${r.max_value}${r.ok ? "" : "  BELOW"}`).join("\n")),
    });

    const fz = await frozenAges(ctx, ref);
    out.push({
      id: "UI02d",
      title: "UI02d: relfrozenxid / relminmxid ages before the upgrade",
      status: fz.error ? "fail" : "info",
      detail: fz.error ? fz.error : fz.rows.map((r) => `${r.rel} age ${r.xid_age} (owner ${r.owner})`).join("; "),
      measurements: Object.fromEntries(fz.rows.map((r) => [`age_${r.rel}`, r.xid_age])),
      evidence: redact(fz.rows.map((r) => `${r.rel}: relfrozenxid ${r.relfrozenxid} age ${r.xid_age}; relminmxid ${r.relminmxid} mxid_age ${r.mxid_age}; owner ${r.owner}`).join("\n")),
    });

    state.baseline = { snap, amcheck: am.rows, seq: sq.rows, frozen: fz.rows, cronSchedule };
    return out;
  },
};
export default mod;
