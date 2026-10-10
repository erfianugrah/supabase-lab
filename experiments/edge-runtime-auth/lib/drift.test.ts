import { describe, expect, test } from "bun:test";
import { percentile } from "./er";
import { analyseDrift, bucketP95, type Sample } from "./drift";

const s = (t: number, build: string, isolate = "i", status = 200, ms = 10): Sample => ({ t, status, build, isolate, ms });

describe("analyseDrift", () => {
  test("clean cutover has no mixed window", () => {
    const d = analyseDrift([s(100, "A"), s(900, "A"), s(1200, "B"), s(1500, "B")], "A", "B");
    expect(d.newBuildFirstMs).toBe(1200);
    expect(d.oldBuildLastMs).toBe(900);
    expect(d.mixedWindowMs).toBe(0);
    expect(d.oldAfterFirstNew).toBe(0);
  });
  test("an old answer after the first new one is a mixed window", () => {
    const d = analyseDrift([s(100, "A"), s(1000, "B", "j"), s(4000, "A"), s(5000, "B", "j")], "A", "B");
    expect(d.mixedWindowMs).toBe(3000);
    expect(d.oldAfterFirstNew).toBe(1);
  });
  test("old answers before the deploy returned do not count as drift", () => {
    const d = analyseDrift([s(-500, "A"), s(1000, "B")], "A", "B");
    expect(d.oldBuildLastMs).toBe(-1);
    expect(d.mixedWindowMs).toBe(0);
  });
  test("non-200 are counted", () => {
    expect(analyseDrift([s(1, "", "", 404), s(2, "B")], "A", "B").nonOk).toBe(1);
  });
});

describe("bucketP95", () => {
  test("groups by width", () => {
    const b = bucketP95([{ t: 0, ms: 1 }, { t: 10, ms: 100 }, { t: 1000, ms: 5 }], 1000, (v) => percentile(v, 95));
    expect(b).toEqual([{ start: 0, n: 2, p95: 100 }, { start: 1000, n: 1, p95: 5 }]);
  });
});

describe("percentile", () => {
  test("nearest rank", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile([], 95)).toBe(-1);
  });
});
