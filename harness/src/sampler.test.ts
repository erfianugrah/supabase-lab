import { expect, test } from "bun:test";
import { sampleDuring, type PathWindow, type Probe } from "./sampler";

/** A probe that fails while `shouldFail(callIndex)` is true. */
function scriptedProbe(name: string, shouldFail: (i: number) => boolean): Probe {
  let i = -1;
  return {
    name,
    async run() {
      i += 1;
      return shouldFail(i) ? { ok: false, error: "timeout expired" } : { ok: true };
    },
  };
}

const OPTS = { intervalMs: 5, maxWaitMs: 4000, settleMs: 20 };

// tsconfig sets noUncheckedIndexedAccess, so every index access needs the `!`.
const one = (ws: PathWindow[]): PathWindow => ws[0]!;

test("records first failure, recovery, and window for a path that goes down", async () => {
  const probe = scriptedProbe("rest", (i) => i >= 2 && i < 8);
  const w = one(await sampleDuring([probe], OPTS, async () => {}));
  expect(w.name).toBe("rest");
  expect(w.failures).toBe(6);
  expect(w.firstFailMs).not.toBeNull();
  expect(w.recoveredMs).not.toBeNull();
  expect(w.windowMs).toBeGreaterThan(0);
  expect(w.modes).toContain("timeout expired");
});

test("a path that never fails reports nulls, not a zero window", async () => {
  const probe = scriptedProbe("rest", () => false);
  const w = one(await sampleDuring([probe], { ...OPTS, maxWaitMs: 100 }, async () => {}));
  expect(w.failures).toBe(0);
  expect(w.firstFailMs).toBeNull();
  expect(w.recoveredMs).toBeNull();
  expect(w.windowMs).toBeNull();
});

test("a path that never recovers reports a first failure and no recovery", async () => {
  const probe = scriptedProbe("pooler", (i) => i >= 2);
  const w = one(await sampleDuring([probe], { ...OPTS, maxWaitMs: 200 }, async () => {}));
  expect(w.firstFailMs).not.toBeNull();
  expect(w.recoveredMs).toBeNull();
  expect(w.windowMs).toBeNull();
});

test("a single lucky sample mid-outage is not recovery", async () => {
  // ok at 0-1, down 2-5, ONE ok at 6, down 7-10, then up for good.
  const probe = scriptedProbe("pooler", (i) => (i >= 2 && i <= 5) || (i >= 7 && i <= 10));
  const w = one(await sampleDuring([probe], OPTS, async () => {}));
  expect(w.failures).toBe(8);
  // recovery is the sustained one, so the window spans the flap
  expect(w.windowMs).toBeGreaterThan(OPTS.settleMs);
});

test("a recovery blip shorter than settleMs is not recovery", async () => {
  // ok 0-1, down 2-5, TWO ok at 6-7 (~5ms, under the 20ms settle), down 8-11,
  // then up for good. The previous test only has a ONE-sample blip, which the
  // two-branch structure rejects on its own - so it passes even with settleMs
  // removed entirely. This one is what actually pins the duration: if settle is
  // dropped, recovery fires at sample 7, the watchdog stops the run early, and
  // only the first four failures are ever seen.
  const probe = scriptedProbe("pooler", (i) => (i >= 2 && i <= 5) || (i >= 8 && i <= 11));
  const w = one(await sampleDuring([probe], OPTS, async () => {}));
  expect(w.failures).toBe(8);
});

test("paths are tracked independently", async () => {
  const fast = scriptedProbe("rest", (i) => i >= 2 && i < 4);
  const slow = scriptedProbe("pooler", (i) => i >= 2 && i < 10);
  const windows = await sampleDuring([fast, slow], OPTS, async () => {});
  const rest = windows.find((w) => w.name === "rest")!;
  const pooler = windows.find((w) => w.name === "pooler")!;
  expect(rest.failures).toBe(2);
  expect(pooler.failures).toBe(8);
  expect(pooler.windowMs!).toBeGreaterThan(rest.windowMs!);
});

test("a path already failing before the operation is flagged", async () => {
  const probe = scriptedProbe("rest", (i) => i < 6);
  const w = one(await sampleDuring([probe], OPTS, async () => {}));
  expect(w.healthyAtStart).toBe(false);
});

test("the operation runs while sampling, and its error propagates", async () => {
  const probe = scriptedProbe("rest", () => false);
  await expect(
    sampleDuring([probe], { ...OPTS, maxWaitMs: 100 }, async () => {
      throw new Error("restart API returned 500");
    }),
  ).rejects.toThrow("restart API returned 500");
});

/**
 * A clock whose wall time jumps `jumpMs` ahead once `afterMs` of real time has
 * passed, while the monotonic clock keeps real time: what a process sees across
 * a macOS idle sleep (2026-10-23: Date.now() gaps of 66 s and 263 s that
 * performance.now() did not count).
 */
function sleepingClock(afterMs: number, jumpMs: number) {
  const start = Date.now();
  return {
    wall: () => Date.now() + (Date.now() - start >= afterMs ? jumpMs : 0),
    mono: () => performance.now(),
  };
}

test("a host suspension inside an outage is logged and counted against that path's window", async () => {
  const logs: string[] = [];
  const probe = scriptedProbe("rest_read", (i) => i >= 2 && i < 6);
  const w = one(
    await sampleDuring(
      [probe],
      { ...OPTS, maxWaitMs: 120_000, clock: sleepingClock(25, 60_000), log: (m) => logs.push(m) },
      async () => {},
    ),
  );
  expect(logs.some((l) => /host paused \d+ s at \+\d+ms .*suspended/.test(l))).toBe(true);
  expect(w.pausedMs).toBeGreaterThanOrEqual(59_000);
});

test("no suspension: pausedMs is 0 and nothing is logged about it", async () => {
  const logs: string[] = [];
  const probe = scriptedProbe("rest_read", (i) => i >= 2 && i < 6);
  const w = one(await sampleDuring([probe], { ...OPTS, log: (m) => logs.push(m) }, async () => {}));
  expect(w.pausedMs).toBe(0);
  expect(logs.some((l) => l.includes("host paused"))).toBe(false);
});

test("a path that recovers, fails again and comes back logs the second recovery too", async () => {
  // 2026-10-23: rest_read and auth went quiet at +264.7 s, most likely after
  // a SECOND recovery (inferred from the log), which the sampler never
  // logged; read as a stall.
  const logs: string[] = [];
  const flappy = scriptedProbe("rest_read", (i) => (i >= 2 && i < 4) || (i >= 12 && i < 14));
  const late = scriptedProbe("pooler", (i) => i >= 2 && i < 30);
  await sampleDuring([flappy, late], { ...OPTS, log: (m) => logs.push(m) }, async () => {});
  expect(logs.filter((l) => l.startsWith("rest_read recovered")).length).toBe(1);
  expect(logs.some((l) => l.startsWith("rest_read up again"))).toBe(true);
});

test("a probe whose run() never settles is cut off at the sample deadline and recorded as a failure", async () => {
  let i = -1;
  const hangs: Probe = {
    name: "hangs",
    run() {
      i += 1;
      // Sample 0 healthy, sample 1 never settles, then healthy again.
      return i === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true });
    },
  };
  const t0 = Date.now();
  const w = one(await sampleDuring([hangs], { ...OPTS, maxWaitMs: 1000, sampleDeadlineMs: 50 }, async () => {}));
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(w.failures).toBe(1);
  expect(w.modes[0]).toBe("probe did not answer within 50 ms");
  expect(w.recoveredMs).not.toBeNull();
});
