import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./report";
import type { RunArtifact } from "./types";

const artifact = (results: RunArtifact["results"]): RunArtifact => ({
  startedAt: "2026-08-02T00:00:00Z",
  finishedAt: "2026-08-02T00:05:00Z",
  where: "runner",
  region: "ap-southeast-1",
  ref: "abc123",
  toolVersions: { psql: "16.14" },
  results,
});

describe("renderMarkdown", () => {
  test("the title names the experiment, and does not claim PrivateLink when unlabelled", () => {
    const labelled = renderMarkdown({
      ...artifact([{ id: "X01", title: "shapes", status: "pass" }]),
      experiment: "cross-project-auth",
    });
    expect(labelled.split("\n")[0]).toBe("# cross-project-auth run - 2026-08-02T00:00:00Z");

    const unlabelled = renderMarkdown(artifact([{ id: "X01", title: "shapes", status: "pass" }]));
    expect(unlabelled.split("\n")[0]).toBe("# supabase-lab run - 2026-08-02T00:00:00Z");
    expect(unlabelled).not.toContain("PrivateLink");
  });

  test("a new test's measurements become columns with no renderer change", () => {
    const md = renderMarkdown(
      artifact([
        {
          id: "T02",
          title: "direct 5432",
          status: "pass",
          measurements: { connect_ms: 37, p95_ms: 42 },
        },
        {
          id: "TNEW",
          title: "something added later",
          status: "pass",
          measurements: { connect_ms: 12, brand_new_metric: "yes" },
        },
      ]),
    );
    expect(md).toContain("| Test | connect_ms | p95_ms | brand_new_metric |");
    expect(md).toContain("| TNEW | 12 |  | yes |");
  });

  test("failures are listed before passes", () => {
    const md = renderMarkdown(
      artifact([
        { id: "T01", title: "ok", status: "pass" },
        { id: "T02", title: "broken", status: "fail", detail: "refused" },
      ]),
    );
    expect(md.indexOf("T02 broken")).toBeLessThan(md.indexOf("T01 ok"));
  });

  test("pipes in detail text cannot break the table", () => {
    const md = renderMarkdown(
      artifact([{ id: "T1", title: "a|b", status: "info", detail: "x | y" }]),
    );
    expect(md).toContain("T1 a\\|b");
    expect(md).toContain("x \\| y");
  });

  test("omits the measurements section when nothing measured", () => {
    const md = renderMarkdown(artifact([{ id: "T1", title: "t", status: "skip" }]));
    expect(md).not.toContain("## Measurements");
  });
});
