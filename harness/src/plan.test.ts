import { describe, expect, test } from "bun:test";
import { planRun } from "./plan";
import type { Capability, TestModule } from "./types";

const mod = (over: Partial<TestModule> & { id: string }): TestModule => ({
  title: `test ${over.id}`,
  where: "runner",
  run: async () => ({ id: over.id, title: "t", status: "pass" }),
  ...over,
});

const caps = (...c: Capability[]) => new Set<Capability>(c);

describe("planRun", () => {
  test("filters by execution vantage and says why", () => {
    const { run, skipped } = planRun([mod({ id: "T1", where: "local" })], {
      where: "runner",
      capabilities: caps(),
    });
    expect(run).toHaveLength(0);
    expect(skipped[0]!.status).toBe("skip");
    expect(skipped[0]!.detail).toContain('runs on "local"');
  });

  test("skips on missing capabilities and names them", () => {
    const { run, skipped } = planRun(
      [mod({ id: "T1", requires: ["lambda", "anon-key"] })],
      { where: "runner", capabilities: caps("lambda") },
    );
    expect(run).toHaveLength(0);
    expect(skipped[0]!.detail).toBe("missing capability: anon-key");
  });

  test("runs when every capability is present", () => {
    const { run } = planRun([mod({ id: "T1", requires: ["db"] })], {
      where: "runner",
      capabilities: caps("db", "endpoint"),
    });
    expect(run.map((m) => m.id)).toEqual(["T1"]);
  });

  test("excludes destructive tests by default", () => {
    const { run, skipped } = planRun([mod({ id: "T1", destructive: true })], {
      where: "runner",
      capabilities: caps(),
    });
    expect(run).toHaveLength(0);
    expect(skipped[0]!.detail).toContain("--destructive");
  });

  test("orders destructive tests last so read-only results survive", () => {
    const mods = [
      mod({ id: "T9", destructive: true }),
      mod({ id: "T2" }),
      mod({ id: "T1", destructive: true }),
      mod({ id: "T3" }),
    ];
    const { run } = planRun(mods, {
      where: "runner",
      capabilities: caps(),
      allowDestructive: true,
    });
    expect(run.map((m) => m.id)).toEqual(["T2", "T3", "T1", "T9"]);
  });

  test("--only selects a subset, case-insensitively", () => {
    const mods = [mod({ id: "T1" }), mod({ id: "T2" }), mod({ id: "T3" })];
    const { run, skipped } = planRun(mods, {
      where: "runner",
      capabilities: caps(),
      only: ["t1", "T3"],
    });
    expect(run.map((m) => m.id)).toEqual(["T1", "T3"]);
    // unselected tests are omitted entirely, not reported as skips
    expect(skipped).toHaveLength(0);
  });
});
