# platform-facts: a real diff, plus two new surfaces - implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "re-run it and diff it" premise that `platform-facts` was built on
actually work, and add the two surfaces the existing modules do not cover: region
availability, and which control-plane writes are reachable from a stable API.

**Architecture:** A pure `diffArtifacts(prev, cur)` in the shared harness, wired to a new
`--diff` mode beside the existing merge mode, plus two read-only modules in
`experiments/platform-facts/tests`. No new experiment directory and no new project - F04
and F05 run against the one `platform-facts` already provisions.

**Tech stack:** Bun + TypeScript (harness), the existing `TestModule` / `RunArtifact`
contracts, `mgmt()` for every call.

**Standing constraint:** the operator has asked for no commits in this session. Per-task
commit steps are therefore omitted; commit at your own cadence.

**Verified against the repo on 2026-08-04:**
`run.ts` writes `${outDir}/run-${stamp}.json` and `run-${stamp}.md`. `RunArtifact` is
`{startedAt, finishedAt, where, region, ref, experiment?, labCommit?, toolVersions,
results}` (`types.ts:89`). `mergeMode(files, outDir)` at `run.ts:58`, dispatched from
`arg("merge")` at `run.ts:88`, is the precedent for a second artifact-level mode.
`report.ts` exports exactly one function, `renderMarkdown`. F01 already reads
`/organizations/{slug}/entitlements` into a stable row set; F02 already covers compute
prices, connection counts, key shapes and the default Postgres major; F03 already probes
PAT scoping **with a positive control in the same run**. Sensors are `bun run typecheck`
and `bun run test` from the repo root.

**On flag names:** the runner has no literal flag strings in source - `arg(name)` resolves
`--${name}` at `run.ts:18`, so the existing modes are spelled `--merge`, `--only`,
`--where`, `--out`, `--tests`, `--experiment`, and `flag("destructive")` / `flag("list")`
give `--destructive` / `--list`. `--diff` does not exist yet; this plan introduces it.

**Dry-run status (2026-08-04).** Tasks 1 and 2 were applied verbatim to a scratch copy and
gated on the repo's sensors: `bun run typecheck` exit 0, `diff.test.ts` 8 pass / 0 fail
(baseline 27 pass across the suite), `bun run build` clean, and the compiled binary
exercised end to end on synthetic artifacts - all-clear path, changed path, wrong arity
(exit 1) and missing file (exit 1, via `main().catch` at `run.ts:204`). One defect was found
by MUTATION rather than by the tests, and the plan below carries the fix; see Task 1 Step 6.
Tasks 3-6 need a live project and a PAT, so they remain verification steps.

**A defect this plan fixes on the way past.** `experiments/platform-facts/Makefile` says
"diff `evidence/<new>/REPORT.md` against the previous run", and
`experiments/http-tier-lockdown/Makefile` echoes `== evidence/$(TS)/REPORT.md ==`. No code
path writes a `REPORT.md`; the runner writes `run-<stamp>.md`. Both messages have always
pointed at a file that does not exist. Fix them in Task 5.

---

## Why a diff mode rather than `diff(1)`

The Makefile's advice is to diff two rendered Markdown reports. That fails in the way that
matters: the report carries `startedAt`, `finishedAt`, `labCommit`, tool versions and
per-test `durationMs`, so **every** re-run diffs dirty, and the one changed entitlement is
buried in a wall of noise that is not a platform change. A snapshot you cannot cheaply
compare is a snapshot nobody re-takes.

The unit that matters is the measurement: same test id, same measurement key, different
value. That is a small comparison over `RunArtifact.results`, and it is pure, so it gets
tests.

## File structure

| Path | Responsibility |
| --- | --- |
| `harness/src/diff.ts` | CREATE. Pure `diffArtifacts` + `renderDiffMarkdown`. |
| `harness/src/diff.test.ts` | CREATE. Unit tests. |
| `harness/src/run.ts` | MODIFY. `--diff a.json,b.json` mode, mirroring merge mode at line 58. |
| `experiments/platform-facts/tests/f04-regions.ts` | CREATE. Region catalogue and where a smart region lands. |
| `experiments/platform-facts/tests/f05-control-plane-writes.ts` | CREATE. Which control-plane writes are on the stable API, with a positive control. |
| `experiments/platform-facts/Makefile` | MODIFY. `diff` target; fix the `REPORT.md` message; add F04,F05 to the only-list. |
| `experiments/http-tier-lockdown/Makefile` | MODIFY. Fix the same `REPORT.md` message. |
| `experiments/platform-facts/RUNLOG.md` | MODIFY. Record F04/F05 findings. |
| `AGENTS.md` | MODIFY. Extend the platform-facts key-facts section. |

---

### Task 1: `diffArtifacts`

**Files:**
- Create: `harness/src/diff.ts`
- Test: `harness/src/diff.test.ts`

Semantics the tests below pin, so do not "simplify" them away:

- Compare on `(test id, measurement key)`. Everything else in the artifact is run metadata
  and must be ignored, or the diff is noise.
- A test present in one artifact and not the other is reported as added/removed, NOT as a
  changed measurement. A skipped test that later runs is the common case and must read
  clearly.
- A changed `status` is reported even when no measurement moved: `pass` to `fail` on an
  unchanged value is the single most interesting row a re-run can produce.
- Only `measurements` is compared. `TestResult`'s own fields - `durationMs` above all - are
  run metadata and never enter a diff. Note this is a property of WHERE we read from, not a
  filter: `durationMs` is a `TestResult` field, never a measurement key, so there is nothing
  to exclude. An earlier draft of this plan carried an `IGNORED_KEYS = new Set(["durationMs"])`
  and a test for it; both were dead. See Step 6.

- [ ] **Step 1: Write the failing tests**

Create `harness/src/diff.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test harness/src/diff.test.ts`
Expected: FAIL - `Cannot find module './diff'`.

- [ ] **Step 3: Implement**

Create `harness/src/diff.ts`:

```ts
/**
 * Compare two run artifacts at the measurement level.
 *
 * platform-facts was built to be re-run and diffed, but the Makefile's advice
 * was to diff two rendered reports - and those carry timestamps, a lab commit,
 * tool versions and per-test durations, so every re-run diffs dirty and the one
 * entitlement that moved is invisible. The unit that matters is
 * (test id, measurement key).
 */
import type { RunArtifact, TestResult } from "./types";

export interface MeasurementChange {
  id: string;
  key: string;
  /** null when the key did not exist in the previous run. */
  from: string | number | null;
  /** null when the key has vanished. */
  to: string | number | null;
}

export interface StatusChange {
  id: string;
  from: TestResult["status"];
  to: TestResult["status"];
}

export interface ArtifactDiff {
  added: string[];
  removed: string[];
  changed: MeasurementChange[];
  statusChanged: StatusChange[];
  /** Measurements compared and found identical - the denominator. */
  unchanged: number;
}

function byId(a: RunArtifact): Map<string, TestResult> {
  return new Map(a.results.map((r) => [r.id, r]));
}

/**
 * Only `measurements` is compared. TestResult's own fields - durationMs above
 * all - are run metadata and are never part of a diff.
 */
function measurements(r: TestResult | undefined): Record<string, string | number> {
  return r?.measurements ?? {};
}

export function diffArtifacts(prev: RunArtifact, cur: RunArtifact): ArtifactDiff {
  const a = byId(prev);
  const b = byId(cur);

  const added = [...b.keys()].filter((id) => !a.has(id)).sort();
  const removed = [...a.keys()].filter((id) => !b.has(id)).sort();

  const changed: MeasurementChange[] = [];
  const statusChanged: StatusChange[] = [];
  let unchanged = 0;

  for (const id of [...a.keys()].filter((k) => b.has(k)).sort()) {
    const before = a.get(id)!;
    const after = b.get(id)!;
    if (before.status !== after.status) {
      statusChanged.push({ id, from: before.status, to: after.status });
    }
    const mb = measurements(before);
    const ma = measurements(after);
    for (const key of [...new Set([...Object.keys(mb), ...Object.keys(ma)])].sort()) {
      const from = key in mb ? mb[key]! : null;
      const to = key in ma ? ma[key]! : null;
      if (from === to) unchanged += 1;
      else changed.push({ id, key, from, to });
    }
  }

  return { added, removed, changed, statusChanged, unchanged };
}

export function renderDiffMarkdown(d: ArtifactDiff): string {
  const quiet =
    !d.added.length && !d.removed.length && !d.changed.length && !d.statusChanged.length;
  if (quiet) {
    return `# Platform diff\n\nno change across ${d.unchanged} measurements.\n`;
  }

  const lines = ["# Platform diff", ""];
  if (d.statusChanged.length) {
    lines.push("## Status changes", "", "| id | from | to |", "| --- | --- | --- |");
    for (const s of d.statusChanged) lines.push(`| ${s.id} | ${s.from} | ${s.to} |`);
    lines.push("");
  }
  if (d.changed.length) {
    lines.push(
      "## Changed measurements",
      "",
      "| id | key | before | after |",
      "| --- | --- | --- | --- |",
    );
    for (const c of d.changed) {
      lines.push(`| ${c.id} | ${c.key} | ${c.from ?? "(absent)"} | ${c.to ?? "(absent)"} |`);
    }
    lines.push("");
  }
  if (d.added.length) lines.push(`Added tests: ${d.added.join(", ")}`, "");
  if (d.removed.length) lines.push(`Removed tests: ${d.removed.join(", ")}`, "");
  lines.push(`${d.unchanged} measurement${d.unchanged === 1 ? "" : "s"} unchanged.`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test harness/src/diff.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 6: Prove the suite has teeth before moving on**

Green tests are not evidence that the tests test anything. Break the comparison and confirm
the suite notices:

```bash
cp harness/src/diff.ts /tmp/diff.bak
perl -0pi -e 's/if \(from === to\) unchanged \+= 1;/if (true) unchanged += 1;/' harness/src/diff.ts
bun test harness/src/diff.test.ts   # MUST fail
cp /tmp/diff.bak harness/src/diff.ts && rm /tmp/diff.bak
bun test harness/src/diff.test.ts   # green again
```
Expected: 3 fail under the mutation, 8 pass after restoring. Measured on 2026-08-04.

This step exists because the first draft of this plan had an `IGNORED_KEYS` filter for
`durationMs` plus a test asserting it worked - and deleting the filter entirely left all 8
tests passing, because `durationMs` is a `TestResult` field and never reaches the
measurement comparison. The feature was dead and the test was a lie. Both were removed. If
you add a filter here later, mutate it before you believe its test.

---

### Task 2: the diff mode

**Files:**
- Modify: `harness/src/run.ts`

- [ ] **Step 1: Read the precedent**

Run: `sed -n '55,95p' harness/src/run.ts`
Expected: `mergeMode(files, outDir)` reads each path with `Bun.file(f).text()`, `JSON.parse`s
into `RunArtifact`, and is dispatched from the top of `main` before any context is built.
Mirror that placement exactly - a diff must not require a PAT, a ref, or a network.

- [ ] **Step 2: Add the mode**

Below `mergeMode`, add:

```ts
/**
 * `--diff prev.json,cur.json` - compare two artifacts and write the result.
 * Placed beside mergeMode and dispatched before buildCtx for the same reason:
 * this is an offline operation on files and must not need a credential.
 */
async function diffMode(files: string[], outDir: string): Promise<void> {
  if (files.length !== 2) throw new Error("--diff needs exactly two artifact paths, oldest first");
  const [prevPath, curPath] = files as [string, string];
  const prev = JSON.parse(await Bun.file(prevPath).text()) as RunArtifact;
  const cur = JSON.parse(await Bun.file(curPath).text()) as RunArtifact;
  const md = renderDiffMarkdown(diffArtifacts(prev, cur));
  await $`mkdir -p ${outDir}`.quiet();
  await Bun.write(`${outDir}/diff.md`, md);
  console.log(md);
}
```

Import `diffArtifacts` and `renderDiffMarkdown` from `./diff` at the top of the file, and
dispatch immediately after the existing merge block in `main`:

```ts
  const diffArg = arg("diff");
  if (diffArg) {
    await diffMode(diffArg.split(",").map((s) => s.trim()).filter(Boolean), arg("out", "./out")!);
    return;
  }
```

Extend the usage comment at the top of the file with the new invocation, in the same style
as the two lines already there.

- [ ] **Step 3: Typecheck and build**

Run: `bun run typecheck && cd harness && bun run build`
Expected: exit 0 both.

- [ ] **Step 4: Exercise it on synthetic artifacts**

Run:
```bash
cd /tmp && rm -rf diffcheck && mkdir diffcheck && cd diffcheck
cat > a.json <<'JSON'
{"startedAt":"2026-08-01T00:00:00.000Z","finishedAt":"2026-08-01T00:01:00.000Z","where":"local","region":"ap-southeast-1","ref":"abcdefghijklmnopqrst","experiment":"platform-facts","toolVersions":{"bun":"1.3.13"},"results":[{"id":"F01","title":"F01","status":"info","measurements":{"plan":"pro","audit_logs_days":7}}]}
JSON
sed 's/"audit_logs_days":7/"audit_logs_days":28/' a.json > b.json
~/supabase-lab/harness/dist/pvlab --diff a.json,b.json --out .
```
Expected: a Changed-measurements table with `F01 | audit_logs_days | 7 | 28`, and `diff.md`
written. Confirm it needed no PAT and made no network call.

Also check the two bad-invocation paths, both measured on 2026-08-04:
```bash
~/supabase-lab/harness/dist/pvlab --diff a.json --out . >/dev/null 2>&1; echo $?          # 1
~/supabase-lab/harness/dist/pvlab --diff nope.json,b.json --out . >/dev/null 2>&1; echo $?  # 1
```
Expected: exit 1 for both, via the existing `main().catch` at `run.ts:204`. That is correct
and consistent with the runner's rule - a measured failure exits 0 because it is data, but a
harness that could not produce an artifact exits non-zero. Read `$?` directly; piping
through `tail` gives you `tail`'s status, not the binary's.

---

### Task 3: F04 - regions

**Files:**
- Create: `experiments/platform-facts/tests/f04-regions.ts`

The question this answers: which regions can a project actually be created in through the
API, and where does a non-specific region choice land. Data residency is decided on that
answer, and the published region list has no as-of date.

- [ ] **Step 1: Find the surface before writing anything**

Run:
```bash
TOK=<pat>
for p in /projects /regions /platform/regions; do
  printf '%-22s %s\n' "$p" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" "https://api.supabase.com/v1$p")"
done
curl -s -H "Authorization: Bearer $TOK" https://api.supabase.com/v1/projects | jq -r '.[].region' | sort -u
```
Expected: a status per path, and the distinct regions of the projects on this account.
Record all of it in RUNLOG. If there is no region-catalogue endpoint, that absence IS the
finding and F04 records it with `status: "info"` - do not fabricate a list from memory.

- [ ] **Step 2: Write the module**

Model it on F02: all GETs, `status: "info"` for anything that merely records what the
platform says today, and `pass`/`fail` reserved for shape assertions that have a right
answer. Emit at minimum the count of distinct regions observed, each region as a
measurement, and - if a catalogue endpoint exists - whether any smart or multi-region alias
appears in it. Follow F02's habit of naming sub-results `F04a`, `F04b`.

Use `mgmt(ctx, "GET", path)` for every call, never bare `fetch`: `mgmt` is what classifies
a Cloudflare HTML interstitial as `throttled` instead of recording it as a parse bug.

- [ ] **Step 3: Build, list, run**

Run:
```bash
cd harness && bun run build && ./dist/pvlab --list | grep F04
cd ../experiments/platform-facts && make probe ONLY=F04
```
Expected: the F04 row appears; the run writes measurements and needs no `--destructive`.

---

### Task 4: F05 - the control-plane write surface

**Files:**
- Create: `experiments/platform-facts/tests/f05-control-plane-writes.ts`

The claim under test: membership and provisioning actions are not fully reachable from the
stable v1 API, which is why automation gets pushed onto the unstable surface the dashboard
uses. A sibling project (`gatekeeper`) independently concluded that org member writes are
not PAT-drivable. This pins that from the outside.

- [ ] **Step 1: Copy F03's structure, including its control**

Run: `sed -n '1,89p' experiments/platform-facts/tests/f03-pat-scope.ts`
Expected: you can see the pattern - a list of candidate paths where absence is the finding,
plus positive endpoints that must answer 200 **in the same run**. Without the control, a
wall of 404s equally describes a dead token, a wrong base URL, or an outage. F05 must have
the same control. This is the single most important thing to carry over.

- [ ] **Step 2: Enumerate the candidates with GET only**

Probe for the EXISTENCE of member-management routes using GET and record the status per
path. Do NOT issue POST/PUT/DELETE against a real organization: a 405 tells you the path
exists with different verbs, and that is enough for the finding. This keeps F05
non-destructive, which is what lets it run on a schedule alongside F01-F04.

Include at least the organization members and invitations paths under
`/organizations/{slug}/...`, and record for each the status and whether the body was JSON or
an HTML interstitial. Gate on the `org` capability the way F01 does, and skip with a reason
when `ctx.orgSlugs` is empty.

- [ ] **Step 3: State the finding as a measurement, not prose**

Emit `v1_member_read`, `v1_member_write_surface` (present / absent / verb-restricted) and
`control_ok`. A future reader should see the day this flips without reading the detail
string.

- [ ] **Step 4: Run it**

Run: `cd experiments/platform-facts && make probe ONLY=F05 ORGS=<slug>`
Expected: results recorded, control green. If the control fails the whole result is void -
say so in the detail and return `fail`, exactly as F03 does.

---

### Task 5: Makefile, and the `REPORT.md` that never existed

**Files:**
- Modify: `experiments/platform-facts/Makefile`
- Modify: `experiments/http-tier-lockdown/Makefile`

- [ ] **Step 1: Confirm the defect before fixing it**

Run:
```bash
grep -rn 'REPORT.md' experiments/*/Makefile
grep -n 'run-' harness/src/run.ts | grep -i write
```
Expected: two Makefiles referring to `REPORT.md`, and `run.ts` writing
`run-${stamp}.json` / `run-${stamp}.md`. There is no `REPORT.md` anywhere in the codebase.

- [ ] **Step 2: Fix both messages**

Replace `REPORT.md` with `run-<stamp>.md` in both files. In `platform-facts`, replace the
"diff evidence/<new>/REPORT.md against the previous run" comment with a pointer to the new
`make diff` target.

- [ ] **Step 3: Add the diff target and widen the only-list**

```make
# Compare the two most recent runs. Offline: no PAT, no network - the diff is
# a pure function over two artifacts.
diff:
	@ls -1 evidence/*/run-*.json | tail -2 | { \
		read prev; read cur; \
		test -n "$$cur" || (echo "need two runs under evidence/ - run 'make probe' twice"; exit 1); \
		echo "prev: $$prev"; echo "cur:  $$cur"; \
		$(ROOT)/harness/dist/pvlab --diff "$$prev,$$cur" --out evidence/diff-$(TS); }
```

Add `diff` to `.PHONY`, and extend the existing `--only F01,F02,F03` to
`--only F01,F02,F03,F04,F05`.

- [ ] **Step 4: Verify the diff target end to end**

Run: `make probe && sleep 2 && make probe && make diff`
Expected: `no change across N measurements` on two back-to-back runs of a stable platform.
That all-clear is the point: a diff that is noisy on an unchanged platform is a diff nobody
reads. If it is noisy, find which key moved and either stop the module emitting a
timestamp-like value or add the key to `IGNORED_KEYS` with a comment saying why.

---

### Task 6: RUNLOG and AGENTS

**Files:**
- Modify: `experiments/platform-facts/RUNLOG.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Record F04 and F05 findings in RUNLOG**

Match the existing entries: what was probed, what came back, what it means for a published
claim. For F05, note whether it agrees with gatekeeper's independent conclusion - two tools
reaching the same answer from different directions is worth stating, and a disagreement is
worth investigating before either is published.

- [ ] **Step 2: Extend the AGENTS.md platform-facts section**

Add the diff mode to the harness description (it is a harness capability, not an experiment
one) and the two new modules to the platform-facts key facts. Note the `REPORT.md` fix so
nobody reintroduces it from an old memory.

---

## Self-review

**Coverage.** The diff mechanism, plus the two surfaces F01-F03 do not touch. Deliberately
NOT included: a feature-gating matrix scraped from product surfaces rather than the
entitlements API. F01 already reads the authoritative source, and a second softer source
would be a thing to maintain rather than a thing to trust.

**Placeholders.** Tasks 3 and 4 each open with a surface-discovery step rather than a pinned
endpoint list, because those paths are not verified. Task 5 Step 1 confirms the `REPORT.md`
defect before fixing it. These are verification steps, not TBDs.

**Type consistency.** `MeasurementChange`, `StatusChange`, `ArtifactDiff`, `diffArtifacts`
and `renderDiffMarkdown` are defined in Task 1 and used unchanged in Task 2. `RunArtifact`
and `TestResult` are the existing types from `harness/src/types.ts`, not new ones.

**Known weakness.** `diffArtifacts` compares with `===`, so a measurement whose value is a
rendered object string (F01's `render()` emits `JSON.stringify` for objects) will diff on
key reordering even when nothing changed. F01's `ROWS` list keeps that surface small today.
If it bites, normalise in `render()` at the source rather than teaching the diff about JSON
- the diff should stay a dumb comparison.

---

## Appendix: what this evidence is for

F01-F05 and `cross-project-auth` are the evidence base for one downstream document - a
reference doc separating application-plane identity from control-plane identity. It lives
in the docs-site repo at `src/content/docs/reference/supabase-iam-two-planes.mdx`, and the
mapping is recorded HERE rather than there because the claims are downstream of these
measurements. The site repo gets the prose; this repo owns what the prose is allowed to say.

There is deliberately no plan file in the docs-site repo. That repo is the published
artifact, its taxonomy is `guides/` and `reference/` with a sidebar generated from the
directory, and its own AGENTS.md is already the authoring contract - skeleton, citation
convention, house style, and a verify-before-done checklist. A plan there would be a second
source of truth for things the first one already specifies. The process for writing the doc
is: AGENTS.md is the contract, `bun run build` plus `bun test` are the sensors, and a row in
`tests/pins.test.ts` is the regression guard.

### Why the doc is worth writing

"Can my application's users sign in through my customer's identity provider" and "can my own
staff reach the dashboard through ours" get asked in the same breath and answered as one
question. They are unrelated systems with different primitives, different failure modes and
different mitigations. Every claim below already exists in this corpus; the doc contributes a
boundary, not a measurement.

### Data plane - the application's users

| Claim | Evidence | Note |
| --- | --- | --- |
| RLS plus JWT claims is the authorization primitive; the role model is customer-owned | existing corpus reference docs | Frame as "you build it", not as a gap |
| A project can trust an external OIDC issuer, and the trust is fast to establish and fast to revoke | `cross-project-auth` X01/X02 | Quote the mechanism and the measured shape, with the interval it was measured at |
| Token portability is attributable: the same token is refused before the trust exists and accepted after | `cross-project-auth` X02 | The strongest single result in the corpus for this plane |
| Refresh still goes to the issuing project - a trusting project verifies, it does not mint | `cross-project-auth` RUNLOG | CONDITIONAL: reported but not yet reproduced by a test module. Publish as reported-not-reproduced until an X03 exists |
| Two key shapes coexist; sending the wrong one as a bearer answers `PGRST301 "Expected 3 parts in JWT"` | AGENTS.md key facts | Include the error text verbatim - it reads like an auth finding and is not |
| Auth and Storage have no equivalent of the PostgREST schema wedge or Realtime's private-only toggle | `http-tier-lockdown` | The asymmetry IS the finding |

### Control plane - your own staff and machines

| Claim | Evidence | Note |
| --- | --- | --- |
| A Personal Access Token reaches every organization and project the account can reach | F03, which carries a positive control in the same run | Say that the control is what makes the 404s mean anything |
| Organization roles are a fixed small set; there is no custom role builder | `org-topology` | State the number only if F01's entitlements output confirms it on the day of writing |
| Organization membership is READ-ONLY on the stable API - one operation across 169 | F05, RAN 2026-08-04, with `/projects` and `/organizations` as a same-run positive control | FIRM. Corroborated from the opposite direction by the sibling gateway project's `member-plan`. Two independent routes to the same answer is worth stating; it is the strongest control-plane row here |
| The `jit/invite` endpoints are DATABASE access, not membership | F05 | Include it - a keyword search for "invite" finds them, and reading them as membership provisioning produces a confidently wrong claim |
| There is no region-catalogue endpoint; the creatable set is documentation-only | F04, RAN 2026-08-04, same control idiom | FIRM. This is what qualifies any "programmatic per-customer region placement" claim: you can place, you cannot discover |
| A project cannot be created at an older version, so an upgrade cannot be staged | F06, RAN 2026-08-04 | FIRM. The version selectors on project creation are deprecated and typed null |
| The mitigation is a scoped gateway in front of the coarse credential, not a finer credential | the sibling gateway project | Be explicit that this governs only traffic routed through it |

### The synthesis section

Close the doc by mapping each common enterprise ask to its plane and to today's answer on
that plane. No roadmap opinions - those date the doc, and the boundary does not.

### Status on park, 2026-08-04

Four of the control-plane rows above are now measured rather than conditional -
F04, F05 and F06 all ran, and F05's row was written before it had. The data-plane
side is unchanged.

**One conditional row remains, and it is the only thing blocking the doc:** the
claim that refresh goes to the issuing project - that a trusting project verifies
but does not mint. It sits in `cross-project-auth`'s RUNLOG as reported and not
reproduced. Closing it is one test module (X03) against two peer projects, and it
is load-bearing for every "the tenant stays independent" statement the doc would
make. Write X03 before the doc, or publish that row as reported-not-reproduced
and say which.

### Pin what must not regress

When the doc is written, add one row to the site repo's `tests/pins.test.ts`: the verbatim
`PGRST301` text and the verifies-but-does-not-mint phrase under `mustContain`, the two plane
section slugs plus the synthesis slug under `anchors`, and the multitenant-platform
reference under `linksTo`. Then break one pinned string and confirm the suite fails before
trusting it - that repo has already been bitten by a section regex that matched a heading an
edit had split in two.
