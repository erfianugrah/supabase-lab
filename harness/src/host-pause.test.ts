import { expect, test } from "bun:test";
import { PAUSE_SLACK_MS, suspendedMs, withHostSuspension } from "./host-pause";

test("wall time that passed while the monotonic clock did not is a suspension", () => {
  // 2026-10-23 Medium C: run wall 568 s, summed performance.now() durations 266 s,
  // and pmset logged a 263 s and a 43 s idle sleep inside it.
  expect(suspendedMs(0, 318_000, 0, 55_000)).toBe(263_000);
});

test("clock jitter under the slack is not a suspension", () => {
  expect(suspendedMs(0, 10_000 + PAUSE_SLACK_MS, 0, 10_000)).toBe(0);
  expect(suspendedMs(0, 10_000, 0, 10_050)).toBe(0);
});

test("a suspended test gets host_suspended_s and a detail note; an awake one is untouched", () => {
  const r = withHostSuspension({ id: "D03", title: "t", status: "pass", detail: "outage on auth 299s", measurements: { auth_window_s: 299 } }, 263_000);
  expect(r.measurements?.host_suspended_s).toBe(263);
  expect(r.measurements?.auth_window_s).toBe(299);
  expect(r.detail).toContain("host suspended 263 s");
  const awake = { id: "D04", title: "t", status: "pass" as const, measurements: { a: 1 } };
  expect(withHostSuspension(awake, 0)).toEqual(awake);
});
