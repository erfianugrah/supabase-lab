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
