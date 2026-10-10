/**
 * PL07 - what a paused pipeline does to the source's WAL.
 *
 * Docs claims: stopping a pipeline "finishes in-flight work and stops; WAL
 * accumulates and pipeline-hour billing continues while stopped"; the Dashboard
 * shows "WAL retention remaining" from `safe_wal_size`; a slot whose retention
 * limit is exceeded becomes `Lost` and the pipeline needs "Recreate slot"
 * (replaces every destination table). The billing half is not testable here
 * (PL08 records why).
 *
 *   PL07a  baseline: retained WAL of the main slot while the replicator runs.
 *   PL07b  replicator stopped with SIGTERM; 5000 rows (about 1.5 MB) inserted
 *          every 10 s for 150 s; the slot is sampled each time: retained bytes
 *          (current LSN minus restart_lsn), unconfirmed bytes (current minus
 *          confirmed_flush_lsn), wal_status, safe_wal_size.
 *   PL07c  replicator restarted: seconds until the destination holds every row
 *          and the slot's unconfirmed bytes are back under 1 MB.
 *   PL07d  replicator stopped again; full-table UPDATEs of a 100 MB table
 *          until the slot retains more than the source's
 *          `max_slot_wal_keep_size`; CHECKPOINT (which is when Postgres
 *          enforces the limit); slot status sampled until `lost` or 6 minutes.
 *   PL07e  restart with the default invalidated-slot behaviour (error): does
 *          the pipeline start, what does it log.
 *   PL07f  restart with `invalidated_slot_behavior: recreate`: seconds until
 *          the table is rebuilt and the destination matches the source.
 *
 * Entity note: engine, not the managed service (see PL02). The source is a
 * managed Supabase project, so the Postgres side of every number is the
 * platform's own.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { beginPipeline, ensureFixture, openDuck, withCleanup } from "../lib/fixture.js";
import {
  applySlot,
  currentTag,
  killReplicator,
  num,
  renderConfig,
  replicatorLogs,
  replicatorRunning,
  slots,
  sleep,
  startReplicator,
  stopReplicator,
  tableStates,
  waitTablesReady,
  type SrcDb,
} from "../lib/stack.js";
import { lbl, pct, round } from "../lib/util.js";

const T = "public.pl07_wal";
const mb = (b: number) => round(b / 1e6, 1);

async function sample(db: SrcDb) {
  const s = applySlot(await slots(db));
  return {
    t: Date.now(),
    active: s?.active ?? "?",
    status: s?.wal_status ?? "?",
    reason: s?.invalidation_reason ?? "",
    safe: num(s?.safe_wal_size),
    retained: num(s?.retained_bytes),
    lag: num(s?.lag_bytes),
  };
}

async function walDir(db: SrcDb): Promise<string> {
  try {
    const r = await db.q("select count(*)::text as n, coalesce(sum(size),0)::text as b from pg_ls_waldir()");
    return `${r[0]?.n} files, ${mb(num(r[0]?.b))} MB`;
  } catch (e) {
    return `n/a (${(e instanceof Error ? e.message : String(e)).slice(0, 60)})`;
  }
}

const mod: TestModule = {
  id: "PL07",
  title: "PL07 - paused pipeline, retained WAL, slot invalidation",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const fx = await ensureFixture(ctx);
    const { db, state } = fx;
    await db.q(`drop table if exists ${T} cascade`);
    await db.q(`create table ${T} (id bigint primary key, pad text)`);
    await db.q(`insert into ${T} select g, repeat(md5(g::text), 32) from generate_series(1, 100000) g`);
    const opts = { tables: [T], tag: "pl07", maxFillMs: 1000 };
    await beginPipeline(fx, opts);
    const w = await waitTablesReady(db, [T], 600_000, 2000, ["sync_done", "ready"]);
    if (!w.ok) return [{ id: "PL07", title: "PL07 setup", status: "fail", detail: `copy: ${JSON.stringify(w.states)}` }];
    for (let i = 0; i < 30 && (await tableStates(db, [T]))[T] !== "ready"; i++) {
      await db.q(`update ${T} set id = id where id = 1`);
      await sleep(2000);
    }
    const maxKeep = await db.scalar("select pg_size_bytes(current_setting('max_slot_wal_keep_size'))");
    const heapMb = mb(num(await db.scalar(`select pg_relation_size('${T}')`)));

    // ---- PL07a baseline
    await sleep(5000);
    const base = await sample(db);
    results.push({
      id: "PL07a",
      title: "PL07a: main slot while the replicator runs",
      status: "info",
      measurements: {
        slot_active: base.active,
        wal_status: base.status,
        retained_mb: mb(base.retained),
        unconfirmed_mb: mb(base.lag),
        safe_wal_size_mb: mb(base.safe),
        max_slot_wal_keep_size_mb: mb(num(maxKeep)),
        table_heap_mb: heapMb,
        wal_dir: await walDir(db),
      },
    });

    // ---- PL07b stopped, steady writes
    const stopCall = Date.now();
    const stop = await stopReplicator(60);
    const stopS = round((Date.now() - stopCall) / 1000, 1);
    await sleep(3000);
    const afterStop = await sample(db);
    const rowsPerBatch = 5000;
    let next = 200_000;
    const series: Array<{ s: number; retained: number; lag: number; status: string; safe: number }> = [];
    const tStart = Date.now();
    // idle sample (no writes) first: Supabase's own WAL and checkpoints keep adding bytes
    await sleep(30_000);
    const idle = await sample(db);
    for (let i = 0; i < 15; i++) {
      await db.q(`insert into ${T} select g, repeat(md5(g::text), 8) from generate_series(${next}, ${next + rowsPerBatch - 1}) g`);
      next += rowsPerBatch;
      const s = await sample(db);
      series.push({ s: round((s.t - tStart) / 1000), retained: s.retained, lag: s.lag, status: s.status, safe: s.safe });
      await sleep(10_000);
    }
    const last = series.at(-1);
    const rowsWritten = rowsPerBatch * 15;
    const growth = (last?.retained ?? 0) - idle.retained;
    results.push({
      id: "PL07b",
      title: "PL07b: slot retention while the replicator is stopped and 75000 rows are written",
      status: stop.code === 0 && afterStop.active === "false" ? "info" : "fail",
      detail: `slot active after stop: ${afterStop.active}; retained ${mb(idle.retained)} MB (idle, 30 s after stop) to ${mb(last?.retained ?? NaN)} MB after ${rowsWritten} rows`,
      measurements: {
        stop_call_s: stopS,
        slot_active_after_stop: afterStop.active,
        retained_just_after_stop_mb: mb(afterStop.retained),
        retained_after_30s_idle_mb: mb(idle.retained),
        idle_growth_kb_per_30s: round((idle.retained - afterStop.retained) / 1e3),
        rows_written_while_stopped: rowsWritten,
        retained_after_writes_mb: mb(last?.retained ?? NaN),
        retained_growth_from_writes_mb: mb(growth),
        retained_bytes_per_row_written: round(growth / rowsWritten),
        unconfirmed_after_writes_mb: mb(last?.lag ?? NaN),
        wal_status_after_writes: last?.status ?? "?",
        safe_wal_size_after_writes_mb: mb(last?.safe ?? NaN),
        samples: series.length,
        retained_mb_series: series.map((x) => mb(x.retained)).join(" "),
        wal_dir_after: await walDir(db),
      },
    });

    // ---- PL07c restart and drain
    const t0 = Date.now();
    const st = await startReplicator(state, opts);
    const duck = await openDuck();
    let drained = -1;
    let destRows = "";
    const srcRows = await db.scalar(`select count(*) from ${T}`);
    try {
      for (let i = 0; i < 90; i++) {
        await sleep(2000);
        destRows = await duck.scalar(`select count(*) from lake.public.pl07_wal`).catch(() => "");
        const s = await sample(db);
        if (destRows === srcRows && s.lag < 1_000_000) {
          drained = Date.now() - t0;
          break;
        }
      }
    } finally {
      duck.close();
    }
    const afterDrain = await sample(db);
    results.push({
      id: "PL07c",
      title: "PL07c: restart drains the backlog",
      status: st.code === 0 && drained >= 0 ? "info" : "fail",
      detail: drained >= 0 ? `destination matched source ${round(drained / 1000, 1)} s after the restart call` : `did not drain in 180 s (dest ${destRows} of ${srcRows})`,
      measurements: {
        restart_to_drained_s: drained >= 0 ? round(drained / 1000, 1) : -1,
        src_rows: srcRows,
        dest_rows: destRows,
        retained_after_drain_mb: mb(afterDrain.retained),
        unconfirmed_after_drain_mb: mb(afterDrain.lag),
      },
    });

    // ---- PL07d: beyond max_slot_wal_keep_size
    await stopReplicator(60);
    await sleep(3000);
    const walStart = await sample(db);
    const sel = await db.scalar(`select count(*) from ${T}`);
    let passes = 0;
    const retainedSeries: number[] = [];
    const tGen = Date.now();
    while (passes < 14) {
      passes += 1;
      for (let lo = 0; lo < 300_000; lo += 25_000) {
        // about 100 MB of rows, 120 s statement_timeout: update in slices
        await db.q(`update ${T} set pad = repeat(md5(random()::text), 32) where id >= ${lo} and id < ${lo + 25_000}`);
      }
      const s = await sample(db);
      retainedSeries.push(s.retained);
      if (s.retained > num(maxKeep) * 1.15) break;
    }
    const genS = round((Date.now() - tGen) / 1000);
    const beforeCkpt = await sample(db);
    let ckpt = "ok";
    try {
      await db.q("checkpoint");
    } catch (e) {
      ckpt = `refused: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`;
    }
    const tc = Date.now();
    let final = await sample(db);
    const statusTrail: string[] = [`${final.status}`];
    while (Date.now() - tc < 360_000 && final.status !== "lost") {
      await sleep(10_000);
      final = await sample(db);
      if (statusTrail.at(-1) !== final.status) statusTrail.push(final.status);
    }
    results.push({
      id: "PL07d",
      title: "PL07d: retention beyond max_slot_wal_keep_size",
      status: "info",
      detail: `slot wal_status ${beforeCkpt.status} before CHECKPOINT, ${final.status} ${round((Date.now() - tc) / 1000)} s after`,
      measurements: {
        max_slot_wal_keep_size_mb: mb(num(maxKeep)),
        update_passes: passes,
        wal_generation_s: genS,
        retained_before_checkpoint_mb: mb(beforeCkpt.retained),
        wal_status_before_checkpoint: beforeCkpt.status,
        safe_wal_size_before_checkpoint_mb: mb(beforeCkpt.safe),
        checkpoint_statement: ckpt,
        wal_status_trail: lbl(statusTrail.join(">")),
        invalidation_reason: final.reason || "none",
        retained_final_mb: mb(final.retained),
        wal_dir_at_peak: await walDir(db),
        rows: sel,
        retained_mb_series: retainedSeries.map(mb).join(" "),
        start_retained_mb: mb(walStart.retained),
      },
    });

    // ---- PL07e: restart with the default behaviour
    const t1 = Date.now();
    await startReplicator(state, opts);
    await sleep(60_000);
    const running = await replicatorRunning();
    const logE = (await replicatorLogs(new Date(t1 - 2000).toISOString()))
      .split("\n")
      .filter((l) => /ERROR|invalid|lost|slot/i.test(l))
      .map((l) => l.replace(/\s+/g, " ").replace(/\x1b\[[0-9;]*m/g, ""));
    const stE = (await tableStates(db, [T]).catch(() => ({}) as Record<string, string>))[T] ?? "?";
    results.push({
      id: "PL07e",
      title: "PL07e: restart with invalidated_slot_behavior error (default)",
      status: "info",
      detail: `container running after 60 s: ${running}; table state ${stE}`,
      measurements: {
        container_running_after_60s: String(running),
        table_state: stE,
        log_lines_matching: logE.length,
        first_matching_line: lbl(logE.find((l) => /invalid|lost/i.test(l)) ?? logE[0] ?? "none", 240),
      },
    });

    // ---- PL07f: recreate
    await killReplicator().catch(() => undefined);
    // The WAL for these deletes is not retained for the lost slot, so a destination
    // that reaches the new count can only have got there by a rebuild.
    await db.q(`delete from ${T} where id between 200000 and 200049`);
    await renderConfig(state, { ...opts, tag: currentTag(), invalidated: "recreate" });
    const t2 = Date.now();
    await startReplicator(state, { ...opts, invalidated: "recreate" });
    const duck2 = await openDuck();
    let rebuilt = -1;
    let dest2 = "";
    let newStates = "";
    const src2 = await db.scalar(`select count(*) from ${T}`);
    try {
      for (let i = 0; i < 150; i++) {
        await sleep(4000);
        const hist = await db
          .q(
            `select state::text as s from etl.replication_state where pipeline_id = 1 and table_id = '${T}'::regclass::oid and created_at > to_timestamp(${t2 / 1000}) order by id`,
          )
          .catch(() => []);
        newStates = hist.map((h) => h.s).join(">");
        dest2 = await duck2.scalar(`select count(*) from lake.public.pl07_wal`).catch(() => "");
        if (dest2 === src2 && /sync_done|ready/.test(newStates)) {
          rebuilt = Date.now() - t2;
          break;
        }
      }
    } finally {
      duck2.close();
    }
    const slotAfter = applySlot(await slots(db));
    results.push({
      id: "PL07f",
      title: "PL07f: invalidated_slot_behavior recreate rebuilds the table",
      status: rebuilt >= 0 ? "info" : "fail",
      detail: rebuilt >= 0 ? `destination matched source ${round(rebuilt / 1000, 1)} s after restart (50 rows deleted at the source while the slot was lost)` : `no rebuild within 600 s (dest ${dest2} of ${src2})`,
      measurements: {
        restart_to_rebuilt_s: rebuilt >= 0 ? round(rebuilt / 1000, 1) : -1,
        table_states_after_restart: lbl(newStates || "none"),
        src_rows: src2,
        dest_rows: dest2,
        new_slot_status: slotAfter?.wal_status ?? "none",
        new_slot_active: slotAfter?.active ?? "none",
      },
    });
    void pct;
    return results;
  },
};

export default withCleanup(mod);
