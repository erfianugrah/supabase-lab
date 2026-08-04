# Pooler semantics and throughput - implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish by measurement which Postgres features break in each Supavisor pooler
mode, with the server's exact error text for each, and what the throughput difference is
between direct 5432, the dedicated pooler on 6543, and the public shared pooler.

**Architecture:** Two generic pieces land in the shared harness. `harness/src/matrix.ts`
runs a set of named feature probes against one connection and turns the outcomes into one
report row, so adding a connection mode is a table entry and adding a feature is a closure.
`harness/src/sbperf.ts` reads `sbperf bench --json`, because throughput comparison is a
methodology problem before it is a measurement problem and `sbperf bench` already solves the
methodology. A new experiment `experiments/pooler-semantics` provides one project, the
Postgres feature probes, and two modules: S01 emits one row per mode with one measurement
per feature, S02 emits one row per path with the benchmark scalars.

**Tech stack:** Bun + TypeScript (harness), `pg`'s `Client` for Postgres, OpenTofu for the
project, `sbperf bench` (which wraps `pgbench`) for throughput, the existing `TestModule`
contract in `harness/src/types.ts`.

**Standing constraint:** the operator has asked for no commits in this session. Per-task
commit steps are therefore omitted; commit at your own cadence.

**Depends on Task 1 of `docs/plans/2026-08-04-platform-downtime.md`.** That task adds
`ctx.endpoints` (populated from `PVLAB_ENDPOINT_<NAME>`) and the `pooler` capability. Every
module here reads `ctx.endpoints`, so apply that task first. It is not repeated here: two
plans landing the same field in `types.ts` and `ctx.ts` would conflict on the second apply.
If it is already in the tree, `grep -n readEndpoints harness/src/ctx.ts` returns a hit and
there is nothing to do.

**The output is a matrix, not a verdict.** Connection-pooling maturity is a live objection,
and at least one large account has moved a primary database elsewhere citing pooler
stability. A reader deciding whether to migrate does not need a score; they need to know
that their ORM's named statements will come back as
`prepared statement "s1" does not exist` on this path and not that one. That is why every
probe records the server's wording verbatim rather than a boolean.

**Verified against the repo on 2026-08-04:**

- `P01` through `P04` are ALREADY TAKEN by `experiments/tenant-promotion`, and `D01`-`D04`
  are claimed by the downtime plan. `./dist/pvlab --list` on a clean tree lists 32 tests
  across the prefixes C, F, P, T, V and X. This experiment uses `S` (Supavisor), which is
  free.
- `pgbench` is already a `Capability` in `harness/src/types.ts` and is derived from
  `which pgbench` in `deriveCapabilities`. S02 gates on it; nothing new is added to the
  capability union.
- Postgres client is `pg`'s `Client` (`experiments/privatelink-aws/tests/t02-connectivity.ts`).
  There is no `Bun.SQL` in this repo.
- A module may return `TestResult[]` with ids the module id does not carry:
  `t20-latency.ts` emits `T20a`/`T20b`/`T20c` from module id `T20`. S01 and S02 use the
  same shape, and `--only` still filters on the MODULE id.
- Root scripts are `bun run test` (`bun test harness`) and `bun run typecheck`
  (`bunx tsc --noEmit -p harness/tsconfig.json`). **`bun test harness` only collects tests
  under `harness/`** - a `*.test.ts` inside `experiments/*/lib` would never run, and
  `harness/tsconfig.json` includes `src` and `../experiments/*/tests` but not
  `../experiments/*/lib`, so it would not even be typechecked. That is why the pure logic
  in Tasks 1 and 2 lands in `harness/src/`.
- `harness/tsconfig.json` sets `noUncheckedIndexedAccess`, which is why every row access
  below is guarded or carries a `!`.
- The donor for a single-project scaffold is `experiments/platform-facts`. Its resource is
  `supabase_project.probe`, its `outputs.tf` already exports `project_ref` and `api_host`,
  and BOTH `experiment.tfvars` and the `project_name` default in `variables.tf` say
  `lab-platform-facts`.
- `sbperf` is expected on PATH (`which sbperf`); it is a separate public tool, not vendored
  here, so do not pin an absolute path - this repo is meant to run on a machine that is not
  the one this plan was written on. Its `bench` subcommand accepts
  `--db-url --ref --builtin --clients --time --runs --warmup --protocol --name --store
  --json --yes` - confirmed by running it with exactly those flags on 2026-08-04, which
  parsed them all and reached `findPgbench()`. `--json` prints
  `JSON.stringify({ id, row, runs, tpsSpreadPct })`, where `row` carries `tps_median`,
  `p50_us`, `p95_us`, `p99_us`, `failed_tx`, `clients`, `time_s`, `protocol`,
  `client_cores`, `client_load_max`, `tainted`, `unstable`, `server_version`,
  `pgbench_version`.
- `sbperf bench` spawns pgbench with `{ ...process.env, PGPASSWORD }`, so `PGSSLMODE` set
  by the caller reaches pgbench. It parses `--db-url` with `new URL()`, so the username and
  password must be percent-encoded.
- `pgbench` was absent when this plan was written and S02 correctly self-skipped with
  `missing capability: pgbench`. **Installed 2026-08-04: pgbench 18.4**, from Arch's
  `postgresql` package (`postgresql-libs`, which ships psql, does NOT carry it). The
  harness derives the capability from `which pgbench`, so S02 needs no change to light up.
- **The direct 5432 control needs IPv6 and this vantage has none** - no global address, no
  egress, confirmed. DECISION: buy the `ipv4_default` addon on the throwaway project for
  the duration of the run, using the same `PATCH /v1/projects/{ref}/billing/addons` lever
  D03/D04 exercised (`addon_type: "ipv4"`). Check the project's own `available_addons`
  before relying on it. The alternatives were rejected: the AWS runner rig is the whole
  VPC/SSM/endpoint stack for one experiment, and running without the control leaves
  "cursors do not work on 6543" indistinguishable from "the cursor probe is broken", which
  is the one thing summariseRow exists to prevent.
- Test ids sort within the destructive tier, so id order IS execution order. S01
  (non-destructive) runs before S02 (destructive), which is the order the findings need:
  the feature matrix explains the throughput numbers.

**Dry-run status (2026-08-04).** Tasks 1, 2, 3, 4, 5, 6 and 7 were applied verbatim to a
scratch copy at `/tmp/pooler-check` and gated on this plan's own sensors, with the downtime
plan's Task 1 applied first as its stated prerequisite. Sensors: `bun run typecheck` exit 0;
`bun run test` **62 pass / 0 fail** (baseline 27, plus 4 from the prerequisite, plus 20 from
Task 1 and 11 from Task 2); `bun run build` then `./dist/pvlab --list` shows **34 registered
tests** including the S01 and S02 rows; `tofu init -backend=false && tofu validate` returns
`Success! The configuration is valid.` on the Task 6 scaffold with four `.tf` files present;
`tofu fmt -check` clean. Both modules were also executed end-to-end against an unresolvable
ref, and every degradation path was exercised: absent endpoint, malformed endpoint, and
unreachable host each produce the intended skip or fail rather than a throw. The Task 7
Makefile's three guards were each fired. What is NOT verified: every number S01 and S02 are
built to produce. Those need a live project, and the plan spends no money.

---

## Why not just extend T02 and T20

Both already exist and both are the precedent this generalises.

`experiments/privatelink-aws/tests/t02-connectivity.ts` connects on 5432 and 6543 and, in
seven lines, records whether ONE named statement prepares. That single probe is the source
of the repo's standing finding that the "no prepared statements in transaction mode" rule
measured false on 6543. It answers one question about one feature on two ports, and it runs
`where: "runner"` because it goes through a PrivateLink endpoint.

`experiments/privatelink-aws/tests/t20-latency.ts` shells out to
`pgbench ... -c 4 -j 2 -T 15 --no-vacuum` and scrapes `tps = ([0-9.]+)` out of stdout. There
is no warmup, no repetition, no spread, no percentiles beyond what its own connect loop
computes, no check that the client was idle, and no record of the server settings the number
came from. It is enough to notice that a pooled path is slower; it is not enough to publish
a comparison.

Three things follow:

1. The interesting object is a MATRIX. Nine features by four modes is 36 cells, and 36
   copies of t02's probe is not a test suite. Separating "what feature" from "what
   connection mode" is what keeps that to one closure per feature and one table row per
   mode - the same split `sampler.ts` makes for downtime.
2. A single-shot probe cannot see the failure that matters. t02 prepares a statement once
   and executes it in the same call. A real client prepares once and BINDS many times, and
   that is where a transaction pooler breaks. Task 3 measures both, and keeps t02's probe
   as its own column so the standing finding is reproduced rather than replaced.
3. Throughput needs methodology, and it already exists. `sbperf bench` refuses to run on a
   saturated client, runs an unmeasured warmup before N measured repetitions, takes exact
   percentiles from pgbench's `-l` transaction log rather than the rounded stdout summary,
   snapshots `pg_settings` per run so two numbers can be shown to have come from the same
   server configuration, and stores every run so `sbperf bench --compare <a> <b>` is a
   command. Reimplementing that inside a test module is the wrong direction of travel.

## File structure

| Path | Responsibility |
| --- | --- |
| `harness/src/matrix.ts` | CREATE. Feature-probe runner, `FeatureFailure`, outcome-to-measurement flattening, control-row rules, `parseTarget`. |
| `harness/src/matrix.test.ts` | CREATE. 20 unit tests over the pure parts. |
| `harness/src/sbperf.ts` | CREATE. Parse `sbperf bench --json`; caveats; baseline delta. |
| `harness/src/sbperf.test.ts` | CREATE. 11 unit tests against a fixture shaped from sbperf's own types. |
| `experiments/pooler-semantics/providers.tf` | CREATE. Copied from `platform-facts` with its `.terraform.lock.hcl`. |
| `experiments/pooler-semantics/variables.tf` | CREATE. Copied; `project_name` default renamed. |
| `experiments/pooler-semantics/supabase.tf` | CREATE. One project. |
| `experiments/pooler-semantics/outputs.tf` | CREATE. Already exports `project_ref` and `api_host`. |
| `experiments/pooler-semantics/experiment.tfvars` | CREATE. Renamed project, region, compute. |
| `experiments/pooler-semantics/lib/features.ts` | CREATE. The nine Postgres feature probes. |
| `experiments/pooler-semantics/tests/s01-feature-matrix.ts` | CREATE. One row per mode plus the T11 re-measure. |
| `experiments/pooler-semantics/tests/s02-throughput.ts` | CREATE. One row per path via `sbperf bench`. |
| `experiments/pooler-semantics/Makefile` | CREATE. `init/apply/pooler-config/bench-init/probe/probe-destructive/destroy`. |
| `experiments/pooler-semantics/RUNLOG.md` | CREATE. Findings, written as they are measured. |
| `AGENTS.md` | MODIFY. Add the experiment's key-facts section after the run. |

Deliberately deferred: session mode on the PUBLIC shared pooler (the shape is the same as
S01b, and the interesting shared-pooler question is throughput and noisy-neighbour
variance, which S02 covers); and IPv4-add-on paths (a billable entitlement, and this matrix
is about pooler semantics, not addressing).

The code tasks come before the infrastructure tasks on purpose. Everything in Tasks 1 to 5
is gated by `bun run typecheck`, `bun run test` and `bun run build` on a machine with no
project, so the whole thing is proven executable before the first billable resource exists.

---

### Task 1: `harness/src/matrix.ts` - the feature-matrix primitive

**Files:**
- Create: `harness/src/matrix.ts`
- Test: `harness/src/matrix.test.ts`

Two design decisions the tests below encode, so do not simplify them away:

- A feature can fail SILENTLY. `pg_advisory_unlock` returns `false` and logs a warning when
  the lock is not held; it raises nothing. `FeatureFailure` is how a probe reports that,
  so "no exception" never reads as "worked".
- The direct, unpooled mode is a CONTROL and is the only row that asserts. A feature that
  fails there means the probe is wrong; the same feature failing only on a pooled row is
  the finding. Without that rule, "cursors do not work on 6543" is indistinguishable from
  "the cursor probe is broken".

- [ ] **Step 1: Write the failing tests**

Create `harness/src/matrix.test.ts`:

```ts
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
    const outcomes = await runFeatures([{ name: "pid_stable", async run() { return "pid 4711"; } }]);
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
    const v = regressionVerdict(bad("prepared_first", 'prepared statement "x" does not exist'), prior);
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test harness/src/matrix.test.ts`
Expected: `error: Cannot find module './matrix'`, 0 pass / 1 fail.

- [ ] **Step 3: Implement**

Create `harness/src/matrix.ts`:

```ts
/**
 * Feature-matrix probing: run the same set of named feature probes against
 * several connection modes and turn each mode's outcomes into one report row.
 *
 * The generalisation is the same one sampler.ts makes for downtime. There,
 * "what operation" is separated from "what paths"; here, "what feature" is
 * separated from "what connection mode", so adding a mode is a table row and
 * adding a feature is one closure.
 *
 * Two rules are encoded here rather than left to each experiment:
 *
 * 1. A feature can fail SILENTLY. `pg_advisory_unlock` returns false and emits
 *    a warning when the lock is not held; nothing is raised. `FeatureFailure`
 *    is how a probe reports that, so "no exception" never reads as "worked".
 * 2. The error text is the finding, not decoration. A reader wants to know how
 *    the failure will present in their application, so the server's wording is
 *    carried verbatim into `evidence` and only TRUNCATED (never reworded) for
 *    the measurement cell.
 */
import type { Status } from "./types";

/** Thrown by a probe whose feature did not work but which raised nothing. */
export class FeatureFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureFailure";
  }
}

export interface Feature {
  name: string;
  /** Resolve (optionally with a note) on success; THROW on failure. */
  run(): Promise<string | void>;
}

export interface FeatureOutcome {
  name: string;
  ok: boolean;
  /** Verbatim, single-lined. Empty string when ok. */
  error: string;
  /** Recorded on success - e.g. the backend pid the probe observed. */
  note?: string;
}

/** Error -> a single line. Unwrapped only; never reworded. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Runs the probes IN ORDER on one connection. Order matters: the
 * prepared-statement reuse probe is only meaningful after the statement has
 * been prepared, so the caller's array order is preserved and never
 * parallelised.
 */
export async function runFeatures(features: Feature[]): Promise<FeatureOutcome[]> {
  const outcomes: FeatureOutcome[] = [];
  for (const f of features) {
    try {
      const note = await f.run();
      outcomes.push({ name: f.name, ok: true, error: "", ...(note ? { note } : {}) });
    } catch (e) {
      outcomes.push({ name: f.name, ok: false, error: errorText(e) });
    }
  }
  return outcomes;
}

/** One measurement per feature. `maxLen` bounds the table cell, not the record. */
export function toMeasurements(
  outcomes: FeatureOutcome[],
  maxLen: number,
): Record<string, string> {
  const m: Record<string, string> = {};
  for (const o of outcomes) {
    if (o.ok) m[o.name] = o.note ? `ok (${o.note})` : "ok";
    else
      m[o.name] =
        o.error.length > maxLen ? `failed: ${o.error.slice(0, maxLen)}...` : `failed: ${o.error}`;
  }
  return m;
}

/** The verbatim record. Nothing here is truncated. */
export function renderEvidence(outcomes: FeatureOutcome[]): string {
  return outcomes
    .map((o) => `${o.name}: ${o.ok ? `ok${o.note ? ` (${o.note})` : ""}` : o.error}`)
    .join("\n");
}

/**
 * `control: true` is the unpooled reference mode. Every feature MUST work
 * there; one that does not means the probe is broken, so the row fails rather
 * than quietly widening the matrix. A pooled row is always `info` - an
 * unsupported feature is the measurement being taken, not a defect.
 */
export function summariseRow(
  outcomes: FeatureOutcome[],
  opts: { control: boolean },
): { status: Status; detail: string } {
  const broken = outcomes.filter((o) => !o.ok).map((o) => o.name);
  if (opts.control) {
    return broken.length
      ? {
          status: "fail",
          detail: `control mode did not support ${broken.join(", ")} - the probe is suspect, not the pooler`,
        }
      : {
          status: "pass",
          detail: `control mode supports all ${outcomes.length} features`,
        };
  }
  return {
    status: "info",
    detail: broken.length
      ? `${broken.length}/${outcomes.length} unsupported: ${broken.join(", ")}`
      : `0/${outcomes.length} unsupported - behaved as a direct session on every feature`,
  };
}

/**
 * Compare one feature outcome against a result this repo already recorded.
 * A prior finding that flips is the loudest thing in a run; without this it
 * would land as one `info` cell in a wide table and be read past.
 */
export function regressionVerdict(
  outcome: FeatureOutcome | undefined,
  prior: { label: string; ok: boolean },
): { status: Status; detail: string } {
  if (!outcome)
    return { status: "skip", detail: `mode not probed - nothing to compare against ${prior.label}` };
  if (prior.ok && outcome.ok)
    return { status: "pass", detail: `reproduces ${prior.label}: ${outcome.name} still works` };
  if (prior.ok && !outcome.ok)
    return {
      status: "fail",
      detail: `REGRESSION vs ${prior.label}: ${outcome.name} now fails with "${outcome.error}"`,
    };
  if (!prior.ok && outcome.ok)
    return {
      status: "info",
      detail: `${prior.label} recorded ${outcome.name} as broken; it works now`,
    };
  return { status: "pass", detail: `reproduces ${prior.label}: ${outcome.name} still fails` };
}

export interface Target {
  host: string;
  port: number;
}

/**
 * `"host"` / `"host:port"` / `"[v6addr]:port"` -> a target; absent or empty ->
 * null, so the mode self-skips with a reason instead of dialling "".
 *
 * A non-numeric port throws. Defaulting there would benchmark one port while
 * the report named another, which is worse than a crash at startup.
 */
export function parseTarget(value: string | undefined, defaultPort: number): Target | null {
  const v = (value ?? "").trim();
  if (!v) return null;

  const bracketed = v.match(/^\[([^\]]+)\](?::(.+))?$/);
  if (bracketed) return { host: bracketed[1]!, port: portOf(bracketed[2], defaultPort, v) };

  const i = v.lastIndexOf(":");
  // A bare IPv6 literal has several colons and no port; treat it as a host.
  if (i === -1 || v.indexOf(":") !== i) return { host: v, port: defaultPort };
  return { host: v.slice(0, i), port: portOf(v.slice(i + 1), defaultPort, v) };
}

function portOf(raw: string | undefined, fallback: number, whole: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535)
    throw new Error(`not a port in endpoint "${whole}": ${raw}`);
  return n;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test harness/src/matrix.test.ts`
Expected: `20 pass, 0 fail, 34 expect() calls`.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

---

### Task 2: `harness/src/sbperf.ts` - read the benchmark, do not write one

**Files:**
- Create: `harness/src/sbperf.ts`
- Test: `harness/src/sbperf.test.ts`

- [ ] **Step 1: Confirm the tool and its flags before writing a parser for them**

Run:
```bash
which sbperf
sbperf bench --db-url "postgres://u:p@127.0.0.1:6543/postgres" --ref abcdefghijklmnopqrst \
  --builtin select-only --clients 8 --time 60 --runs 3 --warmup 10 \
  --protocol extended --name smoke --store /tmp/sbperf-flagcheck.db --json
```
Expected, re-measured on 2026-08-04 WITH pgbench installed:
```
> pgbench 18.4 -> 127.0.0.1:6543/postgres (as u)
> 8 clients / 8 threads, 3 x 60s + 10s warmup, protocol extended
error: warmup failed (exit 1): pgbench: error: connection to server at "127.0.0.1", port 6543 failed: Connection refused
```
That is the PASS condition: every flag parsed, pgbench was found, the target resolved, and
it died only because nothing is listening on that port. Before pgbench was installed the
pass condition was the earlier `error: pgbench not found` - also fine, and also proof the
flags parsed, since both errors come after argument handling. If instead you get an
unknown-flag usage dump, the installed `sbperf` is older than this plan - reconcile against
its `--help` before continuing. `--store` points at a throwaway file so the flag check does
not write into the real history store.

Note what that output also confirms: sbperf prints PROSE, not JSON, when it fails. That is
exactly the path `parseBenchJson` is built to surface rather than swallow as a
SyntaxError.

Client tools are now present:
```bash
which pgbench   # /usr/sbin/pgbench, pgbench 18.4
```

- [ ] **Step 2: Write the failing tests**

Create `harness/src/sbperf.test.ts`. The fixture's field VALUES are invented; only the
field NAMES and the nesting are load-bearing, and those are read off sbperf's own
`BenchResult` and `BenchRunInput` types.

```ts
import { describe, expect, test } from "bun:test";
import { benchCaveats, benchMeasurements, parseBenchJson, throughputDelta } from "./sbperf";

/**
 * Shaped from sbperf's own types (src/bench.ts `BenchResult`, src/store.ts
 * `BenchRunInput`): `bench --json` prints JSON.stringify(res, null, 2) where
 * res = { id, row, runs, tpsSpreadPct }. Only the fields read below are
 * asserted on, so an added column upstream does not break this. The numbers
 * are invented - this test pins the parser, not the platform.
 */
const SAMPLE = JSON.stringify({
  id: 12,
  row: {
    ref: "abcdefghijklmnopqrst",
    ts: 1785500000,
    name: "direct-5432",
    script_hash: "9f2c",
    scale: 1,
    clients: 8,
    threads: 4,
    time_s: 60,
    protocol: "extended",
    rate: null,
    tps_median: 3810.42,
    p50_us: 2010,
    p95_us: 5400,
    p99_us: 11250,
    failed_tx: 0,
    client_cores: 16,
    client_load_max: 3.2,
    tainted: false,
    unstable: false,
    pgbench_version: "16.4",
    server_version: "15.8",
  },
  runs: [{ tps: 3800 }, { tps: 3810 }, { tps: 3822 }],
  tpsSpreadPct: 0.6,
});

describe("parseBenchJson", () => {
  test("pulls the scalars and converts microseconds to milliseconds", () => {
    const s = parseBenchJson(SAMPLE);
    expect(s.id).toBe(12);
    expect(s.tpsMedian).toBe(3810.42);
    expect(s.p95Ms).toBe(5.4);
    expect(s.p99Ms).toBe(11.25);
    expect(s.clients).toBe(8);
    expect(s.protocol).toBe("extended");
    expect(s.serverVersion).toBe("15.8");
  });

  test("non-JSON stdout throws WITH the output, not a bare SyntaxError", () => {
    // sbperf refuses to run on a busy client; that message must reach the report
    // instead of being swallowed as "unexpected token".
    expect(() => parseBenchJson("client load is 14.2 on 16 cores - a busy client")).toThrow(
      /busy client/,
    );
  });

  test("JSON of the wrong shape throws rather than yielding NaN columns", () => {
    expect(() => parseBenchJson('{"ok":true}')).toThrow(/row/);
  });
});

describe("benchCaveats", () => {
  test("a clean run has none", () => {
    expect(benchCaveats(parseBenchJson(SAMPLE))).toEqual([]);
  });

  test("client saturation and tps spread are reported separately", () => {
    const dirty = JSON.parse(SAMPLE) as { row: Record<string, unknown>; tpsSpreadPct: number };
    dirty.row.tainted = true;
    dirty.row.client_load_max = 22.5;
    dirty.tpsSpreadPct = 21.4;
    dirty.row.unstable = true;
    const c = benchCaveats(parseBenchJson(JSON.stringify(dirty)));
    expect(c).toHaveLength(2);
    expect(c[0]).toContain("22.5");
    expect(c[1]).toContain("21.4");
  });
});

describe("throughputDelta", () => {
  test("slower than the baseline reads negative", () => {
    expect(throughputDelta(3810, 2258)).toBe("-40.7%");
  });

  test("faster reads positive with a sign", () => {
    expect(throughputDelta(2000, 2500)).toBe("+25.0%");
  });

  test("the baseline against itself is exactly zero", () => {
    expect(throughputDelta(3810, 3810)).toBe("+0.0%");
  });

  test("a zero or absent baseline is n/a, not Infinity", () => {
    // The direct row skips when there is no IPv6 path out of this vantage,
    // which would otherwise make every pooled delta read "Infinity%".
    expect(throughputDelta(0, 2258)).toBe("n/a");
    expect(throughputDelta(null, 2258)).toBe("n/a");
  });
});

describe("benchMeasurements", () => {
  test("flattens to scalar report columns, baseline delta included", () => {
    const m = benchMeasurements(parseBenchJson(SAMPLE), 4500);
    expect(m.tps_median).toBe(3810.42);
    expect(m.p95_ms).toBe(5.4);
    expect(m.vs_baseline).toBe("-15.3%");
    expect(m.clients).toBe(8);
    expect(m.sbperf_run_id).toBe(12);
  });

  test("without a baseline the delta column says so instead of vanishing", () => {
    // A missing column silently drops the row out of the comparison table.
    expect(benchMeasurements(parseBenchJson(SAMPLE), null).vs_baseline).toBe("n/a");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test harness/src/sbperf.test.ts`
Expected: `error: Cannot find module './sbperf'`.

- [ ] **Step 4: Implement**

Create `harness/src/sbperf.ts`:

```ts
/**
 * Reads the output of `sbperf bench --json`.
 *
 * Why shell out at all: throughput comparison is a methodology problem before
 * it is a measurement problem, and `sbperf bench` already solves the
 * methodology - it refuses to run on a saturated client, runs an unmeasured
 * warmup before N measured repetitions, takes exact percentiles from pgbench's
 * own -l transaction log rather than the rounded stdout summary, snapshots
 * pg_settings per run so two numbers can be shown to have come from the same
 * server configuration, and stores every run so `--compare` is a command rather
 * than an arithmetic exercise. T20's inline `pgbench ... -T 15` +
 * `tps = ([0-9.]+)` regex has none of that.
 *
 * This module deliberately parses only the fields the report needs. An added
 * column upstream must not break a lab run.
 */

export interface BenchSummary {
  /** Row id in sbperf's history store - the handle for `bench --compare`. */
  id: number;
  label: string;
  tpsMedian: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  failedTx: number;
  clients: number;
  timeS: number;
  protocol: string;
  spreadPct: number;
  tainted: boolean;
  clientLoadMax: number;
  clientCores: number;
  serverVersion: string;
  pgbenchVersion: string;
}

function num(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`sbperf bench --json: ${field} is not a number (${v})`);
  return n;
}

/** us -> ms, two decimals. Percentiles are reported in ms everywhere else here. */
function ms(us: unknown, field: string): number {
  return Math.round(num(us, field) / 10) / 100;
}

export function parseBenchJson(text: string): BenchSummary {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // sbperf's guardrails (busy client, missing pgbench) print prose and exit.
    // Surfacing that prose is the whole point - a bare SyntaxError is not a
    // finding, "client load is 14.2 on 16 cores" is.
    throw new Error(`sbperf bench did not emit JSON: ${text.trim().slice(0, 300)}`);
  }
  const top = doc as { id?: unknown; row?: unknown; tpsSpreadPct?: unknown };
  if (!top.row || typeof top.row !== "object")
    throw new Error(`sbperf bench --json: no "row" object in the output`);
  const r = top.row as Record<string, unknown>;

  return {
    id: num(top.id, "id"),
    label: typeof r.name === "string" ? r.name : "",
    tpsMedian: num(r.tps_median, "row.tps_median"),
    p50Ms: ms(r.p50_us, "row.p50_us"),
    p95Ms: ms(r.p95_us, "row.p95_us"),
    p99Ms: ms(r.p99_us, "row.p99_us"),
    failedTx: num(r.failed_tx, "row.failed_tx"),
    clients: num(r.clients, "row.clients"),
    timeS: num(r.time_s, "row.time_s"),
    protocol: String(r.protocol ?? ""),
    spreadPct: num(top.tpsSpreadPct ?? 0, "tpsSpreadPct"),
    tainted: r.tainted === true,
    clientLoadMax: num(r.client_load_max ?? 0, "row.client_load_max"),
    clientCores: num(r.client_cores ?? 0, "row.client_cores"),
    serverVersion: String(r.server_version ?? ""),
    pgbenchVersion: String(r.pgbench_version ?? ""),
  };
}

/**
 * Reasons this number may not mean what it appears to. Reported next to the
 * number rather than as a footnote: a tainted run measured the client.
 */
export function benchCaveats(s: BenchSummary): string[] {
  const out: string[] = [];
  if (s.tainted)
    out.push(
      `client load peaked at ${s.clientLoadMax} on ${s.clientCores} cores - the CLIENT may be the bottleneck`,
    );
  if (s.spreadPct > 15) out.push(`tps spread ${s.spreadPct}% across runs - unstable`);
  return out;
}

/** Signed percentage difference against a baseline tps. */
export function throughputDelta(baselineTps: number | null, tps: number): string {
  if (!baselineTps) return "n/a";
  const pct = ((tps - baselineTps) / baselineTps) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export function benchMeasurements(
  s: BenchSummary,
  baselineTps: number | null,
): Record<string, number | string> {
  return {
    tps_median: s.tpsMedian,
    vs_baseline: throughputDelta(baselineTps, s.tpsMedian),
    p50_ms: s.p50Ms,
    p95_ms: s.p95Ms,
    p99_ms: s.p99Ms,
    failed_tx: s.failedTx,
    clients: s.clients,
    protocol: s.protocol,
    tps_spread_pct: s.spreadPct,
    sbperf_run_id: s.id,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test harness/src/sbperf.test.ts`
Expected: `11 pass, 0 fail, 24 expect() calls`.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `bun run test && bun run typecheck`
Expected: 62 pass / 0 fail (27 baseline + 4 from the downtime plan's Task 1 + 20 + 11), and
typecheck exit 0.

---

### Task 3: the nine feature probes

**Files:**
- Create: `experiments/pooler-semantics/lib/features.ts`

Nine probes, and the reason for each:

| Probe | What it asks | How the failure presents |
| --- | --- | --- |
| `pid_stable` | Does `pg_backend_pid()` change between two consecutive statements? | The MECHANISM behind every row below. If it changes, nothing session-scoped can survive. |
| `prepared_first` | t02's exact probe: one named statement, prepared and executed in one call. | Reproduces the standing finding rather than replacing it. |
| `prepared_reuse` | Does the prepared statement survive to a LATER call? | `prepared statement "..." does not exist`. This is what an ORM does. |
| `advisory_lock` | Is a session advisory lock still held by the next statement? | SILENT: `pg_advisory_unlock` returns false, raises nothing. |
| `listen_notify` | Does a LISTEN registration survive to the NOTIFY? | No delivery within the wait; no error at all. |
| `session_guc` | Does a `SET` persist across statements? | `unrecognized configuration parameter "my.pvlab_probe"`. |
| `cursor_with_hold` | Does a WITH HOLD cursor survive to the FETCH? | `cursor "..." does not exist`. |
| `temp_table` | Does a temp table survive to the INSERT? | `relation "..." does not exist`. |
| `explicit_txn` | Does the pool PIN the connection for an explicit transaction? | Backend changes mid-transaction. Outranks every other row: no multi-statement write is safe. |

`cursor_with_hold` uses WITH HOLD because Postgres itself rejects a plain `DECLARE` outside
a transaction block. Whether WITH HOLD works outside one is answered by the CONTROL row, not
asserted here - that is what the control is for.

- [ ] **Step 1: Write the probes**

Create `experiments/pooler-semantics/lib/features.ts`:

```ts
/**
 * The feature probes, one closure each, run against ONE already-connected
 * client. Which connection mode that client is on is the caller's business -
 * that is what makes this a matrix rather than seven near-identical tests.
 *
 * Every probe is written so its failure carries the SERVER's wording. A reader
 * planning a migration wants to know that their app will see
 * `prepared statement "s1" does not exist`, not that "prepared statements are
 * unsupported" - the first is greppable in their logs, the second is not.
 *
 * Transport is `pg`'s Client, the same one t02-connectivity.ts uses. There is
 * no Bun.SQL in this repo.
 */
import type { Client, Notification } from "pg";
import { FeatureFailure, type Feature } from "../../../harness/src/matrix";

/** How long a self-NOTIFY is given to come back. Chosen, not measured. */
const NOTIFY_WAIT_MS = 3000;

async function backendPid(client: Client): Promise<number> {
  const r = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  const row = r.rows[0];
  if (!row) throw new FeatureFailure("pg_backend_pid() returned no row");
  return Number(row.pid);
}

/**
 * `tag` must be identifier-safe: it is interpolated into DECLARE / LISTEN /
 * CREATE TEMP TABLE, none of which take parameters. `advisoryKey` is
 * per-RUN, not per-mode: in transaction mode the unlock lands on a different
 * backend than the lock, so the lock LEAKS until that backend is recycled. A
 * fresh key each run is what stops a leaked lock from wedging the next one.
 */
export function featuresFor(client: Client, tag: string, advisoryKey: number): Feature[] {
  const stmt = `pvlab_ps_${tag}`;
  const chan = `pvlab_ch_${tag}`;
  const cursor = `pvlab_cur_${tag}`;
  const temp = `pvlab_tmp_${tag}`;

  return [
    {
      // The mechanism behind every row below. If the backend changes between
      // two statements, nothing session-scoped can survive, and the specific
      // failures become predictions rather than surprises.
      name: "pid_stable",
      async run() {
        const a = await backendPid(client);
        const b = await backendPid(client);
        if (a !== b)
          throw new FeatureFailure(
            `backend changed between two consecutive statements: pid ${a} -> ${b}`,
          );
        return `pid ${a}`;
      },
    },
    {
      // Exactly t02-connectivity.ts's probe: ONE named statement, prepared and
      // executed in a single call. AGENTS.md records this working on 6543.
      name: "prepared_first",
      async run() {
        await client.query({ name: stmt, text: "select 1 as one" });
      },
    },
    {
      // The stronger question t02 did not ask: does the PREPARED statement
      // survive to a later call? node-postgres caches the name per connection
      // and sends Bind/Execute with no Parse the second time, which is how a
      // real client behaves and where a transaction pooler breaks.
      name: "prepared_reuse",
      async run() {
        await client.query("select 1");
        await client.query({ name: stmt, text: "select 1 as one" });
        return "bind/execute with no re-parse";
      },
    },
    {
      name: "advisory_lock",
      async run() {
        await client.query("select pg_advisory_lock($1::bigint)", [advisoryKey]);
        try {
          const r = await client.query<{ released: boolean }>(
            "select pg_advisory_unlock($1::bigint) as released",
            [advisoryKey],
          );
          const row = r.rows[0];
          if (!row) throw new FeatureFailure("pg_advisory_unlock returned no row");
          if (row.released !== true)
            // Postgres RAISES NOTHING here - it returns false and logs a
            // warning. Without FeatureFailure this reads as a pass.
            throw new FeatureFailure(
              `pg_advisory_unlock returned ${row.released}: the session lock was not held by the backend that ran the second statement (lock leaked until that backend is recycled)`,
            );
        } finally {
          await client.query("select pg_advisory_unlock_all()").catch(() => {});
        }
      },
    },
    {
      name: "listen_notify",
      async run() {
        let deliver: () => void = () => {};
        const delivered = new Promise<"delivered">((res) => {
          deliver = () => res("delivered");
        });
        const handler = (msg: Notification) => {
          if (msg.channel === chan) deliver();
        };
        client.on("notification", handler);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await client.query(`listen ${chan}`);
          await client.query(`notify ${chan}, 'pvlab'`);
          const timeout = new Promise<"timeout">((res) => {
            timer = setTimeout(() => res("timeout"), NOTIFY_WAIT_MS);
          });
          if ((await Promise.race([delivered, timeout])) === "timeout")
            throw new FeatureFailure(
              `no NOTIFY delivered within ${NOTIFY_WAIT_MS}ms - the LISTEN registration did not survive to the next statement`,
            );
        } finally {
          if (timer) clearTimeout(timer);
          client.removeListener("notification", handler);
          await client.query(`unlisten ${chan}`).catch(() => {});
        }
      },
    },
    {
      name: "session_guc",
      async run() {
        await client.query("set my.pvlab_probe = 'v1'");
        // current_setting RAISES on an unknown parameter, so a reset session
        // gives `unrecognized configuration parameter "my.pvlab_probe"` -
        // precisely the string an application would see.
        const r = await client.query<{ v: string }>(
          "select current_setting('my.pvlab_probe') as v",
        );
        const row = r.rows[0];
        if (!row) throw new FeatureFailure("current_setting returned no row");
        if (row.v !== "v1") throw new FeatureFailure(`GUC read back as "${row.v}", expected "v1"`);
      },
    },
    {
      // WITH HOLD because a plain DECLARE outside a transaction block is
      // rejected by Postgres itself. Whether WITH HOLD works outside one is
      // answered by the control row, not asserted here.
      name: "cursor_with_hold",
      async run() {
        await client.query(`declare ${cursor} cursor with hold for select generate_series(1,3)`);
        try {
          const r = await client.query(`fetch all from ${cursor}`);
          if (r.rowCount !== 3)
            throw new FeatureFailure(`fetch all returned ${r.rowCount} rows, expected 3`);
        } finally {
          await client.query(`close ${cursor}`).catch(() => {});
        }
      },
    },
    {
      name: "temp_table",
      async run() {
        await client.query(`create temp table ${temp}(i int)`);
        try {
          await client.query(`insert into ${temp} values (1)`);
          const r = await client.query<{ n: number }>(`select count(*)::int as n from ${temp}`);
          const row = r.rows[0];
          if (!row) throw new FeatureFailure("count returned no row");
          if (row.n !== 1) throw new FeatureFailure(`temp table held ${row.n} rows, expected 1`);
        } finally {
          await client.query(`drop table if exists ${temp}`).catch(() => {});
        }
      },
    },
    {
      // A transaction pooler is expected to PIN the connection for the length
      // of an explicit transaction. If it does not, no multi-statement write
      // is safe on that path, which outranks every other row here.
      name: "explicit_txn",
      async run() {
        await client.query("begin");
        try {
          const a = await backendPid(client);
          const b = await backendPid(client);
          if (a !== b)
            throw new FeatureFailure(
              `backend changed INSIDE an explicit transaction: pid ${a} -> ${b}`,
            );
          await client.query("commit");
          return `pinned to pid ${a}`;
        } catch (e) {
          await client.query("rollback").catch(() => {});
          throw e;
        }
      },
    },
  ];
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

`harness/tsconfig.json` includes `src` and `../experiments/*/tests`, but NOT
`../experiments/*/lib`. This file is therefore checked transitively, as a dependency of the
test module in Task 4 - the same arrangement `tenant-consolidation/lib` and
`tenant-promotion/lib` already have. Until Task 4 imports it, it is not checked at all, so
do not read a green typecheck here as coverage.

---

### Task 4: S01 - the feature matrix

**Files:**
- Create: `experiments/pooler-semantics/tests/s01-feature-matrix.ts`

- [ ] **Step 1: Write the module**

Create `experiments/pooler-semantics/tests/s01-feature-matrix.ts`:

```ts
/**
 * S01 - which Postgres features survive each connection mode.
 *
 * One row per mode, one measurement per feature, so the report's Measurements
 * table IS the matrix a reader uses to predict what a migration costs them.
 * The Evidence section carries every server error verbatim.
 *
 * The direct 5432 row is the CONTROL and the only one that asserts. A feature
 * that fails there means the probe is wrong; a feature that fails only on a
 * pooled row is the finding. Without the control, "cursors do not work on
 * 6543" cannot be distinguished from "the cursor probe is broken".
 *
 * Reachability caveat: the direct endpoint is IPv6-only (AGENTS.md,
 * privatelink-aws T18). From an IPv4-only vantage the control row skips with
 * the connect error and the pooled rows lose their reference - that is
 * reported, never silently absorbed.
 */
import { Client } from "pg";
import {
  regressionVerdict,
  parseTarget,
  renderEvidence,
  runFeatures,
  summariseRow,
  toMeasurements,
  type FeatureOutcome,
  type Target,
} from "../../../harness/src/matrix";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { featuresFor } from "../lib/features";

const CONNECT_TIMEOUT_MS = 10_000;
/** Bounds one measurement cell. The full text always lands in `evidence`. */
const CELL_MAX = 110;

/**
 * Supavisor tenant-username shape. UNVERIFIED here on purpose - Task 7 Step 2
 * reads it off the live project and passes it as PVLAB_ENDPOINT_POOLER_USER.
 */
const poolerUser = (ctx: Ctx) => ctx.endpoints.pooler_user ?? `postgres.${ctx.ref}`;

interface ModeSpec {
  id: string;
  label: string;
  /** ctx.endpoints key; null means the direct host derived from the ref. */
  endpointKey: string | null;
  defaultPort: number;
  user: (ctx: Ctx) => string;
  control: boolean;
}

const MODES: ModeSpec[] = [
  {
    id: "S01a",
    label: "direct 5432 (session, no pooler)",
    endpointKey: null,
    defaultPort: 5432,
    user: () => "postgres",
    control: true,
  },
  {
    id: "S01b",
    label: "pooler session mode",
    endpointKey: "pooler_session",
    defaultPort: 5432,
    user: poolerUser,
    control: false,
  },
  {
    id: "S01c",
    label: "pooler transaction mode",
    endpointKey: "pooler_txn",
    defaultPort: 6543,
    user: poolerUser,
    control: false,
  },
  {
    id: "S01d",
    label: "public shared pooler, transaction mode",
    endpointKey: "shared_txn",
    defaultPort: 6543,
    user: poolerUser,
    control: false,
  },
];

function tagOf(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

async function probeMode(
  ctx: Ctx,
  spec: ModeSpec,
  target: Target,
  advisoryKey: number,
): Promise<{ result: TestResult; outcomes: FeatureOutcome[] }> {
  const user = spec.user(ctx);
  const client = new Client({
    host: target.host,
    port: target.port,
    user,
    database: "postgres",
    password: ctx.dbPassword,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });

  try {
    await client.connect();
  } catch (e) {
    await client.end().catch(() => {});
    return {
      outcomes: [],
      result: {
        id: spec.id,
        title: spec.label,
        status: "skip",
        detail: `could not connect to ${target.host}:${target.port} as ${user}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        measurements: { mode: spec.label, host_port: `${target.host}:${target.port}` },
      },
    };
  }

  try {
    const outcomes = await runFeatures(featuresFor(client, tagOf(spec.id), advisoryKey));
    const { status, detail } = summariseRow(outcomes, { control: spec.control });
    return {
      outcomes,
      result: {
        id: spec.id,
        title: spec.label,
        status,
        detail,
        measurements: {
          mode: spec.label,
          host_port: `${target.host}:${target.port}`,
          ...toMeasurements(outcomes, CELL_MAX),
        },
        evidence: renderEvidence(outcomes),
      },
    };
  } finally {
    await client.end().catch(() => {});
  }
}

const mod: TestModule = {
  id: "S01",
  title: "Pooler feature matrix: what breaks in each connection mode",
  where: "local",
  requires: ["db"],
  async run(ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    let txnOutcomes: FeatureOutcome[] = [];
    // Per-run key: in transaction mode the lock leaks onto whichever backend
    // took it, so reusing a constant would eventually block a later run.
    const advisoryKey = Date.now() % 2_000_000_000;

    for (const spec of MODES) {
      const raw = spec.endpointKey === null ? ctx.phzHost : ctx.endpoints[spec.endpointKey];
      let target: Target | null;
      try {
        target = parseTarget(raw, spec.defaultPort);
      } catch (e) {
        results.push({
          id: spec.id,
          title: spec.label,
          status: "fail",
          detail: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      if (!target) {
        results.push({
          id: spec.id,
          title: spec.label,
          status: "skip",
          detail: `no PVLAB_ENDPOINT_${spec.endpointKey?.toUpperCase()} supplied - see the Makefile's pooler-config target`,
        });
        continue;
      }

      ctx.log(`${spec.id} ${spec.label} -> ${target.host}:${target.port}`);
      const { result, outcomes } = await probeMode(ctx, spec, target, advisoryKey);
      results.push(result);
      if (spec.id === "S01c") txnOutcomes = outcomes;
    }

    // The pin. AGENTS.md and privatelink-aws T11 record server-side prepared
    // statements MEASURED ok on 6543, against the widely repeated rule that
    // transaction mode forbids them. Re-measured every run so a platform
    // change lands as one loud fail rather than one quiet cell.
    const first = txnOutcomes.find((o) => o.name === "prepared_first");
    const prior = { label: "T11 / AGENTS.md (prepared statements ok on 6543)", ok: true };
    const verdict = regressionVerdict(first, prior);
    results.push({
      id: "S01e",
      title: "Prepared statements on the dedicated pooler, re-measured against the recorded result",
      status: verdict.status,
      detail: verdict.detail,
      measurements: {
        prior_result: "ok (T11)",
        this_run: first ? (first.ok ? "ok" : `failed: ${first.error.slice(0, CELL_MAX)}`) : "n/a",
      },
    });

    return results;
  },
};
export default mod;
```

- [ ] **Step 2: Typecheck and register**

Run: `bun run typecheck && cd harness && bun run build && ./dist/pvlab --list | grep S01`
Expected: exit 0, then
```
  S01    local              db  Pooler feature matrix: what breaks in each connection mode
```
`gen-registry.ts` scans `experiments/*/tests` with no argument, so nothing needs wiring.
Never hand-edit `src/tests.generated.ts`.

- [ ] **Step 3: Prove it degrades instead of throwing, with no project in existence**

Run from `harness/`:
```bash
PVLAB_REF=abcdefghijklmnopqrst DB_PASSWORD=fake \
PVLAB_ENDPOINT_POOLER=pooler.invalid \
PVLAB_ENDPOINT_POOLER_TXN=pooler.invalid:banana \
./dist/pvlab --where local --experiment pooler-semantics --only S01 --out /tmp/s01-smoke
```
Expected, measured on 2026-08-04:
```
  S01a direct 5432 (session, no pooler) -> db.abcdefghijklmnopqrst.supabase.co:5432
  -> skip: could not connect to db.abcdefghijklmnopqrst.supabase.co:5432 as postgres: getaddrinfo ENOTFOUND
  -> skip: no PVLAB_ENDPOINT_POOLER_SESSION supplied - see the Makefile's pooler-config target
  -> fail: not a port in endpoint "pooler.invalid:banana": banana
  -> skip: no PVLAB_ENDPOINT_SHARED_TXN supplied - see the Makefile's pooler-config target
  -> skip: mode not probed - nothing to compare against T11 / AGENTS.md (prepared statements ok on 6543)
```
All four degradation paths in one run: unreachable host, absent endpoint, malformed
endpoint, and a pin with nothing to compare. If any of these throws instead, the module
will lose a whole run's results to one bad environment variable.

---

### Task 5: S02 - throughput via `sbperf bench`

**Files:**
- Create: `experiments/pooler-semantics/tests/s02-throughput.ts`

Marked `destructive: true`. It puts the project under sustained load for minutes and reads
`pgbench_*` tables that `make bench-init` created by dropping whatever was there. It also
sorts after S01 in the destructive tier, which is the order the findings need: the feature
matrix explains the throughput numbers, not the other way round.

Wall clock at the defaults: three targets times (10 s warmup + 3 x 60 s) is about ten and a
half minutes, plus connect preflight.

- [ ] **Step 1: Write the module**

Create `experiments/pooler-semantics/tests/s02-throughput.ts`:

```ts
/**
 * S02 - throughput on identical hardware: direct 5432 vs the dedicated pooler
 * on 6543 vs the public shared pooler.
 *
 * DESTRUCTIVE: sustained load for minutes, against pgbench_* tables that
 * `make bench-init` created by dropping whatever was there.
 *
 * The benchmark is NOT implemented here. `sbperf bench` already carries the
 * methodology - it refuses to run on a saturated client, warms up before N
 * measured repetitions, takes percentiles from pgbench's -l transaction log
 * instead of the rounded stdout line, snapshots pg_settings per run so two
 * numbers can be shown to come from the same server configuration, and keeps a
 * run history that `sbperf bench --compare <a> <b>` reads. This module picks
 * the targets, shells out once per target, and flattens the result.
 *
 * Every row runs the SAME script at the SAME client count against the SAME
 * project. The only variable is the path.
 */
import { $ } from "bun";
import { Client } from "pg";
import { benchCaveats, benchMeasurements, parseBenchJson } from "../../../harness/src/sbperf";
import { parseTarget, type Target } from "../../../harness/src/matrix";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const BUILTIN = process.env.PVLAB_BENCH_BUILTIN ?? "select-only";
const CLIENTS = Number(process.env.PVLAB_BENCH_CLIENTS ?? 8);
const TIME_S = Number(process.env.PVLAB_BENCH_TIME_S ?? 60);
const RUNS = Number(process.env.PVLAB_BENCH_RUNS ?? 3);
const WARMUP_S = Number(process.env.PVLAB_BENCH_WARMUP_S ?? 10);
/**
 * Also bench the transaction pooler with pgbench's PREPARED protocol, which is
 * the throughput consequence of S01's prepared_reuse column. Off by default:
 * it adds one full target's wall clock.
 */
const ALSO_PREPARED = process.env.PVLAB_BENCH_PREPARED === "1";
const CONNECT_TIMEOUT_MS = 10_000;

const poolerUser = (ctx: Ctx) => ctx.endpoints.pooler_user ?? `postgres.${ctx.ref}`;

interface BenchTarget {
  id: string;
  label: string;
  endpointKey: string | null;
  defaultPort: number;
  user: (ctx: Ctx) => string;
  protocol: string;
}

const TARGETS: BenchTarget[] = [
  {
    id: "S02a",
    label: "direct-5432",
    endpointKey: null,
    defaultPort: 5432,
    user: () => "postgres",
    protocol: "extended",
  },
  {
    id: "S02b",
    label: "dedicated-pooler-6543",
    endpointKey: "pooler_txn",
    defaultPort: 6543,
    user: poolerUser,
    protocol: "extended",
  },
  {
    id: "S02c",
    label: "shared-pooler-6543",
    endpointKey: "shared_txn",
    defaultPort: 6543,
    user: poolerUser,
    protocol: "extended",
  },
];

function connString(target: Target, user: string, password: string): string {
  // sbperf splits this with `new URL()`, so both parts must be encoded: a
  // pooler username contains a dot and a generated password can contain
  // anything.
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${target.host}:${target.port}/postgres`;
}

/** Connect once before spending a benchmark's wall clock on an unreachable path. */
async function reachable(
  ctx: Ctx,
  target: Target,
  user: string,
): Promise<{ ok: true; hasPgbenchTables: boolean } | { ok: false; error: string }> {
  const client = new Client({
    host: target.host,
    port: target.port,
    user,
    database: "postgres",
    password: ctx.dbPassword,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const r = await client.query<{ t: string | null }>(
      "select to_regclass('public.pgbench_accounts')::text as t",
    );
    return { ok: true, hasPgbenchTables: Boolean(r.rows[0]?.t) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.end().catch(() => {});
  }
}

const mod: TestModule = {
  id: "S02",
  title: "Throughput: direct 5432 vs dedicated pooler vs public shared pooler",
  where: "local",
  requires: ["db", "pgbench"],
  destructive: true,
  async run(ctx): Promise<TestResult[]> {
    const bin = process.env.PVLAB_SBPERF ?? Bun.which("sbperf");
    if (!bin)
      return [
        {
          id: "S02",
          title: mod.title,
          status: "skip",
          detail:
            "sbperf not on PATH - install it or set PVLAB_SBPERF=/path/to/sbperf. This module deliberately does not hand-roll a benchmark.",
        },
      ];

    const plan = [...TARGETS];
    if (ALSO_PREPARED) {
      const txn = TARGETS.find((t) => t.id === "S02b");
      if (txn) plan.push({ ...txn, id: "S02d", label: "dedicated-pooler-6543-prepared", protocol: "prepared" });
    }

    const results: TestResult[] = [];
    let baselineTps: number | null = null;

    for (const t of plan) {
      const raw = t.endpointKey === null ? ctx.phzHost : ctx.endpoints[t.endpointKey];
      let target: Target | null;
      try {
        target = parseTarget(raw, t.defaultPort);
      } catch (e) {
        results.push({
          id: t.id,
          title: t.label,
          status: "fail",
          detail: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      if (!target) {
        results.push({
          id: t.id,
          title: t.label,
          status: "skip",
          detail: `no PVLAB_ENDPOINT_${t.endpointKey?.toUpperCase()} supplied`,
        });
        continue;
      }

      const user = t.user(ctx);
      const pre = await reachable(ctx, target, user);
      if (!pre.ok) {
        results.push({
          id: t.id,
          title: t.label,
          status: "skip",
          detail: `unreachable from this vantage (${target.host}:${target.port} as ${user}): ${pre.error}`,
          measurements: { path: t.label },
        });
        continue;
      }
      if (!pre.hasPgbenchTables) {
        results.push({
          id: t.id,
          title: t.label,
          status: "skip",
          detail: "no pgbench_accounts table - run 'make bench-init' once before benching",
          measurements: { path: t.label },
        });
        continue;
      }

      ctx.log(`${t.id} ${t.label}: ${RUNS}x${TIME_S}s + ${WARMUP_S}s warmup, ${CLIENTS} clients`);
      const url = connString(target, user, ctx.dbPassword);
      const args = [
        "bench",
        "--db-url", url,
        "--ref", ctx.ref,
        "--builtin", BUILTIN,
        "--clients", String(CLIENTS),
        "--time", String(TIME_S),
        "--runs", String(RUNS),
        "--warmup", String(WARMUP_S),
        "--protocol", t.protocol,
        "--name", `${ctx.ref}-${t.label}`,
        "--json",
      ];
      if (process.env.PVLAB_BENCH_STORE) args.push("--store", process.env.PVLAB_BENCH_STORE);

      // sbperf spawns pgbench with `{...process.env, PGPASSWORD}`, so PGSSLMODE
      // set here reaches pgbench. --yes is deliberately NOT passed: it would
      // disable the busy-client refusal, which is one of the guardrails this
      // module exists to inherit.
      const proc = await $`${bin} ${args}`
        .env({ ...process.env, PGSSLMODE: "require" })
        .quiet()
        .nothrow();
      const stdout = proc.stdout.toString();
      const stderr = proc.stderr.toString().trim();

      if (proc.exitCode !== 0) {
        results.push({
          id: t.id,
          title: t.label,
          status: "fail",
          detail: `sbperf bench exited ${proc.exitCode}: ${stderr.split("\n").at(-1) ?? "no stderr"}`,
          evidence: stderr,
          measurements: { path: t.label },
        });
        continue;
      }

      let summary: ReturnType<typeof parseBenchJson>;
      try {
        summary = parseBenchJson(stdout);
      } catch (e) {
        results.push({
          id: t.id,
          title: t.label,
          status: "fail",
          detail: e instanceof Error ? e.message : String(e),
          evidence: stderr,
          measurements: { path: t.label },
        });
        continue;
      }

      if (t.id === "S02a") baselineTps = summary.tpsMedian;
      const caveats = benchCaveats(summary);
      results.push({
        id: t.id,
        title: t.label,
        // info, not pass: a throughput number is a measurement, and slower is
        // not a defect. A caveated run is the exception - it may not be a
        // measurement of the database at all.
        status: caveats.length ? "fail" : "info",
        detail: caveats.length
          ? `result not usable: ${caveats.join("; ")}`
          : `${summary.tpsMedian} tps median over ${RUNS}x${TIME_S}s, p95 ${summary.p95Ms} ms`,
        measurements: { path: t.label, ...benchMeasurements(summary, baselineTps) },
        evidence: [
          `server ${summary.serverVersion}, pgbench ${summary.pgbenchVersion}`,
          `script ${BUILTIN}, protocol ${t.protocol}, clients ${CLIENTS}`,
          `sbperf run id ${summary.id} - 'sbperf bench --show ${summary.id}' for the pg_settings snapshot`,
          ...(stderr ? [stderr] : []),
        ].join("\n"),
      });
    }

    return results;
  },
};
export default mod;
```

Note `baselineTps` is assigned from S02a and read by every later row, so the direct path
MUST be first in `TARGETS`. If it skips, `vs_baseline` reads `n/a` on every row rather than
silently comparing against whatever ran first.

- [ ] **Step 2: Typecheck, build, and confirm the gate**

Run: `bun run typecheck && cd harness && bun run build && ./dist/pvlab --list | grep S02`
Expected: exit 0, then
```
  S02    local  destructive db,pgbench  Throughput: direct 5432 vs dedicated pooler vs public shared pooler
```
If the `pgbench` capability is absent on this machine, S02 will report
`skip: missing capability: pgbench` at run time - that is the gate working, and it is what
happened on 2026-08-04 before the client tools were installed.

- [ ] **Step 3: Prove the whole target loop degrades cleanly**

Run from `harness/`, with the client tools installed:
```bash
PVLAB_REF=abcdefghijklmnopqrst DB_PASSWORD=fake \
PVLAB_ENDPOINT_POOLER_TXN=pooler.invalid:6543 \
PVLAB_ENDPOINT_SHARED_TXN=shared.invalid:6543 \
PVLAB_ENDPOINT_POOLER_USER=postgres.abcdefghijklmnopqrst \
./dist/pvlab --where local --experiment pooler-semantics --only S02 --destructive --out /tmp/s02-smoke
```
Expected, measured on 2026-08-04:
```
pvlab: 1 to run, 0 skipped (vantage=local, capabilities=db,openssl,pat,pgbench,pooler)
  -> skip: unreachable from this vantage (db.abcdefghijklmnopqrst.supabase.co:5432 as postgres): getaddrinfo ENOTFOUND
  -> skip: unreachable from this vantage (pooler.invalid:6543 as postgres.abcdefghijklmnopqrst): getaddrinfo ENOTFOUND
  -> skip: unreachable from this vantage (shared.invalid:6543 as postgres.abcdefghijklmnopqrst): getaddrinfo ENOTFOUND
```
Every target preflighted and skipped without spending a benchmark's wall clock, which is the
point of `reachable()`.

- [ ] **Step 4: Prove the shell-out itself, without a database**

The riskiest line in the module is `$`${bin} ${args}`` - Bun interpolates the array as
separate arguments, and a mistake there produces one giant argv entry that `sbperf` rejects
with a usage dump.

**Do NOT try to reach the stub through the module.** `reachable()` preflights every target
with a real connection before shelling out, so with no database up, all three targets skip
and `sbperf` is never invoked - measured 2026-08-04, the stub below stayed untouched. That
preflight is correct and worth keeping; it means this step has to exercise the interpolation
in ISOLATION. Verified that way instead, with a password containing a space and a slash and
a username containing a dot:

```
ARGC=20
ARGV[1]=bench
ARGV[2]=--db-url
ARGV[3]=postgres://postgres.abcdefghijklmnopqrst:p%40ss%20w%2Ford@127.0.0.1:6543/postgres
```

Twenty separate entries, and the URL arrives as ONE argument with the credentials
percent-encoded, which is what sbperf's `new URL()` split requires. The stub's JSON then
parses through `parseBenchJson` to a tps figure, so the whole spawn-to-summary path is
covered without a database.

The stub, for reference:

```bash
mkdir -p /tmp/stubbin && cat > /tmp/stubbin/sbperf <<'EOF'
#!/bin/sh
echo "args: $*" >&2
echo '{"id":7,"row":{"name":"probe","tps_median":3810.42,"p50_us":2010,"p95_us":5400,"p99_us":11250,"failed_tx":0,"clients":8,"time_s":60,"protocol":"extended","client_cores":16,"client_load_max":3.2,"tainted":false,"unstable":false,"pgbench_version":"16.4","server_version":"15.8"},"tpsSpreadPct":0.6}'
EOF
chmod +x /tmp/stubbin/sbperf
```
Then re-run Step 3 with `PVLAB_SBPERF=/tmp/stubbin/sbperf` and a reachable target, or check
the interpolation directly with a five-line script that calls
`$`${bin} ${args}`.env({...process.env, PGSSLMODE:"require"}).quiet().nothrow()` and prints
`proc.stderr.toString()`. Expected on 2026-08-04: every flag arrives as its own argv entry
and the percent-encoded connstring survives intact -
```
args: bench --db-url postgres://u%2Ea:p%40ss@h:6543/postgres --ref abcdefghijklmnopqrst --builtin select-only --clients 8 --time 60 --runs 3 --warmup 10 --protocol extended --name abc-direct-5432 --json
```
Delete `/tmp/stubbin` afterwards so a stub can never shadow the real binary.

---

### Task 6: experiment scaffold

**Files:**
- Create: `experiments/pooler-semantics/{providers.tf,variables.tf,supabase.tf,outputs.tf,experiment.tfvars}`

- [ ] **Step 1: Copy the smallest existing experiment**

Run:
```bash
cd ~/supabase-lab
mkdir -p experiments/pooler-semantics/{tests,lib}
cp experiments/platform-facts/{providers.tf,variables.tf,supabase.tf,outputs.tf,experiment.tfvars,.terraform.lock.hcl} \
   experiments/pooler-semantics/
```
Expected: six files present. `platform-facts` is the right donor - one project, no AWS. The
lock file is copied deliberately: it is committed in this repo, and copying it pins the new
experiment to the provider versions the donor was validated against instead of resolving
fresh ones on `tofu init`.

- [ ] **Step 2: Rewrite the header comment**

Run: `sed -n '1,200p' experiments/pooler-semantics/supabase.tf`
Expected: you can name every resource. The donor's header describes harvesting platform
constants, which is not what this directory does. Replace the comment, keep the resource:

```hcl
# One project, probed over every connection path it exposes.
#
# The question is not whether the project works - it is which Postgres
# features survive each pooler mode, and what throughput each path sustains
# on identical hardware. Both are properties of the connection path, so one
# project is enough and a second would only add variance.
#
# Micro on purpose. The comparison is between paths to the SAME server; a
# larger instance moves every row by the same amount and costs more.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
```

- [ ] **Step 3: Rename the project in BOTH places**

Run: `grep -rn 'lab-platform-facts' experiments/pooler-semantics/`
Expected: two hits, not one - `experiment.tfvars` AND the `project_name` default in
`variables.tf`. Change both to `lab-pooler-semantics`:

```bash
cd experiments/pooler-semantics
sd 'project_name  = "lab-platform-facts"' 'project_name  = "lab-pooler-semantics"' experiment.tfvars
sd 'default = "lab-platform-facts"' 'default = "lab-pooler-semantics"' variables.tf
grep -rn 'lab-' experiment.tfvars variables.tf
```
Expected: no `lab-platform-facts` remains. Two projects with the same name in one org is a
self-inflicted wound the first time you go looking for the right one in the dashboard, and
the `variables.tf` default is the copy that bites later, when someone applies without
`-var-file=experiment.tfvars`.

Leave `region` and `instance_size` alone. Micro is right, and the region matters only
because it determines the pooler hostname, which Task 7 reads rather than constructs.

- [ ] **Step 4: Confirm the outputs, do not re-add them**

Run: `cat experiments/pooler-semantics/outputs.tf`
Expected: `project_ref` and `api_host` are ALREADY there, keyed off `supabase_project.probe.id`.
The resource is named `probe`, not `this`; keep the donor's name so the outputs keep
resolving. Nothing to add in this step.

Do NOT hand-construct a pooler hostname in the tf. It is region-dependent and its shape is
not something to guess - Task 7 reads it from the live project.

- [ ] **Step 5: Validate the copy before spending anything**

Run:
```bash
cd experiments/pooler-semantics
ls *.tf                      # MUST list providers/variables/supabase/outputs
tofu init -backend=false
tofu validate
tofu fmt -check -diff .
```
Expected: four `.tf` files, then `Success! The configuration is valid.`, then no diff.

The `ls` is not padding. `tofu validate` returns **Success on an empty directory** - the
exemplar plan's dry run hit exactly that when a blocked `cp` left the directory empty and
validate reported green anyway. Confirm the files exist, then trust the validate.

---

### Task 7: Makefile

**Files:**
- Create: `experiments/pooler-semantics/Makefile`

- [ ] **Step 1: Copy the donor and read it**

Run:
```bash
cp experiments/platform-facts/Makefile experiments/pooler-semantics/Makefile
sed -n '1,60p' experiments/pooler-semantics/Makefile
```
Expected: you can name every variable. `ROOT`, `VARS`, `TOK`, `TS` and the `bun run build`
step carry over unchanged. The `DBPW` line is not in this donor - copy it from
`experiments/http-tier-lockdown/Makefile`, where it already exists:
```make
DBPW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
```

- [ ] **Step 2: Prove to yourself why `--only` is MANDATORY here**

`--experiment` is a LABEL for the report title, NOT a filter. One registry carries every
experiment's tests and `planRun` filters only on `where`, `capabilities`, `only` and
`allowDestructive`. Do not take that on trust - `planRun` is pure, so ask it directly.
From `harness/`, after `bun run build`:

```ts
// prove-only.ts - delete after running
import { planRun } from "./src/plan";
import { tests } from "./src/tests.generated"; // note: lowercase `tests`
import type { Capability } from "./src/types";

// Exactly what this experiment's Makefile produces: DB_PASSWORD + PVLAB_REF
// give `db`, the PAT gives `pat`, PVLAB_ENDPOINT_POOLER gives `pooler`,
// pgbench/openssl are probed off PATH. No peers, no org slugs, no anon key.
const caps = new Set<Capability>(["db", "pat", "pooler", "pgbench", "openssl"]);
for (const only of [undefined, ["S01", "S02"]]) {
  const { run } = planRun(tests, { where: "local", capabilities: caps, only, allowDestructive: true });
  console.log(
    `--only ${only ? only.join(",") : "(ABSENT)"} -> ${run.map((m) => `${m.id}${m.destructive ? "*" : ""}`).join(", ")}`,
  );
}
```

Run: `bun ./prove-only.ts && rm prove-only.ts`
Expected, measured on 2026-08-04:

```
--only (ABSENT) -> F02, F03, S01, C05*, S02*, V04*
--only S01,S02 -> S01, S02*
```

**C05 and V04 are destructive, need nothing this run does not already supply, and belong to
other experiments.** Without `--only` they run against this project - C05 mutates a merged
users table, V04 deletes a project. Add `peer` to that capability set (a leftover
`PVLAB_PEER_*` in the shell is enough) and the unfiltered list grows to 19 modules
including all of C01-C04, P01-P04 and X01-X02. Never omit `--only`.

Also confirmed: destructive mode is the `--destructive` flag (`flag("destructive")` in
`run.ts`), not an environment variable.

- [ ] **Step 3: Fix the inherited `REF` derivation before anything else**

The donor has:

```make
REF := $(shell tofu output -raw project_ref 2>/dev/null)
```

With no state, `tofu output -raw` puts its `Warning: No outputs found` block on **stdout**,
so `REF` is a non-empty blob of box-drawing characters: the `test -n "$(REF)"` guard passes,
and the run dies later with `/bin/sh: line 1: output: command not found`. Re-measured on
2026-08-04 in this directory. Harden it, and leave the donor alone - fixing it there is a
separate change:

```make
# A project ref is 20 lowercase letters. Filtering on that shape is what makes
# the `test -n` guard below actually fire: with no state, `tofu output -raw`
# prints its "No outputs found" warning to STDOUT, which is not empty.
REF := $(shell tofu output -raw project_ref 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)
```

- [ ] **Step 4: Write the endpoint variables and the targets**

```make
# Connection endpoints, all discovered by `make pooler-config` and passed in
# rather than constructed here. The pooler hostname is region-dependent and the
# mode-to-port mapping is a platform fact, not something to hard-code in a
# Makefile that then reports it as measured.
#
#   POOLER          bare hostname; lights up the `pooler` capability
#   POOLER_SESSION  host[:port] for session mode
#   POOLER_TXN      host[:port] for transaction mode
#   SHARED_TXN      host[:port] for the PUBLIC shared pooler, transaction mode
#   POOLER_USER     Supavisor tenant username
POOLER ?=
POOLER_SESSION ?=
POOLER_TXN ?=
SHARED_TXN ?=
POOLER_USER ?=

RUNNER_FLAGS ?=
# MANDATORY. --experiment only labels the report; the registry is shared, so
# without --only a destructive run reaches other experiments' destructive
# tests. Measured on 2026-08-04 with this experiment's own capability set
# (db,pat,pooler,pgbench,openssl): C05 and V04 join the run.
ONLY ?= S01,S02

BENCH_SCALE ?= 1
# Session mode on purpose: pgbench -i uses COPY plus several statements, which
# is not a transaction-mode workload.
BENCH_INIT_URL ?= postgres://$(POOLER_USER):$(DBPW)@$(POOLER_SESSION)/postgres

.PHONY: init fmt validate apply pooler-config bench-init probe probe-destructive destroy

# Read the connection surface off the live project instead of guessing it.
# Record every value in RUNLOG.md, then pass them to probe/probe-destructive.
pooler-config:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@echo "== /v1/projects/$(REF)/config/database/pooler =="
	@curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/config/database/pooler" | jq . || true
	@echo "== /v1/projects/$(REF) =="
	@curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)" | jq '{region, database}' || true

# One-time, and it DROPS any existing pgbench_* tables in the database.
# Separate target so it can never happen as a side effect of a measurement.
bench-init:
	@test -n "$(POOLER_SESSION)" || (echo "set POOLER_SESSION=host[:port] - see 'make pooler-config'"; exit 1)
	@test -n "$(POOLER_USER)" || (echo "set POOLER_USER=<tenant username> - see 'make pooler-config'"; exit 1)
	@test -n "$(DBPW)" || (echo "no db_password in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@echo "pgbench -i -s $(BENCH_SCALE) DROPS and recreates pgbench_* on $(POOLER_SESSION). Ctrl-C within 5s to abort."
	@sleep 5
	PGSSLMODE=require pgbench -i -s $(BENCH_SCALE) "$(BENCH_INIT_URL)"

probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@test -n "$(DBPW)" || (echo "no db_password in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@test -n "$(ONLY)" || (echo "refusing to run with an empty ONLY - see the comment above"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(REF)" DB_PASSWORD="$(DBPW)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		PVLAB_ENDPOINT_POOLER="$(POOLER)" \
		PVLAB_ENDPOINT_POOLER_SESSION="$(POOLER_SESSION)" \
		PVLAB_ENDPOINT_POOLER_TXN="$(POOLER_TXN)" \
		PVLAB_ENDPOINT_SHARED_TXN="$(SHARED_TXN)" \
		PVLAB_ENDPOINT_POOLER_USER="$(POOLER_USER)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment pooler-semantics \
		--only $(ONLY) $(RUNNER_FLAGS) --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# S02 puts the project under sustained load for minutes and reads pgbench_*
# tables that bench-init created destructively. Separate target so a bare
# `make probe` only ever collects the feature matrix.
probe-destructive:
	@test -n "$(POOLER_TXN)" || echo "note: POOLER_TXN empty - the transaction-mode rows will self-skip"
	@$(MAKE) probe RUNNER_FLAGS=--destructive
```

Keep the donor's `init`, `fmt`, `validate`, `apply` and `destroy` targets as they are.
`DB_PASSWORD` is exported here and nowhere else in the donor - `buildCtx` reads it from the
environment and without it the `db` capability never derives, so BOTH modules skip.

- [ ] **Step 5: Verify each guard fires before verifying anything else**

Run, in this order:
```bash
cd experiments/pooler-semantics
make probe                                                  # no state yet
make probe ONLY= REF=abcdefghijklmnopqrst TOK=x DBPW=y      # ONLY guard
make bench-init                                             # endpoint guard
```
Expected, measured on 2026-08-04:
```
no project_ref output - run 'make apply' first
refusing to run with an empty ONLY - see the comment above
set POOLER_SESSION=host[:port] - see 'make pooler-config'
```
each with exit status 2 from make. If the first one instead prints
`/bin/sh: line 1: output: command not found`, the hardened `REF` line from Step 3 is not in
place and the guard is being satisfied by tofu's warning text.

The second command supplies `REF`, `TOK` and `DBPW` on the command line because the guards
are ordered and the earlier ones would otherwise mask the one under test.

---

### Task 8: apply, discover the connection surface, run

**Parked 2026-08-04 with tasks 1-5 built and committed.** Settle these three
unknowns with read-only calls BEFORE provisioning - each one can invalidate a row
this task pays for, and all three are answerable from an existing project or the
published schema.

1. **Does a Micro project offer `ipv4_default` in `available_addons`?** The variant
   is in the create/patch enum, but the enum is the API surface and entitlement is
   a separate question. The direct-5432 control row depends on it: this vantage is
   IPv4-only, confirmed - no global address, no egress - so without the addon the
   control is unreachable and every pooled row loses its reference.
2. **Is dedicated-pooler SESSION mode simply port 5432 on the host the API returns
   for transaction mode?** `GET /v1/projects/{ref}/config/database/pooler` returned
   `pool_mode: transaction`, port 6543, and said nothing about a session endpoint.
   S01b assumes the same host on 5432. If that is wrong the row is measuring the
   wrong thing rather than skipping.
3. **Are the dedicated and public shared poolers distinct hosts on one project?**
   S01c and S01d are separate rows on the assumption they differ. If they resolve
   to the same host the two rows are one measurement reported twice.

Also re-prove the `--only` guard for the S ids specifically. It was proven for
`D01,D02` under `pat,anon-key,db,org`; this experiment additionally supplies
`pgbench`, so the admitted set is different and the earlier proof does not carry.

**Files:** none - this task spends money and records answers.

- [ ] **Step 1: Apply**

Run:
```bash
cd experiments/pooler-semantics
tofu init
tofu plan -var-file=../../secrets.tfvars -var-file=experiment.tfvars -out=tfplan
tofu apply tfplan
```
Expected: a project ref on stdout. If `secrets.tfvars` is absent, run `make secrets-decrypt`
at the repo root first. Never commit `tfplan` - it embeds tfstate including every variable
value.

- [ ] **Step 2: Wait for real readiness, then read the connection surface**

Run:
```bash
REF=$(tofu output -raw project_ref)
TOK=$(grep -E '^supabase_access_token' ../../secrets.tfvars | cut -d'"' -f2)
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.supabase.com/v1/projects/$REF/health?services=db" 
make pooler-config
```
Expected: `db` reports `ACTIVE_HEALTHY`, then JSON describing the pooler. Per AGENTS.md
`ACTIVE_HEALTHY` is still not sufficient - the first write can fail for about ten seconds
afterwards, so wait a further 30 s before running any module and do not record an early
failure as a finding.

From the `pooler-config` output, record in `RUNLOG.md` and then pin as make variables:

| Variable | What to take from the response |
| --- | --- |
| `POOLER` | the dedicated pooler hostname, bare |
| `POOLER_SESSION` | `host:port` for SESSION mode |
| `POOLER_TXN` | `host:port` for TRANSACTION mode |
| `POOLER_USER` | the tenant username |
| `SHARED_TXN` | `host:port` for the PUBLIC shared pooler |

None of those five is pinned anywhere in this plan, and that is deliberate. The pooler
hostname is region-dependent, the mode-to-port mapping is a platform fact rather than a
constant, and `postgres.<ref>` is only a fallback in the modules. Read them, write them
down, and pass them in.

If `/config/database/pooler` 404s, read the values from the dashboard connect dialog
instead and note in RUNLOG that they are not API-derivable - that is itself a finding worth
carrying to `platform-facts`. If the response does not distinguish the shared pooler from
the dedicated one, `supabase link` without `--skip-pooler` targets the shared pooler (T09),
so linking a throwaway directory and reading the resulting config is the fallback path.

- [ ] **Step 3: Run the non-destructive matrix**

Run:
```bash
make probe POOLER=<host> POOLER_SESSION=<host:port> POOLER_TXN=<host:port> \
           SHARED_TXN=<host:port> POOLER_USER=<user>
```
Expected: a report under `evidence/<ts>/` whose Measurements table has one row per mode and
one column per feature, and whose Evidence section carries the verbatim server errors. S02
appears as `skip: destructive; re-run with --destructive to include`. If any C/F/P/T/V/X id
appears in the output, `--only` is not being passed - fix that before running anything else.

Read the S01a row FIRST. If the control did not connect (IPv6), or if it did connect and
`fail`ed a feature, the pooled rows are not yet interpretable and the matrix is not
publishable.

- [ ] **Step 4: Initialise pgbench, then run the throughput group**

Run:
```bash
make bench-init POOLER_SESSION=<host:port> POOLER_USER=<user>
make probe-destructive POOLER=<host> POOLER_SESSION=<host:port> POOLER_TXN=<host:port> \
                       SHARED_TXN=<host:port> POOLER_USER=<user>
```
Expected: about ten and a half minutes of benchmark, then three more rows carrying
`tps_median`, `vs_baseline`, `p50_ms`, `p95_ms`, `p99_ms` and `sbperf_run_id`. Then, for
the settings diff between any two paths:
```bash
sbperf bench --list --ref <ref>
sbperf bench --compare <idA> <idB>
```

Two things to watch. A row reported `fail` with `result not usable` means the client
saturated or the spread exceeded 15 percent - re-run on a quiet machine rather than
publishing it. And `vs_baseline` reads `n/a` on every row when S02a skipped, which is the
honest output from an IPv4-only vantage, not a bug.

- [ ] **Step 5: Optionally close the loop between the two groups**

Run: `make probe-destructive PVLAB_BENCH_PREPARED=1 ...`
This adds `S02d`, the transaction pooler benchmarked with pgbench's PREPARED protocol. It is
the throughput consequence of S01's `prepared_reuse` column: if that column failed, this row
should fail too, and if it passed, the delta between S02b and S02d is what prepared
statements are worth on that path. Costs one more target's wall clock.

---

### Task 9: RUNLOG and AGENTS

**Files:**
- Create: `experiments/pooler-semantics/RUNLOG.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write RUNLOG.md as you go, not at the end**

Structure it like `experiments/cross-project-auth/RUNLOG.md`. Two things must travel with
every number here:

- For the matrix: the exact server error, not a paraphrase. `evidence/<ts>/REPORT.md`'s
  Evidence section already has them verbatim - copy them across rather than retyping.
- For throughput: the script, the client count, the run count, the server version and the
  `sbperf` run id. A tps figure without those is not comparable to anything, including a
  later run of this same experiment. Note explicitly that the numbers are NOT comparable to
  T20's, which used a different script with no warmup and a single 15 s run.

Also record the five connection-surface values from Task 8 Step 2 and where each came from
(API response or dashboard).

- [ ] **Step 2: Add the key-facts section to AGENTS.md**

Append `## experiments/pooler-semantics - key facts (validated <date>)` in the same voice as
the others: mechanism first, number second, and an explicit note on anything that is NOT a
reproducible integer. The two entries that matter most to a future reader:

- Whether `prepared_first` still measured ok on 6543, stated either way. If it did, the
  existing AGENTS.md line stands and this run is its second measurement. If it did NOT, that
  line must be corrected in place and dated, not appended to - a contradicted fact left
  standing next to its correction is worse than either alone.
- The per-mode matrix in one table, because it is the artifact the rest of the corpus will
  cite.

- [ ] **Step 3: Destroy**

Run:
```bash
cd experiments/pooler-semantics
tofu destroy -var-file=../../secrets.tfvars -var-file=experiment.tfvars
```
Expected: the project is gone. It is billable, and nothing worth keeping lives on it -
`evidence/` is gitignored and the findings are in RUNLOG. The `sbperf` runs survive in the
history store independently of the project.

---

## Self-review

**Coverage.** Group 1 covers every feature the brief named - server-side prepared statements,
advisory locks across statements, LISTEN/NOTIFY, session GUCs, cursors outside a
transaction, temp tables across statements, and transaction scope - plus `pid_stable`, which
is the mechanism the other eight are consequences of. Group 2 covers the three paths named,
with a fourth optional row tying the prepared-statement finding to a throughput number.
Session mode on the public shared pooler is the one combination deliberately left out, with
the reason stated in the file-structure section.

**Placeholders.** None. The five connection-surface values are the only unpinned specifics,
and each is a verification step in Task 8 Step 2 with a named fallback if the API does not
expose it. That is deliberate: the pooler hostname is region-dependent and the mode-to-port
mapping is a platform fact, so pinning either here would put a guess into a document whose
whole purpose is measurement.

**Type consistency.** `Feature`, `FeatureOutcome`, `FeatureFailure`, `Target`, `runFeatures`,
`toMeasurements`, `renderEvidence`, `summariseRow`, `regressionVerdict` and `parseTarget` are
defined in Task 1 and used unchanged in Tasks 3, 4 and 5. `BenchSummary`, `parseBenchJson`,
`benchCaveats`, `benchMeasurements` and `throughputDelta` are defined in Task 2 and used in
Task 5. `featuresFor` is defined in Task 3 and called in Task 4. `ctx.endpoints` comes from
the downtime plan's Task 1, declared as a dependency at the top rather than duplicated.

**Known weakness to watch.** `prepared_reuse` depends on node-postgres's per-connection
statement cache sending Bind/Execute with no Parse on the second call. That is the behaviour
the probe is designed around, and it is what makes the probe representative of a real ORM,
but it is a client-library property rather than a protocol guarantee. If a future `pg`
release re-parses named statements, the column would silently start passing everywhere. The
`pid_stable` column is the cross-check: a mode where the backend changes between statements
but `prepared_reuse` passes is a contradiction worth investigating before publishing.

**Second known weakness.** The direct 5432 control is IPv6-only, so on an IPv4-only vantage
the matrix loses its control row and the throughput table loses its baseline. Both degrade
to explicit skips rather than silence, but the run is worth less. Run it from a vantage with
IPv6 egress, and record in RUNLOG which vantage produced the numbers.

**What the dry run changed.** Seven defects were found by applying this plan to a scratch
copy rather than by reading it:

1. `P01`-`P04`, the natural id prefix for a Pooler experiment, are already taken by
   `tenant-promotion`. Found by `./dist/pvlab --list` before a line was written. The
   experiment uses `S` instead.
2. `bun test harness` only collects tests under `harness/`, and `harness/tsconfig.json`
   excludes `experiments/*/lib`. Pure logic placed in the experiment's `lib/` would have
   been neither run nor typechecked. Tasks 1 and 2 moved into `harness/src/`.
3. The unfiltered destructive run is worse here than in the downtime experiment, because
   this one supplies the `db` capability: `--only` absent admits C05 and V04 at minimum, and
   19 modules if a stray `PVLAB_PEER_*` is in the environment.
4. The donor's `REF := $(shell tofu output -raw project_ref 2>/dev/null)` is satisfied by
   tofu's "No outputs found" warning on stdout, re-measured in this directory.
5. `lab-platform-facts` appears TWICE in the donor - `experiment.tfvars` and the
   `project_name` default in `variables.tf`. The exemplar plan renames only the first.
6. The donor Makefile (`platform-facts`) does not export `DB_PASSWORD`, so both modules
   would have skipped on a missing `db` capability. The line was taken from
   `http-tier-lockdown`.
7. `pgbench` is not installed on the machine this was written on, so S02 gates itself off
   with `missing capability: pgbench` - correct behaviour, and a prerequisite that now has
   its own step.

Anything below that is still stated as an expectation rather than a measurement - the
matrix cells, the tps figures, the pooler hostnames and the tenant username - is unverified
by construction: it needs a live project.
