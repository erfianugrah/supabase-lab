import { describe, expect, test } from "bun:test";
import { interleave, percentile, rng, roundRobin, separated, summarize, summaryColumns } from "./stats";

describe("percentile", () => {
  test("type-7 interpolation", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10], 99)).toBe(10);
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([3, 1, 2], 100)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 25)).toBe(2);
  });
  test("empty is NaN, input not mutated", () => {
    expect(Number.isNaN(percentile([], 50))).toBe(true);
    const xs = [3, 1, 2];
    percentile(xs, 50);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("summarize", () => {
  test("drops warm-up from the front and counts it", () => {
    const s = summarize([100, 100, 1, 2, 3], 2);
    expect(s.n).toBe(3);
    expect(s.dropped).toBe(2);
    expect(s.p50).toBe(2);
    expect(s.max).toBe(3);
    expect(s.mean).toBe(2);
  });
  test("warm-up larger than sample", () => {
    const s = summarize([1], 5);
    expect(s.n).toBe(0);
    expect(s.dropped).toBe(1);
    expect(Number.isNaN(s.p50)).toBe(true);
  });
  test("columns are prefixed", () => {
    const c = summaryColumns("d1", summarize([1, 2, 3]));
    expect(c.d1_p50).toBe(2);
    expect(c.d1_n).toBe(3);
  });
});

describe("separated", () => {
  test("non-overlapping spreads name the faster side", () => {
    expect(separated({ p25: 1, p75: 2 }, { p25: 3, p75: 4 })).toBe("a");
    expect(separated({ p25: 5, p75: 6 }, { p25: 3, p75: 4 })).toBe("b");
  });
  test("overlap or touching is no call", () => {
    expect(separated({ p25: 1, p75: 3 }, { p25: 2, p75: 4 })).toBeNull();
    expect(separated({ p25: 1, p75: 3 }, { p25: 3, p75: 4 })).toBeNull();
  });
});

describe("roundRobin", () => {
  test("rotates the starting backend each iteration and flags warm-up", () => {
    const s = roundRobin(["a", "b", "c"], 3, 1);
    expect(s.map((x) => x.item).join("")).toBe("abcbcacab");
    expect(s.filter((x) => x.warmup).length).toBe(3);
    expect(s[3]).toEqual({ iter: 1, pos: 0, item: "b", warmup: false });
  });
  test("every item appears once per iteration", () => {
    const s = roundRobin([1, 2, 3, 4], 10);
    for (let i = 0; i < 10; i++) {
      expect(s.filter((x) => x.iter === i).map((x) => x.item).sort()).toEqual([1, 2, 3, 4]);
    }
  });
});

describe("interleave", () => {
  test("uneven lists", () => {
    expect(interleave([["a1", "a2", "a3"], ["b1"], []])).toEqual(["a1", "b1", "a2", "a3"]);
    expect(interleave([])).toEqual([]);
  });
});

describe("rng", () => {
  test("deterministic per seed, in [0,1)", () => {
    const a = rng(42);
    const b = rng(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(rng(1)()).not.toBe(rng(2)());
  });
});
