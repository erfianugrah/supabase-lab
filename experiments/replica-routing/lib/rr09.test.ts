import { describe, expect, test } from "bun:test";
import { blkDelta, removalSummary, replicaShare, tagOf } from "./rr09";

describe("blkDelta", () => {
  test("read and hit deltas with the buffer miss share", () => {
    expect(blkDelta({ read: 100, hit: 900 }, { read: 400, hit: 1600 })).toEqual({ read: 300, hit: 700, missPct: 30 });
  });
  test("no activity", () => {
    expect(blkDelta({ read: 5, hit: 5 }, { read: 5, hit: 5 })).toEqual({ read: 0, hit: 0, missPct: 0 });
  });
  test("a counter that went backwards (stats reset) reads as unknown", () => {
    expect(blkDelta({ read: 500, hit: 500 }, { read: 10, hit: 20 })).toEqual({ read: -1, hit: -1, missPct: -1 });
  });
});

describe("replicaShare", () => {
  test("percent of the two nodes' total that the replica did", () => {
    expect(replicaShare(300, 100)).toBe(25);
  });
  test("nothing on either node", () => {
    expect(replicaShare(0, 0)).toBe(-1);
  });
  test("an unknown side makes the share unknown", () => {
    expect(replicaShare(-1, 10)).toBe(-1);
  });
});

describe("tagOf", () => {
  test("the rr9 tag in a PostgREST filter", () => {
    expect(tagOf("?select=id&tag=eq.rr9-custom&limit=1")).toBe("custom");
    expect(tagOf("select=id&tag=eq.rr9-lb")).toBe("lb");
  });
  test("no tag", () => {
    expect(tagOf("?select=id")).toBe("none");
    expect(tagOf("")).toBe("none");
  });
});

describe("removalSummary", () => {
  const ok = (t: number, label = "primary") => ({ t, label });
  const bad = (t: number, label = "HTTP 400") => ({ t, label });
  test("errors from shortly after the call, then recovery to the primary", () => {
    const s = removalSummary([ok(0, "replica"), ok(5), bad(10), bad(15), bad(20), ok(25), ok(30)]);
    expect(s).toEqual({
      firstErrorS: 10,
      lastErrorS: 20,
      recoveredS: 25,
      errors: 3,
      ok: 4,
      errorLabels: "HTTP 400 x3",
      afterRecovery: "primary x2",
      endLabel: "primary",
    });
  });
  test("never recovered inside the watch", () => {
    const s = removalSummary([ok(0, "replica"), bad(5), bad(10, "HTTP 503")]);
    expect(s.recoveredS).toBe("never");
    expect(s.endLabel).toBe("HTTP 503");
    expect(s.errorLabels).toBe("HTTP 400 x1, HTTP 503 x1");
  });
  test("never failed", () => {
    const s = removalSummary([ok(0, "replica"), ok(5)]);
    expect(s.firstErrorS).toBe("none");
    expect(s.recoveredS).toBe("n/a");
  });
});
