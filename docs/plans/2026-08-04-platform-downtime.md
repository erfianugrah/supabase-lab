# Platform downtime matrix - implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, per platform operation and per connection path, the client-visible
outage a Supabase project incurs - and record the failure MODE alongside the duration.

**Architecture:** A reusable continuous sampler lands in the shared harness
(`harness/src/sampler.ts`). A new experiment `experiments/platform-downtime` provides
the project and one test module per operation. Each module builds a probe set, hands it
plus an operation closure to the sampler, and flattens the per-path result into scalar
`measurements` so the existing report renderer produces the matrix with no renderer
change.

**Tech stack:** Bun + TypeScript (harness), OpenTofu (project provisioning), the existing
`TestModule` contract in `harness/src/types.ts`.

**Standing constraint:** the operator has asked for no commits in this session. Per-task
commit steps are therefore omitted; commit at your own cadence.

**On the numbers in this plan:** the only measured constant carried over is T14's existing
`PROBE_EVERY_MS = 5000` (read from `tests/t14-restart.ts`). Every other interval, settle
window and ceiling below is a CHOSEN starting value, not a measured optimum - tune them
against the first run and record what you picked in RUNLOG.

**Verified against the repo on 2026-08-04:** `buildCtx` takes a `CtxInput`, not an env
record - the pure, testable seam is `readPeers(env)` + `deriveCapabilities(f)`, and this
plan mirrors it. Destructive mode is the `--destructive` flag (`flag("destructive")` in
`run.ts`). The donor experiment's project resource is `supabase_project.probe` and its
`outputs.tf` already exports `api_host`. DB probes in this repo use `pg`'s `Client`
(`t02-connectivity.ts`) and WebSocket probes use the `ws` package
(`t16-realtime.ts`) - there is no `Bun.SQL` anywhere in the lab, so do not introduce one.
Root scripts are `bun run test` (`bun test harness`) and `bun run typecheck`
(`bunx tsc --noEmit -p harness/tsconfig.json`). `harness/tsconfig.json` sets
`noUncheckedIndexedAccess`, which is why every array/record index below carries a `!`.

**Dry-run status (2026-08-04).** Tasks 1, 2, 4 and 5 were applied verbatim to a scratch
copy of this repo and gated on the plan's own sensors. Result: `bun run typecheck` exit 0
with `probes.ts` and `d01-restart.ts` in the tree, and `bun run test` 38 pass / 0 fail (up
from a 27-pass baseline) - the 7 sampler tests and 4 ctx tests below all pass as written.
`bun run build` regenerates the registry and `./dist/pvlab --list` shows the D01 row.
Tasks 3, 6, 7 and 8 were exercised as far as they can be without spending money, and that
is where the remaining traps were found - they are called out inline.

---

## Why not just extend T14

`experiments/privatelink-aws/tests/t14-restart.ts` already measures a restart window, and
it is the precedent this generalises. Three things stop it being the answer:

1. It probes every 5000 ms (`PROBE_EVERY_MS`), so every window is quantised to +/- 5 s and
   a short one returns `info: "no client-visible failure observed"`.
2. It measures one path (a Lambda on 6543). The interesting result is that different
   paths differ - a REST caller and a pooler caller do not see the same outage.
3. Trigger and measurement are interleaved in one function, so adding a second operation
   means copying the loop.

The sampler separates "what operation" from "what paths" from "how we time it", which is
what turns eight modules into eight small files.

## File structure

| Path | Responsibility |
| --- | --- |
| `harness/src/sampler.ts` | CREATE. Continuous multi-path sampler; runs an operation while sampling; returns one window per path. |
| `harness/src/sampler.test.ts` | CREATE. Unit tests for the sampler with injected probes. |
| `harness/src/types.ts` | MODIFY. Add `endpoints` to `Ctx`; add `pooler` / `direct-db` capabilities. |
| `harness/src/ctx.ts` | MODIFY. Populate `ctx.endpoints` from `PVLAB_ENDPOINT_<NAME>`. |
| `harness/src/ctx.test.ts` | MODIFY. Cover the new env parsing. |
| `experiments/platform-downtime/providers.tf` | CREATE. Pinned providers, copied from `platform-facts` (with its `.terraform.lock.hcl`). |
| `experiments/platform-downtime/variables.tf` | CREATE. |
| `experiments/platform-downtime/supabase.tf` | CREATE. One project. |
| `experiments/platform-downtime/outputs.tf` | CREATE. `project_ref`, `api_host`. |
| `experiments/platform-downtime/experiment.tfvars` | CREATE. Non-secret config (region, plan, compute). |
| `experiments/platform-downtime/lib/probes.ts` | CREATE. One probe factory per connection path. |
| `experiments/platform-downtime/tests/d01-restart.ts` | CREATE. |
| `experiments/platform-downtime/tests/d02-restriction-flip.ts` | CREATE. |
| `experiments/platform-downtime/tests/d03-resize-up.ts` | CREATE. |
| `experiments/platform-downtime/tests/d04-resize-down.ts` | CREATE. |
| `experiments/platform-downtime/Makefile` | CREATE. `init/apply/probe/probe-destructive/destroy`. |
| `experiments/platform-downtime/RUNLOG.md` | CREATE. Findings, written as they are measured. |
| `AGENTS.md` | MODIFY. Add the experiment's key-facts section after the run. |

Operations deliberately deferred to a follow-up plan: major upgrade, PITR restore, and
read-replica add/remove. Each needs a paid entitlement and a longer wall clock, and the
sampler is the same. Ship the matrix with four cheap operations first.

---

### Task 1: `ctx.endpoints`

`peers` and `orgSlugs` exist because tests reaching into `process.env` put the run's shape
outside the object that describes it. Probe targets are the third instance: the pooler
host, a custom domain, and later a replica host are all "a URL this run should probe".
Add one general field rather than three specific ones.

**Files:**
- Modify: `harness/src/types.ts`
- Modify: `harness/src/ctx.ts`
- Test: `harness/src/ctx.test.ts`

- [ ] **Step 1: Read the current shape**

Run: `bun --version && sed -n '1,120p' harness/src/ctx.ts`
Expected: you can see how `peers` and `orgSlugs` are parsed from env. Mirror it exactly;
do not invent a second parsing style.

- [ ] **Step 2: Write the failing test**

`buildCtx` takes a `CtxInput` and reads `process.env` internally, so it is not the seam to
test against. `readPeers(env)` and `deriveCapabilities(f)` are the pure functions the
existing tests use - mirror them exactly.

Append to `harness/src/ctx.test.ts`:

```ts
describe("readEndpoints", () => {
  test("PVLAB_ENDPOINT_POOLER=host -> { pooler: host }, lowercased", () => {
    expect(
      readEndpoints({
        PVLAB_ENDPOINT_POOLER: "pooler.example.test",
        PVLAB_ENDPOINT_CUSTOM_DOMAIN: "db.example.test",
        UNRELATED: "x",
      }),
    ).toEqual({ pooler: "pooler.example.test", custom_domain: "db.example.test" });
  });

  test("an empty value counts as absent", () => {
    // A Makefile interpolating a missing tofu output exports exactly this.
    expect(readEndpoints({ PVLAB_ENDPOINT_POOLER: "" })).toEqual({});
  });

  test("PVLAB_ENDPOINT_IPS is NOT an endpoint", () => {
    // It predates this and is parsed separately in buildCtx; a greedy prefix
    // match would swallow it into endpoints.ips.
    expect(readEndpoints({ PVLAB_ENDPOINT_IPS: "10.0.0.1 10.0.0.2" })).toEqual({});
  });
});

test("pooler capability comes from a supplied endpoint", () => {
  expect(deriveCapabilities({ endpoints: {} }).has("pooler")).toBe(false);
  expect(deriveCapabilities({ endpoints: { pooler: "h" } }).has("pooler")).toBe(true);
});
```

Add `readEndpoints` to the existing import at the top of the file:
`import { deriveCapabilities, readEndpoints, readPeers } from "./ctx";`

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test harness/src/ctx.test.ts`
Expected: FAIL - `readEndpoints` is not exported.

- [ ] **Step 4: Add the field to the contract**

In `harness/src/types.ts`, inside `interface Ctx`, after `orgSlugs`:

```ts
  /**
   * Probe targets for this run, by role - `pooler`, `custom_domain`, `replica`.
   * Populated from `PVLAB_ENDPOINT_<NAME>`, lowercased. Same reasoning as
   * `peers`: a test that reads process.env directly puts the run's shape
   * outside the context object whose job is to describe it. An env var set to
   * empty counts as absent, because a Makefile interpolating a missing tofu
   * output exports exactly that.
   */
  endpoints: Record<string, string>;
```

And extend the `Capability` union:

```ts
  | "pooler" // pooler host supplied via PVLAB_ENDPOINT_POOLER
  | "direct-db" // direct 5432 reachable from this vantage (IPv6 - runner only)
```

- [ ] **Step 5: Implement the parsing**

In `harness/src/ctx.ts`, directly below `readPeers`:

```ts
/**
 * `PVLAB_ENDPOINT_POOLER=host` -> `{ pooler: "host" }`. Roles are
 * experiment-defined, exactly as with peers. `PVLAB_ENDPOINT_IPS` is excluded:
 * it predates this and is parsed on its own in buildCtx.
 */
export function readEndpoints(env: Record<string, string | undefined>): Record<string, string> {
  const endpoints: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "PVLAB_ENDPOINT_IPS") continue;
    const m = k.match(/^PVLAB_ENDPOINT_([A-Z0-9_]+)$/);
    if (m?.[1] && v) endpoints[m[1].toLowerCase()] = v;
  }
  return endpoints;
}
```

Add `endpoints?: Record<string, string>` to `CtxInput`, add it to the
`deriveCapabilities` parameter type, and inside `deriveCapabilities`:

```ts
  if (f.endpoints?.pooler) caps.add("pooler");
```

Then in `buildCtx`, next to the `peers` line:

```ts
  const endpoints = input.endpoints ?? readEndpoints(process.env);
```

pass `endpoints` into the `deriveCapabilities({...})` call, and include `endpoints` in the
returned object.

- [ ] **Step 6: Run the tests**

Run: `bun run test`
Expected: PASS, and no existing ctx test regresses.

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: exit 0. `endpoints` is a REQUIRED field on `Ctx`, so in principle any hand-built
context elsewhere breaks. In the 2026-08-04 dry run nothing else needed touching - no test
constructs a bare `Ctx` literal - so if you find yourself editing other files here, stop
and check you have not changed a signature you did not mean to.

---

### Task 2: the sampler

**Files:**
- Create: `harness/src/sampler.ts`
- Test: `harness/src/sampler.test.ts`

Design notes that the tests below encode, so do not "simplify" them away:

- Sampling starts BEFORE the operation, so a baseline sample proves the path was healthy
  going in. A path that was already failing is reported as such rather than as an outage
  caused by the operation.
- Recovery requires `settleMs` of sustained success. The pooler queues before it refuses,
  so a single lucky sample mid-outage would otherwise be recorded as recovery.
- Each probe runs on its own loop. A slow probe must not delay a fast one, or every window
  inherits the slowest path's resolution.
- The return type is per-path scalars. `measurements` in the report is
  `Record<string, number | string>`; a time series does not belong there.

- [ ] **Step 1: Write the failing tests**

Create `harness/src/sampler.test.ts`:

```ts
import { expect, test } from "bun:test";
import { sampleDuring, type PathWindow, type Probe } from "./sampler";

/** A probe that fails while `shouldFail(callIndex)` is true. */
function scriptedProbe(name: string, shouldFail: (i: number) => boolean): Probe {
  let i = -1;
  return {
    name,
    async run() {
      i += 1;
      return shouldFail(i) ? { ok: false, error: "timeout expired" } : { ok: true };
    },
  };
}

const OPTS = { intervalMs: 5, maxWaitMs: 4000, settleMs: 20 };

// tsconfig sets noUncheckedIndexedAccess, so every index access needs the `!`.
const one = (ws: PathWindow[]): PathWindow => ws[0]!;

test("records first failure, recovery, and window for a path that goes down", async () => {
  const probe = scriptedProbe("rest", (i) => i >= 2 && i < 8);
  const w = one(await sampleDuring([probe], OPTS, async () => {}));
  expect(w.name).toBe("rest");
  expect(w.failures).toBe(6);
  expect(w.firstFailMs).not.toBeNull();
  expect(w.recoveredMs).not.toBeNull();
  expect(w.windowMs).toBeGreaterThan(0);
  expect(w.modes).toContain("timeout expired");
});

test("a path that never fails reports nulls, not a zero window", async () => {
  const probe = scriptedProbe("rest", () => false);
  const w = one(await sampleDuring([probe], { ...OPTS, maxWaitMs: 100 }, async () => {}));
  expect(w.failures).toBe(0);
  expect(w.firstFailMs).toBeNull();
  expect(w.recoveredMs).toBeNull();
  expect(w.windowMs).toBeNull();
});

test("a path that never recovers reports a first failure and no recovery", async () => {
  const probe = scriptedProbe("pooler", (i) => i >= 2);
  const w = one(await sampleDuring([probe], { ...OPTS, maxWaitMs: 200 }, async () => {}));
  expect(w.firstFailMs).not.toBeNull();
  expect(w.recoveredMs).toBeNull();
  expect(w.windowMs).toBeNull();
});

test("a single lucky sample mid-outage is not recovery", async () => {
  // ok at 0-1, down 2-5, ONE ok at 6, down 7-10, then up for good.
  const probe = scriptedProbe("pooler", (i) => (i >= 2 && i <= 5) || (i >= 7 && i <= 10));
  const w = one(await sampleDuring([probe], OPTS, async () => {}));
  expect(w.failures).toBe(8);
  // recovery is the sustained one, so the window spans the flap
  expect(w.windowMs).toBeGreaterThan(OPTS.settleMs);
});

test("paths are tracked independently", async () => {
  const fast = scriptedProbe("rest", (i) => i >= 2 && i < 4);
  const slow = scriptedProbe("pooler", (i) => i >= 2 && i < 10);
  const windows = await sampleDuring([fast, slow], OPTS, async () => {});
  const rest = windows.find((w) => w.name === "rest")!;
  const pooler = windows.find((w) => w.name === "pooler")!;
  expect(rest.failures).toBe(2);
  expect(pooler.failures).toBe(8);
  expect(pooler.windowMs!).toBeGreaterThan(rest.windowMs!);
});

test("a path already failing before the operation is flagged", async () => {
  const probe = scriptedProbe("rest", (i) => i < 6);
  const w = one(await sampleDuring([probe], OPTS, async () => {}));
  expect(w.healthyAtStart).toBe(false);
});

test("the operation runs while sampling, and its error propagates", async () => {
  const probe = scriptedProbe("rest", () => false);
  await expect(
    sampleDuring([probe], { ...OPTS, maxWaitMs: 100 }, async () => {
      throw new Error("restart API returned 500");
    }),
  ).rejects.toThrow("restart API returned 500");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test harness/src/sampler.test.ts`
Expected: FAIL - `Cannot find module './sampler'`.

- [ ] **Step 3: Implement the sampler**

Create `harness/src/sampler.ts`:

```ts
/**
 * Continuous multi-path sampler.
 *
 * Runs an operation while sampling several connection paths independently, and
 * reports one window per path. Separating "what operation" from "what paths"
 * from "how we time it" is what lets one module per platform operation stay a
 * few dozen lines - see t14-restart.ts for the interleaved version this
 * generalises.
 *
 * Everything returned is scalar: `measurements` in the report contract is
 * Record<string, number | string>, so a series has nowhere to go.
 */

export interface ProbeOutcome {
  ok: boolean;
  /** Short failure text. Kept verbatim: the MODE matters as much as the duration. */
  error?: string;
}

export interface Probe {
  name: string;
  run(): Promise<ProbeOutcome>;
}

export interface PathWindow {
  name: string;
  /** Did the FIRST sample succeed? False means the path was already down. */
  healthyAtStart: boolean;
  samples: number;
  failures: number;
  /** ms after sampling started. */
  firstFailMs: number | null;
  /** ms after sampling started, at the first sample of the sustained recovery. */
  recoveredMs: number | null;
  /** recoveredMs - firstFailMs, or null if it never failed or never recovered. */
  windowMs: number | null;
  /** Distinct failure texts, in first-seen order. */
  modes: string[];
}

export interface SampleOptions {
  /** Delay between samples on one path. Chosen per module, not measured. */
  intervalMs: number;
  /** Hard stop for the whole run. */
  maxWaitMs: number;
  /** Sustained success required before recovery is believed. */
  settleMs: number;
  log?: (msg: string) => void;
}

interface PathState {
  probe: Probe;
  healthyAtStart: boolean | null;
  samples: number;
  failures: number;
  firstFailMs: number | null;
  /** Candidate recovery: first OK sample after a failure, pending settle. */
  pendingRecoveryMs: number | null;
  recoveredMs: number | null;
  modes: string[];
}

function finalise(state: PathState): PathWindow {
  const windowMs =
    state.firstFailMs !== null && state.recoveredMs !== null
      ? state.recoveredMs - state.firstFailMs
      : null;
  return {
    name: state.probe.name,
    healthyAtStart: state.healthyAtStart ?? false,
    samples: state.samples,
    failures: state.failures,
    firstFailMs: state.firstFailMs,
    recoveredMs: state.recoveredMs,
    windowMs,
    modes: state.modes,
  };
}

/** True once every path that failed has recovered and settled. */
function allSettled(states: PathState[]): boolean {
  return states.every((s) => s.firstFailMs === null || s.recoveredMs !== null);
}

export async function sampleDuring(
  probes: Probe[],
  opts: SampleOptions,
  operation: () => Promise<void>,
): Promise<PathWindow[]> {
  const t0 = Date.now();
  const states: PathState[] = probes.map((probe) => ({
    probe,
    healthyAtStart: null,
    samples: 0,
    failures: 0,
    firstFailMs: null,
    pendingRecoveryMs: null,
    recoveredMs: null,
    modes: [],
  }));

  let stop = false;

  async function loop(state: PathState): Promise<void> {
    while (!stop && Date.now() - t0 < opts.maxWaitMs) {
      const at = Date.now() - t0;
      let outcome: ProbeOutcome;
      try {
        outcome = await state.probe.run();
      } catch (e) {
        outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      state.samples += 1;
      if (state.healthyAtStart === null) state.healthyAtStart = outcome.ok;

      if (!outcome.ok) {
        state.failures += 1;
        state.pendingRecoveryMs = null;
        if (state.firstFailMs === null) state.firstFailMs = at;
        const mode = (outcome.error ?? "unknown").slice(0, 80);
        if (!state.modes.includes(mode)) state.modes.push(mode);
        opts.log?.(`${state.probe.name} down at +${at}ms: ${mode}`);
      } else if (state.firstFailMs !== null && state.recoveredMs === null) {
        if (state.pendingRecoveryMs === null) {
          state.pendingRecoveryMs = at;
        } else if (at - state.pendingRecoveryMs >= opts.settleMs) {
          state.recoveredMs = state.pendingRecoveryMs;
          opts.log?.(`${state.probe.name} recovered at +${state.recoveredMs}ms`);
        }
      }

      await Bun.sleep(opts.intervalMs);
    }
  }

  const loops = states.map((s) => loop(s));
  const watchdog = (async () => {
    while (!stop && Date.now() - t0 < opts.maxWaitMs) {
      // Stop early ONLY once something actually went down and came back.
      // A no-op operation must run to maxWaitMs: a null result has to be
      // earned by waiting, not assumed by an early exit.
      if (states.some((s) => s.firstFailMs !== null) && allSettled(states)) break;
      await Bun.sleep(opts.intervalMs);
    }
  })();

  try {
    await operation();
  } catch (e) {
    stop = true;
    await Promise.all([...loops, watchdog]);
    throw e;
  }

  await watchdog;
  stop = true;
  await Promise.all(loops);

  return states.map(finalise);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test harness/src/sampler.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

---

### Task 3: experiment scaffold

**Files:**
- Create: `experiments/platform-downtime/{providers.tf,variables.tf,supabase.tf,outputs.tf,experiment.tfvars}`

- [ ] **Step 1: Copy the smallest existing experiment**

Run:
```bash
cd ~/supabase-lab
mkdir -p experiments/platform-downtime/{tests,lib}
cp experiments/platform-facts/{providers.tf,variables.tf,supabase.tf,outputs.tf,experiment.tfvars,.terraform.lock.hcl} \
   experiments/platform-downtime/
```
Expected: six files present. `platform-facts` is the right donor - one project, no AWS. The
lock file is copied deliberately: it is committed in this repo, and copying it pins the new
experiment to the provider versions the donor was validated against instead of resolving
fresh ones on `tofu init`.

- [ ] **Step 2: Read what you copied and strip what does not apply**

Run: `sed -n '1,200p' experiments/platform-downtime/supabase.tf`
Expected: you can name every resource. Remove anything specific to entitlement probing.
The experiment needs exactly one project. Rewrite the donor's header comment - it describes
harvesting platform constants, which is not what this dir does.

- [ ] **Step 2b: Rename the project in BOTH places**

Run: `rg -n 'lab-platform-facts' experiments/platform-downtime/`
Expected: TWO hits, not one - `experiment.tfvars:1` and the `project_name` default in
`variables.tf:17`. Change both to `lab-platform-downtime`.

The tfvars value wins at apply time, so renaming only it is functionally sufficient and that
is exactly why the second one is a trap: it sits there named after a different experiment
until the day someone applies without the var-file. Two projects with the same name in one
org is a self-inflicted wound the first time you go looking for the right one in the
dashboard. (Found by the pooler-semantics dry run, 2026-08-04, and verified here.)

Leave `region` and `instance_size` alone: micro is right, and the region only matters for
the pooler host.

- [ ] **Step 3: Confirm the outputs, do not re-add them**

Run: `cat experiments/platform-downtime/outputs.tf`
Expected: `project_ref` and `api_host` are ALREADY there - the donor exports both, keyed off
`supabase_project.probe.id`. The resource is named `probe`, not `this`; keep the donor's
name so the outputs keep resolving. Nothing to add in this step.

Do NOT hand-construct a pooler hostname anywhere in the tf. The pooler host is
region-dependent and its shape is not something to guess - Task 5 Step 1 reads it from the
live project and the Makefile passes it in as `PVLAB_ENDPOINT_POOLER`.

- [ ] **Step 3b: Validate the copy before spending anything**

Run:
```bash
cd experiments/platform-downtime
ls *.tf                      # MUST list providers/variables/supabase/outputs
tofu init -backend=false
tofu validate
```
Expected: four `.tf` files, then `Success! The configuration is valid.`

The `ls` is not padding. `tofu validate` returns **Success on an empty directory** - during
the 2026-08-04 dry run a blocked `cp` left the dir empty and validate reported green
anyway. Confirm the files exist, then trust the validate.

- [ ] **Step 4: Init and apply**

Run:
```bash
cd experiments/platform-downtime
tofu init
tofu plan -var-file=../../secrets.tfvars -var-file=experiment.tfvars -out=tfplan
tofu apply tfplan
```
Expected: a project ref on stdout. If `secrets.tfvars` is absent, run `make
secrets-decrypt` at the repo root first. Never commit `tfplan` - it embeds tfstate
including every variable value.

- [ ] **Step 5: Wait for real readiness, not ACTIVE_HEALTHY**

Run:
```bash
REF=$(tofu output -raw project_ref)
TOK=$(grep -E '^supabase_access_token' ../../secrets.tfvars | cut -d'"' -f2)
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.supabase.com/v1/projects/$REF/health?services=auth&services=rest&services=db"
```
Expected: all three services `ACTIVE_HEALTHY`. Per AGENTS.md this is still not sufficient
- the first write can fail for about ten seconds afterwards. Wait a further 30 s before
running any module, and do not record an early failure as a finding.

---

### Task 4: the probe set

**Files:**
- Create: `experiments/platform-downtime/lib/probes.ts`

- [ ] **Step 1: Verify each path's probe URL against the live project BEFORE pinning it**

Do not write a probe against a path you have not seen answer. Run, substituting your ref
and anon key:

```bash
REF=<ref>; ANON=<anon key>
for p in /rest/v1/ /auth/v1/settings /auth/v1/health /storage/v1/bucket; do
  printf '%-22s %s\n' "$p" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $ANON" "https://$REF.supabase.co$p")"
done
```
Expected: a status code per line. Record them in `RUNLOG.md` now - these are the healthy
baselines the probes compare against. Per AGENTS.md, `/rest/v1/` answers 401 for anon on
the current platform; a 401 is therefore HEALTHY for that probe, not a failure. Use
whichever of the two auth paths answers with a non-5xx; if both do, prefer
`/auth/v1/health`.

- [ ] **Step 2: Write the probe factories**

Create `experiments/platform-downtime/lib/probes.ts`:

```ts
/**
 * One probe per connection path. "Healthy" means the service ANSWERED - not
 * that it answered 200. Anon gets 401 from /rest/v1/ on the current platform,
 * and a probe that treats that as down would report a permanent outage.
 *
 * 5xx IS down: a wedged PostgREST answers 503 PGRST002, which is exactly the
 * state we want the matrix to show.
 *
 * Transports match the rest of the repo: `pg`'s Client for Postgres
 * (t02-connectivity.ts) and the `ws` package for WebSocket (t16-realtime.ts).
 * Both are root dependencies already.
 */
import type { IncomingMessage } from "node:http";
import { Client } from "pg";
import WebSocket from "ws";
import type { Probe, ProbeOutcome } from "../../../harness/src/sampler";

const TIMEOUT_MS = 5000;

function httpProbe(name: string, url: string, headers: Record<string, string>): Probe {
  return {
    name,
    async run() {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.status >= 500) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

export function restProbe(apiHost: string, anonKey: string): Probe {
  return httpProbe("rest", `https://${apiHost}/rest/v1/`, { apikey: anonKey });
}

export function authProbe(apiHost: string, anonKey: string, path: string): Probe {
  return httpProbe("auth", `https://${apiHost}${path}`, { apikey: anonKey });
}

export function storageProbe(apiHost: string, anonKey: string): Probe {
  return httpProbe("storage", `https://${apiHost}/storage/v1/bucket`, {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  });
}

/**
 * Pooler on 6543, via `pg` - the same client t02-connectivity.ts uses.
 *
 * `user` is a parameter, not derived: the Supavisor tenant-username shape is
 * verified in Task 5 Step 1 against the live project, not assumed here.
 * Prepared-statement behaviour across a pooled connection is deliberately NOT
 * exercised - that is a pooler-semantics question, not a downtime one.
 */
export function poolerProbe(poolerHost: string, user: string, password: string): Probe {
  return {
    name: "pooler",
    async run() {
      const client = new Client({
        host: poolerHost,
        port: 6543,
        user,
        database: "postgres",
        password,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: TIMEOUT_MS,
      });
      try {
        await client.connect();
        await client.query("select 1");
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}

/**
 * Realtime handshake only, via the `ws` package (t16-realtime.ts idiom - the
 * hand-rolled curl upgrade it replaced returned an uninterpretable 500).
 *
 * A non-5xx HTTP response on the upgrade counts as HEALTHY, matching httpProbe:
 * a 401 means Realtime answered. Whether a JOIN would be permitted is an
 * authorization question http-tier-lockdown already settled, and this matrix
 * does not re-ask it.
 */
export function realtimeProbe(apiHost: string, anonKey: string): Probe {
  const url = `wss://${apiHost}/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`;
  return {
    name: "realtime",
    async run() {
      return await new Promise<ProbeOutcome>((resolve) => {
        const ws = new WebSocket(url, { handshakeTimeout: TIMEOUT_MS });
        const done = (outcome: ProbeOutcome) => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          resolve(outcome);
        };
        const timer = setTimeout(() => done({ ok: false, error: "ws handshake timeout" }), TIMEOUT_MS);
        ws.on("open", () => done({ ok: true }));
        ws.on("unexpected-response", (_req: unknown, res: IncomingMessage) => {
          const code = res.statusCode ?? 0;
          done(code >= 500 ? { ok: false, error: `HTTP ${code} on upgrade` } : { ok: true });
        });
        ws.on("error", (e: Error) => done({ ok: false, error: e.message }));
      });
    },
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

Note `harness/tsconfig.json` includes `src` and `../experiments/*/tests`, but NOT
`../experiments/*/lib`. `probes.ts` is therefore checked transitively, as a dependency of
the test modules that import it - consistent with the `lib/` directories the other
experiments already have. If it is never imported, it is never checked.

---

### Task 5: D01 - restart

**Files:**
- Create: `experiments/platform-downtime/tests/d01-restart.ts`

- [ ] **Step 1: Get the pooler host AND username from the live project**

Run:
```bash
REF=<ref>; TOK=<pat>
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.supabase.com/v1/projects/$REF/config/database/pooler" | head -40
```
Expected: JSON containing the pooler connection details. Record BOTH the host and the
username in `RUNLOG.md`. The `postgres.<ref>` fallback in the module is an unverified
assumption - if the response shows a different shape, pass the real one through as
`PVLAB_ENDPOINT_POOLER_USER` rather than editing the fallback.

If this endpoint 404s, read the values from the dashboard connect dialog instead and note
in RUNLOG that they are not API-derivable - that is itself a finding worth carrying to
platform-facts.

- [ ] **Step 2: Write the module**

Create `experiments/platform-downtime/tests/d01-restart.ts`:

```ts
/**
 * D01 - client-visible outage across a project restart, per connection path.
 *
 * DESTRUCTIVE: restarts the project.
 *
 * Generalises t14-restart.ts (privatelink-aws), which measured one path at its
 * PROBE_EVERY_MS = 5000 resolution. The result worth carrying forward from that
 * run: the failure mode was "timeout expired", not a refusal - a caller with a
 * long client timeout spends its whole budget on one attempt.
 *
 * intervalMs / settleMs / maxWaitMs below are chosen starting values, not
 * measured optima. Record what you used next to every number in RUNLOG.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { sampleDuring } from "../../../harness/src/sampler";
import { restProbe, authProbe, storageProbe, realtimeProbe, poolerProbe } from "../lib/probes";

const AUTH_PATH = "/auth/v1/health"; // pinned by Task 4 Step 1 - re-verify if it 404s
// Supavisor tenant-username shape. UNVERIFIED as of writing - Task 5 Step 1
// confirms it against the live project; override with PVLAB_ENDPOINT_POOLER_USER.
const poolerUserFor = (ctx: { ref: string; endpoints: Record<string, string> }) =>
  ctx.endpoints.pooler_user ?? `postgres.${ctx.ref}`;
const INTERVAL_MS = 500;
const SETTLE_MS = 5000;
const MAX_WAIT_MS = 420_000;

const mod: TestModule = {
  id: "D01",
  title: "Restart: client-visible outage per connection path",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx): Promise<TestResult> {
    const anon = ctx.anonKey as string;
    const probes = [
      restProbe(ctx.apiHost, anon),
      authProbe(ctx.apiHost, anon, AUTH_PATH),
      storageProbe(ctx.apiHost, anon),
      realtimeProbe(ctx.apiHost, anon),
    ];
    // BOTH conditions: the `pooler` capability only means a host was supplied.
    // ctx.dbPassword comes from DB_PASSWORD in the environment, and the donor
    // Makefile does not export it - see Task 8. Connecting with an empty
    // password fails from sample zero, which the healthyAtStart guard would
    // then report as "already failing before the operation" and skip the whole
    // module. A missing password should self-skip the PATH, not void the run.
    if (ctx.capabilities.has("pooler") && ctx.dbPassword) {
      probes.push(poolerProbe(ctx.endpoints.pooler!, poolerUserFor(ctx), ctx.dbPassword));
    } else {
      ctx.log("pooler path skipped: needs PVLAB_ENDPOINT_POOLER and DB_PASSWORD");
    }

    const windows = await sampleDuring(
      probes,
      { intervalMs: INTERVAL_MS, maxWaitMs: MAX_WAIT_MS, settleMs: SETTLE_MS, log: ctx.log },
      async () => {
        const res = await fetch(`https://api.supabase.com/v1/projects/${ctx.ref}/restart`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.pat}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`restart request failed: HTTP ${res.status}`);
        ctx.log(`restart API: HTTP ${res.status}`);
      },
    );

    const measurements: Record<string, number | string> = { probe_interval_ms: INTERVAL_MS };
    for (const w of windows) {
      measurements[`${w.name}_window_s`] =
        w.windowMs === null ? "n/a" : Math.round(w.windowMs / 1000);
      measurements[`${w.name}_mode`] = w.modes[0] ?? "none";
    }

    const unhealthy = windows.filter((w) => !w.healthyAtStart).map((w) => w.name);
    const stuck = windows.filter((w) => w.firstFailMs !== null && w.recoveredMs === null);
    const downed = windows.filter((w) => w.firstFailMs !== null);

    if (unhealthy.length > 0) {
      return {
        id: "D01",
        title: mod.title,
        status: "skip",
        detail: `path(s) already failing before the restart: ${unhealthy.join(", ")}`,
        measurements,
      };
    }

    return {
      id: "D01",
      title: mod.title,
      status: stuck.length > 0 ? "fail" : "pass",
      detail:
        stuck.length > 0
          ? `never recovered within the probe window: ${stuck.map((w) => w.name).join(", ")}`
          : downed.length === 0
            ? "no client-visible failure on any path"
            : `outage on ${downed
                .map((w) => `${w.name} ${Math.round((w.windowMs as number) / 1000)}s`)
                .join(", ")}`,
      measurements,
    };
  },
};
export default mod;
```

- [ ] **Step 3: Build the registry and confirm the module is reachable**

Run: `cd harness && bun run build && ./dist/pvlab --list`
Expected: D01 appears in the listing (`flag("list")` is a real runner flag).
`gen-registry.ts` scans `experiments/*/tests` with no argument, so no build-time wiring is
needed. Never hand-edit `src/tests.generated.ts`. Note the build targets
`bun-linux-x64`.

- [ ] **Step 4: Run it**

Run:
```bash
cd experiments/platform-downtime
make probe-destructive
```
Expected: a REPORT.md under `evidence/<ts>/` with one column per path. The hypothesis worth
falsifying: REST and pooler see different windows.

- [ ] **Step 5: Record the finding in RUNLOG.md**

Write the numbers AND the failure modes. A window without its mode is half the finding:
"timeout expired" and "connection refused" call for different client retry logic.

---

### Task 6: D02 - network restriction flip

**Files:**
- Create: `experiments/platform-downtime/tests/d02-restriction-flip.ts`

The cheapest destructive operation, and the one with a real chance of a null result -
worth publishing either way. `supabase_settings.network` is verified to apply clean
(privatelink-aws T12), so the shape is known-good; here we drive it via the Management API
so the operation stays a single closure.

- [ ] **Step 1: Verify the endpoint and capture the current state**

Run:
```bash
REF=<ref>; TOK=<pat>
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.supabase.com/v1/projects/$REF/network-restrictions" | head -20
```
Expected: JSON with the current allowed CIDRs. Record it in RUNLOG - you will restore it.

- [ ] **Step 2: Write the module**

Create `experiments/platform-downtime/tests/d02-restriction-flip.ts`, structured exactly
like D01, with this operation and this teardown:

```ts
const apply = async (cidrs: string[]) => {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${ctx.ref}/network-restrictions/apply`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.pat}`, "Content-Type": "application/json" },
      body: JSON.stringify({ dbAllowedCidrs: cidrs }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) throw new Error(`restriction apply failed: HTTP ${res.status}`);
};

let windows;
try {
  windows = await sampleDuring(
    probes,
    { intervalMs: INTERVAL_MS, maxWaitMs: 180_000, settleMs: SETTLE_MS, log: ctx.log },
    async () => {
      await apply(["192.0.2.1/32"]); // TEST-NET-1, guaranteed not us
    },
  );
} finally {
  await apply(["0.0.0.0/0"]); // ALWAYS restore, even if sampling threw
}
```

Set the module id to `D02` and the title to
`"Network restriction flip: does closing the DB to a /32 interrupt the HTTP tier?"`.
Flatten measurements exactly as D01 does.

Do NOT leave the project restricted - the next module would read it as a pre-existing
outage and skip. If the apply path 404s, probe several verb/path shapes the way
`vault-root-key` V03 does rather than concluding from one guessed 404.

- [ ] **Step 3: Run and record**

Run: `make probe-destructive`
Expected: most likely `pooler_window_s` non-null with every HTTP path `n/a` - restrictions
are a DB-socket control, so the HTTP tier should be untouched. If the HTTP tier does blip,
that is a genuine finding; write it up in RUNLOG with the mode.

---

### Task 7: D03 / D04 - resize up and down

**Files:**
- Create: `experiments/platform-downtime/tests/d03-resize-up.ts`
- Create: `experiments/platform-downtime/tests/d04-resize-down.ts`

Ids sort within the destructive tier, so id order IS execution order. D03 must precede D04:
resizing down first leaves nothing to resize down from, and the pair only reads as a
comparison if the direction is known. That ordering lives in the ids, not in the Makefile.

- [ ] **Step 1: Confirm the compute-size surface and the current size**

Run:
```bash
REF=<ref>; TOK=<pat>
curl -s -H "Authorization: Bearer $TOK" "https://api.supabase.com/v1/projects/$REF" | head -30
```
Expected: the project object. Find the field carrying compute size. If it is not there, look
at `/v1/projects/{ref}/billing/addons`, and record in RUNLOG which surface exposes it - a
size that is not API-readable is a finding for platform-facts.

- [ ] **Step 2: Write D03**

Same shape as D01. The operation closure issues the resize; the module measures. Use the
smallest real step - the point is the interruption, not the tier. Set
`maxWaitMs: 900_000`: a resize is slower than a restart, and a short ceiling would record
"never recovered" for an operation that was merely slow.

- [ ] **Step 3: Write D04 as the reverse**

Identical, resizing back down. State the hypothesis in RUNLOG before running it: down-sizing
is not symmetric with up-sizing. Then record whether it held.

- [ ] **Step 4: Run the pair and record**

Run: `make probe-destructive`
Expected: two more rows in the matrix. Note the cost in RUNLOG - a resize is billable and
the compute change persists until D04 completes.

---

### Task 8: Makefile

**Files:**
- Create: `experiments/platform-downtime/Makefile`

- [ ] **Step 1: Copy the donor and read it**

Run:
```bash
cp experiments/platform-facts/Makefile experiments/platform-downtime/Makefile
sed -n '1,60p' experiments/platform-downtime/Makefile
```
Expected: you can name every variable. `ROOT`, `VARS`, `REF`, `TOK`, `TS` and the
`bun run build` step carry over unchanged.

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

const caps = new Set<Capability>(["pat", "anon-key"]);
for (const only of [undefined, ["D01", "D02", "D03", "D04"]]) {
  const { run } = planRun(tests, { where: "local", capabilities: caps, only, allowDestructive: true });
  console.log(
    `--only ${only ? only.join(",") : "(ABSENT)"} -> ${run.map((m) => `${m.id}${m.destructive ? "*" : ""}`).join(", ")}`,
  );
}
```

Run: `bun ./prove-only.ts && rm prove-only.ts`
Expected, measured on 2026-08-04:

```
--only (ABSENT)              -> F02, F03, C05*, D01*, V04*
--only D01,D02,D03,D04       -> D01*
(* = destructive)
```

**C05 and V04 are destructive, need nothing but a PAT, and belong to other experiments.**
Without `--only` they run against this project. The donor Makefile passes
`--only F01,F02,F03` for exactly this reason. Never omit it.

Also confirmed: destructive mode is the `--destructive` flag (`flag("destructive")` in
`run.ts`), not an env var.

- [ ] **Step 3: Replace the probe target**

The donor Makefile does NOT export `DB_PASSWORD` - only `vault-root-key` does, and it
derives it the same way it derives the PAT. Without it `ctx.dbPassword` is the empty string
and the pooler probe connects with no password. Add, next to the `TOK :=` line:

```make
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
```

Then fix the inherited `REF` derivation. The donor has:

```make
REF := $(shell tofu output -raw project_ref 2>/dev/null)
```

With no state, `tofu output -raw` puts its `Warning: No outputs found` block on **stdout**,
so `REF` is a non-empty blob of box-drawing characters: the `test -n "$(REF)"` guard passes,
and the run dies later with `/bin/sh: line 1: output: command not found`. Measured on
2026-08-04. Harden it, and leave the donor alone - fixing it there is a separate change:

```make
# A project ref is 20 lowercase letters. Filtering on that shape is what makes
# the `test -n` guard below actually fire: `tofu output -raw` prints its
# "No outputs found" warning to stdout, which is not empty.
REF := $(shell tofu output -raw project_ref 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)
```

Then the targets:

```make
POOLER ?=
POOLER_USER ?=
RUNNER_FLAGS ?=
# MANDATORY. --experiment only labels the report; the registry is shared, so
# without --only a destructive run reaches other experiments' destructive tests
# (C05 and V04 need nothing but a PAT). Proven in Step 2.
ONLY ?= D01,D02,D03,D04

probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@test -n "$(ONLY)" || (echo "refusing to run with an empty ONLY - see the comment above"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@anon=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys" \
		| jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	test -n "$$anon" || (echo "could not fetch the anon key"; exit 1); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" SUPABASE_ANON_KEY="$$anon" DB_PASSWORD="$(PW)" \
		PVLAB_ENDPOINT_POOLER="$(POOLER)" PVLAB_ENDPOINT_POOLER_USER="$(POOLER_USER)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment platform-downtime \
		--only $(ONLY) $(RUNNER_FLAGS) --out evidence/$(TS)

# Every module here restarts, resizes, or restricts the project. Separate
# target so a bare `make probe` can never take the project down by accident.
probe-destructive:
	@test -n "$(POOLER)" || echo "note: POOLER empty - the pooler path will self-skip"
	@$(MAKE) probe RUNNER_FLAGS=--destructive
```

The anon-key fetch is copied verbatim from `experiments/http-tier-lockdown/Makefile` -
`buildCtx` reads `SUPABASE_ANON_KEY` from the environment, and selecting by `.name=="anon"`
is what keeps a project's second key pair (`sb_publishable_`) from being sent as a bearer
and answering `PGRST301 "Expected 3 parts in JWT"`, which reads like an auth finding and is
not. Note the backslash continuations: the `anon=` assignment and the `pvlab` call must be
one shell invocation.

- [ ] **Step 4: Verify the guards fire before verifying anything else**

```bash
make probe ONLY=
```
Expected: `refusing to run with an empty ONLY`, exit 1.

Then, BEFORE `make apply` has ever run in this directory (so there is no state):
```bash
make probe
```
Expected: `no project_ref output - run 'make apply' first`, exit 1. If instead you see
`/bin/sh: line 1: output: command not found`, the hardened `REF` line above is not in place
and the guard is being satisfied by tofu's warning text.

- [ ] **Step 5: Verify the non-destructive path is safe**

Run: `make probe`
Expected: all four D-modules reported as skipped with "destructive; re-run with
--destructive to include", and no other experiment's test in the output. If any C/V/P/X/T
id appears, `--only` is not being passed - fix that before running anything else.

---

### Task 9: RUNLOG and AGENTS

**Files:**
- Create: `experiments/platform-downtime/RUNLOG.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write RUNLOG.md as you go, not at the end**

Structure it like `experiments/cross-project-auth/RUNLOG.md`. Every number carries its probe
interval: a 4 s window measured at 500 ms resolution and one measured at 5 s resolution are
not the same claim.

- [ ] **Step 2: Add the key-facts section to AGENTS.md**

Append `## experiments/platform-downtime - key facts (validated <date>)` in the same voice as
the others: mechanism first, number second, and an explicit note on anything that is NOT a
reproducible integer. If a window varies run to run, quote the shape and the mechanism the
way T07 does for the pooler client ceiling.

- [ ] **Step 3: Destroy**

Run:
```bash
cd experiments/platform-downtime
tofu destroy -var-file=../../secrets.tfvars -var-file=experiment.tfvars
```
Expected: the project is gone. It is billable, and nothing worth keeping lives on it -
`evidence/` is gitignored and the findings are in RUNLOG.

---

## Self-review

**Coverage.** The four operations here (restart, restriction flip, resize up, resize down)
cover the cheap half of the matrix. Upgrade, PITR restore and replica add/remove are
explicitly deferred to a follow-up plan with the reason stated (entitlement plus wall clock),
not silently dropped.

**Placeholders.** Task 4 Step 1, Task 5 Step 1, Task 6 Step 1, Task 7 Step 1 and Task 8
Step 2 each verify a surface before pinning it. Those are deliberate verification steps, not
TBDs - every one of them replaces a guess that would otherwise be baked into code.

**Type consistency.** `Probe`, `ProbeOutcome`, `PathWindow`, `SampleOptions` and
`sampleDuring` are defined in Task 2 and used unchanged in Tasks 4-7. `ctx.endpoints` is
defined in Task 1 and read in Tasks 5-7. The probe factory names in Task 4 match the imports
in Task 5.

**Known weakness to watch.** The watchdog exits early only once at least one path has failed
and every failed path has settled, so an operation causing no outage runs to `maxWaitMs`.
That is intentional - a null result should be earned by waiting - but it makes D02 slow if
restrictions really are HTTP-invisible. Drop D02's `maxWaitMs` once the first run confirms
the shape.

**What the dry run changed.** Six defects were found by applying this plan to a scratch copy
rather than by reading it: the missing `--only` (which would have run two other experiments'
destructive tests against this project), the `REF` guard that never fires, `tofu validate`
returning green on an empty directory, the duplicated `project_name`, and - before that -
the wrong `buildCtx` test seam and the `Bun.SQL`/global-`WebSocket` idioms that do not exist
in this repo. Anything below that is still stated as an expectation rather than a
measurement (D01-D04 windows, the pooler username, the auth health path) is unverified by
construction: it needs a live project.
