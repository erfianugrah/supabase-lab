import { describe, expect, test } from "bun:test";
import {
  FeatureFailure,
  type FeatureOutcome,
  errorText,
  parseTarget,
  regressionVerdict,
  renderEvidence,
  runFeatures,
  summariseRow,
  toMeasurements,
} from "./matrix";

const ok = (name: string, note?: string): FeatureOutcome => ({ name, ok: true, error: "", note });
const bad = (name: string, error: string): FeatureOutcome => ({ name, ok: false, error });

describe("errorText", () => {
  test("a multi-line server error becomes one line, verbatim otherwise", () => {
    // The error IS the finding, so nothing is reworded - only unwrapped, because
    // a measurement lands in a markdown table cell.
    const e = new Error('prepared statement "pvlab_ps" does not exist\n  at Parser.parseError');
    expect(errorText(e)).toBe('prepared statement "pvlab_ps" does not exist at Parser.parseError');
  });

  test("a non-Error rejection still yields text", () => {
    expect(errorText("ECONNRESET")).toBe("ECONNRESET");
  });
});

describe("runFeatures", () => {
  test("a thrown server error is recorded, and later features still run", async () => {
    const outcomes = await runFeatures([
      { name: "a", async run() {} },
      {
        name: "b",
        async run() {
          throw new Error('relation "pvlab_tmp" does not exist');
        },
      },
      { name: "c", async run() {} },
    ]);
    expect(outcomes.map((o) => o.name)).toEqual(["a", "b", "c"]);
    expect(outcomes[1]!.ok).toBe(false);
    expect(outcomes[1]!.error).toBe('relation "pvlab_tmp" does not exist');
    expect(outcomes[2]!.ok).toBe(true);
  });

  test("a SILENT failure is a FeatureFailure, not an absent error", async () => {
    // pg_advisory_unlock returns false rather than raising: the whole reason
    // this class exists is that "no exception" does not mean "feature worked".
    const outcomes = await runFeatures([
      {
        name: "advisory_lock",
        async run() {
          throw new FeatureFailure("pg_advisory_unlock returned false");
        },
      },
    ]);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.error).toBe("pg_advisory_unlock returned false");
  });

  test("a returned string is kept as a note on a passing feature", async () => {
    const outcomes = await runFeatures([
      {
        name: "pid_stable",
        async run() {
          return "pid 4711";
        },
      },
    ]);
    expect(outcomes[0]).toEqual({ name: "pid_stable", ok: true, error: "", note: "pid 4711" });
  });
});

describe("toMeasurements", () => {
  test("ok, ok-with-note, and failed each render distinctly", () => {
    expect(toMeasurements([ok("a"), ok("b", "pid 7"), bad("c", "boom")], 80)).toEqual({
      a: "ok",
      b: "ok (pid 7)",
      c: "failed: boom",
    });
  });

  test("a long error is truncated in the measurement, with an ellipsis marker", () => {
    const m = toMeasurements([bad("c", "x".repeat(200))], 20);
    expect(m.c).toBe(`failed: ${"x".repeat(20)}...`);
    // The full text is never lost - renderEvidence keeps it verbatim.
    expect(renderEvidence([bad("c", "x".repeat(200))])).toContain("x".repeat(200));
  });
});

describe("summariseRow", () => {
  test("the control row FAILS when any feature is broken", () => {
    // Direct 5432 is the control: a feature that does not work there means the
    // probe is wrong, not that the pooler broke it.
    const r = summariseRow([ok("a"), bad("b", "boom")], { control: true });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("b");
  });

  test("the control row passes when everything works", () => {
    expect(summariseRow([ok("a"), ok("b")], { control: true }).status).toBe("pass");
  });

  test("a pooled row is INFO regardless - an unsupported feature is the measurement", () => {
    const r = summariseRow([ok("a"), bad("b", "boom"), bad("c", "boom")], { control: false });
    expect(r.status).toBe("info");
    expect(r.detail).toBe("2/3 unsupported: b, c");
  });

  test("a pooled row that breaks nothing says so explicitly", () => {
    const r = summariseRow([ok("a"), ok("b")], { control: false });
    expect(r.status).toBe("info");
    expect(r.detail).toBe("0/2 unsupported - behaved as a direct session on every feature");
  });
});

describe("regressionVerdict", () => {
  const prior = { label: "T11 (privatelink-aws)", ok: true };

  test("still working reproduces the prior result", () => {
    const v = regressionVerdict(ok("prepared_first"), prior);
    expect(v.status).toBe("pass");
    expect(v.detail).toContain("reproduces");
  });

  test("newly broken is a FAIL naming the prior result", () => {
    // AGENTS.md records prepared statements working on 6543. If that flips, it
    // is the loudest thing in the run, not a quiet info row.
    const v = regressionVerdict(
      bad("prepared_first", 'prepared statement "x" does not exist'),
      prior,
    );
    expect(v.status).toBe("fail");
    expect(v.detail).toContain("REGRESSION");
    expect(v.detail).toContain("T11 (privatelink-aws)");
    expect(v.detail).toContain("does not exist");
  });

  test("a mode that was not probed is a skip, not a pass", () => {
    expect(regressionVerdict(undefined, prior).status).toBe("skip");
  });

  test("working where the prior said broken is info, not a silent pass", () => {
    const v = regressionVerdict(ok("prepared_first"), { label: "folklore", ok: false });
    expect(v.status).toBe("info");
  });
});

describe("parseTarget", () => {
  test("host only takes the default port", () => {
    expect(parseTarget("pooler.example.test", 6543)).toEqual({
      host: "pooler.example.test",
      port: 6543,
    });
  });

  test("host:port overrides it", () => {
    expect(parseTarget("pooler.example.test:5432", 6543)).toEqual({
      host: "pooler.example.test",
      port: 5432,
    });
  });

  test("absent or empty is null, so the mode self-skips with a reason", () => {
    // A Makefile interpolating a missing tofu output exports exactly "".
    expect(parseTarget(undefined, 6543)).toBeNull();
    expect(parseTarget("", 6543)).toBeNull();
    expect(parseTarget("   ", 6543)).toBeNull();
  });

  test("a bracketed IPv6 literal keeps its address", () => {
    // The direct database endpoint is IPv6-only (AGENTS.md, privatelink-aws).
    expect(parseTarget("[2600:1f1c::1]:5432", 6543)).toEqual({
      host: "2600:1f1c::1",
      port: 5432,
    });
  });

  test("a non-numeric port THROWS rather than silently defaulting", () => {
    // Silently defaulting would measure port 6543 while the report claims 5432.
    expect(() => parseTarget("host:banana", 6543)).toThrow(/banana/);
  });
});
