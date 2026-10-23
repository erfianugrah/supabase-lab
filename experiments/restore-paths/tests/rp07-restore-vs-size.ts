/**
 * RP07 - PITR restore time against database size, past 1 GB.
 *
 * RP02 measured back-to-ACTIVE_HEALTHY at 30 s on a 10 MB database and 81 s at
 * 574 MB (Small). This module grows one database through the sizes in
 * RP07_SIZES_GB (default 3,10) and restores at each, so the slope past 1 GB
 * has a measured point. n = 1 per size.
 *
 * One throwaway Pro project (RP07_COMPUTE, default small; ap-southeast-1),
 * `pitr_7` applied by this module and removed in `finally`. The disk is grown
 * ONCE up front to RP07_DISK_GB (default 40) with POST /config/disk: the
 * manual-grow cooldown is four hours (compute-disk D03) and a fast fill on the
 * default disk hit `53100` in compute-disk D10.
 *
 *   RP07a  create, enable pitr_7, grow the disk; disk as reported.
 *   RP07b<n>  per size: fill with 1M-row INSERTs of ~230 B rows over the
 *          session pooler until pg_database_size reaches the size; fill time;
 *          wait for the platform's recoverable upper bound to pass the fill's
 *          end (archive catch-up); then restore to that bound and measure time
 *          to ACTIVE_HEALTHY plus per-path outage (REST, Auth, Storage,
 *          Realtime, pooler) with the RP02 sampler; rows counted after.
 *   RP07z  cleanup.
 *
 * Second-revision additions (2026-10-22 UTC, first complete run R18 in the
 * RUNLOG), after R15's 10 GB restore came back short of rows: `rp_bulk.at` (clock_timestamp) so the newest restored row can be set
 * against the target and the fill's end; WAL position at the fill's end and
 * at restore (pg_walfile_name(pg_current_wal_lsn()) against
 * pg_stat_archiver.last_archived_wal); RP07_WAIT_ARCHIVER=1 as a control that
 * also waits for the archiver to pass the fill-end segment before reading the
 * bound; and a `rest_read` probe (a Data API read that reaches Postgres),
 * because the `rest` probe's anon 401 on /rest/v1/ never touches the database.
 *
 * What the restore replays: the fill happens after the project's latest
 * physical backup (recorded per row), so each restore is base backup + WAL
 * for everything written since. That is the shape of a restore late in a
 * backup cycle, not right after a base backup; the two are not separated.
 *
 * DESTRUCTIVE and BILLABLE. Not settled: n>1, other compute sizes for the
 * same size, a restore right after a fresh base backup, sizes past the last
 * one run.
 */
import { mgmt } from "../../../harness/src/mgmt";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  addMarker,
  again,
  applyPitr7,
  backups,
  createProject,
  dbSizeMb,
  deleteProject,
  diskLine,
  errText,
  flatten,
  healthLine,
  markerLabels,
  measureRestore,
  pitrBound,
  poolerClient,
  randomPassword,
  recoveryLogLines,
  restReadProbe,
  seedData,
  seedStorage,
  sleep,
  storageState,
  subjectOf,
  waitPitrReady,
  waitProjectStatus,
  walMb,
  walPosition,
  type Subject,
} from "../lib/rp";

const SIZES_GB = (process.env.RP07_SIZES_GB ?? "3,10").split(",").map(Number).filter((x) => x > 0);
const COMPUTE = process.env.RP07_COMPUTE ?? "small";
const DISK_GB = Number(process.env.RP07_DISK_GB ?? 40);
const ARCHIVE_WAIT_MS = 45 * 60_000;
const WAIT_ARCHIVER = process.env.RP07_WAIT_ARCHIVER === "1";

async function growDisk(s: Subject): Promise<{ http: number; text: string; appliedAfterS: number | string }> {
  const cur = await mgmt(s.ctx, "GET", `/projects/${s.ref}/config/disk`);
  const attrs = ((cur.json ?? {}) as { attributes?: Record<string, unknown> }).attributes ?? {};
  const r = await mgmt(s.ctx, "POST", `/projects/${s.ref}/config/disk`, { attributes: { ...attrs, size_gb: DISK_GB } });
  const t0 = Date.now();
  let applied: number | string = "never";
  while (r.status < 300 && Date.now() - t0 < 15 * 60_000) {
    const u = await again(() => mgmt(s.ctx, "GET", `/projects/${s.ref}/config/disk/util`));
    const fs = ((u.json ?? {}) as { metrics?: { fs_size_bytes?: number } }).metrics?.fs_size_bytes ?? 0;
    if (fs > (DISK_GB - 2) * 1024 ** 3) {
      applied = Math.round((Date.now() - t0) / 1000);
      break;
    }
    await sleep(20_000);
  }
  return { http: r.status, text: r.text.slice(0, 160), appliedAfterS: applied };
}

/** Fill until pg_database_size >= gb. Returns seconds, MB/s and the final size. */
async function fillTo(s: Subject, pw: string, gb: number): Promise<{ s: number; mbPerS: number; dbMb: number; stmts: number; error: string }> {
  const target = gb * 1024;
  const start = await again(() => dbSizeMb(s));
  const t0 = Date.now();
  let c = await poolerClient(s, pw);
  let stmts = 0;
  let error = "";
  let dbMb = start;
  try {
    await c.query(
      "create table if not exists public.rp_bulk (id bigserial primary key, pad text not null, at timestamptz not null default clock_timestamp())",
    );
    while (dbMb < target && stmts < 400) {
      try {
        await c.query("insert into public.rp_bulk(pad) select repeat(md5(random()::text), 7) from generate_series(1, 1000000)");
        stmts += 1;
        const r = await c.query("select (pg_database_size(current_database()) / 1048576)::int as mb");
        dbMb = Number(r.rows[0].mb);
      } catch (e) {
        error = errText(e);
        await c.end().catch(() => {});
        await sleep(15_000);
        c = await poolerClient(s, pw);
      }
    }
  } finally {
    await c.end().catch(() => {});
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  return { s: secs, mbPerS: Number(((dbMb - start) / Math.max(secs, 1)).toFixed(1)), dbMb, stmts, error };
}

const mod: TestModule = {
  id: "RP07",
  title: "PITR restore time against database size (past 1 GB)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "RP07", title: "RP07", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const pw = randomPassword();
    let ref = "";
    let pitrOn = false;
    let tPitr = 0;
    const tCreate = Date.now();
    try {
      const created = await createProject(ctx, org, `rp-rp07-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, pw, COMPUTE);
      ref = created.ref;
      if (!ref) return [{ id: "RP07a", title: "create", status: "fail", detail: `HTTP ${created.status} ${created.text}` }];
      const healthy = await waitProjectStatus(ctx, ref, "ACTIVE_HEALTHY", 10 * 60_000);
      if (!healthy.ok) return [{ id: "RP07a", title: "create", status: "fail", detail: `not healthy: ${healthy.last}` }];
      const s = await subjectOf(ctx, ref);
      await seedData(s);
      const seedSt = await seedStorage(s);
      tPitr = Date.now();
      const en = await applyPitr7(ctx, ref);
      pitrOn = en.status < 300;
      const ready = pitrOn ? await waitPitrReady(s) : { enabledS: "n/a", windowS: "n/a" };
      const grow = await growDisk(s);
      out.push({
        id: "RP07a",
        title: `create (${COMPUTE}), enable pitr_7, grow disk to ${DISK_GB} GB`,
        status: pitrOn && grow.http < 300 ? "info" : "fail",
        detail: `addon HTTP ${en.status}; disk POST HTTP ${grow.http}, applied after ${grow.appliedAfterS}s`,
        measurements: {
          compute: COMPUTE,
          seed_storage: seedSt,
          addon_http: en.status,
          window_populated_after_s: ready.windowS,
          disk_post_http: grow.http,
          disk_post_body: grow.text,
          disk_applied_after_s: grow.appliedAfterS,
          disk: await again(() => diskLine(s)),
        },
      });
      if (!pitrOn || grow.http >= 300) return out;

      let n = 0;
      for (const gb of SIZES_GB) {
        n += 1;
        const id = `RP07b${n}`;
        const fill = await fillTo(s, pw, gb);
        const fillEnd = Math.floor(Date.now() / 1000);
        const walAtFillEnd = await again(() => walPosition(s));
        await again(() => addMarker(s, `filled-${gb}gb`));
        const bkBefore = await again(() => backups(s));
        // Archive catch-up: wait for the recoverable upper bound to pass the fill's end.
        const tw = Date.now();
        let bound = await again(() => pitrBound(s));
        while ((bound.latest === null || bound.latest < fillEnd + 10) && Date.now() - tw < ARCHIVE_WAIT_MS) {
          await sleep(30_000);
          bound = await again(() => pitrBound(s));
        }
        const catchUpS = Math.round((Date.now() - tw) / 1000);
        // Control (RP07_WAIT_ARCHIVER=1): also wait until Postgres's archiver has
        // archived the segment that was current at the fill's end, then re-read the bound.
        let archiverWaitS: number | string = "not waited";
        if (WAIT_ARCHIVER && !walAtFillEnd.lastArchived) archiverWaitS = "archiver reports nothing archived; not waited";
        if (WAIT_ARCHIVER && walAtFillEnd.current && walAtFillEnd.lastArchived) {
          const ta = Date.now();
          let p = await again(() => walPosition(s));
          while ((!p.lastArchived || p.lastArchived < walAtFillEnd.current) && Date.now() - ta < ARCHIVE_WAIT_MS) {
            await sleep(30_000);
            p = await again(() => walPosition(s));
          }
          archiverWaitS = !p.lastArchived || p.lastArchived < walAtFillEnd.current ? `gave up ${Math.round((Date.now() - ta) / 1000)}` : Math.round((Date.now() - ta) / 1000);
          bound = await again(() => pitrBound(s));
        }
        const walAtRestore = await again(() => walPosition(s));
        const wal = await again(() => walMb(s));
        const disk = await again(() => diskLine(s));
        const rowsBefore = await again(() => sql(s.ctx, "select count(*)::bigint as n from public.rp_bulk", 120_000));
        if (bound.latest === null || bound.latest < fillEnd + 10) {
          out.push({
            id,
            title: `${gb} GB: restore`,
            status: "fail",
            detail: `bound did not pass the fill end within ${ARCHIVE_WAIT_MS / 60_000} min: ${bound.text}`,
            measurements: { fill_s: fill.s, db_mb: fill.dbMb, archive_catch_up_s: catchUpS, wal_mb: wal },
          });
          break;
        }
        const target = bound.latest;
        const run = await measureRestore(s, {
          newPw: pw,
          oldPw: randomPassword(),
          issue: async () => {
            const r = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore-pitr`, { recovery_time_target_unix: target });
            return { status: r.status, text: r.text };
          },
          retryMs: 5 * 60_000,
          maxMs: 90 * 60_000,
          extraProbes: [restReadProbe(s)],
        });
        const rowsAfter = await again(() => sql(s.ctx, "select count(*)::bigint as n from public.rp_bulk", 120_000));
        const newest = await again(() => sql(s.ctx, "select extract(epoch from max(at))::float8 as t from public.rp_bulk", 120_000));
        const newestAt = newest.rows[0]?.t === null || newest.rows[0]?.t === undefined ? NaN : Number(newest.rows[0].t);
        const ok = run.http >= 200 && run.http < 300;
        out.push({
          id,
          title: `${gb} GB: fill, archive catch-up, PITR restore to the latest recoverable instant`,
          status: ok ? "info" : "fail",
          detail: `db ${fill.dbMb} MB; back healthy after ${run.tl?.backHealthyS ?? "n/a"}s; statuses ${run.tl?.seen.join(" -> ") ?? "n/a"}`,
          measurements: {
            size_target_gb: gb,
            db_mb_before_restore: fill.dbMb,
            fill_s: fill.s,
            fill_mb_per_s: fill.mbPerS,
            fill_statements: fill.stmts,
            fill_error: fill.error || "none",
            archive_catch_up_s: catchUpS,
            wait_archiver: String(WAIT_ARCHIVER),
            archiver_wait_s: archiverWaitS,
            wal_at_fill_end: walAtFillEnd.line,
            wal_at_restore: walAtRestore.line,
            target_unix: target,
            target_minus_fill_end_s: target - fillEnd,
            newest_restored_row_minus_fill_end_s: Number.isFinite(newestAt) ? Number((newestAt - fillEnd).toFixed(1)) : "n/a",
            newest_restored_row_minus_target_s: Number.isFinite(newestAt) ? Number((newestAt - target).toFixed(1)) : "n/a",
            wal_mb_before_restore: wal,
            disk_before_restore: disk,
            backups_window_latest_unix: bkBefore.windowLatest ?? "none",
            fill_end_minus_backups_window_latest_s: bkBefore.windowLatest ? fillEnd - bkBefore.windowLatest : "n/a",
            physical_backups_listed: bkBefore.physicalIds.length,
            project_age_at_restore_min: Math.round((Date.now() - tCreate) / 60_000),
            restore_http: run.http,
            restore_body: run.body,
            accepted_after_s: run.acceptedAfterS,
            status_first_off_s: run.tl?.firstOffS ?? "n/a",
            status_back_healthy_s: run.tl?.backHealthyS ?? "n/a",
            status_poll_resolution_s: 10,
            statuses_seen: run.tl?.seen.join(" -> ") ?? "n/a",
            rows_before: String(rowsBefore.rows[0]?.n ?? `HTTP ${rowsBefore.status}`),
            rows_after: String(rowsAfter.rows[0]?.n ?? `HTTP ${rowsAfter.status}`),
            markers_after: await again(() => markerLabels(s)),
            db_mb_after_restore: await again(() => dbSizeMb(s)),
            storage_after: (await storageState(s, `rp07-${gb}`)).line,
            health_after: await again(() => healthLine(s)),
            cred_final_current: run.cred?.finalNew ?? "n/a",
            recovery_log: await recoveryLogLines(s),
            ...flatten(run.windows, run.postOffsetMs),
          },
        });
        if (!ok) break;
      }
    } catch (e) {
      out.push({ id: "RP07", title: "RP07 aborted", status: "fail", detail: `threw: ${errText(e)}` });
    } finally {
      let rm = -2;
      if (ref && pitrOn) rm = (await mgmt(ctx, "DELETE", `/projects/${ref}/billing/addons/pitr_7`).catch(() => ({ status: -1 }))).status;
      const pitrHours = tPitr ? ((Date.now() - tPitr) / 3_600_000).toFixed(2) : "0";
      let del = -2;
      if (ref) del = await deleteProject(ctx, ref).catch(() => -1);
      out.push({
        id: "RP07z",
        title: "cleanup: pitr_7 removed, project deleted",
        status: del >= 200 && del < 300 ? "info" : "fail",
        detail: `DELETE pitr_7 HTTP ${rm}; DELETE project HTTP ${del}`,
        measurements: { pitr_on_hours: pitrHours, project_hours: ((Date.now() - tCreate) / 3_600_000).toFixed(2) },
      });
    }
    return out;
  },
};

export default mod;
