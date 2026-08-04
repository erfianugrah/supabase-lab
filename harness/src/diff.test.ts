import { describe, expect, test } from "bun:test";
import { diffArtifacts, renderDiffMarkdown } from "./diff";
import type { RunArtifact, TestResult } from "./types";

function artifact(results: TestResult[]): RunArtifact {
  return {
    startedAt: "2026-08-01T00:00:00.000Z",
    finishedAt: "2026-08-01T00:01:00.000Z",
    where: "local",
    region: "ap-southeast-1",
    ref: "abcdefghijklmnopqrst",
    experiment: "platform-facts",
    toolVersions: { bun: "1.3.13" },
    results,
  };
}

const r = (
  id: string,
  status: TestResult["status"],
  m?: Record<string, string | number>,
): TestResult => ({ id, title: id, status, ...(m ? { measurements: m } : {}) });

describe("diffArtifacts", () => {
  test("a changed measurement is the unit of the diff", () => {
    const d = diffArtifacts(
      artifact([r("F01", "info", { plan: "pro", audit_logs_days: 7 })]),
      artifact([r("F01", "info", { plan: "pro", audit_logs_days: 28 })]),
    );
    expect(d.changed).toEqual([{ id: "F01", key: "audit_logs_days", from: 7, to: 28 }]);
    expect(d.statusChanged).toEqual([]);
  });

  test("run metadata never appears in the diff", () => {
    const a = artifact([r("F01", "info", { plan: "pro" })]);
    const b = {
      ...artifact([r("F01", "info", { plan: "pro" })]),
      startedAt: "2026-09-01T00:00:00.000Z",
      labCommit: "deadbee",
      toolVersions: { bun: "9.9.9" },
    };
    const d = diffArtifacts(a, b);
    expect(d.changed).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  test("TestResult fields like durationMs are never compared - only measurements are", () => {
    const a = artifact([{ ...r("F01", "info", { plan: "pro" }), durationMs: 10 }]);
    const b = artifact([{ ...r("F01", "info", { plan: "pro" }), durationMs: 9000 }]);
    expect(diffArtifacts(a, b).changed).toEqual([]);
  });

  test("a status change is reported even when no measurement moved", () => {
    const d = diffArtifacts(
      artifact([r("F03", "pass", { probed: 8 })]),
      artifact([r("F03", "fail", { probed: 8 })]),
    );
    expect(d.changed).toEqual([]);
    expect(d.statusChanged).toEqual([{ id: "F03", from: "pass", to: "fail" }]);
  });

  test("appearing and disappearing tests are not changed measurements", () => {
    const d = diffArtifacts(artifact([r("F01", "info")]), artifact([r("F02", "info")]));
    expect(d.removed).toEqual(["F01"]);
    expect(d.added).toEqual(["F02"]);
    expect(d.changed).toEqual([]);
  });

  test("a measurement key appearing is a change, with an explicit absent marker", () => {
    const d = diffArtifacts(
      artifact([r("F01", "info", { plan: "pro" })]),
      artifact([r("F01", "info", { plan: "pro", new_row: "x" })]),
    );
    expect(d.changed).toEqual([{ id: "F01", key: "new_row", from: null, to: "x" }]);
  });
});

describe("renderDiffMarkdown", () => {
  test("an all-clear run says so rather than rendering an empty table", () => {
    const md = renderDiffMarkdown(
      diffArtifacts(
        artifact([r("F01", "info", { plan: "pro" })]),
        artifact([r("F01", "info", { plan: "pro" })]),
      ),
    );
    expect(md).toContain("no change");
    expect(md).not.toContain("| id |");
  });

  test("changed rows render with both values", () => {
    const md = renderDiffMarkdown(
      diffArtifacts(
        artifact([r("F01", "info", { audit_logs_days: 7 })]),
        artifact([r("F01", "info", { audit_logs_days: 28 })]),
      ),
    );
    expect(md).toContain("audit_logs_days");
    expect(md).toContain("28");
  });
});
