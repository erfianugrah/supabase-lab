# Lab backlog waves (2026-10-13) Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task, in the current session. Steps use checkbox (`- [ ]`) syntax for tracking. Per-task subagents (subagent-driven-development) only if the user asks for them.

> **W1 + Task 20 SHIPPED 2026-10-13 (commits: see git log).** Tasks 1-17
> and 20 (Steps 1-3) done; Task 18 took its no-release fallback; Task 19
> Steps 2-4 done; Task 20 Step 4 ran 2026-10-13 with O03 and W12 still
> unverified (note under the step). Deviations are noted under each task.
>
> **STATUS 2026-10-13: PLANNED.** Covers every open card on the
> `work-supabase-lab` board (90 To-Do plus #127 In Review = 91; two non-lab
> cards moved to another project on 2026-10-13). W1 (offline)
> and the offline half of #128 are written out in full and were dry-run on a
> copy of the repo (see "Dry-run status" at the end). W2 to W5 are triage
> entries only; each wave gets its own detailed plan when it starts.

**Goal:** Clear the offline backlog (publish every locally held run artifact, write the missing RUNLOG entries, fix the harness region header, patch two dependency advisories, close stale doc items) and give every other card a wave, a precondition and a cost.

**Architecture:** W1 tasks are independent doc, config and code edits in this repo; the shared code changes are Task 1 (#172), which changes the facts header every later publish renders, and Task 1b, which teaches the redactor about home-directory paths; both run before any publish. Publishing uses the existing `harness/scripts/publish-evidence.ts` through each experiment's `make publish-evidence` target, adding the target where it is missing. No task in W1 calls the Management API, OpenTofu or a cloud account.

**Tech Stack:** Bun 1.3.14 (harness, `bun test`, `tsc`), GNU make, the pvlab harness (`harness/src/run.ts --facts`), ripgrep / fd / jq / sd for edits and verification, `vkctl` for board moves.

---

## Conventions every W1 task relies on

- Run every command from the repo root (`~/work/supabase-lab`) unless a step
  says otherwise. `make -C experiments/<name> ...` keeps the shell there.
- Sensors (the same two after every task):

  ```bash
  bunx tsc --noEmit -p harness/tsconfig.json; echo "tsc exit $?"
  (cd harness && bun test); echo "bun test exit $?"
  ```

  Expected: `tsc exit 0`, and a `bun test` summary with ` 0 fail` and
  `bun test exit 0`. The pass count grows as tasks land: Task 1 adds 6 unit
  tests, and `harness/src/identifiers.test.ts` adds one case per new file
  under `experiments/*/out/` (every published run adds 2: the JSON and its
  `.facts.md`). Baseline at 0d18eb0: `1596 pass`; with this plan file committed
  (it is a tracked markdown file the scan covers) `1597 pass`. The running total for
  in-order execution is given in each task's verify step.
- `make publish-evidence` prints one line per run:
  `published run-<stamp>.json -> <repo>/experiments/<name>/out/<date> (<n> results; 0 unredacted ref-shaped tokens remain; 0 unredacted credential ids remain)`.
  It exits 1 if a ref-shaped token survives redaction; stop and look if that
  happens. `<date>` is the UTC date of the run's `startedAt`, which is why a
  few runs from the morning of 2026-10-10 (UTC+8) land in `out/2026-10-09/`
  or `out/2026-10-08/`. The script asks Cloudflare's trace endpoint on
  `1.1.1.1` (`vantageAddresses()` in the script) for this machine's public
  address so it can redact it; offline it prints
  `warning: could not learn this vantage's public address; set PVLAB_REDACT_ADDRS`
  and still publishes. None of the artifacts below contain a client address
  (checked 2026-10-13: the only IPv4 literals are public resolvers, anycast
  edges, `127.0.0.1` and Postgres version strings).
- Facts headers rendered after Task 1 read
  `harness region ap-southeast-1 (not read from the project)`, because none
  of these old artifacts carries a `projectRegion`.
- Count published files with
  `git status --short --untracked-files=all experiments/<name>/out | wc -l`,
  not with `fd`: an experiment-level `.gitignore` that lists `out/` (found in
  pipelines and observability-surface during the dry-run) overrides the root
  carve-out for `experiments/*/out/20*/`, and `git add` then skips the files
  without an error.
- Publishing is redaction by shape (refs, project and pooler hosts, emails,
  PAT/OAuth ids). It does not redact project NAMES. Before committing an
  `out/` directory, run
  `rg -n '"name": "' experiments/<name>/out/ | rg -v '"name": "(log_|unindexed|auth_rls|unused_)'`
  and read every hit; the only account-specific names found on 2026-10-13
  are in usage-metering M07, which Task 11 therefore does not publish. Also
  run `rg -l '/Users/|/home/' experiments/<name>/out/`: expected no output
  once Task 1b is in (before it, auth-providers and pooler-checkout each had
  one artifact with a home path).
- Commit messages: Conventional Commits, ASCII, no tool attribution.
- Lexicanum pages that cite these experiments are edited in the lexicanum
  repo after this repo is pushed (links pin to the pushed commit). That
  follow-up is listed in Task 19 and is not part of this plan's execution.

## Triage: every open card

Waves: **W1** offline (no cloud, no credential beyond reading local files;
docs, config, code and publishing only). **W2** time-bound. **W3** unblocked
live work: code exists or is small, a PAT plus the lab orgs (or a local Docker
rig, or a human Dashboard session) suffices. **W4** blocked on credentials,
access or money the lab does not have today. **W5** new research.
Cost: offline / local (Docker or kind on this Mac, no cloud) / live-cheap
(throwaway Micro projects, minutes) / live-paid (add-ons, replicas, AWS,
plan upgrades or hours of runtime). Effort is hands-on time, not wall time.

| card | wave | blocker / precondition | cost | effort |
|---|---|---|---|---|
| #3 SFP coverage Task 16-17 | W4 | Task 16: restore points and OAuth bridge need entitlement enablement on the platform org; Task 17 is filing upstream doc reports | live-cheap | 2 h |
| #15 compute-disk D10 on the platform-plan org | W4 | platform-org token as a secretctl keyfile plus that control plane's base URL | live-paid | 1 h (40 min run) |
| #20 platform-downtime stats_reset around D01 | W3 | small code: wrap D01 with D05's before/after read | live-cheap | 2 h |
| #33 bu-attribution org-scoped PAT on production | W3 | an operator-created org-scoped token (`PVLAB_SCOPED_PAT_ORG`); SP04 is ready (scoped-pats RUNLOG). Moved out of the "gated" group: no new access needed | live-cheap | 1 h |
| #34 bu-attribution BA04 transfer-in | W4 | a second org on the same control plane; `/v1` cannot delete an org | live-cheap | 2 h |
| #35 bu-attribution BA05 member scope | W4 | a second human user (`PVLAB_PAT2`); batch with #153 | live-cheap | 2 h |
| #36 bu-attribution M07 on a platform invoice | W4 | a platform-plan invoice PDF | offline once the PDF exists | 1 h |
| #37 bu-attribution v2 member-role PATCH | W4 | Enterprise org access | live-cheap | 1 h |
| #39 compute-disk over-quota billing | W4 | spend plus a full billing cycle | live-paid | days (wall) |
| #40 platform-facts F06 upgrade window | W4 | an aged project the lab may upgrade (destructive) | live-cheap | 2 h |
| #41 platform-facts `eligible: null` | W3 | none | live-cheap | 1 h |
| #42 rate-limits edge HTML 429 | W3 | none | live-cheap | 2 h |
| #43 usage-metering RUNLOG M03-M07 | W1 | M03 left no artifact; M07's artifact names account projects | offline | 1 h |
| #44 s2z-wake auto-pause on production free plan | W3 | free orgs on production exist (FE01 and RP03 used them on 2026-10-10); needs days of idle | live-cheap | 1 h + wait |
| #45 s2z-wake Z02 write operations | W3 | none (Z01 about 35 min) | live-cheap | 2 h |
| #46 s2z-wake reach scale-to-zero | W4 | an account with the mechanism enabled | live-cheap | 0.5 d |
| #47 instance-sizing RUNLOG I04 | W1 | none | offline | 0.5 h |
| #48 privatelink-aws T28/T29 | W4 | #130, AWS spin cost, one manual association | live-paid | 0.5 d |
| #49 privatelink-aws verify-full TLS second VPC | W4 | #130, AWS spin | live-paid | 2 h |
| #50 privatelink-aws T19 rewrite | W4 | code is offline; the spin needs #130 | live-paid | 3 h |
| #51 security-lockdown Phase C PrivateLink | W4 | #130, Team org, manual association | live-paid | 0.5 d |
| #52 security-lockdown Log Drain + before-user-created hook | W4 | drain creation answered 403 to the PAT on the Pro org (OB04, 2026-10-10); Dashboard creation; billed per drain per project | live-paid | 0.5 d |
| #53 security-lockdown pg_cron and webhooks under restrict-all | W3 | none | live-cheap | 2 h |
| #54 http-tier-lockdown stale 'untested' note | W1 | none | offline | 0.1 h |
| #55 auth Storage/Realtime third-party token | W3 | none | live-cheap | 2 h |
| #56 replica-cluster-tpa RC01-RC05 | W3 | modules not written; RC01-RC04 local, RC05 three managed projects | local + live-cheap | 1 d |
| #57 third-party-auth TPA05/TPA06 | W3 | modules not written | live-cheap | 0.5 d |
| #58 cross-project-auth OAuth 2.1 aud mismatch | W3 | none | live-cheap | 2 h |
| #59 identity-transfer IT02/IT03 + IT01 | W3 | managed project + PAT | live-cheap | 2 h |
| #60 identity-transfer Apple transfer_sub | W4 | a real Apple team and app | live-cheap | 0.5 d |
| #61 self-hosted-auth apikey vs cache | W3 | local self-hosted stack, probe past 45 s | local | 1 h |
| #62 tenant-promotion OAuth/OIDC identities | W3 | an OIDC provider; the AU01 Worker issuer can stand in (inference, untested for promotion) | live-cheap | 3 h |
| #63 data-api-reenable DA06 Dashboard timing | W3 | human Dashboard session | live-cheap | 1 h |
| #64 edge-function-limits wall clock (free) | W3 | none | live-cheap | 1 h |
| #65 edge-function-limits CPU/memory | W3 | none | live-cheap | 2 h |
| #66 residency-facts retention, drains, cache TTL | W3 | retention/cache: a project older than 4 days (the standing DD01S project qualifies); the drain part merges into #52 | live-cheap | 2 h |
| #67 checkpointer-reset managed stop path | W3 | find a managed-side signal first | live-cheap | 3 h |
| #68 tls-surface re-run + IPv6 + replica TLS | W3 | an IPv6 vantage; replica TLS needs a replica | live-paid | 3 h |
| #69 stripe-sync-schema fixture matrix + E02 | W4 | a Stripe test-mode write key | live-cheap | 0.5 d |
| #70 stale plan checkboxes | W1 | none | offline | 0.5 h |
| #71 governed-starter-kit interactive confirm + Explorer | W3 | human MCP-client and Dashboard session | live-cheap | 2 h |
| #73 platform-facts F03 header | W1 | none | offline | 0.1 h |
| #78 governed-starter-kit first-call 502 | W3 | the next fanout deploy | live-cheap | 1 h |
| #83 edge-function-limits 30 requests per trace | W3 | none | live-cheap | 2 h |
| #86 governed-starter-kit app: sharp advisory | W1 | `bun install` and `bun audit` fetch from the registry | offline + registry | 0.5 h |
| #87 governed-starter-kit app: braces advisory | W1 | a patched braces release must exist (not verified offline) | offline + registry | 0.25 h |
| #89 Data API grants after 2026-10-30 | W2 | on or after 2026-10-30; PAT, standing-project ref, Pro org | live-cheap | 1 h |
| #93 Pipelines managed service | W3 | Dashboard session, Pro project, a destination credential | live-paid | 0.5 d |
| #112 MCP enterprise-managed auth | W5 | an IdP test tenant with SSO; Team/Enterprise org | live-paid | 1 d |
| #117 searchable encryption partner integration | W5 | read the integration, then a probe design | live-cheap | 1 d |
| #127 (In Review) client network path | W4 | retitle and close once #162 has run | none | 0.1 h |
| #128 explicit GRANTs in older experiments | W2 | code before 2026-10-30 (offline, Task 20); one live re-run per experiment | offline + live-cheap | 1 h + 3 h |
| #129 graphql status semantics in DA03 and T22 | W3 | code offline; DA03 re-run live; T22 re-run waits for #130 | live-cheap | 2 h |
| #130 AWS vault key pair rejected | W4 | owner action: rotate the vault item or switch to SSO; unblocks #48 #49 #50 #51 #145 #149 #162 | none | 0.5 h |
| #131 auth-providers publish | W1 | none | offline | 0.5 h |
| #132 hostname-path publish | W1 | Makefile target first | offline | 0.5 h |
| #133 free-email-templates publish | W1 | none | offline | 0.25 h |
| #134 jit-db-access publish | W1 | none | offline | 0.25 h |
| #135 restore-paths publish | W1 | Makefile target; `RUN` variable clash; two runs share a file name | offline | 0.75 h |
| #136 pooler-checkout publish | W1 | none | offline | 0.5 h |
| #137 pipelines publish | W1 | Makefile target | offline | 0.5 h |
| #138 observability-surface publish | W1 | Makefile target | offline | 0.5 h |
| #139 logs usage-based pricing meter | W5 | find the token or surface that reads org GB figures | live-cheap | 0.5 d |
| #140 Multigres managed private alpha | W5 | alpha access for a lab org | live-paid | 1 d |
| #141 dbarena methodology vs lab OrioleDB | W5 | none (reading first) | offline, then live-paid | 0.5 d |
| #142 app hosting announcement | W5 | none (reading first) | offline | 2 h |
| #143 operate-with-confidence diff | W5 | none (reading first) | offline | 2 h |
| #144 community supabase-audit checks | W5 | a lab project | live-cheap | 2 h |
| #145 PrivateLink self-serve on a fresh Team org | W4 | #130 and a fresh Team org | live-paid | 2 h |
| #149 privatelink-aws RUNLOG follow-ups | W4 | #130 for the spin parts (wording and Makefile fixes are offline) | offline + live-paid | 2 h |
| #150 lifecycle-ops cluster B runbook | W3 | none | live-cheap | 0.5 d |
| #151 publish lifecycle-ops, data-api-defaults, scoped-pats | W1 | raw JSON survives only in an earlier session's `/private/tmp` scratchpad (tmpfs, lost on reboot) | offline | 1.5 h |
| #152 Dashboard-session checks (branch merge, clone) | W3 | human Dashboard session; clone needs a paid plan | live-paid | 2 h |
| #153 jit-db-access revocation | W4 | a second human user and a disposable PAT; batch with #35 | live-cheap | 2 h |
| #154 @supabase/server on Vercel and Bun | W3 | a Vercel account for that half; Bun half is local | live-cheap | 3 h |
| #155 orioledb pipelines, PITR, XID | W3 | PITR add-on; can share #93's pipeline session | live-paid | 0.5 d |
| #156 Multigres kind/operator failover | W3 | local kind cluster | local | 0.5 d |
| #157 cli-surface linux/amd64, glibc, CI runner | W3 | an amd64 Linux host or hosted CI runner | live-cheap | 3 h |
| #158 storage-surface Dashboard S3 keys | W3 | human Dashboard session | live-cheap | 1 h |
| #161 governed-starter-kit interactive OAuth consent | W3 | human session; batch with #71 | live-cheap | 1 h |
| #162 hostname-path eastern-US vantage | W4 | #130 | live-cheap | 2 h |
| #163 client-keyed-objects CK04/CK06 re-run | W3 | keep the laptop awake (`caffeinate`) | live-cheap | 2 h |
| #164 storage-surface stale cache, >2 GiB, parts | W3 | none | live-cheap | 0.5 d |
| #165 pooler-checkout 60 s vs 15 s | W3 | find the 15 s claim's source first | live-cheap | 2 h |
| #166 mgmt-api-faults connection faults, orphans | W3 | a local fault proxy | live-cheap | 3 h |
| #167 terraform-edge-functions parallel-deploy loss | W3 | a throwaway `tofu apply` with `TF_LOG=DEBUG` | live-cheap | 2 h |
| #168 self-hosted-defaults sb_ keys, PG15 to 17, amd64 | W3 | local Docker; an amd64 host for that row | local | 0.5 d |
| #169 replica-routing unhealthy replica | W3 | a read replica | live-paid | 3 h |
| #170 restore-paths >1 GB, older targets | W3 | PITR add-on, targets hours to days old | live-paid | 0.5 d |
| #171 governed-starter-kit publish | W1 | Makefile target | offline | 0.75 h |
| #172 harness region header | W1 | none | offline | 1 h |

Counts: W1 18 (#43 #47 #54 #70 #73 #86 #87 #131 #132 #133 #134 #135 #136
#137 #138 #151 #171 #172), W2 2 (#89 #128), W3 41, W4 22, W5 8. Total 91.

### Duplicates, merges and batches

- **Merge:** #52 (Log Drain delivery), the drain half of #66, and
  observability-surface OB04d (code written, never run against a live drain)
  are one measurement. Run it once under #52; close the drain line of #66 and
  cite #52 in the observability-surface RUNLOG.
- **Merge:** #127 and #162. #127 recorded the resolver half; #162 is the
  eastern-US half its title promises. When #162 is done, retitle #127 to what
  ran and close both.
- **Batch:** #35 and #153 both need a second human user. #71 and #161 are
  both interactive governed-starter-kit sessions. #63, #152 and #158 are all
  Dashboard-session checks. #93 and #155 can share one managed pipeline.
- **Related, not duplicates:** #89 (grants on the platform) and #128 (grants
  in this repo's fixtures); #129 and DD02 (pg_graphql off by default).

---

## W1 - offline (detailed)

### Task 1: harness records the target project's region (#172)

**Files:**
- Modify: `harness/src/types.ts` (RunArtifact)
- Modify: `harness/src/ctx.ts` (new `readProjectRegion`)
- Modify: `harness/src/facts.ts` (new `regionLabel`, header line)
- Modify: `harness/src/report.ts` (header line)
- Modify: `harness/src/run.ts` (read once before modules run; merge mode)
- Test: `harness/src/ctx.test.ts`, `harness/src/facts.test.ts`, `harness/src/report.test.ts`

`RunArtifact.region` is `ctx.region`, which is `REGION` / `AWS_REGION` /
`ap-southeast-1` (`harness/src/ctx.ts`, `buildCtx`). Self-provisioning modules
create projects in that region, so the field stays; it just must not be
presented as the region of a `PVLAB_REF` project (DD01S on 2026-10-13 read an
eu-central-1 project and its facts said ap-southeast-1). The fix adds
`projectRegion`, read from `GET /v1/projects/{ref}` (the field
`audit-integrity/tests/a12-rbac-roles.ts` already reads), and makes both
renderers say which one they show.

- [x] **Step 1: Write the failing tests**

**Replace in `harness/src/ctx.test.ts`:**

```text
import { deriveCapabilities, readEndpoints, readOrgs, readPeers } from "./ctx";
```

**with:**

```text
import { deriveCapabilities, readEndpoints, readOrgs, readPeers, readProjectRegion } from "./ctx";
import type { MgmtResponse } from "./mgmt";
import type { Ctx } from "./types";

describe("readProjectRegion", () => {
  const ctx = { ref: "abcdefghijklmnopqrst", pat: "sbp_test", region: "ap-southeast-1" } as Ctx;
  const answer = (status: number, json?: unknown) => async (): Promise<MgmtResponse> => ({
    status,
    text: "",
    json: json as MgmtResponse["json"],
    throttled: false,
  });

  test("reads region from GET /v1/projects/{ref}", async () => {
    const seen: string[] = [];
    const call = async (_c: Ctx, method: string, path: string): Promise<MgmtResponse> => {
      seen.push(`${method} ${path}`);
      return { status: 200, text: "", json: { region: "eu-central-1" }, throttled: false };
    };
    expect(await readProjectRegion(ctx, call)).toBe("eu-central-1");
    expect(seen).toEqual(["GET /projects/abcdefghijklmnopqrst"]);
  });

  test("no ref or no PAT: no call is made", async () => {
    let calls = 0;
    const call = async (): Promise<MgmtResponse> => {
      calls++;
      return { status: 200, text: "", json: { region: "eu-central-1" }, throttled: false };
    };
    expect(await readProjectRegion({ ...ctx, ref: "" }, call)).toBeUndefined();
    expect(await readProjectRegion({ ...ctx, pat: undefined }, call)).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("a non-200, a body without region, or a failed call is undefined, never the harness default", async () => {
    expect(await readProjectRegion(ctx, answer(404, { message: "not found" }))).toBeUndefined();
    expect(await readProjectRegion(ctx, answer(200, { name: "x" }))).toBeUndefined();
    expect(
      await readProjectRegion(ctx, async () => {
        throw new Error("offline");
      }),
    ).toBeUndefined();
  });
});
```

**Replace in `harness/src/facts.test.ts`:**

```text
describe("numbersIn", () => {
```

**with:**

```text
describe("region in the facts header", () => {
  test("without projectRegion the header says the region is the harness setting", () => {
    expect(renderFacts(run)).toContain("harness region ap-southeast-1 (not read from the project)");
  });

  test("with projectRegion the header names the project's region", () => {
    const md = renderFacts({ ...run, projectRegion: "eu-central-1" });
    expect(md).toContain("region eu-central-1 (read from the project)");
    expect(md).not.toContain("harness region");
  });
});

describe("numbersIn", () => {
```

**Replace in `harness/src/report.test.ts`:**

```text
  test("a new test's measurements become columns with no renderer change", () => {
```

**with:**

```text
  test("the header says whether the region was read from the project", () => {
    const plain = renderMarkdown(artifact([{ id: "X01", title: "shapes", status: "pass" }]));
    expect(plain).toContain("| harness region ap-southeast-1 (not read from the project) |");
    const read = renderMarkdown({ ...artifact([{ id: "X01", title: "shapes", status: "pass" }]), projectRegion: "eu-central-1" });
    expect(read).toContain("| region eu-central-1 (read from the project) |");
  });

  test("a new test's measurements become columns with no renderer change", () => {
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `(cd harness && bun test src/ctx.test.ts src/facts.test.ts src/report.test.ts); echo "exit $?"`

Expected: `exit 1`, summary ` 10 pass`, ` 4 fail`, `1 error`. The error is
`SyntaxError: Export named 'readProjectRegion' not found in module '.../harness/src/ctx.ts'`
(ctx.test.ts cannot load); the three new header tests fail on `toContain`
(the header still says `region ap-southeast-1`).

- [x] **Step 3: Write the minimal implementation**

**Replace in `harness/src/types.ts`:**

```text
  where: Where;
  region: string;
  ref: string;
  /**
   * Which experiment produced this.
```

**with:**

```text
  where: Where;
  /**
   * The harness region setting (REGION / AWS_REGION / ap-southeast-1): where
   * self-provisioning modules create projects. It says nothing about a
   * PVLAB_REF project, which can live anywhere (work-supabase-lab#172).
   */
  region: string;
  /** The target project's region from GET /v1/projects/{ref}, when the run had a ref and a PAT. */
  projectRegion?: string;
  ref: string;
  /**
   * Which experiment produced this.
```

**Replace in `harness/src/ctx.ts`:**

```text
import type { Capability, Ctx, Where } from "./types";
```

**with:**

```text
import { mgmt } from "./mgmt";
import type { Capability, Ctx, Where } from "./types";
```

**Replace in `harness/src/ctx.ts`:**

```text
export async function toolVersions(): Promise<Record<string, string>> {
```

**with:**

```text
/**
 * The target project's region, for the run artifact. Undefined when the run
 * has no ref or no PAT, or the read fails: the artifact then says the region
 * shown is the harness setting instead of guessing (work-supabase-lab#172).
 */
export async function readProjectRegion(ctx: Ctx, call: typeof mgmt = mgmt): Promise<string | undefined> {
  if (!ctx.ref || !ctx.pat) return undefined;
  const res = await call(ctx, "GET", `/projects/${ctx.ref}`, undefined, 10_000).catch(() => undefined);
  if (res?.status !== 200) return undefined;
  const region = (res.json as { region?: unknown } | undefined)?.region;
  return typeof region === "string" && region ? region : undefined;
}

export async function toolVersions(): Promise<Record<string, string>> {
```

**Replace in `harness/src/facts.ts`:**

```text
export function renderFacts(run: RunArtifact, opts: FactsOptions = {}): string {
```

**with:**

```text
/** Which region an artifact can vouch for: the project's, or only the harness setting. */
export function regionLabel(run: Pick<RunArtifact, "region" | "projectRegion">): string {
  return run.projectRegion
    ? `region ${run.projectRegion} (read from the project)`
    : `harness region ${run.region} (not read from the project)`;
}

export function renderFacts(run: RunArtifact, opts: FactsOptions = {}): string {
```

**Replace in `harness/src/facts.ts`:**

```text
vantage ${run.where}, region ${run.region}` +
```

**with:**

```text
vantage ${run.where}, ${regionLabel(run)}` +
```

**Replace in `harness/src/report.ts`:**

```text
import type { RunArtifact, TestResult } from "./types";
```

**with:**

```text
import { regionLabel } from "./facts";
import type { RunArtifact, TestResult } from "./types";
```

**Replace in `harness/src/report.ts`:**

```text
    `Project \`${a.ref}\` | region ${a.region} | vantage ${a.where}` +
```

**with:**

```text
    `Project \`${a.ref}\` | ${regionLabel(a)} | vantage ${a.where}` +
```

**Replace in `harness/src/run.ts`:**

```text
import { buildCtx, toolVersions } from "./ctx";
```

**with:**

```text
import { buildCtx, readProjectRegion, toolVersions } from "./ctx";
```

**Replace in `harness/src/run.ts`:**

```text
    region: first.region,
```

**with:**

```text
    region: first.region,
    projectRegion: parts.find((p) => p.projectRegion)?.projectRegion,
```

**Replace in `harness/src/run.ts`:**

```text
  const startedAt = new Date().toISOString();
  const results: TestResult[] = [...skipped];
```

**with:**

```text
  // Read before any module runs: a module may delete the project it targets.
  const projectRegion = await readProjectRegion(ctx);
  const startedAt = new Date().toISOString();
  const results: TestResult[] = [...skipped];
```

**Replace in `harness/src/run.ts`:**

```text
    region: ctx.region,
    ref: ctx.ref,
```

**with:**

```text
    region: ctx.region,
    projectRegion,
    ref: ctx.ref,
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `(cd harness && bun test src/ctx.test.ts src/facts.test.ts src/report.test.ts); echo "exit $?"`

Expected: ` 34 pass`, ` 0 fail`, `exit 0`.

Then the sensors (Conventions). Expected: `tsc exit 0`; `1603 pass`, ` 0 fail`.

Offline check that rendering an old artifact works (no ref, so no network):

Run: `bun harness/src/run.ts --facts experiments/data-api-defaults/out/2026-10-13/run-2026-10-13T00-06-25-892Z.json | sed -n 3p`

Expected: `Source artifact: run started 2026-10-13T00:06:25.892Z, finished ... vantage local, harness region ap-southeast-1 (not read from the project), lab commit 91fe131. Project ref omitted on purpose.`

- [x] **Step 5: Commit**

```bash
git add harness/src/types.ts harness/src/ctx.ts harness/src/ctx.test.ts harness/src/facts.ts harness/src/facts.test.ts harness/src/report.ts harness/src/report.test.ts harness/src/run.ts
git commit -m "fix(harness): record the target project's region, label the harness default (#172)"
```

---

### Task 1b: publish-evidence redacts home-directory paths (found by the dry-run; no card)

**Files:**
- Modify: `harness/scripts/publish-evidence.ts` (`redact`, header comment)
- Test: `harness/src/redact.test.ts`

Two of the artifacts this plan publishes carry the operator's macOS home
path in a stack trace or captured stderr (auth-providers `au03-run2`, the
AU03 error detail; pooler-checkout run 6, the crashed process's stderr). No
tracked file contains one today, and `redact()` knows only refs, project and
pooler hosts, emails and PAT/OAuth ids. Fix it in the shared redactor, before
any publish task runs.

- [x] **Step 1: Write the failing test**

**Replace in `harness/src/redact.test.ts`:**

```text
  {
    name: "OAuth client id in a provenance comment",
    input: "-- user: oauth:0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
    expected: "-- user: oauth:<id>",
  },
];
```

**with:**

```text
  {
    name: "OAuth client id in a provenance comment",
    input: "-- user: oauth:0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
    expected: "-- user: oauth:<id>",
  },
  // Stack traces and captured stderr name the operator's home directory
  // (auth-providers AU03, pooler-checkout PC03, 2026-10-10); caught by the
  // 2026-10-13 backlog plan's dry-run before either was published.
  {
    name: "macOS home directory in a stack trace",
    input: "at run (/Users/someone/work/lab/tests/x.ts:10:5)",
    expected: "at run (~/work/lab/tests/x.ts:10:5)",
  },
  {
    name: "Linux home directory",
    input: "open /home/someone/.cache/x failed",
    expected: "open ~/.cache/x failed",
  },
];
```

- [x] **Step 2: Run it to verify it fails**

Run: `(cd harness && bun test src/redact.test.ts); echo "exit $?"`
Expected: ` 15 pass`, ` 2 fail` (the two new cases: the path comes back unchanged), `exit 1`.

- [x] **Step 3: Write the minimal implementation**

**Replace in `harness/scripts/publish-evidence.ts`:**

```text
    .replace(/\boauth:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "oauth:<id>");
```

**with:**

```text
    .replace(/\boauth:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "oauth:<id>")
    // A stack trace or captured stderr names the operator's home directory.
    .replace(/\/(?:Users|home)\/[^/\s"'\\]+/g, "~");
```

**Replace in `harness/scripts/publish-evidence.ts`:**

```text
 * `aws-N-<region>.pooler.supabase.com` hosts, and anything that looks like an
 * email; plus, by literal,
```

**with:**

```text
 * `aws-N-<region>.pooler.supabase.com` hosts, anything that looks like an
 * email, and a home-directory prefix (macOS or Linux); plus, by literal,
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `(cd harness && bun test src/redact.test.ts); echo "exit $?"`
Expected: ` 17 pass`, ` 0 fail`, `exit 0`.

Run the sensors. Expected: `tsc exit 0`; `1605 pass`, ` 0 fail`.

- [x] **Step 5: Commit**

```bash
git add harness/scripts/publish-evidence.ts harness/src/redact.test.ts
git commit -m "fix(harness): publish-evidence redacts home-directory paths"
```

> **Executed 2026-10-13, with an addition found in Task 11.** The first
> usage-metering publish let three project refs through in M05a's evidence
> (one ref per line inside a JSON string). `redact()` runs on the raw JSON
> text, where a ref at the start of such a line follows the two characters
> `\n` and reads as a 21-letter token; the publish script's leftover check
> (`\b[a-z]{20}\b`) and `identifiers.test.ts` had the same blind spot, so
> both reported clean. Fixed in this task's commit: one exported `REF_SHAPE`
> in `publish-evidence.ts` that also treats a JSON escape (`\n`, `\t`, `\r`,
> `\b`, `\f`) as a boundary, used by `redact()`, the leftover check and
> `identifiers.test.ts`, plus two `redact.test.ts` cases (red 17 pass / 2 fail
> against the old pattern, green 19 pass). Every pass count from Task 11 on is
> 2 higher than written. No tracked file carried the pattern (scanned with the
> new shape before the fix); the leak was caught before any commit.

---

### Task 2: auth-providers - publish the 2026-10-10 artifacts (#131)

**Files:**
- Create: `experiments/auth-providers/out/2026-10-09/` (1 run), `experiments/auth-providers/out/2026-10-10/` (9 runs)
- Modify: `experiments/auth-providers/RUNLOG.md:14-18`

The RUNLOG cites ten runs by `evidence/` directory label: au01-final2,
au02-final, au03-run3, au04-final (headline), plus au01, au01-final,
au02-run2, au03-run2, au04, au04-run2 (earlier runs named in the text).
`au01/run-2026-10-09T23-57-18-992Z.json` is a skip-only run and is not cited.

- [x] **Step 1: Publish**

```bash
make -C experiments/auth-providers publish-evidence RUN=evidence/au01/run-2026-10-09T23-57-24-149Z.json
make -C experiments/auth-providers publish-evidence RUN=evidence/au01-final/run-2026-10-10T00-13-52-726Z.json
make -C experiments/auth-providers publish-evidence RUN=evidence/au01-final2/run-2026-10-10T00-14-53-112Z.json
make -C experiments/auth-providers publish-evidence RUN=evidence/au02-run2/run-2026-10-10T00-01-30-351Z.json
make -C experiments/auth-providers publish-evidence RUN=evidence/au02-final/run-2026-10-10T00-13-16-939Z.json
make -C experiments/auth-providers publish-evidence RUN=evidence/au03-run2/run-2026-10-10T00-08-26-464Z.json
make -C experiments/auth-providers publish-evidence RUN=evidence/au03-run3/run-2026-10-10T00-09-32-436Z.json
make -C experiments/auth-providers publish-evidence RUN=evidence/au04/run-2026-10-10T00-11-01-907Z.json
make -C experiments/auth-providers publish-evidence RUN=evidence/au04-run2/run-2026-10-10T00-11-41-807Z.json
make -C experiments/auth-providers publish-evidence RUN=evidence/au04-final/run-2026-10-10T00-26-40-222Z.json
```

Expected: ten `published ...` lines, result counts 11, 11, 11, 9, 9, 3, 7, 4,
4, 4, each with `0 unredacted ref-shaped tokens remain; 0 unredacted
credential ids remain`. The first goes to `out/2026-10-09`, the rest to
`out/2026-10-10`.

- [x] **Step 2: Re-cite in the RUNLOG**

**Replace in `experiments/auth-providers/RUNLOG.md`:**

```text
deleted it in `finally`. Artifacts are in the gitignored `evidence/`; they
are not published to `out/` yet (`make publish-evidence`), so the numbers
below are pasted from the harness's facts renders and the publish step is
open. Latencies are in milliseconds where a row says "in ms".
```

**with:**

```text
deleted it in `finally`. The numbers below are pasted from the harness's
facts renders. Raw artifacts stay in the gitignored `evidence/`; the redacted
copies, each with a `.facts.md` beside it, are listed by the labels the
sections below use. Latencies are in milliseconds where a row says "in ms".

| label | published artifact |
|---|---|
| au01 | `out/2026-10-09/run-2026-10-09T23-57-24-149Z.json` |
| au01-final | `out/2026-10-10/run-2026-10-10T00-13-52-726Z.json` |
| au01-final2 | `out/2026-10-10/run-2026-10-10T00-14-53-112Z.json` |
| au02-run2 | `out/2026-10-10/run-2026-10-10T00-01-30-351Z.json` |
| au02-final | `out/2026-10-10/run-2026-10-10T00-13-16-939Z.json` |
| au03-run2 | `out/2026-10-10/run-2026-10-10T00-08-26-464Z.json` |
| au03-run3 | `out/2026-10-10/run-2026-10-10T00-09-32-436Z.json` |
| au04 | `out/2026-10-10/run-2026-10-10T00-11-01-907Z.json` |
| au04-run2 | `out/2026-10-10/run-2026-10-10T00-11-41-807Z.json` |
| au04-final | `out/2026-10-10/run-2026-10-10T00-26-40-222Z.json` |
```

- [x] **Step 3: Verify**

Run: `git status --short --untracked-files=all experiments/auth-providers/out | wc -l`
Expected: `20`

Run: `rg -n '"name": "' experiments/auth-providers/out/ | rg -v '"name": "(log_|unindexed|auth_rls|unused_)'`
Expected: no output.

Run: `rg -c '~/work' experiments/auth-providers/out/2026-10-10/run-2026-10-10T00-08-26-464Z.json; rg -l '/Users/|/home/' experiments/auth-providers/out/`
Expected: `1` (the AU03 stack trace line, redacted by Task 1b), then no output.

Run the sensors. Expected: `tsc exit 0`; `1625 pass`, ` 0 fail`.

- [x] **Step 4: Commit**

```bash
git add experiments/auth-providers/out experiments/auth-providers/RUNLOG.md
git commit -m "docs(auth-providers): publish the 2026-10-10 run artifacts and cite them (#131)"
```

---

### Task 3: hostname-path - add the publish target, publish, re-cite (#132)

**Files:**
- Modify: `experiments/hostname-path/Makefile` (append target)
- Create: `experiments/hostname-path/out/2026-10-10/` (7 runs)
- Modify: `experiments/hostname-path/RUNLOG.md:21-25`

- [x] **Step 1: Add the target (copied from `experiments/auth-providers/Makefile`)**

**Append to `experiments/hostname-path/Makefile`:**

```text

.PHONY: publish-evidence

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
```

(The recipe lines start with a TAB.)

Run: `make -C experiments/hostname-path publish-evidence 2>&1 | rg 'required'`
Expected: `RUN=evidence/<ts>/run-<stamp>.json required`

- [x] **Step 2: Publish**

```bash
make -C experiments/hostname-path publish-evidence RUN=evidence/20261010-122802/run-2026-10-10T04-28-02-410Z.json
make -C experiments/hostname-path publish-evidence RUN=evidence/20261010-122852/run-2026-10-10T04-28-53-141Z.json
make -C experiments/hostname-path publish-evidence RUN=evidence/20261010-123323/run-2026-10-10T04-33-23-282Z.json
make -C experiments/hostname-path publish-evidence RUN=evidence/20261010-123430/run-2026-10-10T04-34-30-810Z.json
make -C experiments/hostname-path publish-evidence RUN=evidence/20261010-124147/run-2026-10-10T04-41-47-267Z.json
make -C experiments/hostname-path publish-evidence RUN=evidence/20261010-124315/run-2026-10-10T04-43-15-504Z.json
make -C experiments/hostname-path publish-evidence RUN=evidence/20261010-124339/run-2026-10-10T04-43-39-984Z.json
```

Expected: seven `published ... -> .../out/2026-10-10` lines, result counts
5, 10, 2, 9, 6, 4, 1, all with 0 unredacted tokens and 0 credential ids.

- [x] **Step 3: Re-cite in the RUNLOG**

**Replace in `experiments/hostname-path/RUNLOG.md`:**

```text
Artifacts (gitignored `evidence/<ts>/`, copies kept outside the repo; not yet
published to `out/`): `20261010-122802` (HP01, HP02 first pass),
`20261010-122852` (HP02, HP03 first cycle, HP04, HP05), `20261010-123323` (HP04
re-run), `20261010-123430` (HP06, HP07, HP08), `20261010-124147` (HP03 second
cycle, HP04), `20261010-124315` (HP05 with HP05d), `20261010-124339` (HP09).
```

**with:**

```text
Artifacts (raw in the gitignored `evidence/<ts>/`, copies kept outside the
repo; redacted copies, each with a `.facts.md` beside it, in `out/2026-10-10/`):

| evidence dir | modules | published artifact |
|---|---|---|
| `20261010-122802` | HP01, HP02 first pass | `out/2026-10-10/run-2026-10-10T04-28-02-410Z.json` |
| `20261010-122852` | HP02, HP03 first cycle, HP04, HP05 | `out/2026-10-10/run-2026-10-10T04-28-53-141Z.json` |
| `20261010-123323` | HP04 re-run | `out/2026-10-10/run-2026-10-10T04-33-23-282Z.json` |
| `20261010-123430` | HP06, HP07, HP08 | `out/2026-10-10/run-2026-10-10T04-34-30-810Z.json` |
| `20261010-124147` | HP03 second cycle, HP04 | `out/2026-10-10/run-2026-10-10T04-41-47-267Z.json` |
| `20261010-124315` | HP05 with HP05d | `out/2026-10-10/run-2026-10-10T04-43-15-504Z.json` |
| `20261010-124339` | HP09 | `out/2026-10-10/run-2026-10-10T04-43-39-984Z.json` |
```

- [x] **Step 4: Verify**

Run: `git status --short --untracked-files=all experiments/hostname-path/out | wc -l`
Expected: `14`

Run the sensors. Expected: `tsc exit 0`; `1639 pass`, ` 0 fail`.

- [x] **Step 5: Commit**

```bash
git add experiments/hostname-path/Makefile experiments/hostname-path/out experiments/hostname-path/RUNLOG.md
git commit -m "docs(hostname-path): add publish-evidence, publish the 2026-10-10 artifacts (#132)"
```

---

### Task 4: free-email-templates - publish and re-cite (#133)

**Files:**
- Create: `experiments/free-email-templates/out/2026-10-10/` (3 runs)
- Modify: `experiments/free-email-templates/RUNLOG.md:3-7`

- [x] **Step 1: Publish**

```bash
make -C experiments/free-email-templates publish-evidence RUN=evidence/run1/run-2026-10-10T07-20-50-952Z.json
make -C experiments/free-email-templates publish-evidence RUN=evidence/run2/run-2026-10-10T07-22-08-083Z.json
make -C experiments/free-email-templates publish-evidence RUN=evidence/run3/run-2026-10-10T07-23-12-964Z.json
```

Expected: three `published ... -> .../out/2026-10-10` lines, 8, 13 and 9
results, 0 unredacted tokens and 0 credential ids. (This Makefile narrows with
`ONLY`; leave it unset.)

- [x] **Step 2: Re-cite in the RUNLOG**

**Replace in `experiments/free-email-templates/RUNLOG.md`:**

```text
not recorded here. Evidence stays in gitignored
`evidence/`; it has not been published to `out/` yet, so the figures below are
transcribed from the run artifacts' measurement tables and each cites its
module id and run.
```

**with:**

```text
not recorded here. Raw evidence stays in the gitignored `evidence/`; the
figures below are transcribed from the run artifacts' measurement tables and
each cites its module id and run. Redacted copies, each with a `.facts.md`
beside it: run 1 `out/2026-10-10/run-2026-10-10T07-20-50-952Z.json`, run 2
`out/2026-10-10/run-2026-10-10T07-22-08-083Z.json`, run 3
`out/2026-10-10/run-2026-10-10T07-23-12-964Z.json`.
```

- [x] **Step 3: Verify**

Run: `git status --short --untracked-files=all experiments/free-email-templates/out | wc -l`
Expected: `6`

Run the sensors. Expected: `tsc exit 0`; `1645 pass`, ` 0 fail`.

- [x] **Step 4: Commit**

```bash
git add experiments/free-email-templates/out experiments/free-email-templates/RUNLOG.md
git commit -m "docs(free-email-templates): publish the 2026-10-10 run artifacts and cite them (#133)"
```

---

### Task 5: jit-db-access - publish and re-cite (#134)

**Files:**
- Create: `experiments/jit-db-access/out/2026-10-10/` (6 runs)
- Modify: `experiments/jit-db-access/RUNLOG.md:3-7`

- [x] **Step 1: Publish** (all six runs in the RUNLOG's run table, including the exploratory one)

```bash
make -C experiments/jit-db-access publish-evidence RUN=evidence/dry-reused/run-2026-10-10T01-28-01-903Z.json
make -C experiments/jit-db-access publish-evidence RUN=evidence/20261010-094218/run-2026-10-10T01-42-19-583Z.json
make -C experiments/jit-db-access publish-evidence RUN=evidence/20261010-095106/run-2026-10-10T01-51-06-255Z.json
make -C experiments/jit-db-access publish-evidence RUN=evidence/20261010-095754/run-2026-10-10T01-57-55-066Z.json
make -C experiments/jit-db-access publish-evidence RUN=evidence/20261010-101035/run-2026-10-10T02-10-36-037Z.json
make -C experiments/jit-db-access publish-evidence RUN=evidence/20261010-104116/run-2026-10-10T02-41-17-188Z.json
```

Expected: six `published ... -> .../out/2026-10-10` lines, 12 results each,
0 unredacted tokens and 0 credential ids.

- [x] **Step 2: Re-cite in the RUNLOG**

**Replace in `experiments/jit-db-access/RUNLOG.md`:**

```text
user id and email are not recorded here (the org class is). Artifacts are in
`evidence/` (gitignored); no `out/` copy was published for these runs, so the
rows below are quoted from the `evidence/<ts>/run-*.json` files named in the
table.
```

**with:**

```text
user id and email are not recorded here (the org class is). Raw artifacts are
in `evidence/` (gitignored); the rows below are quoted from them. Each
artifact stamp in the run table is published redacted as
`out/2026-10-10/run-2026-10-10T<stamp>.json`, with a `.facts.md` beside it.
```

- [x] **Step 3: Verify**

Run: `git status --short --untracked-files=all experiments/jit-db-access/out | wc -l`
Expected: `12`

Run the sensors. Expected: `tsc exit 0`; `1657 pass`, ` 0 fail`.

- [x] **Step 4: Commit**

```bash
git add experiments/jit-db-access/out experiments/jit-db-access/RUNLOG.md
git commit -m "docs(jit-db-access): publish the 2026-10-10 run artifacts and cite them (#134)"
```

---

### Task 6: restore-paths - publish target, publish, re-cite (#135)

**Files:**
- Modify: `experiments/restore-paths/Makefile` (rename the `RUN` command variable, append target)
- Create: `experiments/restore-paths/evidence/rp03-run2/run-2026-10-10T01-30-06-076Z-rp03.json` (gitignored copy)
- Create: `experiments/restore-paths/out/2026-10-10/` (10 runs)
- Modify: `experiments/restore-paths/RUNLOG.md:7-8, 41, 87-89`

Two traps. The Makefile already defines `RUN :=` as the harness command, so
a `publish-evidence` target reading `$(RUN)` would run that command string
when `RUN=` is omitted; rename it to `PVLAB`. And R2 (`rp02-run2`) and R7
(`rp03-run2`) started in the same millisecond, so both artifacts are named
`run-2026-10-10T01-30-06-076Z.json`; `publish-evidence.ts` names its output
after the input file and would silently overwrite the first with the second.
R7 is published from a suffixed copy.

- [x] **Step 1: Rename the command variable**

**Replace in `experiments/restore-paths/Makefile`:**

```text
RUN := cd $(ROOT) && bun harness/src/run.ts
```

**with:**

```text
PVLAB := cd $(ROOT) && bun harness/src/run.ts
```

Then: `sd '\$\(RUN\) --only' '$(PVLAB) --only' experiments/restore-paths/Makefile`

Run: `rg -c '\$\(PVLAB\)' experiments/restore-paths/Makefile; rg -c '\$\(RUN\)' experiments/restore-paths/Makefile`
Expected: `3`, then no output (exit 1).

Run: `make -n -C experiments/restore-paths surface | tail -1`
Expected: a line starting `cd /` and containing `bun harness/src/run.ts --tests experiments/restore-paths/tests --where local --experiment restore-paths --destructive --only RP01 --out experiments/restore-paths/evidence/`

- [x] **Step 2: Add the target (copied from `experiments/auth-providers/Makefile`)**

**Append to `experiments/restore-paths/Makefile`:**

```text

.PHONY: publish-evidence

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
```

Run: `make -C experiments/restore-paths publish-evidence 2>&1 | rg 'required'`
Expected: `RUN=evidence/<ts>/run-<stamp>.json required`

- [x] **Step 3: Publish**

```bash
cp experiments/restore-paths/evidence/rp03-run2/run-2026-10-10T01-30-06-076Z.json experiments/restore-paths/evidence/rp03-run2/run-2026-10-10T01-30-06-076Z-rp03.json
make -C experiments/restore-paths publish-evidence RUN=evidence/rp01/run-2026-10-10T01-22-13-170Z.json
make -C experiments/restore-paths publish-evidence RUN=evidence/rp01/run-2026-10-10T01-27-07-341Z.json
make -C experiments/restore-paths publish-evidence RUN=evidence/rp02-run2/run-2026-10-10T01-30-06-076Z.json
make -C experiments/restore-paths publish-evidence RUN=evidence/rp02-run3/run-2026-10-10T01-42-15-008Z.json
make -C experiments/restore-paths publish-evidence RUN=evidence/rp02-run4-1500mb/run-2026-10-10T01-42-15-009Z.json
make -C experiments/restore-paths publish-evidence RUN=evidence/rp02-run5-500mb/run-2026-10-10T01-57-31-964Z.json
make -C experiments/restore-paths publish-evidence RUN=evidence/rp02-run6/run-2026-10-10T02-11-13-334Z.json
make -C experiments/restore-paths publish-evidence RUN=evidence/rp03-run2/run-2026-10-10T01-30-06-076Z-rp03.json
make -C experiments/restore-paths publish-evidence RUN=evidence/rp03-run3/run-2026-10-10T01-43-58-645Z.json
make -C experiments/restore-paths publish-evidence RUN=evidence/rp03-run4/run-2026-10-10T02-19-59-081Z.json
```

Expected: ten `published ... -> .../out/2026-10-10` lines, result counts 3,
5, 8, 8, 8, 8, 8, 7, 7, 7, 0 unredacted tokens and 0 credential ids.

- [x] **Step 4: Re-cite in the RUNLOG**

**Replace in `experiments/restore-paths/RUNLOG.md`:**

```text
observation at the end of the session; no snapshot was saved). Raw
artifacts carry project refs and stay off-repo (`evidence/`).
```

**with:**

```text
observation at the end of the session; no snapshot was saved). Raw
artifacts carry project refs and stay off-repo (`evidence/`); redacted
copies are listed under the run table.
```

**Replace in `experiments/restore-paths/RUNLOG.md`:**

```text
| R9 | RP03 | 02:19 | as R7, with the Management API SQL call fixed (R7 and R8 sent it with an empty project path) | 1 |
```

**with:**

```text
| R9 | RP03 | 02:19 | as R7, with the Management API SQL call fixed (R7 and R8 sent it with an empty project path) | 1 |

Published artifacts (redacted, a `.facts.md` beside each):

| run | artifact |
|---|---|
| RP01 first attempt (about 01:22) | `out/2026-10-10/run-2026-10-10T01-22-13-170Z.json` |
| R1 | `out/2026-10-10/run-2026-10-10T01-27-07-341Z.json` |
| R2 | `out/2026-10-10/run-2026-10-10T01-30-06-076Z.json` |
| R3 | `out/2026-10-10/run-2026-10-10T01-42-15-008Z.json` |
| R4 | `out/2026-10-10/run-2026-10-10T01-42-15-009Z.json` |
| R5 | `out/2026-10-10/run-2026-10-10T01-57-31-964Z.json` |
| R6 | `out/2026-10-10/run-2026-10-10T02-11-13-334Z.json` |
| R7 | `out/2026-10-10/run-2026-10-10T01-30-06-076Z-rp03.json` (R2 and R7 started in the same millisecond; the suffix keeps R7 from overwriting R2) |
| R8 | `out/2026-10-10/run-2026-10-10T01-43-58-645Z.json` |
| R9 | `out/2026-10-10/run-2026-10-10T02-19-59-081Z.json` |
```

**Replace in `experiments/restore-paths/RUNLOG.md`:**

```text
module; artifact `rp01/run-2026-10-10T01-22-13-170Z.json` in the off-repo
evidence copy, `fresh_physical_backups=0`) found the listing empty at the same
```

**with:**

```text
module; artifact `out/2026-10-10/run-2026-10-10T01-22-13-170Z.json`,
`fresh_physical_backups=0`) found the listing empty at the same
```

- [x] **Step 5: Verify**

Run: `git status --short --untracked-files=all experiments/restore-paths/out | wc -l`
Expected: `20`

Run: `jq -r '[.results[].id] | join(",")' experiments/restore-paths/out/2026-10-10/run-2026-10-10T01-30-06-076Z.json experiments/restore-paths/out/2026-10-10/run-2026-10-10T01-30-06-076Z-rp03.json`
Expected: `RP02a,RP02b,RP02c,RP02d,RP02e,RP02f,RP02f2,RP02g` then `RP03a,RP03b,RP03c,RP03d,RP03e,RP03f,RP03g` (R2 survived; R7 has its own file).

Run the sensors. Expected: `tsc exit 0`; `1677 pass`, ` 0 fail`.

- [x] **Step 6: Commit**

```bash
git add experiments/restore-paths/Makefile experiments/restore-paths/out experiments/restore-paths/RUNLOG.md
git commit -m "docs(restore-paths): add publish-evidence, publish the 2026-10-10 artifacts (#135)"
```

---

### Task 7: pooler-checkout - publish and re-cite (#136)

**Files:**
- Create: `experiments/pooler-checkout/out/2026-10-10/` (7 runs)
- Modify: `experiments/pooler-checkout/RUNLOG.md:16-30`
- Modify: `AGENTS.md:2642-2644`

- [x] **Step 1: Publish**

```bash
make -C experiments/pooler-checkout publish-evidence RUN=evidence/20261010-095322/run-2026-10-10T01-53-22-718Z.json
make -C experiments/pooler-checkout publish-evidence RUN=evidence/20261010-104011/run-2026-10-10T02-40-11-359Z.json
make -C experiments/pooler-checkout publish-evidence RUN=evidence/20261010-110914/run-2026-10-10T03-09-14-920Z.json
make -C experiments/pooler-checkout publish-evidence RUN=evidence/20261010-112056/run-2026-10-10T03-20-56-512Z.json
make -C experiments/pooler-checkout publish-evidence RUN=evidence/20261010-113309/run-2026-10-10T03-33-09-220Z.json
make -C experiments/pooler-checkout publish-evidence RUN=evidence/20261010-113347/run-2026-10-10T03-33-47-691Z.json
make -C experiments/pooler-checkout publish-evidence RUN=evidence/20261010-114645/run-2026-10-10T03-46-45-971Z.json
```

Expected: seven `published ... -> .../out/2026-10-10` lines, result counts
32, 35, 11, 15, 5, 15, 5, 0 unredacted tokens and 0 credential ids.

- [x] **Step 2: Re-cite in the RUNLOG and AGENTS.md**

**Replace in `experiments/pooler-checkout/RUNLOG.md`:**

```text
`max_connections` 60. Raw artifacts are in the ignored `evidence/<ts>/` and are
not published to `out/` here, so the figures below were quoted by hand from those
artifacts and have no tracked copy.
```

**with:**

```text
`max_connections` 60. Raw artifacts are in the ignored `evidence/<ts>/`; the
figures below were quoted by hand from them. Redacted copies, each with a
`.facts.md` beside it, are in the run table's last column.
```

**Replace in `experiments/pooler-checkout/RUNLOG.md`:**

```text
| Run | Evidence dir | Modules | Note |
|---|---|---|---|
| 1 | `20261010-095322` | PC01-PC04, PC09 | PC02 void: the laptop idle-slept mid-module (below). PC01, PC03, PC04 rows are valid |
| 2 | `20261010-104011` | PC01-PC04, PC09 | run under `caffeinate`; adds the host clock rows |
| 3 | `20261010-110914` | PC02, PC09 | adds PC02h |
| 4 | `20261010-112056` | PC03, PC09 | probe retry delay 300 ms (runs 1 and 2 retried at 0 ms) |
| 5 | `20261010-113309` | PC04, PC09 | adds PC04d |
| 6 | `20261010-113347` | PC03, PC09 | as run 4, plus the head of a crashed process's stderr |
| 7 | `20261010-114645` | PC04, PC09 | project in `us-east-1` |
```

**with:**

```text
| Run | Evidence dir | Modules | Note | Published artifact |
|---|---|---|---|---|
| 1 | `20261010-095322` | PC01-PC04, PC09 | PC02 void: the laptop idle-slept mid-module (below). PC01, PC03, PC04 rows are valid | `out/2026-10-10/run-2026-10-10T01-53-22-718Z.json` |
| 2 | `20261010-104011` | PC01-PC04, PC09 | run under `caffeinate`; adds the host clock rows | `out/2026-10-10/run-2026-10-10T02-40-11-359Z.json` |
| 3 | `20261010-110914` | PC02, PC09 | adds PC02h | `out/2026-10-10/run-2026-10-10T03-09-14-920Z.json` |
| 4 | `20261010-112056` | PC03, PC09 | probe retry delay 300 ms (runs 1 and 2 retried at 0 ms) | `out/2026-10-10/run-2026-10-10T03-20-56-512Z.json` |
| 5 | `20261010-113309` | PC04, PC09 | adds PC04d | `out/2026-10-10/run-2026-10-10T03-33-09-220Z.json` |
| 6 | `20261010-113347` | PC03, PC09 | as run 4, plus the head of a crashed process's stderr | `out/2026-10-10/run-2026-10-10T03-33-47-691Z.json` |
| 7 | `20261010-114645` | PC04, PC09 | project in `us-east-1` (the facts header shows the harness region) | `out/2026-10-10/run-2026-10-10T03-46-45-971Z.json` |
```

**Replace in `AGENTS.md`:**

```text
Micro project per run. IPv4-only vantage in Singapore. Raw artifacts are in the
ignored `evidence/`; none published to `out/`. Details: RUNLOG.md.
```

**with:**

```text
Micro project per run. IPv4-only vantage in Singapore. Raw artifacts are in the
ignored `evidence/`; redacted copies in `out/2026-10-10/`. Details: RUNLOG.md.
```

- [x] **Step 3: Verify**

Run: `git status --short --untracked-files=all experiments/pooler-checkout/out | wc -l`
Expected: `14`

Run: `rg -l '/Users/|/home/' experiments/pooler-checkout/out/`
Expected: no output (run 6's captured stderr had a home path; Task 1b redacts it to `~`).

Run the sensors. Expected: `tsc exit 0`; `1691 pass`, ` 0 fail`.

- [x] **Step 4: Commit**

```bash
git add experiments/pooler-checkout/out experiments/pooler-checkout/RUNLOG.md AGENTS.md
git commit -m "docs(pooler-checkout): publish the 2026-10-10 run artifacts and cite them (#136)"
```

---

### Task 8: pipelines - publish target, publish, re-cite (#137)

**Files:**
- Modify: `experiments/pipelines/Makefile` (append target)
- Modify: `experiments/pipelines/.gitignore` (drop its `out/` line)
- Create: `experiments/pipelines/out/2026-10-10/` (4 runs)
- Modify: `experiments/pipelines/RUNLOG.md:59-60`

The RUNLOG quotes run 1 (`final/`), run 2 (`final-pl07-rerun/`), PL99
(`final-pl99/`) and one development run for PL07c's `41.4` s
(`dev/run-2026-10-10T07-16-05-316Z.json`, `restart_to_drained_s` 41.4).

This experiment's own `.gitignore` lists `out/`, which overrides the root
`.gitignore`'s carve-out for dated `out/20*/` directories: without Step 2 the
published files are written but `git add` silently skips them. The root rules
already ignore anything at the `out/` root, so the line can go.

- [x] **Step 1: Add the target (copied from `experiments/auth-providers/Makefile`)**

**Append to `experiments/pipelines/Makefile`:**

```text

.PHONY: publish-evidence

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
# PUBLISH_ONLY, not ONLY, narrows it: ONLY has a default above.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
```

Run: `make -C experiments/pipelines publish-evidence 2>&1 | rg 'required'`
Expected: `RUN=evidence/<ts>/run-<stamp>.json required`

- [x] **Step 2: Stop the experiment's .gitignore from hiding the dated out/ dirs**

**Replace in `experiments/pipelines/.gitignore`:**

```text
evidence/
out/
```

**with:**

```text
evidence/
```

Run: `git check-ignore -v experiments/pipelines/out/2026-10-10/x.json; echo "rc=$?"`
Expected: `rc=1` (not ignored; the path need not exist).

- [x] **Step 3: Publish**

```bash
make -C experiments/pipelines publish-evidence RUN=evidence/final/run-2026-10-10T07-27-52-201Z.json
make -C experiments/pipelines publish-evidence RUN=evidence/final-pl07-rerun/run-2026-10-10T08-36-43-666Z.json
make -C experiments/pipelines publish-evidence RUN=evidence/final-pl99/run-2026-10-10T08-48-48-931Z.json
make -C experiments/pipelines publish-evidence RUN=evidence/dev/run-2026-10-10T07-16-05-316Z.json
```

Expected: four `published ... -> .../out/2026-10-10` lines, 45, 6, 1 and 6
results, 0 unredacted tokens and 0 credential ids.

- [x] **Step 4: Re-cite in the RUNLOG**

**Replace in `experiments/pipelines/RUNLOG.md`:**

```text
removed. No AWS or Cloudflare resource was created. Figures are pasted from
`pvlab --facts` of the run artifacts (untracked `evidence/`).
```

**with:**

```text
removed. No AWS or Cloudflare resource was created. Figures are pasted from
`pvlab --facts` of the run artifacts (raw copies in the untracked
`evidence/`). Redacted copies, each with a `.facts.md` beside it: run 1
`out/2026-10-10/run-2026-10-10T07-27-52-201Z.json`, run 2
`out/2026-10-10/run-2026-10-10T08-36-43-666Z.json`, PL99
`out/2026-10-10/run-2026-10-10T08-48-48-931Z.json`, and the development run
PL07c quotes `out/2026-10-10/run-2026-10-10T07-16-05-316Z.json`.
```

- [x] **Step 5: Verify**

Run: `git status --short --untracked-files=all experiments/pipelines/out | wc -l`
Expected: `8`

Run the sensors. Expected: `tsc exit 0`; `1699 pass`, ` 0 fail`.

- [x] **Step 6: Commit**

```bash
git add experiments/pipelines/Makefile experiments/pipelines/.gitignore experiments/pipelines/out experiments/pipelines/RUNLOG.md
git commit -m "docs(pipelines): add publish-evidence, publish the 2026-10-10 artifacts (#137)"
```

---

### Task 9: observability-surface - publish target, publish, re-cite (#138)

**Files:**
- Modify: `experiments/observability-surface/Makefile` (append target)
- Modify: `experiments/observability-surface/.gitignore` (drop its `out/` line)
- Create: `experiments/observability-surface/out/2026-10-10/` (10 runs)
- Modify: `experiments/observability-surface/RUNLOG.md:6-11, 317-318`

`evidence/run1/OB04/run-2026-10-10T00-39-36-663Z.json` has no results and is
not published. `ob01-clients.json`, `ob02-polls.json` and `ob03-canary.json`
are side files, not run artifacts (`publish-evidence.ts` cannot read them);
they stay in `evidence/`. As in pipelines, the experiment's own `.gitignore`
lists `out/` and would hide the published files from `git add` (Step 2).

- [x] **Step 1: Add the target (copied from `experiments/auth-providers/Makefile`)**

**Append to `experiments/observability-surface/Makefile`:**

```text

.PHONY: publish-evidence

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
```

Run: `make -C experiments/observability-surface publish-evidence 2>&1 | rg 'required'`
Expected: `RUN=evidence/<ts>/run-<stamp>.json required`

- [x] **Step 2: Stop the experiment's .gitignore from hiding the dated out/ dirs**

**Replace in `experiments/observability-surface/.gitignore`:**

```text
evidence/
out/
.wrangler/
```

**with:**

```text
evidence/
.wrangler/
```

Run: `git check-ignore -v experiments/observability-surface/out/2026-10-10/x.json; echo "rc=$?"`
Expected: `rc=1`

- [x] **Step 3: Publish**

```bash
make -C experiments/observability-surface publish-evidence RUN=evidence/run1/OB01/run-2026-10-10T00-36-30-860Z.json
make -C experiments/observability-surface publish-evidence RUN=evidence/run1/OB02/run-2026-10-10T00-35-30-688Z.json
make -C experiments/observability-surface publish-evidence RUN=evidence/run1/OB03/run-2026-10-10T00-48-25-371Z.json
make -C experiments/observability-surface publish-evidence RUN=evidence/run1/OB04/run-2026-10-10T00-39-42-004Z.json
make -C experiments/observability-surface publish-evidence RUN=evidence/run1/OB05/run-2026-10-10T00-40-48-205Z.json
make -C experiments/observability-surface publish-evidence RUN=evidence/run2/OB01/run-2026-10-10T00-45-35-196Z.json
make -C experiments/observability-surface publish-evidence RUN=evidence/run2/OB02/run-2026-10-10T00-59-06-273Z.json
make -C experiments/observability-surface publish-evidence RUN=evidence/run2/OB05/run-2026-10-10T00-59-15-215Z.json
make -C experiments/observability-surface publish-evidence RUN=evidence/run3/OB01/run-2026-10-10T01-10-20-267Z.json
make -C experiments/observability-surface publish-evidence RUN=evidence/run3/OB02/run-2026-10-10T01-23-47-158Z.json
```

Expected: ten `published ... -> .../out/2026-10-10` lines, result counts 40,
11, 7, 5, 6, 41, 8, 6, 41, 5, 0 unredacted tokens and 0 credential ids.

- [x] **Step 4: Re-cite in the RUNLOG**

**Replace in `experiments/observability-surface/RUNLOG.md`:**

```text
machine. Run artifacts are `evidence/run1/` to `evidence/run3/` (gitignored:
they carry project refs); they were not published to `out/`, so the figures
below are quoted from those artifacts and are not yet citable by artifact.
```

**with:**

```text
machine. Raw run artifacts are `evidence/run1/` to `evidence/run3/`
(gitignored: they carry project refs); the figures below are quoted from them
and the redacted copies are listed under "Published artifacts" below. The side
files `ob01-clients.json`, `ob02-polls.json` and `ob03-canary.json` are not
run artifacts and stay in `evidence/`.
```

**Replace in `experiments/observability-surface/RUNLOG.md`:**

```text
(checked with `GET /v1/projects` after the last run: none named `ob-surface-`
remained).
```

**with:**

```text
(checked with `GET /v1/projects` after the last run: none named `ob-surface-`
remained).

Published artifacts (redacted, a `.facts.md` beside each, `out/2026-10-10/`):

| run | module | artifact |
|---|---|---|
| run1 | OB01 | `run-2026-10-10T00-36-30-860Z.json` |
| run1 | OB02 | `run-2026-10-10T00-35-30-688Z.json` |
| run1 | OB03 | `run-2026-10-10T00-48-25-371Z.json` |
| run1 | OB04 | `run-2026-10-10T00-39-42-004Z.json` |
| run1 | OB05 | `run-2026-10-10T00-40-48-205Z.json` |
| run2 | OB01 | `run-2026-10-10T00-45-35-196Z.json` |
| run2 | OB02 | `run-2026-10-10T00-59-06-273Z.json` |
| run2 | OB05 | `run-2026-10-10T00-59-15-215Z.json` |
| run3 | OB01 | `run-2026-10-10T01-10-20-267Z.json` |
| run3 | OB02 | `run-2026-10-10T01-23-47-158Z.json` |
```

**Replace in `experiments/observability-surface/RUNLOG.md`:**

```text
  access token` to the PAT. Only the Pro-org 403s were kept, in a run artifact
  that is not in the repo (gitignored `evidence/`). No drain was created, so OB04d (batch size, flush
```

**with:**

```text
  access token` to the PAT. Only the Pro-org 403s were kept, in the run1 OB04
  artifact (`out/2026-10-10/run-2026-10-10T00-39-42-004Z.json`). No drain was created, so OB04d (batch size, flush
```

- [x] **Step 5: Verify**

Run: `git status --short --untracked-files=all experiments/observability-surface/out | wc -l`
Expected: `20`

Run the sensors. Expected: `tsc exit 0`; `1719 pass`, ` 0 fail`.

- [x] **Step 6: Commit**

```bash
git add experiments/observability-surface/Makefile experiments/observability-surface/.gitignore experiments/observability-surface/out experiments/observability-surface/RUNLOG.md
git commit -m "docs(observability-surface): add publish-evidence, publish the 2026-10-10 artifacts (#138)"
```

---

### Task 10: governed-starter-kit - publish target, publish, re-cite (#171)

**Files:**
- Modify: `experiments/governed-starter-kit/Makefile` (append target)
- Create: `experiments/governed-starter-kit/out/2026-10-08/` (6 runs), `experiments/governed-starter-kit/out/2026-10-09/` (4 runs)
- Modify: `experiments/governed-starter-kit/RUNLOG.md:333, 431, 441, 461, 556-557, 594-595`

Published: the ten run artifacts the RUNLOG cites by directory. Not
published: `evidence/users-*.json` (seeded demo users per project),
`evidence/faults*/` and `evidence/bff-local-*.json` (not run artifacts);
`evidence/agent-local-2026-10-08T10-1*.json` and
`evidence/bff-local-2026-10-08T09-59-19-565Z.json`, cited at RUNLOG 623 and
654, are no longer on disk (checked 2026-10-13) and stay cited as gitignored.
Uncited K01 runs (2026-10-05 to 2026-10-09) stay in `evidence/`.

- [x] **Step 1: Add the target (copied from `experiments/auth-providers/Makefile`)**

**Append to `experiments/governed-starter-kit/Makefile`:**

```text

.PHONY: publish-evidence

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
```

Run: `make -C experiments/governed-starter-kit publish-evidence 2>&1 | rg 'required'`
Expected: `RUN=evidence/<ts>/run-<stamp>.json required`

- [x] **Step 2: Publish**

```bash
make -C experiments/governed-starter-kit publish-evidence RUN=evidence/20261008-202521/run-2026-10-08T12-25-21-378Z.json
make -C experiments/governed-starter-kit publish-evidence RUN=evidence/20261008-202545/run-2026-10-08T12-25-46-029Z.json
make -C experiments/governed-starter-kit publish-evidence RUN=evidence/20261008-202628/run-2026-10-08T12-26-28-545Z.json
make -C experiments/governed-starter-kit publish-evidence RUN=evidence/20261009-061907/run-2026-10-08T22-19-07-768Z.json
make -C experiments/governed-starter-kit publish-evidence RUN=evidence/20261009-061934/run-2026-10-08T22-19-34-934Z.json
make -C experiments/governed-starter-kit publish-evidence RUN=evidence/20261009-061954/run-2026-10-08T22-19-54-915Z.json
make -C experiments/governed-starter-kit publish-evidence RUN=evidence/20261009-093738/run-2026-10-09T01-37-38-655Z.json
make -C experiments/governed-starter-kit publish-evidence RUN=evidence/20261009-093812/run-2026-10-09T01-38-12-919Z.json
make -C experiments/governed-starter-kit publish-evidence RUN=evidence/20261009-093936/run-2026-10-09T01-39-36-446Z.json
make -C experiments/governed-starter-kit publish-evidence RUN=evidence/20261009-111031/run-2026-10-09T03-10-31-406Z.json
```

Expected: ten `published ...` lines, 8 results each except the last (52);
the first six go to `out/2026-10-08` (UTC start dates), the last four to
`out/2026-10-09`; 0 unredacted tokens and 0 credential ids.

- [x] **Step 3: Re-cite in the RUNLOG**

**Replace in `experiments/governed-starter-kit/RUNLOG.md`:**

```text
  deploys). Artifact `evidence/20261009-111031/`.
```

**with:**

```text
  deploys). Artifact `out/2026-10-09/run-2026-10-09T03-10-31-406Z.json`.
```

**Replace in `experiments/governed-starter-kit/RUNLOG.md`:**

```text
  597 / 339. Artifact `evidence/20261009-093738/`.
```

**with:**

```text
  597 / 339. Artifact `out/2026-10-09/run-2026-10-09T01-37-38-655Z.json`.
```

**Replace in `experiments/governed-starter-kit/RUNLOG.md`:**

```text
  Artifact `evidence/20261009-093812/`.
```

**with:**

```text
  Artifact `out/2026-10-09/run-2026-10-09T01-38-12-919Z.json`.
```

**Replace in `experiments/governed-starter-kit/RUNLOG.md`:**

```text
  wording checks needed no adjustment. Artifact `evidence/20261009-093936/`.
```

**with:**

```text
  wording checks needed no adjustment. Artifact
  `out/2026-10-09/run-2026-10-09T01-39-36-446Z.json`.
```

**Replace in `experiments/governed-starter-kit/RUNLOG.md`:**

```text
  Artifacts `evidence/20261009-061934/` and `evidence/20261009-061954/`
  (warm-up `evidence/20261009-061907/`; gitignored).
```

**with:**

```text
  Artifacts `out/2026-10-08/run-2026-10-08T22-19-34-934Z.json` and
  `out/2026-10-08/run-2026-10-08T22-19-54-915Z.json` (warm-up
  `out/2026-10-08/run-2026-10-08T22-19-07-768Z.json`).
```

**Replace in `experiments/governed-starter-kit/RUNLOG.md`:**

```text
  Functions. Artifacts `evidence/20261008-2025*/` and
  `evidence/20261008-202628/` (gitignored).
```

**with:**

```text
  Functions. Artifacts `out/2026-10-08/run-2026-10-08T12-25-21-378Z.json`,
  `out/2026-10-08/run-2026-10-08T12-25-46-029Z.json` and
  `out/2026-10-08/run-2026-10-08T12-26-28-545Z.json`.
```

- [x] **Step 4: Verify**

Run: `git status --short --untracked-files=all experiments/governed-starter-kit/out | wc -l`
Expected: `20`

Run: `rg -n 'evidence/2026' experiments/governed-starter-kit/RUNLOG.md`
Expected: no output.

Run: `rg -n '"name": "' experiments/governed-starter-kit/out/ | rg -v '"name": "(log_|unindexed|auth_rls|unused_)'`
Expected: no output.

Run the sensors. Expected: `tsc exit 0`; `1739 pass`, ` 0 fail`.

- [x] **Step 5: Commit**

```bash
git add experiments/governed-starter-kit/Makefile experiments/governed-starter-kit/out experiments/governed-starter-kit/RUNLOG.md
git commit -m "docs(governed-starter-kit): add publish-evidence, publish the cited run artifacts (#171)"
```

---

### Task 11: usage-metering - RUNLOG for M03-M07, publish M04-M06 (#43)

**Files:**
- Create: `experiments/usage-metering/out/2026-08-18/` (5 runs)
- Modify: `experiments/usage-metering/RUNLOG.md` (append section)

usage-metering has no Makefile, so publish with the script directly. M03 left
no artifact (its AGENTS.md figures come from the fee7a22 commit message). M07's
artifact is NOT published: its evidence text lists the account's own project
names, which redaction does not touch; its measurement figures are quoted from
the facts render instead. The figures below were pasted from
`bun harness/src/run.ts --facts experiments/usage-metering/evidence/<run>.json`.

- [x] **Step 1: Publish M04, M05 (two runs) and M06 (two runs)**

```bash
(cd harness && bun scripts/publish-evidence.ts ../experiments/usage-metering/evidence/run-2026-08-18T06-31-21-134Z.json ../experiments/usage-metering)
(cd harness && bun scripts/publish-evidence.ts ../experiments/usage-metering/evidence/run-2026-08-18T06-21-24-941Z.json ../experiments/usage-metering)
(cd harness && bun scripts/publish-evidence.ts ../experiments/usage-metering/evidence/run-2026-08-18T06-25-18-819Z.json ../experiments/usage-metering)
(cd harness && bun scripts/publish-evidence.ts ../experiments/usage-metering/evidence/run-2026-08-18T06-36-29-484Z.json ../experiments/usage-metering)
(cd harness && bun scripts/publish-evidence.ts ../experiments/usage-metering/evidence/run-2026-08-18T06-39-38-374Z.json ../experiments/usage-metering)
```

Expected: five `published ... -> .../out/2026-08-18` lines with 4, 3, 3, 3,
3 results, 0 unredacted tokens and 0 credential ids.

- [x] **Step 2: Append the RUNLOG entry**

**Append to `experiments/usage-metering/RUNLOG.md`:**

```text

## 2026-08-18 - M03 to M07, written up from the run artifacts (work-supabase-lab#43)

The modules landed in fee7a22 ("M03-M07 green") on 2026-08-18 with no RUNLOG
entry. Figures are pasted from `pvlab --facts` of the local artifacts. The lab
commit stamped in them (5bce8da) predates the history rewrites and does not
resolve. Vantage local; every project in ap-southeast-1 on the Pro org,
provisioned and deleted by its module; n = 1 run per module unless a row
gives two.

Published (redacted, a `.facts.md` beside each), `out/2026-08-18/`:
`run-2026-08-18T06-31-21-134Z.json` (M04), `run-2026-08-18T06-21-24-941Z.json`
and `run-2026-08-18T06-25-18-819Z.json` (M05),
`run-2026-08-18T06-36-29-484Z.json` and `run-2026-08-18T06-39-38-374Z.json`
(M06). Not published: M07's artifact (`evidence/run-2026-08-18T06-44-26-417Z.json`),
because its evidence lists the account's own project names. M03 left no
artifact.

| Probe | Result | Read |
|---|---|---|
| M03 | no artifact in `evidence/` | the M03 figures in AGENTS.md (3 projects, $29.43/mo compute) come from the fee7a22 commit message and cannot be checked against a run |
| M04-control | gateway 200 | - |
| M04a | throwaway project provisioned in 137 s; upstream and two scoped keys set up (pass) | - |
| M04b | key A: 7 sent, 7 answered 200; key B: 5 sent, 5 answered 200 | - |
| M04c | events feed, key A: 7 events of 7 expected, 7 with the right project ref, 7 with status 200; key B: 5 of 5, 5, 5 | the feed matched the sent count for both keys in this run |
| M05-control | store provisioned in 135 s, schema 201 (both runs) | - |
| M05a | 06:21 run: 4 org projects, 0 rows inserted, own row absent, 0 read back. 06:25 run: 4 projects, 4 rows inserted, own row present, 4 read back | the second run is the self-inclusion result; why the first inserted nothing is not recorded in its artifact |
| M05b | tenant t-a 100 rows, t-b 25 rows; payload bytes 100400 and 25100 (both runs) | module detail: exact for variable-width columns via `pg_column_size`, an estimate for fixed-width |
| M06-control | provisioned in 134 s (both runs) | - |
| M06a | 06:36 run: fail, 2 rollup windows (`t-0@00h=500 t-1@01h=500`), identical after re-flush. 06:39 run: pass, 4 windows of 250 (`t-0` and `t-1` in 00h and 01h), identical after re-flush | the first run's seed put each tenant in one window; the change between the runs is not recorded |
| M06b | late insert 201; closed window moved by 5 (expected 5); duplicate idempotency key rejected; other windows unchanged (both runs) | - |
| M07-control | invoice PDF parsed: 91 per-ref lines | the compute-line count and hour total are in the local facts render, not copied here: they describe the account's billing, not the method |
| M07a | 32 invoiced refs; 3 live projects, 3 matched; 29 deleted since the invoice | - |
| M07b | 4 reconciled rows; largest share of the billing window 98.7% | - |
```

- [x] **Step 3: Verify**

Run: `git status --short --untracked-files=all experiments/usage-metering/out | wc -l`
Expected: `10`

Run: `bun harness/scripts/check-doc-numbers.ts experiments/usage-metering/RUNLOG.md experiments/usage-metering/out/2026-08-18/*.json experiments/usage-metering/evidence/run-2026-08-18T06-44-26-417Z.json`
Expected: exit 0 (the script lists, it does not fail) and exactly five flagged lines, all expected: the two M01
rows from 2026-08-17 (`9940115, 10128531` and `262144`; their artifacts are
not supplied), the stamp digits `941` and `819` in the new "Published"
paragraph's file names, and the M03 row's documented `29.43`. No M04-M07
table row is flagged.

Run the sensors. Expected: `tsc exit 0`; `1749 pass`, ` 0 fail`.

- [x] **Step 4: Commit**

```bash
git add experiments/usage-metering/out experiments/usage-metering/RUNLOG.md
git commit -m "docs(usage-metering): RUNLOG entry for M03-M07 from the 2026-08-18 artifacts (#43)"
```

> **Deviation 2026-10-13:** the first publish of
> `run-2026-08-18T06-25-18-819Z.json` kept three refs (see the note under
> Task 1b); re-published after the redactor fix, same five files.
> `check-doc-numbers.ts` flagged exactly the five expected lines. Sensors
> 1751 pass (plan 1749 + 2 redactor cases).

---

### Task 12: instance-sizing - RUNLOG for I04, publish the runs (#47)

**Files:**
- Create: `experiments/instance-sizing/out/2026-08-18/` (3 runs)
- Modify: `experiments/instance-sizing/RUNLOG.md` (insert before the 2026-08-24/25 addendum)

The first two I04 runs also hold a row `I04 - Source limits` (fail, "Unable
to connect"): image-transformations' module with the same id, which
`--only I04` selected from the shared registry at the time (AGENTS.md,
"Harness - id collisions and the experiment filter"). `--only
I04-control,I04a,I04b` drops it from the published copies. The 05:01
artifact has no results and is not published.

- [x] **Step 1: Publish**

```bash
(cd harness && bun scripts/publish-evidence.ts ../experiments/instance-sizing/evidence/run-2026-08-18T04-43-40-236Z.json ../experiments/instance-sizing --only I04-control,I04a,I04b)
(cd harness && bun scripts/publish-evidence.ts ../experiments/instance-sizing/evidence/run-2026-08-18T04-49-43-066Z.json ../experiments/instance-sizing --only I04-control,I04a,I04b)
(cd harness && bun scripts/publish-evidence.ts ../experiments/instance-sizing/evidence/run-2026-08-18T05-07-03-585Z.json ../experiments/instance-sizing --only I04-control,I04a,I04b)
```

Expected: three `published ... -> .../out/2026-08-18` lines, 3 results
each, 0 unredacted tokens and 0 credential ids.

- [x] **Step 2: Insert the RUNLOG entry**

**Replace in `experiments/instance-sizing/RUNLOG.md`:**

```text
## 2026-08-24/25 addendum - I01's "Nano absent" reading scoped by sfp-platforms
```

**with:**

```text
## 2026-08-18 - I04: a free org's compute surface and pause lifecycle (written up from the artifacts, work-supabase-lab#47)

Module `tests/i04-free-org.ts`, landed in d62dafd. Written from the local
artifacts with `pvlab --facts`; the lab commit stamped in them (f0c4460)
predates the history rewrites and does not resolve. One free-org project per
run in ap-southeast-1, created and deleted by the module; n = 3 runs.

Published (redacted, a `.facts.md` beside each), `out/2026-08-18/`:
`run-2026-08-18T04-43-40-236Z.json`, `run-2026-08-18T04-49-43-066Z.json`,
`run-2026-08-18T05-07-03-585Z.json`, each with `--only I04-control,I04a,I04b`.
The filter drops a row `I04 - Source limits` (fail) from the first two: the
image-transformations module with the same id, which `--only I04` also
selected from the shared registry then. A 05:01 artifact has no results and
is not published.

| Probe | 04:43 | 04:49 | 05:07 |
|---|---|---|---|
| I04-control: create without `desired_instance_size` | provision_s 13; compute_selected `none`; ci_nano_available 0; compute_variants_available empty | provision_s 12; same readback | provision_s 12; same readback |
| I04a: create with `desired_instance_size: nano` | 201, accepted | 201 | 201 |
| I04b: pause, wait for INACTIVE, restore | pause 200; reached INACTIVE; wake_s 182; final ACTIVE_HEALTHY | pause 200; INACTIVE; wake_s 162; ACTIVE_HEALTHY | pause 200; INACTIVE; wake_s 204; ACTIVE_HEALTHY |

While paused, the data API answered `HTTP 540: Project paused. Please unpause
the project before proceeding.` (I04b detail in the 04:43 and 04:49 runs; the
05:07 run records no detail).

## 2026-08-24/25 addendum - I01's "Nano absent" reading scoped by sfp-platforms
```

- [x] **Step 3: Verify**

Run: `git status --short --untracked-files=all experiments/instance-sizing/out | wc -l`
Expected: `6`

Run: `rg -c 'Source limits' experiments/instance-sizing/out/2026-08-18/`
Expected: no output (exit 1).

Run: `bun harness/scripts/check-doc-numbers.ts experiments/instance-sizing/RUNLOG.md experiments/instance-sizing/out/2026-08-18/*.json`
Expected: `every number on a measured line appears in an artifact`, exit 0.

Run the sensors. Expected: `tsc exit 0`; `1755 pass`, ` 0 fail`.

- [x] **Step 4: Commit**

```bash
git add experiments/instance-sizing/out experiments/instance-sizing/RUNLOG.md
git commit -m "docs(instance-sizing): RUNLOG entry for I04 from the 2026-08-18 artifacts (#47)"
```

> **Executed 2026-10-13:** as written; sensors 1757 pass (plan 1755 + 2
> redactor cases).

---

### Task 13: lifecycle-ops, scoped-pats, data-api-defaults - recover and publish (#151)

**Files:**
- Create (gitignored): `experiments/{lifecycle-ops,scoped-pats,data-api-defaults}/evidence/recovered/<dir>/`
- Modify: `experiments/lifecycle-ops/Makefile` (append target)
- Modify: `experiments/scoped-pats/Makefile` (rename `RUN` to `PVLAB`, append target)
- Create: `experiments/lifecycle-ops/out/2026-10-10/` (5 runs), `experiments/scoped-pats/out/2026-10-10/` (5 runs), `experiments/data-api-defaults/out/2026-10-09/` and `out/2026-10-10/` (1 run each)
- Modify: `experiments/lifecycle-ops/RUNLOG.md:12-14`, `experiments/scoped-pats/RUNLOG.md:3-4`, `experiments/data-api-defaults/RUNLOG.md:12-13`

The card's premise ("no local evidence") is half right: none of the three
experiments has an `evidence/` copy, but on 2026-10-13 the raw run JSON for
all three still sat in an earlier session's scratchpad under `/private/tmp`
(lifecycle-ops: 9 files, scoped-pats: 5, data-api-defaults: 2 runs plus 2
skip-only dry runs). `/private/tmp` is tmpfs and is wiped on reboot, so
Step 1 is time-critical; if it finds nothing, the artifacts are gone and the
fallback at the end of this task applies.

- [x] **Step 1: Recover the raw artifacts into the gitignored evidence/ dirs (do this first)**

> Done 2026-10-13 (run by hand right after this plan was written): all 18
> files below recovered, the set matching this list exactly; `git status`
> clean. The two `dd01s-dry*` runs are skip-only (no ref) - do not publish them.

```bash
fd -H -I -t f -e json '^run-2026-10-' /private/tmp 2>/dev/null | while read -r f; do
  e=$(jq -r '.experiment // empty' "$f" 2>/dev/null)
  case "$e" in lifecycle-ops|scoped-pats|data-api-defaults) ;; *) continue ;; esac
  d="experiments/$e/evidence/recovered/$(basename "$(dirname "$f")")"
  mkdir -p "$d" && cp -n "$f" "$d/" && { [ -f "${f%.json}.md" ] && cp -n "${f%.json}.md" "$d/"; true; }
  echo "$e <- $f"
done
fd -t f -e json . experiments/lifecycle-ops/evidence experiments/scoped-pats/evidence experiments/data-api-defaults/evidence/recovered | sort
```

Expected (paths relative to the repo):

```text
experiments/data-api-defaults/evidence/recovered/dd01s-dry1/run-2026-10-13T00-03-55-789Z.json
experiments/data-api-defaults/evidence/recovered/dd01s-dry2/run-2026-10-13T00-03-56-111Z.json
experiments/data-api-defaults/evidence/recovered/run1/run-2026-10-09T23-58-24-538Z.json
experiments/data-api-defaults/evidence/recovered/run2/run-2026-10-10T00-00-27-688Z.json
experiments/lifecycle-ops/evidence/recovered/lo01-try/run-2026-10-10T00-33-08-155Z.json
experiments/lifecycle-ops/evidence/recovered/lo01-try2/run-2026-10-10T00-33-52-888Z.json
experiments/lifecycle-ops/evidence/recovered/lo01-try2/run-2026-10-10T00-34-00-468Z.json
experiments/lifecycle-ops/evidence/recovered/lo01/run-2026-10-10T00-43-34-355Z.json
experiments/lifecycle-ops/evidence/recovered/lo02/run-2026-10-10T00-35-14-763Z.json
experiments/lifecycle-ops/evidence/recovered/lo02/run-2026-10-10T00-35-35-776Z.json
experiments/lifecycle-ops/evidence/recovered/lo03/run-2026-10-10T00-36-15-870Z.json
experiments/lifecycle-ops/evidence/recovered/lo04-05/run-2026-10-10T00-43-31-013Z.json
experiments/lifecycle-ops/evidence/recovered/lo05/run-2026-10-10T00-46-09-369Z.json
experiments/scoped-pats/evidence/recovered/20261010-matrix/run-2026-10-10T07-20-24-545Z.json
experiments/scoped-pats/evidence/recovered/20261010-org-standin/run-2026-10-10T07-22-34-771Z.json
experiments/scoped-pats/evidence/recovered/20261010-ro/run-2026-10-10T07-19-28-030Z.json
experiments/scoped-pats/evidence/recovered/20261010-ro/run-2026-10-10T07-19-47-655Z.json
experiments/scoped-pats/evidence/recovered/20261010-run1/run-2026-10-10T07-18-10-870Z.json
```

Then confirm `git status --short experiments/*/evidence` prints nothing
(`evidence/` is gitignored).

- [x] **Step 2: Publish targets**

**Append to `experiments/lifecycle-ops/Makefile`:**

```text

.PHONY: publish-evidence

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
# PUBLISH_ONLY, not ONLY, narrows it: ONLY has a default above.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
```

scoped-pats defines `RUN =` as its harness command (six uses), which the
documented `make publish-evidence RUN=...` would collide with. Rename it:

```bash
sd '^RUN = ' 'PVLAB = ' experiments/scoped-pats/Makefile
sd '\$\(RUN\)' '$(PVLAB)' experiments/scoped-pats/Makefile
```

**Append to `experiments/scoped-pats/Makefile`:**

```text

.PHONY: publish-evidence

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
```

Run: `rg -c '\$\(PVLAB\)' experiments/scoped-pats/Makefile; make -n -C experiments/scoped-pats probe | tail -1`
Expected: `6`, then a line starting `bun /` and ending
`--experiment scoped-pats --out <repo>/experiments/scoped-pats/evidence/<ts> --only SP01,SP06,SP10`.

Run: `make -C experiments/lifecycle-ops publish-evidence 2>&1 | rg required; make -C experiments/scoped-pats publish-evidence 2>&1 | rg required`
Expected: `RUN=evidence/<ts>/run-<stamp>.json required` twice.

- [x] **Step 3: Publish** (left out: `lo01-try*` (superseded tries), `lo02/...00-35-14-763Z` (no results), `dd01s-dry*` (skip-only))

```bash
make -C experiments/lifecycle-ops publish-evidence RUN=evidence/recovered/lo01/run-2026-10-10T00-43-34-355Z.json
make -C experiments/lifecycle-ops publish-evidence RUN=evidence/recovered/lo02/run-2026-10-10T00-35-35-776Z.json
make -C experiments/lifecycle-ops publish-evidence RUN=evidence/recovered/lo03/run-2026-10-10T00-36-15-870Z.json
make -C experiments/lifecycle-ops publish-evidence RUN=evidence/recovered/lo04-05/run-2026-10-10T00-43-31-013Z.json
make -C experiments/lifecycle-ops publish-evidence RUN=evidence/recovered/lo05/run-2026-10-10T00-46-09-369Z.json
make -C experiments/scoped-pats publish-evidence RUN=evidence/recovered/20261010-run1/run-2026-10-10T07-18-10-870Z.json
make -C experiments/scoped-pats publish-evidence RUN=evidence/recovered/20261010-ro/run-2026-10-10T07-19-28-030Z.json
make -C experiments/scoped-pats publish-evidence RUN=evidence/recovered/20261010-ro/run-2026-10-10T07-19-47-655Z.json
make -C experiments/scoped-pats publish-evidence RUN=evidence/recovered/20261010-matrix/run-2026-10-10T07-20-24-545Z.json
make -C experiments/scoped-pats publish-evidence RUN=evidence/recovered/20261010-org-standin/run-2026-10-10T07-22-34-771Z.json
make -C experiments/data-api-defaults publish-evidence RUN=evidence/recovered/run1/run-2026-10-09T23-58-24-538Z.json
make -C experiments/data-api-defaults publish-evidence RUN=evidence/recovered/run2/run-2026-10-10T00-00-27-688Z.json
```

Expected: twelve `published ...` lines with 0 unredacted tokens and 0
credential ids; data-api-defaults run 1 goes to `out/2026-10-09`, everything
else to `out/2026-10-10`. Then, as for every publish, read
`rg -n '"name": "' experiments/{lifecycle-ops,scoped-pats,data-api-defaults}/out/ | rg -v '"name": "(log_|unindexed|auth_rls|unused_)'`
before committing. scoped-pats SP01/SP06 evidence may carry the token's or
profile's display name; any file that does is dropped (delete its pair from
`out/`, keep the raw copy, and say so in the RUNLOG line below).

- [x] **Step 4: Cite in the RUNLOGs**

**Replace in `experiments/lifecycle-ops/RUNLOG.md`:**

```text
in LO03, one in LO04, one in LO05). All deleted; `GET /v1/projects` showed no
project with the `lo-` prefix at 01:06 UTC.
```

**with:**

```text
in LO03, one in LO04, one in LO05). All deleted; `GET /v1/projects` showed no
project with the `lo-` prefix at 01:06 UTC.

Published artifacts (redacted, a `.facts.md` beside each, `out/2026-10-10/`;
the raw copies were recovered from a session scratchpad on 2026-10-13 and sit
in the gitignored `evidence/recovered/`): LO01
`run-2026-10-10T00-43-34-355Z.json`; the failed first draft of the restart
module, run under the id LO02, `run-2026-10-10T00-35-35-776Z.json`; LO03
`run-2026-10-10T00-36-15-870Z.json`; LO04 with LO05
`run-2026-10-10T00-43-31-013Z.json`; LO05 `run-2026-10-10T00-46-09-369Z.json`.
```

**Replace in `experiments/scoped-pats/RUNLOG.md`:**

```text
recorded here. Raw artifacts carry refs and stay off-repo.
```

**with:**

```text
recorded here. Raw artifacts carry refs and stay off-repo (recovered from a
session scratchpad on 2026-10-13 into the gitignored `evidence/recovered/`).
Redacted copies, a `.facts.md` beside each, `out/2026-10-10/`:
`run-2026-10-10T07-18-10-870Z.json` (SP01, first run),
`run-2026-10-10T07-19-28-030Z.json` (SP01, SP06),
`run-2026-10-10T07-19-47-655Z.json` (SP10),
`run-2026-10-10T07-20-24-545Z.json` (SP02, SP03, SP05),
`run-2026-10-10T07-22-34-771Z.json` (SP04).
```

**Replace in `experiments/data-api-defaults/RUNLOG.md`:**

```text
70e4244 plus the uncommitted tree that adds this experiment. n = 1 project per
run, one trial per probe. Postgres 17.11 on both projects.
```

**with:**

```text
70e4244 plus the uncommitted tree that adds this experiment. n = 1 project per
run, one trial per probe. Postgres 17.11 on both projects. Published
(redacted, recovered from a session scratchpad on 2026-10-13): run 1
`out/2026-10-09/run-2026-10-09T23-58-24-538Z.json` (UTC start date), run 2
`out/2026-10-10/run-2026-10-10T00-00-27-688Z.json`, each with a `.facts.md`.
```

- [x] **Step 5: Verify**

Run: `git status --short --untracked-files=all experiments/lifecycle-ops/out experiments/scoped-pats/out experiments/data-api-defaults/out | wc -l`
Expected: `24` (10 + 10 + 4 new files; the four 2026-10-13 data-api-defaults files are already tracked).

Run the sensors. Expected: `tsc exit 0`; ` 0 fail`; pass count up by 24 from
the previous task.

- [x] **Step 6: Commit**

```bash
git add experiments/lifecycle-ops/Makefile experiments/lifecycle-ops/out experiments/lifecycle-ops/RUNLOG.md experiments/scoped-pats/Makefile experiments/scoped-pats/out experiments/scoped-pats/RUNLOG.md experiments/data-api-defaults/out experiments/data-api-defaults/RUNLOG.md
git commit -m "docs: recover and publish lifecycle-ops, scoped-pats and data-api-defaults artifacts (#151)"
```

Fallback if Step 1 finds nothing: skip Steps 2-5 and append to each of the
three RUNLOGs, under its first dated section, the line
`Raw artifacts were not retained (lost with a session scratchpad); the figures in this section cannot be re-checked against an artifact.`
then commit with `docs: record that the #151 artifacts were not retained`.

> **Deviation 2026-10-13:** 11 runs published, not 12. The SP04 artifact
> (`run-2026-10-10T07-22-34-771Z`) was dropped after publishing, under Step
> 3's rule: its SP04a evidence lists the account's organization names and a
> saved SQL snippet's title and id, escaped inside an evidence string where
> the `"name": "` check does not see them. The raw copy stays in
> `evidence/recovered/`; the scoped-pats RUNLOG line names it as not
> published. Step 5 count 22, not 24; sensors 1779 pass. In Step 2 the
> append ran before the `sd` rename, which turned the new target's `$(RUN)`
> into `$(PVLAB)`; restored by hand (`$(PVLAB)` count 6, both targets print
> `required`).

---

### Task 14: platform-facts F03 header frames the PAT as classic (#73)

**Files:**
- Modify: `experiments/platform-facts/tests/f03-pat-scope.ts:2-8`

- [x] **Step 1: Make the change**

**Replace in `experiments/platform-facts/tests/f03-pat-scope.ts`:**

```text
 * F03 - is a Personal Access Token still unscoped?
 *
 * The consolidation guide's security section rests on this: a PAT reads and
 * writes every organization and every project the account can reach, and
 * there is no scoping surface to reach for. The evidence was a probe of every
 * plausible scope/permission endpoint - all 404, while ordinary endpoints
 * returned 200 on the same token.
```

**with:**

```text
 * F03 - does /v1 expose a scoping surface for a classic (Legacy) Personal
 * Access Token?
 *
 * The consolidation guide's security section rested on this in August: a
 * classic PAT reads and writes every organization and every project the
 * account can reach, and /v1 has no scoping surface to reach for. The
 * evidence was a probe of every plausible scope/permission endpoint - all
 * 404, while ordinary endpoints returned 200 on the same token. Scoped
 * tokens (the 2026-10-07 note below) are created in the dashboard, not here.
```

- [x] **Step 2: Verify**

Run: `rg -n 'still unscoped' experiments/platform-facts/tests/f03-pat-scope.ts`
Expected: no output (exit 1).

Run the sensors. Expected: `tsc exit 0`; ` 0 fail`, pass count unchanged.

- [x] **Step 3: Commit**

```bash
git add experiments/platform-facts/tests/f03-pat-scope.ts
git commit -m "docs(platform-facts): F03 header asks about classic PATs, not PATs in general (#73)"
```

---

### Task 15: http-tier-lockdown - close the 'untested' private-path note (#54)

**Files:**
- Modify: `experiments/http-tier-lockdown/RUNLOG.md:142-145`

privatelink-aws RUNLOG, run 9 (2026-08-07): "T22d/e/f - CLOSED. With the Data
API wedged via `PATCH .../postgrest` (db_schema=""), the private path keeps
working: query over the PHZ host on 5432 and on 6543 both succeeded, and
`db push --db-url` still applied migrations."

- [x] **Step 1: Make the change**

**Replace in `experiments/http-tier-lockdown/RUNLOG.md`:**

```text
- Whether the private data path survives the lockdown (T22d/e/f) - needs the
  `db` capability, i.e. a run from inside the VPC in the PrivateLink
  experiment. Every mechanism observed here is HTTP-tier only, so the
  expectation is "unaffected", but it is untested.
```

**with:**

```text
- [answered in privatelink-aws run 9, 2026-08-07] Whether the private data
  path survives the lockdown (T22d/e/f): it does. With the Data API wedged
  through `PATCH .../postgrest` (`db_schema=""`), queries over the private
  host on 5432 and 6543 succeeded and `db push --db-url` still applied
  migrations (`experiments/privatelink-aws/RUNLOG.md`, run 9).
```

- [x] **Step 2: Verify**

Run: `rg -n 'it is untested' experiments/http-tier-lockdown/RUNLOG.md`
Expected: no output (exit 1).

- [x] **Step 3: Commit**

```bash
git add experiments/http-tier-lockdown/RUNLOG.md
git commit -m "docs(http-tier-lockdown): the private-path question was answered in privatelink-aws run 9 (#54)"
```

---

### Task 16: stale plan checkboxes - status banners (#70)

**Files:**
- Modify: `docs/plans/2026-08-04-platform-downtime.md:1`
- Modify: `docs/plans/2026-08-04-platform-facts-diff-and-surface.md:1`
- Modify: `docs/plans/2026-08-04-pooler-semantics.md:1`
- Modify: `docs/plans/2026-08-10-pdf-corpus-graph-hardening.md:1`
- Modify: `docs/plans/2026-08-10-search-tier.md:1`
- Modify: `docs/plans/2026-08-14-pdf-corpus-graph-demo-readiness.md:1`
- Modify: `docs/plans/2026-08-25-sfp-coverage-closure.md:1`

The card offers "tick or archive". These plans are history; ticking hundreds
of boxes after the fact would assert step-level detail nobody checked, so
each gets a banner naming the commits that shipped it (checked against
`git show --stat` on 2026-10-13) and saying the boxes were never ticked.
`2026-08-19-tenant-cost-ledger.md` already carries an ARCHIVED banner from
the 2026-10-13 stocktake and is not touched.

- [x] **Step 1: Add the banners**

**Replace in `docs/plans/2026-08-04-platform-downtime.md`:**

```text
# Platform downtime matrix - implementation plan
```

**with:**

```text
# Platform downtime matrix - implementation plan

> **STATUS (stocktake 2026-10-13): SHIPPED** 2026-08-04: sampler and
> `ctx.endpoints` in 4771889, D01/D02 with the Makefile and RUNLOG in f11146c,
> D03/D04 in 597be6c (bite-time fix 04771e4, 2026-08-05); D05 added
> 2026-10-01 in 5fd3267. The checkboxes below were never ticked;
> `experiments/platform-downtime/RUNLOG.md` is the record of what ran.
```

**Replace in `docs/plans/2026-08-04-platform-facts-diff-and-surface.md`:**

```text
# platform-facts: a real diff, plus two new surfaces - implementation plan
```

**with:**

```text
# platform-facts: a real diff, plus two new surfaces - implementation plan

> **STATUS (stocktake 2026-10-13): SHIPPED** 2026-08-04: `diffArtifacts` and
> `pvlab --diff` in 4771889, F04 and the experiment Makefile in c3ecae0, F05
> in 475be15. The checkboxes below were never ticked;
> `experiments/platform-facts/RUNLOG.md` is the record of what ran.
```

**Replace in `docs/plans/2026-08-04-pooler-semantics.md`:**

```text
# Pooler semantics and throughput - implementation plan
```

**with:**

```text
# Pooler semantics and throughput - implementation plan

> **STATUS (stocktake 2026-10-13): SHIPPED** 2026-08-04: matrix primitive in
> 9c8835e, sbperf reader in f3f5624, the nine probes and S01 in 67c95c2, S02
> in e9858c2. Task 7's experiment Makefile was never written; the first run
> went through medium-serverless on 2026-09-30 (1de7be3). The checkboxes
> below were never ticked; `experiments/pooler-semantics/RUNLOG.md` is the
> record.
```

**Replace in `docs/plans/2026-08-10-pdf-corpus-graph-hardening.md`:**

```text
# pdf-corpus-graph: hardening, editorial reshape, and the open scale questions
```

**with:**

```text
# pdf-corpus-graph: hardening, editorial reshape, and the open scale questions

> **STATUS (stocktake 2026-10-13):** the checkboxes below were never ticked;
> the 2026-08-11 banner that follows is the record (all tracks done, project
> destroyed).
```

**Replace in `docs/plans/2026-08-10-search-tier.md`:**

```text
# search tier: document search + cross-document discovery
```

**with:**

```text
# search tier: document search + cross-document discovery

> **STATUS (stocktake 2026-10-13): SHIPPED** 2026-08-11 in 834dfa5
> (`search_documents`, `cross_document_entities`, the UI panel); loop outcome
> in f55d768. The checkboxes below were never ticked;
> `experiments/pdf-corpus-graph/RUNLOG.md` is the record.
```

**Replace in `docs/plans/2026-08-14-pdf-corpus-graph-demo-readiness.md`:**

```text
# pdf-corpus-graph: demo-readiness gaps and the next iteration
```

**with:**

```text
# pdf-corpus-graph: demo-readiness gaps and the next iteration

> **STATUS (stocktake 2026-10-13): CLOSED.** The 2026-08-14 banner below is
> the last progress record. Its seven unticked items (E3, G12, G15, H1-H4) are
> not carried to the board: the project is destroyed and Track H was
> conversation preparation, not repo work.
```

**Replace in `docs/plans/2026-08-25-sfp-coverage-closure.md`:**

```text
# SFP Coverage Closure - Tracking & Implementation Plan
```

**with:**

```text
# SFP Coverage Closure - Tracking & Implementation Plan

> **STATUS (stocktake 2026-10-13):** Tasks 1-15 DONE 2026-08-25 per the
> tracking ledger below. Task 16 (M5, M6) is blocked on entitlement
> enablement and Task 17 (U1-U6) is track-only; both are carried by board card
> work-supabase-lab#3. The checkboxes were never ticked; the ledger is the
> record.
```

- [x] **Step 2: Verify**

Run: `rg -l 'STATUS \(stocktake 2026-10-13\)' docs/plans -g '!2026-10-13-*' | wc -l`
Expected: `7` (this plan quotes the banners, hence the exclusion; the
tenant-cost-ledger banner reads `Status`, so the case-sensitive pattern does
not match it).

Run the sensors. Expected: ` 0 fail`, pass count unchanged.

- [x] **Step 3: Commit**

```bash
git add docs/plans/2026-08-04-platform-downtime.md docs/plans/2026-08-04-platform-facts-diff-and-surface.md docs/plans/2026-08-04-pooler-semantics.md docs/plans/2026-08-10-pdf-corpus-graph-hardening.md docs/plans/2026-08-10-search-tier.md docs/plans/2026-08-14-pdf-corpus-graph-demo-readiness.md docs/plans/2026-08-25-sfp-coverage-closure.md
git commit -m "docs(plans): status banners on seven shipped or closed plans (#70)"
```

---

### Task 17: governed-starter-kit app - sharp 0.35.5 via override (#86)

**Files:**
- Modify: `experiments/governed-starter-kit/app/package.json`
- Modify: `experiments/governed-starter-kit/app/bun.lock` (regenerated)

`bun.lock` holds `sharp@0.35.4`. Two parents want it: `next@16.3.8` asks for
`^0.35.4` (a plain update would do) and `miniflare@5.20261001.0-alpha` (via
`wrangler@4.147.0`) pins `"sharp": "0.35.4"` exactly, so only an override
moves it. `sharp@0.35.5` exists: it is in the local bun cache
(`~/.bun/install/cache/sharp@0.35.5@@@1`, checked 2026-10-13). That bun
honours the npm-style `overrides` field is recalled from bun's docs, not
re-checked here; Step 3's lockfile check is what confirms it.

- [x] **Step 1: Baseline the app sensors (offline)**

```bash
(cd experiments/governed-starter-kit/app && bunx tsc --noEmit -p .); echo "app tsc exit $?"
(cd experiments/governed-starter-kit/app && bun run lint); echo "app lint exit $?"
```

Expected: `app tsc exit 0`, `$ eslint` with no findings and `app lint exit 0`.
(The app has no unit tests; `next build` is the remaining sensor, Step 4.)

- [x] **Step 2: Add the override**

**Replace in `experiments/governed-starter-kit/app/package.json`:**

```text
  "trustedDependencies": [
    "esbuild",
    "workerd"
  ]
}
```

**with:**

```text
  "trustedDependencies": [
    "esbuild",
    "workerd"
  ],
  "overrides": {
    "sharp": "0.35.5"
  }
}
```

Run: `jq -r '.overrides.sharp' experiments/governed-starter-kit/app/package.json`
Expected: `0.35.5`

- [x] **Step 3: Install and audit (NETWORK: needs the npm registry)**

```bash
(cd experiments/governed-starter-kit/app && bun install); echo "install exit $?"
rg -o '"sharp": \["sharp@[0-9.]+"' experiments/governed-starter-kit/app/bun.lock
rg -c 'sharp@0\.35\.4' experiments/governed-starter-kit/app/bun.lock
(cd experiments/governed-starter-kit/app && bun audit); echo "audit exit $?"
```

Expected: `install exit 0`; `"sharp": ["sharp@0.35.5"`; no output from the
count (no `sharp@0.35.4` left; the `@img/sharp-*` platform packages move to
0.35.5 too); `bun audit` no longer lists GHSA-wq5f-xc86-pv6w. If the lockfile
still shows 0.35.4, bun ignored `overrides`: replace the key with
`"resolutions"` (same body) and repeat this step.

- [x] **Step 4: Re-run the app sensors, then the build (NETWORK for the build if it fetches fonts)**

```bash
(cd experiments/governed-starter-kit/app && bunx tsc --noEmit -p .); echo "app tsc exit $?"
(cd experiments/governed-starter-kit/app && bun run lint); echo "app lint exit $?"
(cd experiments/governed-starter-kit/app && bun run build); echo "app build exit $?"
```

Expected: all three exit 0.

- [x] **Step 5: Commit**

```bash
git add experiments/governed-starter-kit/app/package.json experiments/governed-starter-kit/app/bun.lock
git commit -m "fix(governed-starter-kit): override sharp to 0.35.5 past the pinned 0.35.4 (#86)"
```

> **Executed 2026-10-13:** bun 1.3.14 honoured `overrides`; no
> `resolutions` fallback needed. Lockfile `sharp@0.35.5`, no `sharp@0.35.4`
> left; `bun audit` lists only the braces advisory (GHSA-vfj7-8cjw-p6xm).
> App tsc, lint and `next build` exit 0.

---

### Task 18: governed-starter-kit app - braces override (#87)

**Files:**
- Modify: `experiments/governed-starter-kit/app/package.json`
- Modify: `experiments/governed-starter-kit/app/bun.lock` (regenerated)

`bun.lock` holds `braces@3.0.3` (via `micromatch@4.0.8`, which asks for
`^3.0.3`). The advisory covers `<=3.0.3`. Whether a patched 3.x exists was
not checked (no network); the local bun cache has only 3.0.3. The override
range below (`^3.0.4`) is a guess at the next patch release, not a known
version: Step 1 checks the registry first, and if no such version exists the
card stays open (Step 4).

- [x] **Step 1: Check a patched release exists (NETWORK)**

Run: `bunx npm view braces versions --json | tail -3`
Expected: a version above `3.0.3` in the list. If the last entry is
`"3.0.3"`, stop here and go to Step 4.

- [ ] **Step 2: Add the override**

**Replace in `experiments/governed-starter-kit/app/package.json`:**

```text
  "overrides": {
    "sharp": "0.35.5"
  }
```

**with:**

```text
  "overrides": {
    "sharp": "0.35.5",
    "braces": "^3.0.4"
  }
```

Run: `jq -r '.overrides.braces' experiments/governed-starter-kit/app/package.json`
Expected: `^3.0.4`

- [ ] **Step 3: Install, audit, sensors (NETWORK)**

```bash
(cd experiments/governed-starter-kit/app && bun install); echo "install exit $?"
rg -o '"braces": \["braces@[0-9.]+"' experiments/governed-starter-kit/app/bun.lock
(cd experiments/governed-starter-kit/app && bun audit); echo "audit exit $?"
(cd experiments/governed-starter-kit/app && bunx tsc --noEmit -p .); echo "app tsc exit $?"
(cd experiments/governed-starter-kit/app && bun run lint); echo "app lint exit $?"
```

Expected: `install exit 0`; a braces version of 3.0.4 or later; the audit no
longer lists GHSA-vfj7-8cjw-p6xm; tsc and lint exit 0. Then commit:

```bash
git add experiments/governed-starter-kit/app/package.json experiments/governed-starter-kit/app/bun.lock
git commit -m "fix(governed-starter-kit): override braces past 3.0.3 (#87)"
```

- [ ] **Step 4: If no patched release exists**

Remove the `"braces": "^3.0.4"` line (and the comma after `"0.35.5"`) if
Step 2 was applied, and comment on the card:
`vkctl comment work-supabase-lab#87 "No braces release above 3.0.3 on the registry as of $(date +%F); dev-time only (shadcn, eslint-config-next); re-check on the next dependency bump."`

> **Fallback taken 2026-10-13:** `npm view braces versions` ends at `3.0.3`
> (dist-tag `latest` 3.0.3), so Step 2 was not applied and the card stays
> open. The Step 4 card comment goes in with Task 19's board update.

---

### Task 19: W1 close-out - full sensors, board, lexicanum follow-up

- [x] **Step 1: Full sensors and identifier scan**

```bash
bunx tsc --noEmit -p harness/tsconfig.json; echo "tsc exit $?"
(cd harness && bun test); echo "bun test exit $?"
git status --short
```

Expected: `tsc exit 0`; ` 0 fail` with `1755 pass` after Tasks 1-12 and
14-16 (plus 24 if Task 13 ran); `git status` clean after the per-task
commits.

- [x] **Step 2: Push** (the commit ids lexicanum links pin to must exist on the remote)

> Done 2026-10-13: 20 commits 6cee831..89b018f pushed; the public mirror shows 89b018f.

```bash
git push
```

- [x] **Step 3: Move the cards**

> Done 2026-10-13: 17 cards to In Review with their commit ids (#172 #131-#138
> #171 #43 #47 #151 #73 #54 #70 #86). #87 stays open (fallback: no braces
> release past 3.0.3). #128 stays open until the live check (Task 20 Step 4).

```bash
vkctl mv work-supabase-lab#172 work-supabase-lab#131 work-supabase-lab#132 work-supabase-lab#133 work-supabase-lab#134 work-supabase-lab#135 work-supabase-lab#136 work-supabase-lab#137 work-supabase-lab#138 work-supabase-lab#171 work-supabase-lab#43 work-supabase-lab#47 work-supabase-lab#73 work-supabase-lab#54 work-supabase-lab#70 review
```

Add #151, #86, #87 to that list only if their tasks completed (not their
fallbacks).

- [x] **Step 4: Lexicanum re-cite (separate repo, separate commit; not part of this plan's execution)**

> Done 2026-10-13 in lexicanum 7a99147: 97 rows on 20 pages link the
> facts.md published at b237121 (76 files, all verified to exist). Unpublished
> modules unchanged (SP04, M03, M07, I01-I03, K06, K07). audit-trail-integrity
> and multi-tenant-placement had no rows for these experiments. Older
> experiments with out/ but no row links (client-retries, mgmt-api-faults,
> edge-runtime-auth, platform-downtime, ...): lexicanum#28.

In `~/lexicanum`, replace "not published" / evidence-label cells with links of
the form `https://github.com/erfianugrah/supabase-lab/blob/<pushed short sha>/experiments/<name>/out/<date>/run-<stamp>.facts.md`
on these pages (from the cards):

| card | pages under `src/content/docs/` |
|---|---|
| #131 | `reference/supabase-auth-providers.mdx` (module table, "not published yet") |
| #132 | `reference/supabase-incident-resilience.mdx`, `reference/supabase-static-hosting.mdx` |
| #133 | `reference/supabase-auth-end-to-end.mdx` |
| #134 | `reference/supabase-jit-database-access.mdx`, `reference/supabase-audit-trail-integrity.mdx`, `reference/supabase-multi-tenant-placement.mdx`, `guides/supabase-resilience-runbook.mdx`, `guides/supabase-platform-management-api.mdx` |
| #135 | `reference/supabase-dr-tiers.mdx`, `reference/supabase-platform-operation-cost.mdx`, `reference/supabase-compute-disk.mdx`, `guides/supabase-resilience-runbook.mdx`, `guides/supabase-postgres-major-upgrade-e2e.mdx` |
| #136 | `reference/supabase-incident-resilience.mdx`, `guides/supabase-resilience-runbook.mdx` |
| #137 | `reference/supabase-pipelines.mdx` |
| #138 | `reference/supabase-observability-surface.mdx`, `reference/supabase-data-residency.mdx`, `guides/supabase-management-api-logs-endpoint.mdx` |
| #151 | `reference/supabase-incident-resilience.mdx`, `reference/supabase-auth-end-to-end.mdx`, `reference/supabase-realtime-surface.mdx`, `reference/supabase-data-surface-lockdown.mdx` ("none published") |

Run lexicanum's own tests before committing there (its AGENTS.md).

> **2026-10-13:** Step 1 run: `tsc exit 0`, `1779 pass`, ` 0 fail` (1755 +
> 22 from Task 13 + 2 redactor cases). The tree was not clean at that point
> because the per-task commits were made afterwards in one series. Steps 2-4
> (push, card moves, lexicanum) follow the push. For Step 3: #86 and #151
> completed (#151 without SP04), #87 took its fallback.

---

## W2 - time-bound

### Task 20: explicit GRANTs in older experiments' setup SQL (#128, offline half; due before 2026-10-30)

**Files:**
- Modify: `experiments/edge-resilience/Makefile:84`
- Modify: `experiments/edge-resilience/tests/w05-standby-replication.ts:82-83`
- Modify: `experiments/edge-resilience/tests/w15-ddl-during-replication.ts:76`
- Modify: `experiments/edge-resilience/tests/w16-sequence-resync.ts:70`
- Modify: `experiments/edge-resilience/tests/w12-realtime-probe.ts:116`
- Modify: `experiments/compute-disk/tests/d09-compute-resize-timing.ts:146`
- Modify: `experiments/s2z-wake/tests/z01-get-surface-wake.ts:139`
- Modify: `experiments/usage-metering/tests/m05-control-plane-store.ts:92`
- Modify: `experiments/usage-metering/tests/m01-diy-usage-metering.ts:143`
- Modify: `experiments/byo-oauth/tests/o03-auth-idp-client-id-rls.ts:312`
- Modify: `experiments/privatelink-aws/tests/t22-dataapi-disable.ts:178`

From 2026-10-30 a table created in SQL in `public` gets no Data API grants
(data-api-defaults key facts in AGENTS.md: the revoke covers `select,
insert, update, delete` for `anon`, `authenticated`, `service_role`, and the
sequences form). Every table below is created in SQL and then read or written
over `/rest/v1` or Realtime. The fix grants back exactly what the legacy
default gave, so each module measures what it measured before. A sequence
grant is added only where an anon client inserts into a `serial` column
(W12's `probe_canary`).

Scope check against the card's list (by reading each module, 2026-10-13):
the w_probe seed in the edge-resilience Makefile covers the modules that read
`w_probe` (W01, W04, W07, W23, W24, W25, W27a/b and the Worker). Not changed,
because the SQL-created table never goes through the Data API: audit-integrity
(A03, A09, A13 use SQL only), compute-disk D05/D10 (SQL fill),
usage-metering M06 and M05's `items` (SQL), s2z-wake `lib/write-ops.ts`
(Management API writes), github-branching (migrations read back over SQL),
identity-transfer `local/init-db.sql` (local container), privatelink-aws T08
(CLI), edge-resilience W06, W11, W20, W22 and W23's `w23_hb` (SQL or
replication only), and W27's `w27_locked` (revoked from anon and
authenticated on purpose and read with an authenticated token, which the new
default also leaves ungranted).

- [x] **Step 1: Make the changes**

**Replace in `experiments/edge-resilience/Makefile`:**

```text
-d '{"query":"create table if not exists public.w_probe(id int primary key); insert into public.w_probe values (1) on conflict do nothing;"}'
```

**with:**

```text
-d '{"query":"create table if not exists public.w_probe(id int primary key); insert into public.w_probe values (1) on conflict do nothing; grant select, insert, update, delete on table public.w_probe to anon, authenticated, service_role;"}'
```

**Replace in `experiments/edge-resilience/tests/w05-standby-replication.ts`:**

```text
      await runSql(standby, `DROP TABLE IF EXISTS public.w_repl; CREATE TABLE public.w_repl(id serial primary key, val text)`);
      await runSql(standby, `CREATE TABLE IF NOT EXISTS public.w_probe(id int primary key); INSERT INTO public.w_probe VALUES (1) ON CONFLICT DO NOTHING`);
```

**with:**

```text
      await runSql(standby, `DROP TABLE IF EXISTS public.w_repl; CREATE TABLE public.w_repl(id serial primary key, val text); GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.w_repl TO anon, authenticated, service_role`);
      await runSql(standby, `CREATE TABLE IF NOT EXISTS public.w_probe(id int primary key); INSERT INTO public.w_probe VALUES (1) ON CONFLICT DO NOTHING; GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.w_probe TO anon, authenticated, service_role`);
```

**Replace in `experiments/edge-resilience/tests/w15-ddl-during-replication.ts`:**

```text
      await runSql(standby, `DROP TABLE IF EXISTS public.w_repl; CREATE TABLE public.w_repl(id serial primary key, val text)`);
```

**with:**

```text
      await runSql(standby, `DROP TABLE IF EXISTS public.w_repl; CREATE TABLE public.w_repl(id serial primary key, val text); GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.w_repl TO anon, authenticated, service_role`);
```

**Replace in `experiments/edge-resilience/tests/w16-sequence-resync.ts`:**

```text
      await runSql(standby, `DROP TABLE IF EXISTS public.w16_t; CREATE TABLE public.w16_t(id serial primary key, val text)`);
```

**with:**

```text
      await runSql(standby, `DROP TABLE IF EXISTS public.w16_t; CREATE TABLE public.w16_t(id serial primary key, val text); GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.w16_t TO anon, authenticated, service_role`);
```

**Replace in `experiments/edge-resilience/tests/w12-realtime-probe.ts`:**

```text
      await runSql(`CREATE TABLE IF NOT EXISTS public.probe_canary (id serial primary key, payload text)`);
```

**with:**

```text
      await runSql(`CREATE TABLE IF NOT EXISTS public.probe_canary (id serial primary key, payload text); GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.probe_canary TO anon, authenticated, service_role; GRANT USAGE, SELECT ON SEQUENCE public.probe_canary_id_seq TO anon, authenticated, service_role`);
```

**Replace in `experiments/compute-disk/tests/d09-compute-resize-timing.ts`:**

```text
"create table if not exists public.dpython_probe(id int primary key);"
```

**with:**

```text
"create table if not exists public.dpython_probe(id int primary key); grant select, insert, update, delete on table public.dpython_probe to anon, authenticated, service_role;"
```

**Replace in `experiments/s2z-wake/tests/z01-get-surface-wake.ts`:**

```text
        query: "create table if not exists public.z01_rls_off(i int);",
```

**with:**

```text
        query: "create table if not exists public.z01_rls_off(i int); grant select, insert, update, delete on table public.z01_rls_off to anon, authenticated, service_role;",
```

**Replace in `experiments/usage-metering/tests/m05-control-plane-store.ts`:**

```text
        "create table if not exists public.metering_hourly (ts timestamptz default now(), project_ref text, name text, status text, sku text, monthly_usd numeric)",
```

**with:**

```text
        "create table if not exists public.metering_hourly (ts timestamptz default now(), project_ref text, name text, status text, sku text, monthly_usd numeric)",
        "grant select, insert, update, delete on table public.metering_hourly to anon, authenticated, service_role",
```

**Replace in `experiments/usage-metering/tests/m01-diy-usage-metering.ts`:**

```text
"create table if not exists public.m01_payload (id bigint generated always as identity primary key, body text)"
```

**with:**

```text
"create table if not exists public.m01_payload (id bigint generated always as identity primary key, body text); grant select, insert, update, delete on table public.m01_payload to anon, authenticated, service_role"
```

**Replace in `experiments/byo-oauth/tests/o03-auth-idp-client-id-rls.ts`:**

```text
          `create table public.${table} (id bigint generated always as identity primary key, note text); ` +
```

**with:**

```text
          `create table public.${table} (id bigint generated always as identity primary key, note text); ` +
          `grant select, insert, update, delete on table public.${table} to anon, authenticated, service_role; ` +
```

**Replace in `experiments/privatelink-aws/tests/t22-dataapi-disable.ts`:**

```text
    `create table if not exists ${PROBE_TABLE} (id int primary key, at timestamptz default now());\n`,
```

**with:**

```text
    `create table if not exists ${PROBE_TABLE} (id int primary key, at timestamptz default now());\n` +
      `grant select, insert, update, delete on table ${PROBE_TABLE} to anon, authenticated, service_role;\n`,
```

- [x] **Step 2: Verify**

Run: `rg -c -i 'to anon, authenticated, service_role' experiments/edge-resilience/Makefile experiments/edge-resilience/tests/w05-standby-replication.ts experiments/edge-resilience/tests/w15-ddl-during-replication.ts experiments/edge-resilience/tests/w16-sequence-resync.ts experiments/edge-resilience/tests/w12-realtime-probe.ts experiments/compute-disk/tests/d09-compute-resize-timing.ts experiments/s2z-wake/tests/z01-get-surface-wake.ts experiments/usage-metering/tests/m05-control-plane-store.ts experiments/usage-metering/tests/m01-diy-usage-metering.ts experiments/byo-oauth/tests/o03-auth-idp-client-id-rls.ts experiments/privatelink-aws/tests/t22-dataapi-disable.ts`

Expected: one line per file; w05 `2`, w12 `1` (both GRANTs sit on one line),
every other file `1`.

Run the sensors. Expected: `tsc exit 0`; ` 0 fail`, pass count unchanged.

- [x] **Step 3: Commit**

```bash
git add experiments/edge-resilience experiments/compute-disk/tests/d09-compute-resize-timing.ts experiments/s2z-wake/tests/z01-get-surface-wake.ts experiments/usage-metering/tests experiments/byo-oauth/tests/o03-auth-idp-client-id-rls.ts experiments/privatelink-aws/tests/t22-dataapi-disable.ts
git commit -m "fix: explicit Data API grants on SQL-created tables before the 2026-10-30 default (#128)"
```

- [x] **Step 4 (live, W2 plan): re-run one module per changed experiment**

> **Done 2026-10-13 (partial; see the RUNLOG entries of the same date):**
> no 401/403/42501 on the Data API in any run. M05, M01 (Pro org) and D09
> (Pro org) match their last entries; the grants executed (M05 schema 201,
> anon REST reads of `m01_payload` and `dpython_probe` answered). Z01 ran on a
> production free-plan org (Pro cannot pause): seed with grant 201, zero
> wakers over 52 reads; Z01e fails because the seeded `/advisors/security`
> is now a silent degrader missing from `SILENT_DEGRADERS`. Not verified:
> O03 fails at O03b (`consent=404`, 2 of 2 runs) before O03c's grant runs;
> W12 not run, because edge-resilience's tofu state is empty and `make up`
> provisions two projects and a Worker; T22 waits for #130. D09 surfaced an
> outage-accounting gap in the module (compute-disk RUNLOG). Artifacts stay
> in `evidence/` (none of the four experiments has a `publish-evidence`
> target).

Before 2026-10-30, on a PAT and the lab Pro org: edge-resilience W12 (one
project), compute-disk D09, s2z-wake Z01 (about 35 min), usage-metering M01
and M05, byo-oauth O03. privatelink-aws T22 waits for #130. Expected: each
module's result matches its last RUNLOG entry; any 42501 on the Data API is a
missed grant. Record a RUNLOG line per re-run.

> **Executed 2026-10-13 (Steps 1-3):** offline edits only. The GRANT
> statements were not executed against Postgres; their runtime effect stays
> unverified until Step 4.

### #89 - Data API grants after the 2026-10-30 flip

On or after 2026-10-30: `make -C experiments/data-api-defaults run-standing`
against the same standing project as the 2026-10-13 readings (PVLAB_REF from
the operator's environment, never written down), then `make -C
experiments/data-api-defaults run` for a new project; publish both and
`pvlab --diff` the standing reading against
`out/2026-10-13/run-2026-10-13T00-21-17-694Z.json`. Expected artifact: the
diff, with DD01Sb answering either 200 (enforcement not yet reached the
project) or 42501 plus the "Grant the required privileges" hint. Cross-check
iap-lockdown L08. Calendar reminder exists.

---

## W3 - unblocked live work (entries only; a detailed plan per batch when started)

Each entry: what to run, prerequisite, expected artifact. All need
`SUPABASE_ACCESS_TOKEN` and the lab org slugs from the operator's
environment unless the entry says local.

- **#20** platform-downtime: wrap D01's `POST /restart` with D05's
  `pg_postmaster_start_time()` + `pg_stat_checkpointer.stats_reset`
  before/after read (`lib/setup.ts`). Prereq: the experiment's tofu project.
  Artifact: D01 run with two new measurements.
- **#33** bu-attribution Q14 via scoped-pats SP04: `make -C
  experiments/scoped-pats org` with `PVLAB_SCOPED_PAT_ORG` (dashboard-created,
  Organization Projects read-write). Artifact: SP04 run on a real org-scoped
  token.
- **#41** platform-facts: re-read upgrade eligibility on projects of several
  ages to explain `eligible: null` (RUNLOG:167). Artifact: F06 variant run.
- **#42** rate-limits: burst shapes per endpoint until the edge returns HTML
  instead of JSON 429 (`mgmt.ts` `classifyBody` already tells them apart).
  Artifact: matrix of endpoint x burst -> body class.
- **#44** s2z-wake: leave a production free-org project idle until the
  platform pauses it; then run the wake arm. Artifact: wake timing on
  production.
- **#45** s2z-wake: run module Z02 (write operations) as a module, replacing
  the throwaway-script results. Artifact: Z02 run.
- **#53** security-lockdown: pg_cron job and a database webhook while the
  project is restricted (restrict-all). Artifact: new L-module run.
- **#55** auth: Storage (RLS on a claim) and Realtime with a third-party
  token. Artifact: module run per surface.
- **#56** replica-cluster-tpa: write RC01-RC05 per
  `docs/plans/2026-10-02-replica-cluster-tpa.md`; RC01-RC04 local, RC05 three
  managed projects. Artifact: RC runs.
- **#57** third-party-auth: write and run TPA05/TPA06 (Ed25519 issuer and
  rotation). Artifact: TPA runs.
- **#58** cross-project-auth: OAuth 2.1 server tokens and `aud` mismatch
  against spoke acceptance. Artifact: module run.
- **#59** identity-transfer: IT02/IT03 and the refactored IT01 on managed.
  Artifact: IT runs.
- **#61** self-hosted-auth (local Docker): probe the gateway after a
  legacy-key revoke at intervals past 45 s. Artifact: timing series.
- **#62** tenant-promotion: promotion with an OIDC identity, using the AU01
  Worker issuer as the provider (untested assumption that it is enough).
  Artifact: promotion run with an OAuth identity.
- **#63** data-api-reenable DA06: time Dashboard "Enable Data API" to serving
  (human session, poller running). Artifact: DA06 run.
- **#64 / #65 / #83** edge-function-limits: wall clock on a free project
  (150 s per docs), CPU and memory ceilings, nested calls per trace (30 per
  60 s per docs). Artifact: EF module runs.
- **#66** residency-facts: 3-day partition retention and private cache TTL
  on the standing project (older than 4 days); the drain part runs under
  #52. Artifact: R-module run.
- **#67** checkpointer-reset: find a managed-side signal for the restart stop
  path (logs, `pg_stat_*`), then probe. Artifact: RUNLOG entry, run if a
  signal exists.
- **#68** tls-surface: re-run TL12/TL16/TL20/TL21, add IPv6 (from an
  IPv6-capable vantage) and a replica's TLS. Artifact: TL runs.
- **#71 / #161** governed-starter-kit: interactive destructive-SQL
  confirmation and paid-resource elicitation from capable and incapable
  clients, the Explorer query in the Dashboard, and the Claude OAuth consent
  step. Artifact: RUNLOG section per path.
- **#78** governed-starter-kit: on the next fanout deploy, record the first
  502's body (per-upstream status) and function logs. Artifact: RUNLOG line.
- **#93 / #155** Pipelines managed: copy time, lag, paused billing and WAL
  retention on a managed destination; on the same pipeline, OrioleDB tables,
  a PITR restore of an oriole table and the 64-bit XID claim. Artifact:
  pipelines and orioledb runs.
- **#129** graphql: apply the data-api-defaults fix (query a real type,
  check `pg_extension`) to data-api-reenable DA03 and privatelink-aws T22;
  re-run DA03 now, T22 after #130. Artifact: DA03 run.
- **#150** lifecycle-ops: build the cluster B detect-then-self-restart
  runbook and drill it once. Artifact: runbook plus drill RUNLOG entry.
- **#152 / #63 / #158** Dashboard session batch: branch SQL Editor/Table
  Editor merge path, restore-to-new-project clone, Dashboard-generated S3
  keys. Artifact: one RUNLOG line per check.
- **#154** edge-runtime-auth: the auth mode x token matrix on Vercel and Bun,
  plus the named-key syntax. Prereq: Vercel account for that half.
  Artifact: matrix run.
- **#156** multigres (local kind): failover under pgbench through the
  operator. Artifact: run beside the all-in-one results.
- **#157** cli-surface: native stack on linux/amd64 (hosted CI runner), glibc
  floor, idle stops. Artifact: CI run log plus RUNLOG.
- **#163** client-keyed-objects: CK04/CK06 on region-b under `caffeinate`.
  Artifact: CK runs.
- **#164** storage-surface: SS03e stale cached copy after overwrite, objects
  past 2 GiB, parallel parts, TUS concurrency, MinIO space reclaim.
  Artifact: SS runs.
- **#165** pooler-checkout: find where 15 000 ms comes from (compute size,
  Supavisor release, client setting), then measure it. Artifact: PC run.
- **#166** mgmt-api-faults: connection resets, refusals, TLS and DNS faults
  through a local proxy; orphan reconciliation. Artifact: MF runs.
- **#167** terraform-edge-functions: per-slug listing reads during a parallel
  apply plus `TF_LOG=DEBUG`. Artifact: trace excerpt and RUNLOG.
- **#168** self-hosted-defaults (local Docker): Realtime and Edge Functions
  with `sb_` keys, PG15 to PG17 data-directory upgrade, linux/amd64 on an
  amd64 host. Artifact: runs.
- **#169** replica-routing: unhealthy or lagging replica re-routing and
  non-REST traffic through the load balancer. Prereq: a read replica.
  Artifact: RR runs.
- **#170** restore-paths: restore targets hours to days old, a database over
  1 GB, PITR window start. Prereq: PITR add-on. Artifact: RP runs.

## W4 - blocked on credentials, access or money (entries only)

- **#130** (unblocker) rotate the vault AWS pair or move to SSO; then re-run
  the AWS halves of storage-surface and hostname-path. Unblocks #48 #49 #50
  #51 #145 #149 #162 and the T22 half of #129.
- **#48 / #49 / #50 / #149** privatelink-aws: T28/T29, verify-full TLS from
  the second VPC, T19 rewritten as detach-before-remove (code offline first),
  and the RUNLOG follow-ups (`make wait-ready`, reap-enis scope, T24 wording
  are offline; T15 is a spin). Prereq: #130 plus spin cost.
- **#51** security-lockdown Phase C (L20-L23). Prereq: #130, Team org,
  manual association.
- **#145** PrivateLink self-serve on a fresh Team org. Prereq: #130 and the
  org.
- **#162** then **#127**: eastern-US vantage at :00/:30 (EC2 in us-east-1),
  then retitle #127 to what ran and close both.
- **#3** SFP Task 16 (restore points, OAuth bridge) after entitlement
  enablement; Task 17 is filing U1-U6 upstream.
- **#15** compute-disk D10 on the platform-plan org:
  `PVLAB_ORG_PRO=<platform slug> pvlab --where local --experiment compute-disk --only D10 --destructive`
  with that control plane's token and base URL.
- **#34 / #35 / #36 / #37** bu-attribution BA04 (second org), BA05 plus the
  No access role (second user; batch with #153), M07 on a platform-plan
  invoice, v2 member-role PATCH (Enterprise org).
- **#153** jit-db-access revocation on member removal and PAT revocation
  (second user, disposable PAT).
- **#39** compute-disk over-quota billing (spend plus a billing cycle).
- **#40** platform-facts F06 on an aged project the lab may upgrade.
- **#46** s2z-wake scale-to-zero (an account with it enabled).
- **#52** security-lockdown: one HTTP drain to a Worker (batch size, flush
  interval, encoding, lag, sources) plus the before-user-created hook;
  absorbs #66's drain line and OB04d. Prereq: a drain created in the
  Dashboard and its monthly charge.
- **#60** identity-transfer Apple `transfer_sub` (Apple team and app).
- **#69** stripe-sync-schema seeded matrix and E02, plus the SSL-enforced and
  branch installs (Stripe test write key).

## W5 - new research (entries only)

- **#112** MCP enterprise-managed auth: revocation delay after offboarding
  and writes as a read-only member. Prereq: an IdP test tenant with SSO.
- **#117** searchable encryption partner integration: equality, ORDER BY,
  fuzzy match, what plaintext reaches `postgres_logs`.
- **#139** logs usage-based pricing: find the token type or surface that
  reads org GB ingested/queried, drive a known volume, compare.
- **#140** Multigres managed private alpha: failover window and lost commits
  under load vs the OSS results. Prereq: alpha access.
- **#141** dbarena: read the open benchmark harness; decide whether to rerun
  an OrioleDB cell at a size where storage, not round trips, bounds
  throughput.
- **#142** app hosting announcement: read it; scope an experiment only if it
  is beyond cli-surface and static-hosting.
- **#143** operate-with-confidence: diff the announced agent tools against
  observability-surface; file cards for the gaps.
- **#144** community supabase-audit: run its read-only checks on a lab
  project and compare with the built-in advisors.

---

## Dry-run status

Dry-run 2026-10-13 on a copy of the repo at 0d18eb0 (rsync without `.git`
and `node_modules`, `node_modules` symlinked back, a fresh git index built
from the real repo's `git ls-files` so the identifier scan sees the same
tracked set). Every Replace/Append block in Tasks 1, 1b, 2-18 and 20 (74
blocks) was applied by a script that parses this file and refuses a block
whose old text does not occur exactly once; every command block of those
tasks that needs no network or credential was run as written.

- Baseline: `tsc exit 0`; `bun test` 1596 pass / 0 fail at 0d18eb0, 1597
  with this plan file added.
- After Tasks 1, 1b, 2-12, 14-16, the offline parts of 13, 17 and 18, and
  Task 20: `tsc exit 0`; `bun test` 1755 pass / 0 fail; the app's
  `tsc --noEmit` and `bun run lint` exit 0. Every intermediate pass count in
  the tasks above is the one the dry-run printed.
- Published: 75 runs, 150 files in 13 dated `out/` directories across 11
  experiments; every publish
  line reported 0 unredacted ref-shaped tokens and 0 credential ids; no
  project name, home path or non-public hostname in any of them.
- Plan defects found and fixed: the experiment-level `.gitignore` in
  pipelines and observability-surface hid the published files from `git add`
  (Steps added; counts now use `git status`); two artifacts carried a home
  path (Task 1b added); every pass count was one short because the plan file
  is itself scanned; Task 16's check matched this plan; `check-doc-numbers.ts`
  exits 0 when it lists hits; Task 1's red state is 4 fail plus 1 load error;
  the AU03 home path is on one line, not two.

Not verifiable in the dry-run: Task 13's recovery and publish steps (the raw
files sit in another session's `/private/tmp` scratchpad; only its Makefile
and RUNLOG edits were applied); the network steps of Tasks 17 and 18
(`bun install`, `bun audit`, `npm view braces`, `next build`), so whether bun
honours `overrides` and whether a patched braces exists are open; Task 19
(push, board, lexicanum); Task 20's runtime effect (the GRANT statements were
not executed against Postgres; Step 4 is live); `readProjectRegion` against
the real Management API (stub-tested only). `publish-evidence` reached
Cloudflare's trace endpoint for the vantage address during the dry-run, as it
will in the real run.

## Self-review

- Coverage: status banner (top); triage table with all 93 open cards (91 after two
  non-lab cards left the board on 2026-10-13), each
  once (checked by script against `vkctl ls work-supabase-lab --json`: same
  set, no duplicates; W1 18, W2 2, W3 43 then 41, W4 22, W5 8); merges and batches;
  W1 in full (Tasks 1-19), #128's offline half in full (Task 20); W2-W5 as
  entries, each W3-W5 card present in its section (checked by script).
- Placeholders: the remaining angle-bracket tokens are run-time values
  (`<repo>`, `<ts>`, `<n>`, `<pushed short sha>`, `<platform slug>`), not
  missing content.
- Names: `readProjectRegion`, `regionLabel` and `projectRegion` are spelled
  the same in the tests, the implementation and `run.ts`.
- Confidentiality: no project ref, org slug, email, customer or partner
  relationship, internal page id or channel name; the identifier scan passes
  on this file.
