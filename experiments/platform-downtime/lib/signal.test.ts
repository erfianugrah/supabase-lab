import { describe, expect, test } from "bun:test";
import {
  bootLogged,
  changed,
  classifyShutdownLog,
  logTimeMs,
  shutdownMeasurements,
  signalMeasurements,
} from "./signal";
import type { RestartSignal } from "./setup";

const sig = (startTime: string | null, reset: string | null): RestartSignal => ({
  startTime,
  checkpointerStatsReset: reset,
  checkpointerSource: reset ? "pg_stat_checkpointer" : null,
  error: "",
});

describe("changed", () => {
  test("an unreadable side is n/a, never 'no'", () => {
    expect(changed(null, "2026-10-13T00:00:00.000Z")).toBe("n/a");
    expect(changed("2026-10-13T00:00:00.000Z", null)).toBe("n/a");
  });

  test("equal is no, different is yes", () => {
    expect(changed("a", "a")).toBe("no");
    expect(changed("a", "b")).toBe("yes");
  });
});

describe("signalMeasurements", () => {
  test("a restart that kept checkpointer stats", () => {
    const m = signalMeasurements(
      sig("2026-10-13T01:00:00.000Z", "2026-10-01T00:00:00.000Z"),
      sig("2026-10-13T02:00:00.000Z", "2026-10-01T00:00:00.000Z"),
    );
    expect(m.restart_confirmed).toBe("yes");
    expect(m.checkpointer_stats_reset_changed).toBe("no");
    expect(m.checkpointer_source).toBe("pg_stat_checkpointer");
  });

  test("a restart that reset checkpointer stats", () => {
    const m = signalMeasurements(
      sig("2026-10-13T01:00:00.000Z", "2026-10-01T00:00:00.000Z"),
      sig("2026-10-13T02:00:00.000Z", "2026-10-13T02:00:00.000Z"),
    );
    expect(m.checkpointer_stats_reset_changed).toBe("yes");
  });

  test("an unreadable after-read is n/a on both questions", () => {
    const m = signalMeasurements(sig("2026-10-13T01:00:00.000Z", "2026-10-01T00:00:00.000Z"), sig(null, null));
    expect(m.restart_confirmed).toBe("n/a");
    expect(m.checkpointer_stats_reset_changed).toBe("n/a");
    expect(m.postmaster_start_after).toBe("n/a");
    expect(m.checkpointer_source).toBe("pg_stat_checkpointer");
  });
});

describe("logTimeMs", () => {
  test("an ISO string without a zone is UTC, not local time", () => {
    expect(logTimeMs("2026-10-13T01:02:03.456")).toBe(Date.UTC(2026, 9, 13, 1, 2, 3, 456));
    expect(logTimeMs("2026-10-13 01:02:03")).toBe(Date.UTC(2026, 9, 13, 1, 2, 3));
  });

  test("an explicit zone is honoured", () => {
    expect(logTimeMs("2026-10-13T01:02:03Z")).toBe(Date.UTC(2026, 9, 13, 1, 2, 3));
    expect(logTimeMs("2026-10-13T09:02:03+08:00")).toBe(Date.UTC(2026, 9, 13, 1, 2, 3));
  });

  test("microseconds since the epoch (the retired logs.all shape) become milliseconds", () => {
    const ms = Date.UTC(2026, 9, 13, 1, 2, 3);
    expect(logTimeMs(ms * 1000)).toBe(ms);
    expect(logTimeMs(String(ms * 1000))).toBe(ms);
    expect(logTimeMs(ms)).toBe(ms);
  });

  test("garbage is null", () => {
    expect(logTimeMs("not a time")).toBeNull();
    expect(logTimeMs(undefined)).toBeNull();
    expect(logTimeMs("")).toBeNull();
  });
});

describe("classifyShutdownLog", () => {
  const t = (s: number) => `2026-10-13T01:00:${String(s).padStart(2, "0")}.000`;
  const since = Date.UTC(2026, 9, 13, 1, 0, 10);

  test("the vanilla clean sequence (checkpointer-reset RUNLOG) reads as fast stop, clean boot", () => {
    const r = classifyShutdownLog(
      [
        { timestamp: t(41), event_message: "database system was shut down at 2026-10-13 01:00:20 UTC" },
        { timestamp: t(12), event_message: "received fast shutdown request" },
        { timestamp: t(13), event_message: "aborting any active transactions" },
        { timestamp: t(14), event_message: "checkpoint starting: shutdown immediate" },
        { timestamp: t(20), event_message: "database system is shut down" },
      ],
      since,
    );
    expect(r.stopMode).toBe("fast");
    expect(r.shutdownCheckpointLogged).toBe(true);
    expect(r.shutDownLogged).toBe(true);
    expect(r.nextBoot).toBe("clean");
    expect(bootLogged(r)).toBe(true);
    expect(r.lines).toHaveLength(5);
    expect(r.lines[0]).toBe("2026-10-13T01:00:12.000Z received fast shutdown request");
  });

  test("the crash sequence reads as crash-recovery with no stop logged", () => {
    const r = classifyShutdownLog(
      [
        { timestamp: t(30), event_message: "database system was interrupted; last known up at 2026-10-13 00:59:00 UTC" },
        { timestamp: t(31), event_message: "database system was not properly shut down; automatic recovery in progress" },
      ],
      since,
    );
    expect(r.stopMode).toBe("not-logged");
    expect(r.shutDownLogged).toBe(false);
    expect(r.nextBoot).toBe("crash-recovery");
  });

  test("lines before the cut-off belong to an earlier restart and are ignored", () => {
    const r = classifyShutdownLog(
      [
        { timestamp: t(1), event_message: "received immediate shutdown request" },
        { timestamp: t(2), event_message: "database system was not properly shut down; automatic recovery in progress" },
        { timestamp: t(15), event_message: "received smart shutdown request" },
      ],
      since,
    );
    expect(r.stopMode).toBe("smart");
    expect(r.nextBoot).toBe("not-logged");
    expect(bootLogged(r)).toBe(false);
  });

  test("nothing logged yet", () => {
    const r = classifyShutdownLog([], since);
    expect(shutdownMeasurements(r)).toEqual({
      log_stop_mode: "not-logged",
      log_shutdown_checkpoint: "no",
      log_shut_down: "no",
      log_next_boot: "not-logged",
      log_lines: 0,
    });
  });
});
