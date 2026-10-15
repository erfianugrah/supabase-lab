import { describe, expect, test } from "bun:test";
import type { RunResult } from "./client";
import { coloCounts, transportLost } from "./td02-03-io";

const res = (p: Partial<RunResult>): RunResult => ({ ops: [], colos: [], invocations: 1, ...p }) as RunResult;

describe("transportLost", () => {
  test("only a client fetch failure with no ops counts", () => {
    expect(transportLost(res({ ok: false, error: "fetch: The socket connection was closed unexpectedly." }))).toBe(true);
    expect(transportLost(res({ ok: false, error: "HTTP 503 non-JSON: error code: 1102" }))).toBe(false);
    expect(transportLost(res({ ok: false, error: "fetch: x", ops: [{ inv: 0, lane: 0, i: 0, stmt: 0, t0: 0, ms: 1, ok: true }] }))).toBe(false);
  });
});

describe("coloCounts", () => {
  test("counts invocations per colo, most frequent first", () => {
    expect(coloCounts([res({ colos: ["SIN"] }), res({ colos: ["MRS"] }), res({ colos: ["SIN"], invocations: 3 })])).toBe("SIN:4,MRS:1");
    expect(coloCounts([res({ colos: [] })])).toBe("");
  });
});
