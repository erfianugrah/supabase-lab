/**
 * The machine running the harness can stop, and every timing measured across
 * that stop is wrong.
 *
 * On 2026-10-23 the macOS orchestrator slept in the middle of runs
 * (`pmset -g log`: "Entering Sleep state due to 'Idle Sleep'" or 'Maintenance
 * Sleep'; `pmset -g` system sleep is 1 minute). The process is frozen while
 * the platform operation carries on, so:
 *   - a fetch with `AbortSignal.timeout(5000)` "took" about 65 s and 262 s,
 *     across sleeps of 66 s and 263 s;
 *   - every probe went quiet at once and resumed in the same millisecond;
 *   - outage windows (`Date.now()` deltas) included the sleep, e.g. a 299 s
 *     window whose recovery happened somewhere inside a 263 s sleep;
 *   - a seed loop with a 180 s wall budget timed out after one sleep.
 * `performance.now()` does not advance during that sleep while `Date.now()`
 * does: per artifact, wall time minus the summed test durations matched the
 * logged sleeps within 7 s (301 s against 263 + 43 s; 532 s against
 * 193 + 243 + 103 s). That difference is what this module measures.
 *
 * Bun 1.3.14 (0d9b296af) on macOS; the event loop was idle in `kevent64`
 * because nothing was due, not because it was stuck.
 */
import type { TestResult } from "./types";

/** A wall-minus-monotonic difference above this is a suspension, not clock jitter. */
export const PAUSE_SLACK_MS = 2000;

export interface Clock {
  /** Date.now(): advances while the host sleeps. */
  wall(): number;
  /** performance.now(): does not (macOS, Bun 1.3.14, measured 2026-10-23). */
  mono(): number;
}

export const systemClock: Clock = { wall: () => Date.now(), mono: () => performance.now() };

/** Wall time that passed while the monotonic clock did not, or 0 if within the slack. */
export function suspendedMs(wall0: number, wall1: number, mono0: number, mono1: number): number {
  const d = wall1 - wall0 - (mono1 - mono0);
  return d > PAUSE_SLACK_MS ? Math.round(d) : 0;
}

/**
 * Stamp a result that ran across a suspension: `host_suspended_s` as a
 * measurement (so it shows in the report, the facts and a diff) and a note on
 * the detail line. An awake result is returned unchanged.
 */
export function withHostSuspension(r: TestResult, ms: number): TestResult {
  if (ms <= 0) return r;
  const s = Math.round(ms / 1000);
  const note = `host suspended ${s} s during this test: timings that span it are not measurements`;
  return {
    ...r,
    detail: r.detail ? `${r.detail} (${note})` : note,
    measurements: { ...r.measurements, host_suspended_s: s },
  };
}

/**
 * Hold a macOS idle-sleep assertion for as long as this process lives
 * (`caffeinate -i -w <pid>`). Idle sleep only: a closed lid on battery still
 * sleeps, which `withHostSuspension` and the sampler then report.
 * `PVLAB_ALLOW_SLEEP=1` skips it.
 */
export function preventIdleSleep(): void {
  if (process.platform !== "darwin" || process.env.PVLAB_ALLOW_SLEEP === "1") return;
  try {
    Bun.spawn(["caffeinate", "-i", "-w", String(process.pid)], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch {
    // simplify: no caffeinate (not macOS proper) - suspension is still detected and reported.
  }
}
