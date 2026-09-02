import { describe, expect, test } from "bun:test";
import { numbersIn, renderFacts } from "./facts";
import type { RunArtifact } from "./types";

const run: RunArtifact = {
  startedAt: "2026-09-02T09:29:16.401Z",
  finishedAt: "2026-09-02T09:42:47.000Z",
  where: "local",
  region: "ap-southeast-1",
  ref: "abcdefghijklmnopqrst",
  experiment: "edge-function-limits",
  labCommit: "b761805",
  toolVersions: { bun: "1.3.14" },
  results: [
    {
      id: "EF10b",
      title: "one minute at concurrency 100, depth 2",
      status: "info",
      detail: "59562 chains in 65 s = 110607 nested calls/min",
      measurements: { chains: 59562, nested_calls: 119124, nested_per_minute: 110607, first_refusal: 'outer 429: {"code":"RATE_LIMIT_EXCEEDED"} | retry' },
    },
    { id: "EF10z", title: "cleanup", status: "pass", detail: "deleted 1", measurements: { deleted: 1 } },
    { id: "EF09b", title: "450 s stream", status: "pass", measurements: { last_tick_s: 395, ticks: 79 } },
  ],
};

describe("renderFacts", () => {
  test("one table per result, measurements verbatim, pipes escaped, ref never printed", () => {
    const md = renderFacts(run);
    expect(md).toContain("## EF10b - one minute at concurrency 100, depth 2 (info)");
    expect(md).toContain("| nested_per_minute | 110607 |");
    expect(md).toContain('{"code":"RATE_LIMIT_EXCEEDED"} \\| retry');
    expect(md).toContain("detail: 59562 chains in 65 s");
    expect(md).not.toContain("abcdefghijklmnopqrst");
  });

  test("--only selects by id or id prefix, case-insensitively", () => {
    const md = renderFacts(run, { only: ["ef10"] });
    expect(md).toContain("## EF10b");
    expect(md).toContain("## EF10z");
    expect(md).not.toContain("## EF09b");
    expect(renderFacts(run, { only: ["EF09b"] })).not.toContain("EF10");
  });

  test("an empty selection says so rather than rendering nothing", () => {
    expect(renderFacts(run, { only: ["ZZ99"] })).toContain("_no results matched_");
  });
});

describe("numbersIn", () => {
  test("collects every number in measurements, detail and evidence with separators stripped", () => {
    const n = numbersIn(run);
    expect(n.has("110607")).toBe(true);
    expect(n.has("119124")).toBe(true);
    expect(n.has("395")).toBe(true);
    expect(n.has("429")).toBe(true);
    // the figure a reviewer caught as wrong is absent, which is the point
    expect(n.has("12022")).toBe(false);
  });

  test("scopes to the selected ids", () => {
    expect(numbersIn(run, ["EF09"]).has("110607")).toBe(false);
    expect(numbersIn(run, ["EF09"]).has("395")).toBe(true);
  });
});
