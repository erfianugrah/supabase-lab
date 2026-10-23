/**
 * RP06 - PITR recovery point: how far behind "now" the platform's latest
 * recoverable instant sits, under a light steady writer and while idle, and
 * what a restore to that instant keeps.
 *
 * Doc claim under test (guides/platform/backups): WAL files are backed up at
 * two-minute intervals, sooner on volume, so the worst-case RPO is two
 * minutes; an idle database can show a latest restore point far behind the
 * current time. Hypothesis: lag <= 120 s under writes. Competing: a light
 * writer does not fill segments, so the lag runs past 120 s.
 *
 * One throwaway Pro project (Small, ap-southeast-1) with `pitr_7` applied by
 * this module and removed in `finally`.
 *
 *   RP06a  enable pitr_7, window populated; archive settings as Postgres
 *          reports them.
 *   RP06b  writer phase: one INSERT per ~200 ms through the session pooler,
 *          each acknowledged with the database clock. Every ~15 s read the
 *          platform's upper bound (restore-pitr refusal text, as RP02c) and
 *          GET database/backups, and pg_stat_archiver. lag = sample time -
 *          bound.
 *   RP06c  idle phase: the same sampling with the writer stopped.
 *   RP06d  writer again for a few minutes, read the bound L, restore to L
 *          (writer still running when the request goes in). After: acked rows
 *          written before L that are missing, rows after L that survived,
 *          newest restored row vs L, and acked rows lost relative to the
 *          moment the restore was issued.
 *   RP06e  cleanup.
 *
 * Clocks: lag uses this machine's clock against the platform's unix bound;
 * RP06d compares database clock_timestamp() against the same bound. Skew
 * between the three is not measured.
 *
 * DESTRUCTIVE and BILLABLE. Not settled: lag under heavy write volume, a
 * different region or compute size, n>1 restores.
 */
import { mgmt } from "../../../harness/src/mgmt";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  again,
  applyPitr7,
  archiverLine,
  backups,
  createProject,
  deleteProject,
  errText,
  flatten,
  measureRestore,
  pitrBound,
  poolerClient,
  randomPassword,
  recoveryLogLines,
  restReadProbe,
  sleep,
  stats,
  walPosition,
  subjectOf,
  waitPitrReady,
  waitProjectStatus,
  type Subject,
} from "../lib/rp";

const PHASE_MS = Number(process.env.RP06_PHASE_MIN ?? 20) * 60_000;
const SAMPLE_MS = 15_000;
const WRITE_EVERY_MS = 200;
const PRE_RESTORE_WRITE_MS = Number(process.env.RP06_PRE_RESTORE_MIN ?? 4) * 60_000;

interface Ack {
  seq: number;
  at: number; // database clock, unix seconds (fractional)
}

/** One persistent session-pooler connection writing a row every ~200 ms. */
function startWriter(s: Subject, pw: string, seqStart: number) {
  let running = true;
  const acks: Ack[] = [];
  const errors: string[] = [];
  let seq = seqStart;
  const done = (async () => {
    let c = await poolerClient(s, pw).catch((e) => {
      errors.push(errText(e));
      return undefined;
    });
    while (running) {
      const t = Date.now();
      try {
        if (!c) c = await poolerClient(s, pw);
        const r = await c.query("insert into public.rp_writes(seq) values ($1) returning seq, extract(epoch from written_at)::float8 as at", [seq]);
        acks.push({ seq, at: Number(r.rows[0].at) });
        seq += 1;
      } catch (e) {
        const m = errText(e);
        if (!errors.includes(m)) errors.push(m);
        await c?.end().catch(() => {});
        c = undefined;
        await sleep(2000);
      }
      const wait = WRITE_EVERY_MS - (Date.now() - t);
      if (wait > 0) await sleep(wait);
    }
    await c?.end().catch(() => {});
  })();
  return {
    acks,
    errors,
    nextSeq: () => seq,
    /** Stop issuing new INSERTs now, without waiting for one in flight. */
    halt() {
      running = false;
    },
    async stop() {
      running = false;
      await done;
    },
  };
}

interface Sample {
  bound: number[];
  backupsLatest: number[];
  archiver: number[];
  refusedNoRange: number;
  firstText: string;
  archLine: string;
}

async function samplePhase(s: Subject, ms: number): Promise<Sample> {
  const out: Sample = { bound: [], backupsLatest: [], archiver: [], refusedNoRange: 0, firstText: "", archLine: "" };
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const tick = Date.now();
    const b = await again(() => pitrBound(s));
    const now = Date.now() / 1000;
    if (!out.firstText) out.firstText = `HTTP ${b.http} ${b.text}`;
    if (b.http >= 200 && b.http < 300) throw new Error(`future-target restore-pitr was ACCEPTED (HTTP ${b.http}); project restored`);
    if (b.latest !== null) out.bound.push(Math.round(now - b.latest));
    else out.refusedNoRange += 1;
    const bk = await again(() => backups(s));
    if (bk.windowLatest) out.backupsLatest.push(Math.round(Date.now() / 1000 - bk.windowLatest));
    const a = await archiverLine(s);
    out.archLine = a.line;
    if (a.lastArchivedUnix !== null) out.archiver.push(Math.round(Date.now() / 1000 - a.lastArchivedUnix));
    const wait = SAMPLE_MS - (Date.now() - tick);
    if (wait > 0) await sleep(wait);
  }
  return out;
}

function phaseRow(id: string, title: string, p: Sample, extra: Record<string, number | string>): TestResult {
  const b = stats(p.bound);
  const bk = stats(p.backupsLatest);
  const ar = stats(p.archiver);
  return {
    id,
    title,
    status: "info",
    detail: `bound lag s min/p50/max ${b.min}/${b.p50}/${b.max} over ${b.n} samples; ${p.bound.filter((x) => x > 120).length} samples > 120 s`,
    measurements: {
      sample_every_s: SAMPLE_MS / 1000,
      bound_samples: b.n,
      bound_lag_min_s: b.min,
      bound_lag_p50_s: b.p50,
      bound_lag_max_s: b.max,
      bound_lag_over_120s_samples: p.bound.filter((x) => x > 120).length,
      bound_lag_series_s: p.bound.join(",").slice(0, 600),
      refusals_without_range: p.refusedNoRange,
      first_refusal: p.firstText,
      backups_window_latest_lag_min_s: bk.min,
      backups_window_latest_lag_p50_s: bk.p50,
      backups_window_latest_lag_max_s: bk.max,
      archiver_last_archived_lag_min_s: ar.min,
      archiver_last_archived_lag_p50_s: ar.p50,
      archiver_last_archived_lag_max_s: ar.max,
      archiver: p.archLine,
      ...extra,
    },
  };
}

const mod: TestModule = {
  id: "RP06",
  title: "PITR recovery point: lag of the latest recoverable instant, and what a restore to it keeps",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "RP06", title: "RP06", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const pw = randomPassword();
    let ref = "";
    let pitrOn = false;
    let tPitr = 0;
    try {
      const created = await createProject(ctx, org, `rp-rp06-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, pw, "small");
      ref = created.ref;
      if (!ref) return [{ id: "RP06a", title: "create", status: "fail", detail: `HTTP ${created.status} ${created.text}` }];
      const healthy = await waitProjectStatus(ctx, ref, "ACTIVE_HEALTHY", 10 * 60_000);
      if (!healthy.ok) return [{ id: "RP06a", title: "create", status: "fail", detail: `not healthy: ${healthy.last}` }];
      const s = await subjectOf(ctx, ref);
      const mk = await sql(
        s.ctx,
        "create table public.rp_writes (seq bigint primary key, written_at timestamptz not null default clock_timestamp()); grant select, insert, update, delete on table public.rp_writes to anon, authenticated, service_role",
      );

      // ---- RP06a ----
      tPitr = Date.now();
      const en = await applyPitr7(ctx, ref);
      pitrOn = en.status < 300;
      const ready = pitrOn ? await waitPitrReady(s) : { enabledS: "n/a", windowS: "n/a" };
      const arch0 = await archiverLine(s);
      const settings = await sql(
        s.ctx,
        "select string_agg(name || '=' || setting, ' ' order by name) as v from pg_settings where name in ('archive_timeout','wal_segment_size','max_wal_size','checkpoint_timeout','wal_level')",
      );
      out.push({
        id: "RP06a",
        title: "enable pitr_7 on a Small project; archive settings",
        status: pitrOn && ready.windowS !== "never" ? "info" : "fail",
        detail: `addon HTTP ${en.status}; window after ${ready.windowS}s`,
        measurements: {
          create_table: mk.status === 201 ? "ok" : `HTTP ${mk.status} ${mk.error}`,
          addon_http: en.status,
          pitr_enabled_after_s: ready.enabledS,
          window_populated_after_s: ready.windowS,
          archiver: arch0.line,
          settings: String(settings.rows[0]?.v ?? `HTTP ${settings.status} ${settings.error}`),
        },
      });
      if (!pitrOn || ready.windowS === "never") return out;

      // ---- RP06b: writer ---- (RP06_PHASE_MIN=0 skips b and c and goes to the restore)
      const w1 = startWriter(s, pw, 1);
      if (PHASE_MS > 0) {
        await sleep(30_000);
        const pw1 = await samplePhase(s, PHASE_MS);
        await w1.stop();
        out.push(
          phaseRow("RP06b", "writer phase (one INSERT per ~200 ms): lag of the latest recoverable instant", pw1, {
            phase_min: PHASE_MS / 60_000,
            writer_acked_rows: w1.acks.length,
            writer_rows_per_s: Number((w1.acks.length / ((PHASE_MS + 30_000) / 1000)).toFixed(2)),
            writer_errors: w1.errors.join(" | ").slice(0, 200) || "none",
          }),
        );

        // ---- RP06c: idle ----
        await sleep(15_000);
        const pi = await samplePhase(s, PHASE_MS);
        out.push(phaseRow("RP06c", "idle phase (writer stopped): lag of the latest recoverable instant", pi, { phase_min: PHASE_MS / 60_000 }));
      } else {
        await w1.stop();
      }

      // ---- RP06d: restore to the latest recoverable instant under writes ----
      const w2 = startWriter(s, pw, w1.nextSeq());
      await sleep(PRE_RESTORE_WRITE_MS);
      const b = await again(() => pitrBound(s));
      const tBoundRead = Date.now() / 1000;
      const walAtBound = await again(() => walPosition(s));
      const archAtBound = await again(() => archiverLine(s));
      if (b.latest === null) {
        await w2.stop();
        out.push({ id: "RP06d", title: "restore to latest", status: "fail", detail: `no range quoted: HTTP ${b.http} ${b.text}` });
        return out;
      }
      const L = b.latest;
      let tIssued = 0;
      const run = await measureRestore(s, {
        newPw: pw,
        oldPw: randomPassword(),
        issue: async () => {
          const r = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore-pitr`, { recovery_time_target_unix: L });
          tIssued = Date.now() / 1000;
          // Stop writing once the restore is in: rows written after it would
          // land in the restored database and read as "kept" (R20, R21 on 2026-10-23 UTC; RUNLOG run ids).
          if (r.status >= 200 && r.status < 300) w2.halt();
          return { status: r.status, text: r.text };
        },
        retryMs: 5 * 60_000,
        extraProbes: [restReadProbe(s, "rp_writes")],
      });
      await w2.stop();
      // Only writes acknowledged before the restore request count; anything a
      // reconnecting writer got in after it is excluded on both sides.
      const acked = [...w1.acks, ...w2.acks].filter((a) => a.at <= tIssued);
      const rr = await again(() => sql(s.ctx, "select seq, extract(epoch from written_at)::float8 as at from public.rp_writes order by seq"));
      const restored = new Map<number, number>();
      for (const x of rr.rows) if (Number(x.at) <= tIssued) restored.set(Number(x.seq), Number(x.at));
      const postRestoreRows = rr.rows.filter((x) => Number(x.at) > tIssued).length;
      const ackedBefore = acked.filter((a) => a.at < L);
      const missingBefore = ackedBefore.filter((a) => !restored.has(a.seq));
      const missingAges = missingBefore.map((a) => Number((L - a.at).toFixed(2))).sort((x, y) => y - x);
      const keptBefore = ackedBefore.filter((a) => restored.has(a.seq));
      const newestKeptBefore = keptBefore.length ? Math.max(...keptBefore.map((a) => a.at)) : NaN;
      const oldestMissing = missingBefore.length ? Math.min(...missingBefore.map((a) => a.at)) : NaN;
      const survivedAfter = [...restored.values()].filter((at) => at > L + 1).length;
      const newest = restored.size ? Math.max(...restored.values()) : NaN;
      const ackedAfterTarget = acked.filter((a) => a.at > L);
      const ackedBeforeIssue = acked.filter((a) => a.at <= tIssued);
      const lostAtIssue = ackedBeforeIssue.filter((a) => !restored.has(a.seq));
      const ok = run.http >= 200 && run.http < 300;
      out.push({
        id: "RP06d",
        title: "restore to the latest recoverable instant while a writer runs: what is kept",
        status: ok ? "info" : "fail",
        detail: `target lag at read ${Math.round(tBoundRead - L)}s; acked-before-target missing ${missingBefore.length}/${ackedBefore.length}; acked lost vs issue ${lostAtIssue.length}`,
        measurements: {
          target_lag_at_read_s: Math.round(tBoundRead - L),
          issued_minus_target_s: tIssued ? Math.round(tIssued - L) : "n/a",
          restore_http: run.http,
          accepted_after_s: run.acceptedAfterS,
          attempts: run.attempts.length,
          status_back_healthy_s: run.tl?.backHealthyS ?? "n/a",
          statuses_seen: run.tl?.seen.join(" -> ") ?? "n/a",
          rows_restored: restored.size,
          read_after_restore: rr.status === 201 ? "ok" : `HTTP ${rr.status} ${rr.error}`,
          acked_total: acked.length,
          acked_before_target: ackedBefore.length,
          acked_before_target_missing: missingBefore.length,
          missing_before_target_ages_s: missingAges.join(",").slice(0, 300) || "none",
          target_minus_newest_kept_s: Number.isFinite(newestKeptBefore) ? Number((L - newestKeptBefore).toFixed(2)) : "n/a",
          target_minus_oldest_missing_s: Number.isFinite(oldestMissing) ? Number((L - oldestMissing).toFixed(2)) : "n/a",
          wal_at_bound_read: walAtBound.line,
          archiver_at_bound_read: archAtBound.line,
          archiver_last_archived_minus_target_s: archAtBound.lastArchivedUnix === null ? "n/a" : archAtBound.lastArchivedUnix - L,
          rows_written_after_issue_excluded: postRestoreRows,
          restored_rows_after_target_plus_1s: survivedAfter,
          newest_restored_minus_target_s: Number.isFinite(newest) ? Number((newest - L).toFixed(1)) : "n/a",
          acked_after_target: ackedAfterTarget.length,
          acked_before_issue_lost: lostAtIssue.length,
          lost_span_s: lostAtIssue.length ? Number((Math.max(...lostAtIssue.map((a) => a.at)) - Math.min(...lostAtIssue.map((a) => a.at))).toFixed(1)) : 0,
          writer_errors: w2.errors.join(" | ").slice(0, 200) || "none",
          recovery_log: await recoveryLogLines(s),
          ...flatten(run.windows, run.postOffsetMs),
        },
      });
    } catch (e) {
      out.push({ id: "RP06", title: "RP06 aborted", status: "fail", detail: `threw: ${errText(e)}` });
    } finally {
      let rm = -2;
      if (ref && pitrOn) rm = (await mgmt(ctx, "DELETE", `/projects/${ref}/billing/addons/pitr_7`).catch(() => ({ status: -1 }))).status;
      const pitrHours = tPitr ? ((Date.now() - tPitr) / 3_600_000).toFixed(2) : "0";
      let del = -2;
      if (ref) del = await deleteProject(ctx, ref).catch(() => -1);
      out.push({
        id: "RP06e",
        title: "cleanup: pitr_7 removed, project deleted",
        status: del >= 200 && del < 300 ? "info" : "fail",
        detail: `DELETE pitr_7 HTTP ${rm}; DELETE project HTTP ${del}`,
        measurements: { pitr_on_hours: pitrHours },
      });
    }
    return out;
  },
};

export default mod;
