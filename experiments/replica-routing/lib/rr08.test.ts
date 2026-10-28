import { describe, expect, test } from "bun:test";
import { classifyRead, parseVacuumVerbose, staleEpisodes, statsOf, tallyBy } from "./rr08";

describe("parseVacuumVerbose", () => {
  test("PG17 finished-vacuuming block", () => {
    const t = [
      'finished vacuuming "postgres.public.rr8_items": index scans: 1',
      "pages: 0 removed, 9804 remain, 2210 scanned (22.54% of total)",
      "tuples: 4000 removed, 1500000 remain, 1200 are dead but not yet removable",
      "removable cutoff: 754, which was 31 XIDs old when operation ended",
    ].join("\n");
    expect(parseVacuumVerbose(t)).toEqual({ removed: 4000, remain: 1500000, notRemovable: 1200, cutoffAgeXids: 31 });
  });
  test("no tuples line", () => {
    expect(parseVacuumVerbose('vacuuming "postgres.public.rr8_items"')).toBeNull();
  });
});

describe("classifyRead", () => {
  test("a recovery-conflict cancel", () => {
    const body = JSON.stringify({
      code: "40001",
      details: "User query might have needed to see row versions that must be removed.",
      hint: null,
      message: "canceling statement due to conflict with recovery",
    });
    expect(classifyRead(500, body)).toEqual({
      kind: "40001",
      text: "canceling statement due to conflict with recovery / User query might have needed to see row versions that must be removed.",
    });
  });
  test("a statement timeout", () => {
    const body = JSON.stringify({ code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout" });
    expect(classifyRead(500, body).kind).toBe("57014");
  });
  test("a served read names its node", () => {
    const body = JSON.stringify({ in_recovery: true, pm: 1, rows: 10, iters: 2, ms: 1005, stale_ms: 120 });
    expect(classifyRead(200, body)).toEqual({ kind: "ok", node: "replica", serverMs: 1005, staleMs: 120 });
  });
  test("anything else keeps status and text", () => {
    expect(classifyRead(503, "upstream connect error")).toEqual({ kind: "other", text: "HTTP 503 upstream connect error" });
    expect(classifyRead(0, "", "The operation timed out.")).toEqual({ kind: "other", text: "fetch The operation timed out." });
  });
});

describe("staleEpisodes", () => {
  test("contiguous runs above the threshold", () => {
    const pts = [
      { t: 0, staleMs: 100 },
      { t: 500, staleMs: 2500 },
      { t: 1000, staleMs: 8000 },
      { t: 1500, staleMs: 300 },
      { t: 2000, staleMs: 3000 },
      { t: 2500, staleMs: 200 },
    ];
    expect(staleEpisodes(pts, 2000)).toEqual([
      { startT: 500, endT: 1000, maxStaleMs: 8000 },
      { startT: 2000, endT: 2000, maxStaleMs: 3000 },
    ]);
  });
  test("an episode still open at the end", () => {
    expect(staleEpisodes([{ t: 0, staleMs: 5000 }], 2000)).toEqual([{ startT: 0, endT: 0, maxStaleMs: 5000 }]);
  });
});

describe("statsOf and tallyBy", () => {
  test("empty is none", () => {
    expect(statsOf([])).toEqual({ n: 0, p50: "none", p95: "none", max: "none" });
  });
  test("percentiles", () => {
    const s = statsOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s).toEqual({ n: 10, p50: 5, p95: 10, max: 10 });
  });
  test("tallyBy renders counts", () => {
    expect(tallyBy(["a", "b", "a"])).toBe("a x2, b x1");
    expect(tallyBy([])).toBe("none");
  });
});
