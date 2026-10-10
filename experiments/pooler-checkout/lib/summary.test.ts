import { describe, expect, test } from "bun:test";
import { parseLines, summarise, type QEvent } from "./summary";

const q = (t: number, ok: boolean, extra: Partial<QEvent> = {}): QEvent => ({ e: "q", w: 0, t, ok, ms: 5, ...extra });

describe("summarise", () => {
  const ON = 1000;
  const OFF = 3000;

  test("clean run has no failures and no recovery numbers", () => {
    const s = summarise([q(500, true), q(1500, true), q(3500, true)], ON, OFF);
    expect(s.failed_total).toBe(0);
    expect(s.first_fail_after_fault_ms).toBeNull();
    expect(s.last_fail_after_clear_ms).toBeNull();
    expect(s.first_ok_after_clear_ms).toBe(500);
  });

  test("attempts are windowed by start time", () => {
    const s = summarise(
      [
        q(900, false, { ms: 400, code: "ECONNRESET", msg: "reset" }), // started before the fault, failed inside it
        q(1200, false, { code: "ECONNRESET", msg: "reset" }),
        q(3000, false, { code: "ECONNREFUSED", msg: "refused" }), // boundary: in window
        q(3200, false, { code: "ECONNRESET", msg: "stale" }), // after clear
        q(3400, true),
      ],
      ON,
      OFF,
    );
    expect(s.failed_total).toBe(4);
    expect(s.failed_in_window).toBe(2);
    expect(s.failed_after_clear).toBe(1);
    expect(s.last_fail_after_clear_ms).toBe(200);
    expect(s.first_ok_after_clear_ms).toBe(400);
    expect(s.first_fail_after_fault_ms).toBe(200);
  });

  test("retry outcomes and app timeouts are counted per failed first attempt", () => {
    const s = summarise(
      [
        q(1100, false, { code: "ECONNRESET", retry_ok: true, retry_ms: 30 }),
        q(1200, false, { code: "ECONNREFUSED", retry_ok: false }),
        q(1300, false, { code: "APP_TIMEOUT", ms: 10000, retry_ok: false }),
      ],
      ON,
      OFF,
    );
    expect(s.retry_rescued).toBe(1);
    expect(s.retry_failed).toBe(2);
    expect(s.app_timeouts).toBe(1);
    expect(s.max_ms).toBe(10000);
    expect(Object.keys(s.errors).length).toBe(3);
  });
});

describe("parseLines", () => {
  test("keeps q events, files the rest, drops a torn last line", () => {
    const out = parseLines(
      ['{"e":"ready","t":1}', '{"e":"q","w":0,"t":2,"ok":true,"ms":3}', '{"e":"pool_error","t":4,"code":"X"}', '{"e":"q","w":1,"t'].join("\n"),
    );
    expect(out.events.length).toBe(1);
    expect(out.other.map((o) => o.e)).toEqual(["ready", "pool_error"]);
  });
});
