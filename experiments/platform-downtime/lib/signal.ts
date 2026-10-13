/**
 * What a restart leaves behind, read two ways (work-supabase-lab#20, #67).
 *
 * 1. Counters, before and after: `pg_postmaster_start_time()` and the
 *    checkpointer's `stats_reset` (the pair D05 reads, `readRestartSignal` in
 *    setup.ts). A moved start time with an unmoved `stats_reset` is a restart
 *    that kept its cumulative stats, which the checkpointer-reset local rig
 *    showed for a clean stop; a moved `stats_reset` is a restart that behaved
 *    like a crash for those counters.
 * 2. Postgres's own log lines in `postgres_logs`: which shutdown request it
 *    received, whether it logged the shutdown checkpoint and "database system
 *    is shut down", and how the next boot described the previous stop. That
 *    is the managed-side signal #67 asks for. The texts are the ones the
 *    checkpointer-reset rig (vanilla Postgres) and jit-db-access JA01
 *    (managed) recorded in their RUNLOGs; the smart and immediate request
 *    lines are Postgres's sibling messages and have not been seen in this lab.
 *
 * Pure: no network. Unit tests in signal.test.ts.
 */
import type { RestartSignal } from "./setup";

export type Changed = "yes" | "no" | "n/a";

/** "n/a" when either side is unreadable: an unread value is not an unchanged one. */
export function changed(before: string | null, after: string | null): Changed {
  if (!before || !after) return "n/a";
  return before === after ? "no" : "yes";
}

export function signalMeasurements(before: RestartSignal, after: RestartSignal): Record<string, string> {
  return {
    postmaster_start_before: before.startTime ?? "n/a",
    postmaster_start_after: after.startTime ?? "n/a",
    restart_confirmed: changed(before.startTime, after.startTime),
    checkpointer_source: after.checkpointerSource ?? before.checkpointerSource ?? "n/a",
    checkpointer_stats_reset_before: before.checkpointerStatsReset ?? "n/a",
    checkpointer_stats_reset_after: after.checkpointerStatsReset ?? "n/a",
    checkpointer_stats_reset_changed: changed(before.checkpointerStatsReset, after.checkpointerStatsReset),
  };
}

export interface LogLine {
  timestamp?: unknown;
  event_message?: unknown;
}

/**
 * Epoch milliseconds for a logs-endpoint timestamp. The unified `logs` table
 * returns an ISO string in UTC (harness/src/platform.ts); one without a zone
 * suffix is read as UTC, not as this machine's local time. The retired
 * `logs.all` shape was microseconds since the epoch, accepted for old rows.
 */
export function logTimeMs(ts: unknown): number | null {
  const fromNumber = (n: number) => (n > 1e14 ? Math.floor(n / 1000) : n);
  if (typeof ts === "number") return Number.isFinite(ts) ? fromNumber(ts) : null;
  if (typeof ts !== "string" || !ts.trim()) return null;
  const s = ts.trim();
  if (/^\d+$/.test(s)) return fromNumber(Number(s));
  const iso = /([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export type StopMode = "fast" | "smart" | "immediate" | "not-logged";
export type BootKind = "clean" | "crash-recovery" | "not-logged";

export interface ShutdownReading {
  stopMode: StopMode;
  shutdownCheckpointLogged: boolean;
  shutDownLogged: boolean;
  nextBoot: BootKind;
  /** Matching lines at or after the cut-off, oldest first, as "<iso> <message>". */
  lines: string[];
}

const REQUEST = /received (fast|smart|immediate) shutdown request/;
const SHUTDOWN_CHECKPOINT = /checkpoint starting: shutdown/;
const SHUT_DOWN = /database system is shut down/;
const CLEAN_BOOT = /database system was shut down at/;
const CRASH_BOOT = /database system was (not properly shut down|interrupted)/;

/** Rows older than `sinceMs` are dropped: the query window is an hour and may hold an earlier restart. */
export function classifyShutdownLog(rows: LogLine[], sinceMs: number): ShutdownReading {
  const kept = rows
    .map((r) => ({
      t: logTimeMs(r.timestamp),
      m: typeof r.event_message === "string" ? r.event_message.trim() : "",
    }))
    .filter((r): r is { t: number; m: string } => r.t !== null && r.t >= sinceMs && r.m !== "")
    .sort((a, b) => a.t - b.t);

  let stopMode: StopMode = "not-logged";
  let shutdownCheckpointLogged = false;
  let shutDownLogged = false;
  let nextBoot: BootKind = "not-logged";
  for (const { m } of kept) {
    const req = REQUEST.exec(m);
    if (req && stopMode === "not-logged") stopMode = req[1] as StopMode;
    if (SHUTDOWN_CHECKPOINT.test(m)) shutdownCheckpointLogged = true;
    if (SHUT_DOWN.test(m)) shutDownLogged = true;
    if (CRASH_BOOT.test(m)) nextBoot = "crash-recovery";
    else if (CLEAN_BOOT.test(m) && nextBoot === "not-logged") nextBoot = "clean";
  }
  return {
    stopMode,
    shutdownCheckpointLogged,
    shutDownLogged,
    nextBoot,
    lines: kept.map(({ t, m }) => `${new Date(t).toISOString()} ${m}`.slice(0, 200)),
  };
}

/** Logs ingestion lags the event (32 s in audit-integrity); the read is done once the next boot shows. */
export function bootLogged(r: ShutdownReading): boolean {
  return r.nextBoot !== "not-logged";
}

export function shutdownMeasurements(r: ShutdownReading): Record<string, string | number> {
  return {
    log_stop_mode: r.stopMode,
    log_shutdown_checkpoint: r.shutdownCheckpointLogged ? "yes" : "no",
    log_shut_down: r.shutDownLogged ? "yes" : "no",
    log_next_boot: r.nextBoot,
    log_lines: r.lines.length,
  };
}
