import { describe, expect, test } from "bun:test";
import { attribute, openTailLowerBound, OutageTimeline, outagesOf, type PhaseMark, type Sample } from "./outage";

/**
 * The accumulator D09 used until 2026-10-23, one instance per phase, kept here
 * only to show that the synthetic stream below reproduces the 2026-10-13
 * artifact under the old accounting.
 */
function legacyPhase(samples: Sample[]): { ok: number; tot: number; maxOutageS: number } {
  let ok = 0;
  let maxOutageS = 0;
  let runStart = -1;
  for (const s of samples) {
    if (s.ok) {
      ok += 1;
      if (runStart >= 0) {
        maxOutageS = Math.max(maxOutageS, (s.at - runStart) / 1000);
        runStart = -1;
      }
    } else if (runStart < 0) runStart = s.at;
  }
  return { ok, tot: samples.length, maxOutageS };
}

/**
 * 2026-10-13 shape (compute-disk RUNLOG): Micro to Small, 46 samples in a 39 s
 * phase, 17 OK then 29 failures; the next phase (a refused Small to Large
 * PATCH) opens on 20 failures, its first success 15.063 s after its first
 * sample, then 175 OK. Sample times are synthetic; the counts are the run's
 * console output and the 15.063 s is the artifact's.
 */
function stream1013(): { p1: Sample[]; p2: Sample[]; phases: PhaseMark[]; endMs: number } {
  const p1: Sample[] = [];
  for (let i = 0; i < 17; i += 1) p1.push({ at: i * 250, ok: true });
  for (let i = 0; i < 29; i += 1) p1.push({ at: 4250 + i * 1200, ok: false });
  const p2Start = 39_000;
  const p2: Sample[] = [];
  for (let i = 0; i < 20; i += 1) p2.push({ at: p2Start + Math.round((i * 15_063) / 20), ok: false });
  for (let i = 0; i < 175; i += 1) p2.push({ at: p2Start + 15_063 + i * 250, ok: true });
  const endMs = p2Start + 61_000;
  return {
    p1,
    p2,
    phases: [
      { name: "micro->small", startMs: 0 },
      { name: "small->large", startMs: p2Start },
    ],
    endMs,
  };
}

describe("D09 outage accounting", () => {
  test("the synthetic stream reproduces the 2026-10-13 artifact under the old per-phase accounting", () => {
    const { p1, p2 } = stream1013();
    expect(legacyPhase(p1)).toEqual({ ok: 17, tot: 46, maxOutageS: 0 });
    expect(legacyPhase(p2)).toEqual({ ok: 175, tot: 195, maxOutageS: 15.063 });
  });

  test("an outage open at a phase end is carried and attributed to the phase it started in", () => {
    const { p1, p2, phases, endMs } = stream1013();
    const [a, b] = attribute([...p1, ...p2], phases, endMs);
    // 4.25 s (first failure) to 54.063 s (first success in phase 2).
    expect(a?.maxOutageS).toBe(49.813);
    expect(a?.maxOutageOpen).toBe(false);
    expect(a?.openAtPhaseEnd).toBe(true);
    expect(a?.outages).toBe(1);
    expect(a?.firstFailS).toBe(4.25);
    expect(a?.lastRecoveryS).toBe(54.063);
    expect([a?.ok, a?.samples]).toEqual([17, 46]);
    // Phase 2 started no outage of its own; it sat 15.063 s inside phase 1's.
    expect(b?.maxOutageS).toBe(0);
    expect(b?.outages).toBe(0);
    expect(b?.carriedInS).toBe(15.063);
    expect(b?.openAtPhaseEnd).toBe(false);
    expect([b?.ok, b?.samples]).toEqual([175, 195]);
  });

  test("samples added out of order (concurrent probe loops) are sorted before attribution", () => {
    const { p1, p2, phases, endMs } = stream1013();
    const t = new OutageTimeline();
    for (const ph of phases) t.beginPhase(ph.name, ph.startMs);
    for (const s of [...p2, ...p1].reverse()) t.add(s.ok, s.at);
    expect(t.stats(endMs)[0]?.maxOutageS).toBe(49.813);
    expect(t.lastFailMs()).toBe(39_000 + Math.round((19 * 15_063) / 20));
  });

  test("an outage still open when the stream ends is closed at the end and flagged open", () => {
    const samples: Sample[] = [
      { at: 0, ok: true },
      { at: 250, ok: true },
      { at: 500, ok: false },
      { at: 750, ok: false },
    ];
    const [a] = attribute(samples, [{ name: "small->micro", startMs: 0 }], 10_000);
    expect(a?.maxOutageS).toBe(9.5);
    expect(a?.maxOutageOpen).toBe(true);
    expect(a?.openAtPhaseEnd).toBe(true);
  });

  test("the longest of several outages wins, totals add, a closed outage inside one phase is not carried", () => {
    const samples: Sample[] = [
      { at: 0, ok: false },
      { at: 250, ok: true },
      { at: 500, ok: false },
      { at: 750, ok: false },
      { at: 1000, ok: false },
      { at: 1250, ok: true },
      { at: 2000, ok: true },
    ];
    const phases = [
      { name: "a", startMs: 0 },
      { name: "b", startMs: 1500 },
    ];
    const [a, b] = attribute(samples, phases, 3000);
    expect(outagesOf(samples, phases, 3000)).toHaveLength(2);
    expect(a?.maxOutageS).toBe(0.75);
    expect(a?.totalOutageS).toBe(1);
    expect(a?.openAtPhaseEnd).toBe(false);
    expect(b?.carriedInS).toBe(0);
    expect(b?.maxOutageS).toBe(0);
  });

  test("a healthy path reports zeros, not nulls dressed as zeros", () => {
    const [a] = attribute([{ at: 0, ok: true }], [{ name: "x", startMs: 0 }], 1000);
    expect(a?.maxOutageS).toBe(0);
    expect(a?.firstFailS).toBeNull();
    expect(a?.lastRecoveryS).toBeNull();
  });
});

describe("offline re-read of the old per-phase aggregates", () => {
  test("2026-10-13 Micro to Small: 17 of 46 OK, max 0 -> 29 failures open at the phase end, at least 7.0 s", () => {
    expect(openTailLowerBound({ ok: 17, tot: 46, maxClosedOutageS: 0 }, 250)).toEqual({ tailFailures: 29, tailMinS: 7 });
  });
  test("2026-08-19 Micro to Small: 6 of 69 OK, max 1.0 s -> at least 39 open failures, 9.5 s", () => {
    expect(openTailLowerBound({ ok: 6, tot: 69, maxClosedOutageS: 1.0 }, 250)).toEqual({ tailFailures: 39, tailMinS: 9.5 });
  });
  test("2026-08-19 Small to Micro: 12 of 51 OK, max 0 -> 39 failures open at the end of the run, 9.5 s", () => {
    expect(openTailLowerBound({ ok: 12, tot: 51, maxClosedOutageS: 0 }, 250)).toEqual({ tailFailures: 39, tailMinS: 9.5 });
  });
  test("a phase whose failures all fit inside its closed outages proves no open tail", () => {
    expect(openTailLowerBound({ ok: 130, tot: 154, maxClosedOutageS: 17.0 }, 250)).toEqual({ tailFailures: 0, tailMinS: 0 });
    expect(openTailLowerBound({ ok: 175, tot: 195, maxClosedOutageS: 15.063 }, 250)).toEqual({ tailFailures: 0, tailMinS: 0 });
  });
});
