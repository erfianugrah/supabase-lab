/**
 * RP08 - PITR restore to the quoted latest instant while the WAL archiver is
 * behind: does the restore come back short?
 *
 * Why: in RP07 R15 (2026-10-22 UTC, RUNLOG) one 10 GB restore to the quoted
 * upper bound answered 201, returned to ACTIVE_HEALTHY, and kept 31,000,000
 * of 37,000,000 rows with the post-fill marker missing; four later 10 GB
 * restores kept everything. RP06 found the bound equals
 * pg_stat_archiver.last_archived_time.
 *
 * H1 (archiver lag, untested before this module): under heavy writes the
 * archiver falls behind; last_archived_time keeps moving because it is busy
 * archiving old segments, so the quoted bound reads "now" while the archived
 * WAL ends segments earlier, and a restore to the bound stops at the archive
 * frontier. Predicts: acked statements and the post-fill marker missing only
 * when segments were waiting (`.ready`) at the call, and the recovery stop LSN
 * at or near the end of the last archived segment of that moment.
 * H2 (the restore picked an earlier base backup or an earlier target): stop
 * LSN unrelated to the archive frontier (well below it), loss even with no
 * backlog, or the recovery log naming a target time before the requested one.
 * H3 (the fill had not committed): only statements without an acknowledgement
 * are missing. Every statement here is acknowledged with its commit, so a
 * missing acked statement rules H3 out for that restore.
 *
 * One throwaway Pro project (Small, ap-southeast-1), `pitr_7` and a disk grow
 * applied by this module and removed with the project in `finally`.
 *
 *   RP08a  create, enable pitr_7, grow the disk once (RP08_DISK_GB, default 40).
 *   RP08b<n> one cycle per entry of RP08_ARMS (default latest,explicit):
 *          RP08_WRITERS (default 3) session-pooler connections each commit
 *          RP08_ROWS-row INSERTs (default 100,000 rows of ~230 B, the RP07
 *          row) into rp_bulk, each statement writing its own rp_ledger row in
 *          the same statement (so a ledger row is present iff its bulk rows
 *          are); a ticker commits one rp_tick row per 250 ms. A sampler reads
 *          pg_current_wal_lsn, pg_stat_archiver and the `.ready` count every
 *          10 s and the platform's bound every 20 s. The write phase ends when
 *          `.ready` >= RP08_STOP_READY (default 128) after RP08_MIN_WRITE_S,
 *          or the cycle wrote RP08_CYCLE_GB, or RP08_MAX_WRITE_S passed.
 *          Arms:
 *            latest   writers stop, `postfill-c<n>` marker, wait (30 s polls,
 *                     as RP07) for the bound to pass the fill end + 10 s,
 *                     restore to the bound L. R15's procedure.
 *            explicit as latest, but the target is floor(now) - 2 read just
 *                     before the call, clamped to L.
 *            live     writers still running; marker, bound read, restore to L
 *                     at once; writers and ticker halt when the call is accepted.
 *          Before the call: bound, backups window, archiver line, LSN, `.ready`,
 *          acked statements and ticks. After: acked statements/ticks written
 *          before the target that are missing, the marker, rp_bulk count
 *          against ledger, the recovery log (stop LSN, base backup redo LSN),
 *          and which password the pooler accepts.
 *   RP08z  cleanup.
 *
 * Cycle 2+ truncates rp_bulk first (disk). Each restore replays WAL from the
 * newest base backup: in R29 and R30 (2026-10-23 UTC, RUNLOG) a restore after
 * the first started from a backup whose redo LSN sat 2 segments past the
 * previous restore's stop, so only the current cycle's WAL was replayed.
 *
 * Clocks: targets and bounds are platform unix seconds; acks carry the
 * database clock; db-minus-local skew is recorded per snapshot.
 *
 * DESTRUCTIVE and BILLABLE.
 */
import { appendFileSync } from "node:fs";
import type { Client } from "pg";
import { mgmt } from "../../../harness/src/mgmt";
import { logsQuery, sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  again,
  applyPitr7,
  backups,
  createProject,
  deleteProject,
  diskLine,
  errText,
  flatten,
  markerLabels,
  measureRestore,
  pitrBound,
  poolerClient,
  randomPassword,
  restReadProbe,
  setPassword,
  settledLogin,
  sleep,
  subjectOf,
  waitPitrReady,
  waitProjectStatus,
  type Subject,
} from "../lib/rp";
import { fmtLsn, lsnNum, segOfLsn, segOfWalName, stopLsnFromLog, timeAtLsn } from "../lib/wal";

const env = process.env;
const ARMS = (env.RP08_ARMS ?? "latest,explicit").split(",").map((x) => x.trim()).filter(Boolean);
const WRITERS = Number(env.RP08_WRITERS ?? 3);
const ROWS = Number(env.RP08_ROWS ?? 100_000);
const STOP_READY = Number(env.RP08_STOP_READY ?? 128);
const MIN_WRITE_S = Number(env.RP08_MIN_WRITE_S ?? 90);
const MAX_WRITE_S = Number(env.RP08_MAX_WRITE_S ?? 480);
const CYCLE_GB = Number(env.RP08_CYCLE_GB ?? 6);
const DISK_GB = Number(env.RP08_DISK_GB ?? 40);
const COMPUTE = env.RP08_COMPUTE ?? "small";
const REFS_FILE = env.RP08_REFS_FILE ?? "";
/**
 * bulk: rows into rp_bulk (the RP07 workload). wal: the same bytes as one
 * non-transactional logical message per statement (pg_logical_emit_message),
 * WAL without heap or index writes, a lever for a WAL rate the archiver cannot
 * keep up with; the ledger row still commits in the same statement.
 */
const LOAD = env.RP08_LOAD ?? "bulk";
const BULK_STMT =
  "with i as (insert into public.rp_bulk(pad) select repeat(md5(random()::text), 7) from generate_series(1, $1::int) returning 1) " +
  "insert into public.rp_ledger(cycle, w, stmt, n, at) select $2::int, $3::int, $4::int, count(*), clock_timestamp() from i returning extract(epoch from at)::float8 as at";
const WAL_STMT =
  "with m as (select pg_logical_emit_message(false, 'rp08', string_agg(repeat(md5(random()::text), 7), '')) as l from generate_series(1, $1::int)) " +
  "insert into public.rp_ledger(cycle, w, stmt, n, at) select $2::int, $3::int, $4::int, 0, clock_timestamp() from m returning extract(epoch from at)::float8 as at";
const TICK_MS = 250;
const SNAP_MS = 10_000;

/* ---------- database-side snapshot ---------- */

interface Snap {
  local: number;
  db: number;
  lsn: string;
  lsnN: number;
  cur: string;
  lastArchived: string;
  lastArchivedAt: number | null;
  archived: number;
  failed: number;
  lastFailed: string;
  ready: number | null;
  walMb: number;
  dbMb: number;
  ok: boolean;
  err: string;
}

const SNAP_SQL = (withReady: boolean) =>
  "select pg_current_wal_lsn()::text as lsn, pg_walfile_name(pg_current_wal_lsn()) as cur, a.last_archived_wal as la, " +
  "extract(epoch from a.last_archived_time)::float8 as lat, a.archived_count as ac, a.failed_count as fc, coalesce(a.last_failed_wal, '') as lfw, " +
  (withReady ? "(select count(*) from pg_ls_archive_statusdir() where name like '%.ready')::int as ready, " : "null::int as ready, ") +
  "(select (coalesce(sum(size), 0) / 1048576)::int from pg_ls_waldir()) as wal_mb, " +
  "(pg_database_size(current_database()) / 1048576)::int as db_mb, extract(epoch from clock_timestamp())::float8 as dbnow from pg_stat_archiver a";

let readyReadable = true;

async function snapshot(s: Subject, timeoutMs = 30_000): Promise<Snap> {
  const local = Date.now() / 1000;
  let r = await sql(s.ctx, SNAP_SQL(readyReadable), timeoutMs);
  if (r.status !== 201 && readyReadable && /archive_status|permission/i.test(r.error)) {
    readyReadable = false;
    r = await sql(s.ctx, SNAP_SQL(false), timeoutMs);
  }
  const x = r.rows[0];
  if (r.status !== 201 || !x) {
    return { local, db: NaN, lsn: "", lsnN: NaN, cur: "", lastArchived: "", lastArchivedAt: null, archived: -1, failed: -1, lastFailed: "", ready: null, walMb: -1, dbMb: -1, ok: false, err: `HTTP ${r.status} ${r.error}`.slice(0, 120) };
  }
  return {
    local,
    db: Number(x.dbnow),
    lsn: String(x.lsn),
    lsnN: lsnNum(String(x.lsn)) ?? NaN,
    cur: String(x.cur ?? ""),
    lastArchived: String(x.la ?? ""),
    lastArchivedAt: x.lat === null || x.lat === undefined ? null : Number(x.lat),
    archived: Number(x.ac),
    failed: Number(x.fc),
    lastFailed: String(x.lfw ?? ""),
    ready: x.ready === null || x.ready === undefined ? null : Number(x.ready),
    walMb: Number(x.wal_mb),
    dbMb: Number(x.db_mb),
    ok: true,
    err: "",
  };
}

function segsBehind(p: Snap): number | string {
  const a = segOfWalName(p.cur);
  const b = segOfWalName(p.lastArchived);
  return a === null || b === null ? "n/a" : a - b;
}

function snapLine(p: Snap): string {
  if (!p.ok) return `unreadable ${p.err}`;
  return (
    `lsn=${p.lsn} current=${p.cur} last_archived=${p.lastArchived} segments_behind=${segsBehind(p)} ready=${p.ready ?? "n/a"} ` +
    `archived_count=${p.archived} failed_count=${p.failed}${p.lastFailed ? ` last_failed=${p.lastFailed}` : ""} ` +
    `last_archived_age_s=${p.lastArchivedAt === null ? "n/a" : Math.round(p.db - p.lastArchivedAt)} wal_mb=${p.walMb} db_mb=${p.dbMb} db_minus_local_s=${(p.db - p.local).toFixed(1)}`
  );
}

/* ---------- writers and ticker ---------- */

interface Ack {
  w: number;
  stmt: number;
  at: number; // database clock at the end of the statement, unix s
  localAck: number; // local clock when the commit returned
}

function startBulkWriter(s: Subject, pw: string, cycle: number, w: number) {
  let running = true;
  const acks: Ack[] = [];
  const errors: string[] = [];
  let stmt = 0;
  let inflight = 0;
  const done = (async () => {
    let c: Client | undefined;
    while (running) {
      try {
        if (!c) c = await poolerClient(s, pw);
        stmt += 1;
        inflight = stmt;
        const r = await c.query(LOAD === "wal" ? WAL_STMT : BULK_STMT, [ROWS, cycle, w, stmt]);
        acks.push({ w, stmt, at: Number(r.rows[0].at), localAck: Date.now() / 1000 });
        inflight = 0;
      } catch (e) {
        const m = errText(e);
        if (!errors.includes(m)) errors.push(m);
        await c?.end().catch(() => {});
        c = undefined;
        if (running) await sleep(5000);
      }
    }
    await c?.end().catch(() => {});
  })();
  return {
    acks,
    errors,
    inflight: () => inflight,
    halt() {
      running = false;
    },
    async stop() {
      running = false;
      await done;
    },
  };
}

interface Tick {
  seq: number;
  at: number;
}

function startTicker(s: Subject, pw: string, cycle: number) {
  let running = true;
  const acks: Tick[] = [];
  const errors: string[] = [];
  let seq = 0;
  const done = (async () => {
    let c: Client | undefined;
    while (running) {
      const t = Date.now();
      try {
        if (!c) c = await poolerClient(s, pw);
        const r = await c.query("insert into public.rp_tick(cycle, seq) values ($1, $2) returning extract(epoch from at)::float8 as at", [cycle, seq + 1]);
        seq += 1;
        acks.push({ seq, at: Number(r.rows[0].at) });
      } catch (e) {
        const m = errText(e);
        if (!errors.includes(m)) errors.push(m);
        await c?.end().catch(() => {});
        c = undefined;
        if (running) await sleep(2000);
      }
      const wait = TICK_MS - (Date.now() - t);
      if (wait > 0 && running) await sleep(wait);
    }
    await c?.end().catch(() => {});
  })();
  return {
    acks,
    errors,
    halt() {
      running = false;
    },
    async stop() {
      running = false;
      await done;
    },
  };
}

/* ---------- recovery log ---------- */

const LOG_PATTERNS = [
  "starting backup recovery",
  "redo starts",
  "starting point-in-time recovery",
  "recovery stopping",
  "last completed transaction",
  "redo done",
  "consistent recovery state",
  "selected new timeline",
  "archive recovery complete",
  "could not restore file",
  "recovery target",
];

function tsSeconds(v: unknown): number {
  if (typeof v === "number") return v > 1e14 ? v / 1e6 : v > 1e11 ? v / 1e3 : v;
  // The logs endpoint returns "2026-10-23T08:13:22.020000" with no zone; it is UTC
  // (RP08 R26, 2026-10-23: parsed as local time it filtered out every line).
  const t = String(v);
  const n = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
  return Number.isFinite(n) ? n / 1000 : NaN;
}

/** Recovery lines logged after `since` (unix s), polled until a stop line appears or `maxMs` passes. */
async function recoveryLines(s: Subject, since: number, maxMs = 4 * 60_000): Promise<string[]> {
  const q =
    "select timestamp, event_message from logs where source = 'postgres_logs' and (" +
    LOG_PATTERNS.map((p) => `event_message like '%${p}%'`).join(" or ") +
    ") order by timestamp asc limit 100";
  const t0 = Date.now();
  let lines: string[] = [];
  while (true) {
    const r = await logsQuery(s.ctx, q, 2).catch((e) => ({ status: 0, rows: [] as unknown[], error: errText(e) }));
    if (r.status === 200) {
      lines = (r.rows as { timestamp?: unknown; event_message?: string }[])
        .filter((x) => tsSeconds(x.timestamp) >= since - 5)
        .map((x) => String(x.event_message ?? "").slice(0, 200));
      if (lines.some((l) => /redo done|archive recovery complete|starting point-in-time/.test(l))) return lines;
    } else {
      lines = [`logs HTTP ${r.status} ${"error" in r ? r.error : ""}`.slice(0, 200)];
    }
    if (Date.now() - t0 > maxMs) return lines;
    await sleep(30_000);
  }
}

/* ---------- disk ---------- */

async function growDisk(s: Subject, gb: number): Promise<{ http: number; appliedAfterS: number | string }> {
  const cur = await mgmt(s.ctx, "GET", `/projects/${s.ref}/config/disk`);
  const attrs = ((cur.json ?? {}) as { attributes?: Record<string, unknown> }).attributes ?? {};
  const r = await mgmt(s.ctx, "POST", `/projects/${s.ref}/config/disk`, { attributes: { ...attrs, size_gb: gb } });
  const t0 = Date.now();
  let applied: number | string = "never";
  while (r.status < 300 && Date.now() - t0 < 15 * 60_000) {
    const u = await again(() => mgmt(s.ctx, "GET", `/projects/${s.ref}/config/disk/util`));
    const fs = ((u.json ?? {}) as { metrics?: { fs_size_bytes?: number } }).metrics?.fs_size_bytes ?? 0;
    if (fs > (gb - 2) * 1024 ** 3) {
      applied = Math.round((Date.now() - t0) / 1000);
      break;
    }
    await sleep(20_000);
  }
  return { http: r.status, appliedAfterS: applied };
}

/* ---------- one cycle ---------- */

async function cycle(ctx: Ctx, s: Subject, pw: string, n: number, arm: string): Promise<{ result: TestResult; restored: boolean; pwOk: boolean }> {
  const id = `RP08b${n}`;
  const log = (m: string) => ctx.log(`[${id} ${arm}] ${m}`);
  if (n > 1) await again(() => sql(s.ctx, "truncate public.rp_bulk", 120_000));
  const start = await again(() => snapshot(s));
  const series: Snap[] = [start];
  const bounds: { local: number; latest: number | null }[] = [];
  const ticker = startTicker(s, pw, n);
  const writers = Array.from({ length: WRITERS }, (_, i) => startBulkWriter(s, pw, n, i + 1));
  const t0 = Date.now();
  let stopReason = "";
  let maxReady = 0;
  let lastBound = 0;
  while (!stopReason) {
    await sleep(SNAP_MS);
    const p = await snapshot(s).catch((e) => ({ ...start, ok: false, err: errText(e) }) as Snap);
    if (p.ok) series.push(p);
    if (p.ready !== null) maxReady = Math.max(maxReady, p.ready);
    if (Date.now() - lastBound >= 20_000) {
      lastBound = Date.now();
      const b = await pitrBound(s).catch(() => ({ latest: null }) as { latest: number | null });
      bounds.push({ local: Date.now() / 1000, latest: b.latest });
    }
    const el = (Date.now() - t0) / 1000;
    const behind = p.ready ?? (typeof segsBehind(p) === "number" ? (segsBehind(p) as number) - 1 : 0);
    log(`t+${Math.round(el)}s ${snapLine(p)}`);
    if (el >= MIN_WRITE_S && behind >= STOP_READY) stopReason = `backlog ${behind} >= ${STOP_READY}`;
    else if (p.ok && p.dbMb - start.dbMb >= CYCLE_GB * 1024) stopReason = `wrote ${p.dbMb - start.dbMb} MB`;
    else if (el >= MAX_WRITE_S) stopReason = `time cap ${MAX_WRITE_S}s`;
  }
  const writeS = Math.round((Date.now() - t0) / 1000);

  // ---- arm-specific stop and target ----
  let fillEnd = NaN;
  let markerAt = NaN;
  let boundWaitS: number | string = "n/a";
  if (arm !== "live") {
    for (const w of writers) w.halt();
    await Promise.all(writers.map((w) => w.stop()));
  }
  fillEnd = Date.now() / 1000;
  const mk = await again(() => sql(s.ctx, `insert into public.rp_marker(label) values ('postfill-c${n}') returning extract(epoch from at)::float8 as at`));
  markerAt = mk.status === 201 && mk.rows[0] ? Number(mk.rows[0].at) : NaN;
  const atFillEnd = await again(() => snapshot(s));
  let bound = await again(() => pitrBound(s));
  if (arm !== "live") {
    const tw = Date.now();
    while ((bound.latest === null || bound.latest < fillEnd + 10) && Date.now() - tw < 20 * 60_000) {
      await sleep(30_000);
      bound = await again(() => pitrBound(s));
    }
    boundWaitS = Math.round((Date.now() - tw) / 1000);
  }
  const bk = await again(() => backups(s));
  const pre = await again(() => snapshot(s));
  if (bound.latest === null) {
    ticker.halt();
    for (const w of writers) w.halt();
    await ticker.stop();
    await Promise.all(writers.map((w) => w.stop()));
    return { result: { id, title: `${arm}: restore`, status: "fail", detail: `no bound quoted: HTTP ${bound.http} ${bound.text}` }, restored: false, pwOk: true };
  }
  const L = bound.latest;
  let target = L;
  let clamped = "n/a";
  let tIssued = 0;
  let atAccept: Snap | undefined;
  const run = await measureRestore(s, {
    newPw: pw,
    oldPw: randomPassword(),
    issue: async () => {
      if (arm === "explicit") {
        const want = Math.floor(Date.now() / 1000) - 2;
        clamped = String(want > L);
        target = Math.min(want, L);
      }
      const r = await mgmt(ctx, "POST", `/projects/${s.ref}/database/backups/restore-pitr`, { recovery_time_target_unix: target });
      tIssued = Date.now() / 1000;
      if (r.status >= 200 && r.status < 300) {
        ticker.halt();
        for (const w of writers) w.halt();
        atAccept = await snapshot(s, 8000).catch(() => undefined);
      }
      return { status: r.status, text: r.text };
    },
    retryMs: 0,
    maxMs: 30 * 60_000,
    extraProbes: [restReadProbe(s, "rp_marker")],
  });
  await ticker.stop();
  await Promise.all(writers.map((w) => w.stop()));
  const ok = run.http >= 200 && run.http < 300;
  log(`restore HTTP ${run.http}; healthy after ${run.tl?.backHealthyS ?? "n/a"}s`);

  // ---- after ----
  const lines = ok ? await recoveryLines(s, tIssued) : [];
  const stopLine = lines.find((l) => /starting point-in-time recovery|recovery stopping/.test(l)) ?? "";
  const stopLsn = stopLsnFromLog(stopLine);
  const stopN = stopLsn ? lsnNum(stopLsn) : null;
  const preArchSeg = segOfWalName(pre.lastArchived);
  const acceptArchSeg = atAccept?.ok ? segOfWalName(atAccept.lastArchived) : null;
  const curSeg = segOfWalName(pre.cur);
  const stopSeg = stopN === null ? null : segOfLsn(stopN);
  const tl = series.filter((p) => Number.isFinite(p.lsnN)).map((p) => ({ t: p.db, lsn: p.lsnN }));
  for (const p of [atFillEnd, pre, atAccept]) if (p?.ok && Number.isFinite(p.lsnN)) tl.push({ t: p.db, lsn: p.lsnN });
  tl.sort((a, b) => a.t - b.t);
  const stopWrittenAt = stopN === null ? null : timeAtLsn(tl, stopN);

  const ledger = await again(() => sql(s.ctx, `select w, stmt from public.rp_ledger where cycle = ${n}`, 60_000));
  const kept = new Set(ledger.rows.map((x) => `${x.w}:${x.stmt}`));
  const ticksR = await again(() => sql(s.ctx, `select seq from public.rp_tick where cycle = ${n}`, 60_000));
  const keptTicks = new Set(ticksR.rows.map((x) => Number(x.seq)));
  const bulkCount = await again(() => sql(s.ctx, "select count(*)::bigint as n from public.rp_bulk", 300_000));
  const markers = await again(() => markerLabels(s));
  const post = await again(() => snapshot(s));

  const acks = writers.flatMap((w) => w.acks).filter((a) => a.localAck <= tIssued);
  const ackBefore = acks.filter((a) => a.at < target);
  const missing = ackBefore.filter((a) => !kept.has(`${a.w}:${a.stmt}`));
  const keptAcks = ackBefore.filter((a) => kept.has(`${a.w}:${a.stmt}`));
  const keptAfter = acks.filter((a) => a.at > target + 1 && kept.has(`${a.w}:${a.stmt}`)).length;
  const newestKeptStmt = keptAcks.length ? Math.max(...keptAcks.map((a) => a.at)) : NaN;
  const oldestMissing = missing.length ? Math.min(...missing.map((a) => a.at)) : NaN;
  const tAcks = ticker.acks.filter((a) => a.at <= tIssued + 5);
  const tBefore = tAcks.filter((a) => a.at < target);
  const tMissing = tBefore.filter((a) => !keptTicks.has(a.seq));
  const tKept = tBefore.filter((a) => keptTicks.has(a.seq));
  const newestTick = tKept.length ? Math.max(...tKept.map((a) => a.at)) : NaN;
  const oldestMissingTick = tMissing.length ? Math.min(...tMissing.map((a) => a.at)) : NaN;
  const markerKept = markers.split(",").includes(`postfill-c${n}`);
  const r1 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(1)) : "n/a");

  // Password the pooler accepts at the end (R18 recurrence); reset if refused, so later cycles can write.
  let pwOk = run.cred?.finalNew === "ok";
  let pwFix = "not needed";
  if (ok && !pwOk) {
    const l = await settledLogin(s, pw, 5 * 60_000);
    pwOk = l.ok;
    pwFix = l.ok ? "ok on a login after the watch ended" : `still ${l.error.slice(0, 60)}`;
    if (!l.ok) {
      const sp = await setPassword(s, pw);
      await sleep(20_000);
      const l2 = await settledLogin(s, pw, 3 * 60_000);
      pwOk = l2.ok;
      pwFix += `; PATCH password HTTP ${sp.status}; login after: ${l2.ok ? "ok" : l2.error.slice(0, 60)}`;
    }
  }

  const result: TestResult = {
    id,
    title: `${arm}: heavy write (${WRITERS} ${LOAD} writers), restore-pitr while the archiver is behind`,
    status: ok ? "info" : "fail",
    detail:
      `ready at call ${pre.ready ?? "n/a"}, segments_behind ${segsBehind(pre)}; acked statements before target missing ${missing.length}/${ackBefore.length}; ` +
      `postfill marker ${markerKept ? "kept" : "MISSING"}; stop LSN ${stopLsn ?? "n/a"}`,
    measurements: {
      arm,
      load: LOAD,
      writers: WRITERS,
      rows_per_statement: ROWS,
      write_s: writeS,
      write_stop_reason: stopReason,
      db_mb_start: start.dbMb,
      db_mb_at_fill_end: atFillEnd.dbMb,
      max_ready_during_write: readyReadable ? maxReady : "unreadable",
      archiver_at_fill_end: snapLine(atFillEnd),
      bound_wait_s: boundWaitS,
      archiver_before_call: snapLine(pre),
      ready_before_call: pre.ready ?? "n/a",
      segments_behind_before_call: segsBehind(pre),
      archiver_at_accept: atAccept ? snapLine(atAccept) : "not read",
      bound_L_unix: L,
      local_minus_L_at_call_s: tIssued ? Math.round(tIssued - L) : "n/a",
      L_minus_last_archived_time_s: pre.lastArchivedAt === null ? "n/a" : Math.round(L - pre.lastArchivedAt),
      backups_window_latest_minus_L_s: bk.windowLatest ? bk.windowLatest - L : "n/a",
      physical_backups_listed: bk.physicalIds.length,
      target_unix: target,
      target_kind: arm === "explicit" ? `now-2 at call (clamped to L: ${clamped})` : "L",
      target_minus_fill_end_s: r1(target - fillEnd),
      target_minus_marker_s: r1(target - markerAt),
      restore_http: run.http,
      restore_body: run.body,
      status_back_healthy_s: run.tl?.backHealthyS ?? "n/a",
      statuses_seen: run.tl?.seen.join(" -> ") ?? "n/a",
      stop_lsn: stopLsn ?? "not in logs",
      stop_segment_minus_last_archived_before_call: stopSeg !== null && preArchSeg !== null ? stopSeg - preArchSeg : "n/a",
      stop_segment_minus_last_archived_at_accept: stopSeg !== null && acceptArchSeg !== null ? stopSeg - acceptArchSeg : "n/a",
      stop_segment_minus_current_before_call: stopSeg !== null && curSeg !== null ? stopSeg - curSeg : "n/a",
      lsn_before_call: pre.lsn,
      lsn_before_call_minus_stop_mb: stopN !== null && Number.isFinite(pre.lsnN) ? Math.round((pre.lsnN - stopN) / 1048576) : "n/a",
      stop_lsn_written_at_minus_target_s: stopN === null ? "no stop LSN" : stopWrittenAt === null ? "outside sampled range" : r1(stopWrittenAt - target),
      acked_statements: acks.length,
      acked_statements_before_target: ackBefore.length,
      acked_before_target_missing: missing.length,
      missing_oldest_age_s: r1(target - oldestMissing),
      target_minus_newest_kept_statement_s: r1(target - newestKeptStmt),
      kept_statements_after_target_plus_1s: keptAfter,
      ledger_rows_after: ledger.rows.length,
      inflight_or_unacked_statements: writers.map((w) => w.inflight()).filter((x) => x > 0).length,
      bulk_rows_after: String(bulkCount.rows[0]?.n ?? `HTTP ${bulkCount.status}`),
      bulk_rows_expected_from_ledger: LOAD === "wal" ? 0 : ledger.rows.length * ROWS,
      ticks_before_target: tBefore.length,
      ticks_before_target_missing: tMissing.length,
      tick_missing_oldest_age_s: r1(target - oldestMissingTick),
      target_minus_newest_kept_tick_s: r1(target - newestTick),
      postfill_marker_kept: String(markerKept),
      markers_after: markers,
      archiver_after: snapLine(post),
      writer_errors: writers.flatMap((w) => w.errors).join(" | ").slice(0, 200) || "none",
      ticker_errors: ticker.errors.join(" | ").slice(0, 200) || "none",
      cred_final_current: run.cred?.finalNew ?? "n/a",
      cred_transitions: (run.cred?.transitions ?? []).join(" | ").slice(0, 300),
      cred_refused_until_ok_s: run.cred?.refusedUntilOkS ?? "n/a",
      password_after: pwFix,
      recovery_log: lines.join(" | ").slice(0, 2000) || "(none)",
      ...flatten(run.windows, run.postOffsetMs),
    },
    evidence: JSON.stringify({
      series: series.map((p) => ({ t: Number((p.local - start.local).toFixed(1)), lsn: p.lsn, cur: p.cur, la: p.lastArchived, ready: p.ready, failed: p.failed, wal_mb: p.walMb, db_mb: p.dbMb, la_age: p.lastArchivedAt === null ? null : Math.round(p.db - p.lastArchivedAt) })),
      bound_lag_s: bounds.map((b) => (b.latest === null ? null : Math.round(b.local - b.latest))),
      attempts: run.attempts,
    }),
  };
  return { result, restored: ok, pwOk };
}

const mod: TestModule = {
  id: "RP08",
  title: "PITR restore to the quoted latest instant while the WAL archiver is behind",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "RP08", title: "RP08", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const pw = randomPassword();
    let ref = "";
    let pitrOn = false;
    let tPitr = 0;
    const tCreate = Date.now();
    try {
      const created = await createProject(ctx, org, `rp-rp08-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, pw, COMPUTE);
      ref = created.ref;
      if (REFS_FILE && ref) appendFileSync(REFS_FILE, `${ref} rp08 created ${new Date().toISOString()}\n`);
      if (!ref) return [{ id: "RP08a", title: "create", status: "fail", detail: `HTTP ${created.status} ${created.text}` }];
      const healthy = await waitProjectStatus(ctx, ref, "ACTIVE_HEALTHY", 10 * 60_000);
      if (!healthy.ok) return [{ id: "RP08a", title: "create", status: "fail", detail: `not healthy: ${healthy.last}` }];
      const s = await subjectOf(ctx, ref);
      const mk = await sql(
        s.ctx,
        "create table public.rp_marker (id serial primary key, label text not null, at timestamptz not null default clock_timestamp()); " +
          "insert into public.rp_marker(label) values ('seed-before-backup'); " +
          "create table public.rp_bulk (id bigserial primary key, pad text not null, at timestamptz not null default clock_timestamp()); " +
          "create table public.rp_ledger (cycle int not null, w int not null, stmt int not null, n bigint not null, at timestamptz not null, primary key (cycle, w, stmt)); " +
          "create table public.rp_tick (cycle int not null, seq int not null, at timestamptz not null default clock_timestamp(), primary key (cycle, seq))",
      );
      tPitr = Date.now();
      const en = await applyPitr7(ctx, ref);
      pitrOn = en.status < 300;
      const ready = pitrOn ? await waitPitrReady(s) : { enabledS: "n/a", windowS: "n/a" };
      const grow = pitrOn ? await growDisk(s, DISK_GB) : { http: -1, appliedAfterS: "n/a" };
      const first = await snapshot(s);
      const settings = await sql(
        s.ctx,
        "select string_agg(name || '=' || setting, ' ' order by name) as v from pg_settings where name in ('archive_timeout','archive_mode','wal_segment_size','max_wal_size','checkpoint_timeout','wal_compression','server_version')",
      );
      out.push({
        id: "RP08a",
        title: `create (${COMPUTE}), enable pitr_7, grow disk to ${DISK_GB} GB`,
        status: pitrOn && grow.http < 300 && mk.status === 201 ? "info" : "fail",
        detail: `addon HTTP ${en.status}; window after ${ready.windowS}s; disk POST HTTP ${grow.http}, applied after ${grow.appliedAfterS}s`,
        measurements: {
          compute: COMPUTE,
          load: LOAD,
          arms: ARMS.join(","),
          writers: WRITERS,
          rows_per_statement: ROWS,
          stop_ready: STOP_READY,
          min_write_s: MIN_WRITE_S,
          max_write_s: MAX_WRITE_S,
          cycle_gb: CYCLE_GB,
          tables: mk.status === 201 ? "ok" : `HTTP ${mk.status} ${mk.error}`,
          addon_http: en.status,
          window_populated_after_s: ready.windowS,
          disk_post_http: grow.http,
          disk_applied_after_s: grow.appliedAfterS,
          disk: await again(() => diskLine(s)),
          archiver: snapLine(first),
          ready_count_readable: String(readyReadable),
          settings: String(settings.rows[0]?.v ?? `HTTP ${settings.status} ${settings.error}`),
        },
      });
      if (!pitrOn || grow.http >= 300 || mk.status !== 201) return out;

      let n = 0;
      for (const arm of ARMS) {
        n += 1;
        const c = await cycle(ctx, s, pw, n, arm);
        c.result.measurements = { ...c.result.measurements, project_age_at_end_min: Math.round((Date.now() - tCreate) / 60_000) };
        out.push(c.result);
        if (!c.restored || !c.pwOk) break;
      }
    } catch (e) {
      out.push({ id: "RP08", title: "RP08 aborted", status: "fail", detail: `threw: ${errText(e)}` });
    } finally {
      let rm = -2;
      if (ref && pitrOn) rm = (await mgmt(ctx, "DELETE", `/projects/${ref}/billing/addons/pitr_7`).catch(() => ({ status: -1 }))).status;
      const pitrHours = tPitr ? ((Date.now() - tPitr) / 3_600_000).toFixed(2) : "0";
      let del = -2;
      if (ref) del = await deleteProject(ctx, ref).catch(() => -1);
      if (REFS_FILE && ref) appendFileSync(REFS_FILE, `${ref} rp08 DELETE HTTP ${del} ${new Date().toISOString()}\n`);
      out.push({
        id: "RP08z",
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
