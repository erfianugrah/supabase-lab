# Lab W3 batches (2026-10-13) Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task, in the current session. Steps use checkbox (`- [ ]`) syntax for tracking. Per-task subagents (subagent-driven-development) only if the user asks for them.

> **STATUS 2026-10-13: O1-O5, B01 and B02 EXECUTED; every other batch
> planned, not run.** Each executed task carries an "Executed" note with its
> deviations; commits and card moves are the operator's. Covers the 41 W3 cards of
> `docs/plans/2026-10-13-lab-backlog-waves.md` (section "W3 - unblocked live
> work"; #75 and #148 left the board, so W3 is 41). Offline prep (Tasks O1-O5)
> and the first two live-cheap batches (B01, B02) are written out in full; the
> offline tasks were dry-run on a copy of the repo (see "Dry-run status").
> Every other batch is an entry and gets its own detail when it starts.
> Live-paid batches (P1-P3) need the user's go-ahead for the spend; batches
> marked HUMAN SESSION need the user at a Dashboard or an interactive client.

**Goal:** Turn the W3 backlog into execution batches, write the module code the first live batches need, and run the first two batches (restart signals; Management API reads) end to end.

**Architecture:** Cards that share an experiment, a project or a human session run as one batch. Code changes come first and are offline: a pure helper with unit tests per question (`lib/*.ts` + `lib/*.test.ts`), the module that calls it, and a Makefile target that runs the harness from source (`harness/dist/pvlab` is a linux-x64 binary and does not run on the lab's arm64 Mac). Live batches then run one command each, publish redacted artifacts with `make publish-evidence`, and write RUNLOG and AGENTS.md lines the same day.

**Tech Stack:** Bun 1.3.14 (harness, `bun test`, `tsc`), GNU make 3.81 (macOS), OpenTofu for the experiments that have state, the pvlab harness (`harness/src/run.ts`), `sx` for the Management API token, `jq`, `vkctl` for board moves.

---

## Conventions every task relies on

- Run every command from the repo root (`~/work/supabase-lab`) unless a step
  says otherwise. `make -C experiments/<name> ...` keeps the shell there.
- Sensors (after every offline task):

  ```bash
  bunx tsc --noEmit -p harness/tsconfig.json; echo "tsc exit $?"
  (cd harness && bun test > /tmp/w3-bun-test.txt 2>&1; echo "bun test exit $?"); tail -4 /tmp/w3-bun-test.txt
  ```

  Expected: `tsc exit 0`, `bun test exit 0`, a summary with ` 0 fail`.
  `cd harness && bun test` runs only `harness/src/*.test.ts`;
  `harness/src/identifiers.test.ts` adds one case per tracked or addable
  `.md`, `.ts`, `Makefile` (and a few other) file, so every new file adds one
  to the pass count. Baseline at c8501f6 (the dry-run's tree): `1779 pass`;
  with this plan file committed `1780 pass`. Each task gives its running total for in-order
  execution; if the baseline has moved (other work landed first), expect
  the same deltas on top of it.
- Experiment unit tests are not in that run. Run them by directory:
  `bun test experiments/<name>/lib`.
- An offline skip-run proves a module is registered and gated without
  touching the network (no token, no ref in the environment):

  ```bash
  (cd harness && bun scripts/gen-registry.ts >/dev/null); rm -rf /tmp/w3-skip/<name>
  env -u SUPABASE_ACCESS_TOKEN -u PVLAB_REF -u SUPABASE_ANON_KEY -u DB_PASSWORD -u PVLAB_ORG_SLUGS \
    bun harness/src/run.ts --where local --experiment <name> --only <ID> --destructive --out /tmp/w3-skip/<name>
  jq -c '.results[] | {id,status,detail}' /tmp/w3-skip/<name>/run-*.json
  ```

  The first output line is `pvlab: 0 to run, 1 skipped (vantage=local, capabilities=...)`;
  the capability list depends on the machine (`openssl,pgbench` on the lab Mac).
- The Management API token comes from the vault per command:
  `sx SUPABASE_ACCESS_TOKEN -- <cmd>` (`sx -l` maps `SUPABASE_ACCESS_TOKEN`).
  Never print it. `make secrets-decrypt` at the root writes `secrets.tfvars`
  (gitignored) for the tofu experiments' `db_password` and `supabase_org_id`;
  list its keys with `cut -d= -f1 secrets.tfvars`, never `cat` it. Do not run
  `make -n` on a target that interpolates `$(PW)` without `PW=x` on the
  command line: `-n` prints the database password.
- Lab org slugs come from the operator's environment as `PVLAB_ORG_PRO`,
  `PVLAB_ORG_TEAM`, `PVLAB_ORG_FREE` (and `PVLAB_ORG_SLUGS` where a module
  wants a list). They never go into a tracked file.
- Publishing: `make -C experiments/<name> publish-evidence RUN=evidence/<ts>/run-<stamp>.json`
  prints `published run-<stamp>.json -> <repo>/experiments/<name>/out/<date> (<n> results; 0 unredacted ref-shaped tokens remain; 0 unredacted credential ids remain)`
  and exits 1 if a ref-shaped token survives. Before committing an `out/`
  directory run `rg -n '"name": "' experiments/<name>/out/ | rg -v '"name": "(log_|unindexed|auth_rls|unused_)'`
  and `rg -l '/Users/|/home/' experiments/<name>/out/` (both: no output), and
  count files with `git status --short --untracked-files=all experiments/<name>/out | wc -l`.
- A module that runs gets its RUNLOG line the same day (AGENTS.md
  Conventions). Prose for RUNLOG, AGENTS.md and lexicanum follows the
  `lab-writeup` skill. RUNLOG text below has `<...>` slots for run-time
  values; fill every one from the facts file before committing.
- Nothing account-specific in a tracked file: no project ref, org slug,
  email, home path, customer or partner name, and no note of who asked for a
  run. `harness/src/identifiers.test.ts` checks the shapes; the rest is on
  the writer.
- Commit messages: Conventional Commits, ASCII, no tool attribution.
- Cost classes: **offline-prep** (code and docs, no network beyond the
  package registry), **local** (Docker or kind on this Mac, $0, ordered with
  live-cheap), **live-cheap** (throwaway Pro or Free projects for minutes to
  hours, no add-ons), **live-paid** (add-ons, PITR, Pipelines, replicas,
  larger compute, or a soak that keeps billed resources up for days). Wall
  times in the table are estimates from the cards and earlier RUNLOGs, not
  measurements.

## Batch table

Every W3 card appears exactly once (checked by script against the triage
table of the waves plan; see "Self-review"). "Needs human" means something
only the operator can do: a Dashboard click, an interactive client, an
account or credential the lab does not hold.

| batch | cards | what runs | cost class | est. wall | needs human | blockers |
|---|---|---|---|---|---|---|
| B01 restart signals | #20 #67 | platform-downtime D01 x3 with the restart signal and postgres_logs stop lines | live-cheap (one Pro Micro, ~1.5 h) | 1.5 h | no | Task O1 |
| B02 Management API reads | #41 #42 | platform-facts F07 across the lab orgs; rate-limits L02 burst matrix | live-cheap (no project created; L02 reuses B01's project) | 45 min | no | Tasks O3, O4 |
| B03 GraphQL re-run | #129 | data-api-reenable DA03 with the pg_graphql check | live-cheap (one Pro Micro) | 45 min | no | Task O2; the T22 half waits for #130 (W4) |
| B04 lifecycle drill | #150 | write the cluster B detect-then-self-restart runbook, drill it once | live-cheap (one Pro Micro) | 0.5 d | no | runbook not written; cluster B is defined only in #120's description |
| B05 edge-function limits | #64 #65 #83 | EF09 on a Free project; EF07 pinned at 2 s / 256 MB; EF10 past 30 nested calls per trace | live-cheap (one Pro, one Free project) | 3 h | no | #83: read how the runtime identifies a trace before coding; #64: a Free org slot (2 active projects per Free org) |
| B06 third-party token reach | #55 #61 | Storage (RLS on a claim) and Realtime with an own-key issuer token; gateway apikey vs cache probed past 45 s after a legacy-key revoke | live-cheap (one Pro Micro) plus local Docker GoTrue | 3 h | no | modules not written; #61's revoke is irreversible, so it runs last and the project is destroyed |
| B07 OIDC issuer auth | #58 #59 #62 | cross-project-auth OAuth 2.1 and `aud` mismatch; identity-transfer IT01-IT03; tenant-promotion with an OIDC identity | live-cheap (up to 5 Pro Micro across three experiments) | 1 d | no | #58 and #62 modules not written; the lab OIDC issuer Worker (auth-providers AU01) must still be deployed |
| B08 Ed25519 issuer | #56 #57 | replica-cluster-tpa RC01-RC04 local, RC05 on three managed projects; third-party-auth TPA05/TPA06 | local + live-cheap (3 Pro Micro) | 1.5 d | no | modules not written; design in `docs/plans/2026-10-02-replica-cluster-tpa.md` |
| B09 restrict-all background jobs | #53 | security-lockdown: a pg_cron job and a database webhook while the project is restricted | live-cheap (one Pro Micro) | 2 h | no | module not written |
| B10 storage objects | #163 #164 | client-keyed-objects CK04/CK06 on region-b; storage-surface SS03e stale copy, objects past 2 GiB, parallel parts, TUS concurrency, MinIO reclaim | live-cheap (Pro Micro in two regions) + local MinIO | 1 d | keep the laptop awake (`caffeinate`) | #164 modules not written; local disk for 2 GiB objects (the Docker VM had ~4 GB free when CK ran, client-keyed-objects RUNLOG) |
| B11 control-plane client faults | #166 #167 | mgmt-api-faults connection resets, refusals, TLS and DNS faults through a local proxy, orphan reconciliation; terraform-edge-functions apply with per-slug reads and `TF_LOG=DEBUG` | live-cheap (project creates, minutes each) | 0.5 d | no | #166 modules not written (client-retries `lib/faultproxy.ts` is reusable) |
| B12 pooler checkout timeout | #165 | find the source of the 15 000 ms figure, then measure it | live-cheap if Micro; live-paid if the source is compute size (ask first) | 2 h | no | research first |
| B13 residency on an aged project | #66 | 3-day partition retention and private-object cache TTL on the standing project (older than 4 days); the drain line goes to #52 (W4) | live-cheap (existing project, reads plus one test object) | 2 h | no | module for retention not written |
| B14 production auto-pause | #44 | s2z-wake: leave Free production projects idle until the platform pauses them, then the wake arm | live-cheap ($0 on Free orgs; 1-2 weeks of wall time) | 1 h hands-on | no | 2 active projects per Free org; a sampler must be running before the pause (s2z-wake RUNLOG) |
| B15 local rigs | #156 #168 | multigres failover under pgbench through the kind operator; self-hosted-defaults Realtime and Edge Functions with `sb_` keys and the PG15 to PG17 data-directory upgrade | local | 1 d | no | kind manifests and rig changes not written; #168's amd64 row runs in B16 |
| B16 amd64 host | #157 | cli-surface native stack on linux/amd64 (hosted CI runner or an amd64 box): glibc floor, idle stops; plus #168's amd64 row | local or CI ($0 on a public-repo runner) | 3 h | choose the amd64 host or CI runner | workflow or host script not written |
| B17 server runtimes | #154 | edge-runtime-auth auth mode x token matrix on Bun (local) and Vercel, plus the named-key syntax | local + live-cheap | 3 h | a Vercel account and token | Vercel half not written |
| B18 write-op wake | #45 | s2z-wake Z02 (the write-operation table, `terminal` operations off) on a production free-plan org, as Z01 ran on 2026-10-13 | live-cheap ($0 on a Free org) | 2 h | no | first execution of Z02; the README says staging only, so the user confirms one production write sweep first; shares the Free-org project cap with B05 and B14 |
| H1 Dashboard checks | #33 #63 #152 #158 | create the scoped tokens SP02-SP09 need; DA06 Dashboard toggle timing; branch SQL/Table Editor merge; restore-to-new-project clone; Dashboard-made S3 keys | live-cheap (one Pro project per experiment; the clone adds one for under an hour) | 3 h session | HUMAN SESSION (Dashboard) | #158 needs a small module that takes the Dashboard key from the environment; the clone source needs a daily backup (a project up for more than 24 h, or the standing project) |
| H2 governed-starter-kit interactive | #71 #78 #161 | interactive destructive-SQL confirm and paid-resource confirmation; Logs Explorer query in the Dashboard; Claude OAuth login and consent; first 502 after a fanout deploy with function logs | live-cheap (kit project, Team org Micro) | 3 h session | HUMAN SESSION (Claude Code interactive, browser consent, Dashboard) | kit project destroyed 2026-10-09; re-provision first |
| P1 managed Pipelines | #93 #155 | managed copy time, lag, paused billing and WAL retention on a managed destination; OrioleDB tables on the same pipeline, PITR restore of an oriole table, the 64-bit XID claim | live-paid (Pipelines per hour, PITR add-on) | 1 d | HUMAN SESSION (Pipelines are Dashboard-only; PAT gets 401) and a destination credential | REQUIRES USER GO-AHEAD (cost) |
| P2 read replica | #68 #169 | tls-surface TL12/TL16/TL20/TL21 re-run, replica TLS, IPv6; replica-routing re-routing on an unhealthy or lagging replica and non-REST traffic through the load balancer | live-paid (replica, Small primary and replica) | 0.5 d | an IPv6-capable vantage for the IPv6 rows | REQUIRES USER GO-AHEAD (cost) |
| P3 PITR restore ages | #170 | restore targets hours to days old, a database over 1 GB, the PITR window start | live-paid (PITR add-on kept for days) | 2-4 days wall, 2 h hands-on | no | REQUIRES USER GO-AHEAD (cost) |

Corrections to the waves plan's triage, found while reading the cards and
code for this plan:

- **#61 is not local-only.** The revoke and the gateway are on a managed
  project (self-hosted-auth SH05/SH06 run against one); only the issuer is a
  local GoTrue. Cost class live-cheap.
- **#45 has a route without the staging token.** Z02 was written for the
  staging control plane (s2z-wake README: "Point this experiment at staging
  only"), and staging needs the platform-org token #15 waits for. Z01 ran on
  a production free-plan org on 2026-10-13 (s2z-wake RUNLOG; a Pro org
  cannot pause), and Z02 gates its billable `terminal` operations behind
  `PVLAB_S2Z_TERMINAL=1`, so Z02 can run the same way at $0. The user
  confirms the first production write sweep.
- **30 experiment Makefiles call `harness/dist/pvlab`**, which is a linux-x64
  ELF and fails with `exec format error` on the lab's arm64 Mac. The
  governed-starter-kit, lifecycle-ops and newer experiments run
  `bun harness/src/run.ts` instead. Tasks O1-O2 switch the two Makefiles B01
  and B03 use; each later batch switches its own experiment's Makefile in its
  first task (the same `ifeq ($(shell uname -s),Linux)` block).

## Execution order

1. **Offline prep** (no network, no spend): Task O1 (#20 #67 code), Task O2
   (#129 code), Task O3 (#41 code), Task O4 (#42 code), Task O5 (sensors,
   board comments). Each later batch's own module code is also offline and is
   the first task of that batch's detailed plan.
2. **Live-cheap, code ready, no human:** B01, then B02 (it reuses B01's
   project), then B03, then B18 (Z02 is written and has never run; one
   confirmation from the user before it writes on production).
3. **Live-cheap, code at batch start, no human:** B09, B05, B06, B11, B13,
   B12, B04, B10, B07, B08. Shorter and single-experiment batches first;
   B14 can start any time (it is mostly waiting) and runs alongside.
4. **Local:** B15, B16, B17 (Bun half local; Vercel half needs the account).
5. **HUMAN SESSION, live-cheap:** H1, H2. Scheduled with the user; checklists
   below.
6. **Live-paid, last, each REQUIRES USER GO-AHEAD (cost):** P2, P3, P1 (P1 is
   also a HUMAN SESSION).

---

## Offline prep (detailed)

### Task O1: platform-downtime D01 reads the restart signal and the stop path (#20, #67)

**Files:**
- Create: `experiments/platform-downtime/lib/signal.ts` (pure: before/after measurements, postgres_logs classification)
- Test: `experiments/platform-downtime/lib/signal.test.ts`
- Modify: `experiments/platform-downtime/lib/setup.ts` (new `readShutdownLog`, `SHUTDOWN_LOG_SQL`)
- Modify: `experiments/platform-downtime/tests/d01-restart.ts` (whole file)
- Modify: `experiments/platform-downtime/Makefile` (run from source off Linux; `publish-evidence` target)

#20 asks whether a managed `POST /restart` resets `pg_stat_checkpointer`;
D05 already reads `pg_postmaster_start_time()` and `stats_reset` around a
password PATCH (`readRestartSignal` in `lib/setup.ts`), and the cheaper
route its own doc comment names is the same read around D01. #67 asks for a
managed-side signal of how the platform stops Postgres; jit-db-access JA01
found `received fast shutdown request` rows in `postgres_logs` on a managed
project, and checkpointer-reset (AGENTS.md key facts) says which startup line
goes with which stop on 17.x (`not properly shut down` with a stats reset;
`was shut down at` with stats kept). D01 now records both; its verdict is
unchanged (per-path outage).

- [x] **Step 1: Write the failing test**

**Create `experiments/platform-downtime/lib/signal.test.ts`:**

```ts
import { describe, expect, test } from "bun:test";
import {
  bootLogged,
  changed,
  classifyShutdownLog,
  logTimeMs,
  shutdownMeasurements,
  signalMeasurements,
} from "./signal";
import type { RestartSignal } from "./setup";

const sig = (startTime: string | null, reset: string | null): RestartSignal => ({
  startTime,
  checkpointerStatsReset: reset,
  checkpointerSource: reset ? "pg_stat_checkpointer" : null,
  error: "",
});

describe("changed", () => {
  test("an unreadable side is n/a, never 'no'", () => {
    expect(changed(null, "2026-10-13T00:00:00.000Z")).toBe("n/a");
    expect(changed("2026-10-13T00:00:00.000Z", null)).toBe("n/a");
  });

  test("equal is no, different is yes", () => {
    expect(changed("a", "a")).toBe("no");
    expect(changed("a", "b")).toBe("yes");
  });
});

describe("signalMeasurements", () => {
  test("a restart that kept checkpointer stats", () => {
    const m = signalMeasurements(
      sig("2026-10-13T01:00:00.000Z", "2026-10-01T00:00:00.000Z"),
      sig("2026-10-13T02:00:00.000Z", "2026-10-01T00:00:00.000Z"),
    );
    expect(m.restart_confirmed).toBe("yes");
    expect(m.checkpointer_stats_reset_changed).toBe("no");
    expect(m.checkpointer_source).toBe("pg_stat_checkpointer");
  });

  test("a restart that reset checkpointer stats", () => {
    const m = signalMeasurements(
      sig("2026-10-13T01:00:00.000Z", "2026-10-01T00:00:00.000Z"),
      sig("2026-10-13T02:00:00.000Z", "2026-10-13T02:00:00.000Z"),
    );
    expect(m.checkpointer_stats_reset_changed).toBe("yes");
  });

  test("an unreadable after-read is n/a on both questions", () => {
    const m = signalMeasurements(sig("2026-10-13T01:00:00.000Z", "2026-10-01T00:00:00.000Z"), sig(null, null));
    expect(m.restart_confirmed).toBe("n/a");
    expect(m.checkpointer_stats_reset_changed).toBe("n/a");
    expect(m.postmaster_start_after).toBe("n/a");
    expect(m.checkpointer_source).toBe("pg_stat_checkpointer");
  });
});

describe("logTimeMs", () => {
  test("an ISO string without a zone is UTC, not local time", () => {
    expect(logTimeMs("2026-10-13T01:02:03.456")).toBe(Date.UTC(2026, 9, 13, 1, 2, 3, 456));
    expect(logTimeMs("2026-10-13 01:02:03")).toBe(Date.UTC(2026, 9, 13, 1, 2, 3));
  });

  test("an explicit zone is honoured", () => {
    expect(logTimeMs("2026-10-13T01:02:03Z")).toBe(Date.UTC(2026, 9, 13, 1, 2, 3));
    expect(logTimeMs("2026-10-13T09:02:03+08:00")).toBe(Date.UTC(2026, 9, 13, 1, 2, 3));
  });

  test("microseconds since the epoch (the retired logs.all shape) become milliseconds", () => {
    const ms = Date.UTC(2026, 9, 13, 1, 2, 3);
    expect(logTimeMs(ms * 1000)).toBe(ms);
    expect(logTimeMs(String(ms * 1000))).toBe(ms);
    expect(logTimeMs(ms)).toBe(ms);
  });

  test("garbage is null", () => {
    expect(logTimeMs("not a time")).toBeNull();
    expect(logTimeMs(undefined)).toBeNull();
    expect(logTimeMs("")).toBeNull();
  });
});

describe("classifyShutdownLog", () => {
  const t = (s: number) => `2026-10-13T01:00:${String(s).padStart(2, "0")}.000`;
  const since = Date.UTC(2026, 9, 13, 1, 0, 10);

  test("the vanilla clean sequence (checkpointer-reset RUNLOG) reads as fast stop, clean boot", () => {
    const r = classifyShutdownLog(
      [
        { timestamp: t(41), event_message: "database system was shut down at 2026-10-13 01:00:20 UTC" },
        { timestamp: t(12), event_message: "received fast shutdown request" },
        { timestamp: t(13), event_message: "aborting any active transactions" },
        { timestamp: t(14), event_message: "checkpoint starting: shutdown immediate" },
        { timestamp: t(20), event_message: "database system is shut down" },
      ],
      since,
    );
    expect(r.stopMode).toBe("fast");
    expect(r.shutdownCheckpointLogged).toBe(true);
    expect(r.shutDownLogged).toBe(true);
    expect(r.nextBoot).toBe("clean");
    expect(bootLogged(r)).toBe(true);
    expect(r.lines).toHaveLength(5);
    expect(r.lines[0]).toBe("2026-10-13T01:00:12.000Z received fast shutdown request");
  });

  test("the crash sequence reads as crash-recovery with no stop logged", () => {
    const r = classifyShutdownLog(
      [
        { timestamp: t(30), event_message: "database system was interrupted; last known up at 2026-10-13 00:59:00 UTC" },
        { timestamp: t(31), event_message: "database system was not properly shut down; automatic recovery in progress" },
      ],
      since,
    );
    expect(r.stopMode).toBe("not-logged");
    expect(r.shutDownLogged).toBe(false);
    expect(r.nextBoot).toBe("crash-recovery");
  });

  test("lines before the cut-off belong to an earlier restart and are ignored", () => {
    const r = classifyShutdownLog(
      [
        { timestamp: t(1), event_message: "received immediate shutdown request" },
        { timestamp: t(2), event_message: "database system was not properly shut down; automatic recovery in progress" },
        { timestamp: t(15), event_message: "received smart shutdown request" },
      ],
      since,
    );
    expect(r.stopMode).toBe("smart");
    expect(r.nextBoot).toBe("not-logged");
    expect(bootLogged(r)).toBe(false);
  });

  test("nothing logged yet", () => {
    const r = classifyShutdownLog([], since);
    expect(shutdownMeasurements(r)).toEqual({
      log_stop_mode: "not-logged",
      log_shutdown_checkpoint: "no",
      log_shut_down: "no",
      log_next_boot: "not-logged",
      log_lines: 0,
    });
  });
});
```

- [x] **Step 2: Run it to make sure it fails**

Run: `bun test experiments/platform-downtime/lib; echo "exit $?"`

Expected: `exit 1`, with `error: Cannot find module './signal' from '<repo>/experiments/platform-downtime/lib/signal.test.ts'`
under "Unhandled error between tests" and the summary ` 0 pass`, ` 1 fail`,
` 1 error`.

- [x] **Step 3: Write the pure helpers**

**Create `experiments/platform-downtime/lib/signal.ts`:**

```ts
/**
 * What a restart leaves behind, read two ways (work-supabase-lab#20, #67).
 *
 * 1. Counters, before and after: `pg_postmaster_start_time()` and the
 *    checkpointer's `stats_reset` (the pair D05 reads, `readRestartSignal` in
 *    setup.ts). A moved start time with an unmoved `stats_reset` is a restart
 *    that kept its cumulative stats, which the checkpointer-reset local rig
 *    showed for a clean stop; a moved `stats_reset` is a restart that behaved
 *    like a crash for those counters.
 * 2. Postgres's own log lines in `postgres_logs`: which shutdown request it
 *    received, whether it logged the shutdown checkpoint and "database system
 *    is shut down", and how the next boot described the previous stop. That
 *    is the managed-side signal #67 asks for. The texts are the ones the
 *    checkpointer-reset rig (vanilla Postgres) and jit-db-access JA01
 *    (managed) recorded in their RUNLOGs; the smart and immediate request
 *    lines are Postgres's sibling messages and have not been seen in this lab.
 *
 * Pure: no network. Unit tests in signal.test.ts.
 */
import type { RestartSignal } from "./setup";

export type Changed = "yes" | "no" | "n/a";

/** "n/a" when either side is unreadable: an unread value is not an unchanged one. */
export function changed(before: string | null, after: string | null): Changed {
  if (!before || !after) return "n/a";
  return before === after ? "no" : "yes";
}

export function signalMeasurements(before: RestartSignal, after: RestartSignal): Record<string, string> {
  return {
    postmaster_start_before: before.startTime ?? "n/a",
    postmaster_start_after: after.startTime ?? "n/a",
    restart_confirmed: changed(before.startTime, after.startTime),
    checkpointer_source: after.checkpointerSource ?? before.checkpointerSource ?? "n/a",
    checkpointer_stats_reset_before: before.checkpointerStatsReset ?? "n/a",
    checkpointer_stats_reset_after: after.checkpointerStatsReset ?? "n/a",
    checkpointer_stats_reset_changed: changed(before.checkpointerStatsReset, after.checkpointerStatsReset),
  };
}

export interface LogLine {
  timestamp?: unknown;
  event_message?: unknown;
}

/**
 * Epoch milliseconds for a logs-endpoint timestamp. The unified `logs` table
 * returns an ISO string in UTC (harness/src/platform.ts); one without a zone
 * suffix is read as UTC, not as this machine's local time. The retired
 * `logs.all` shape was microseconds since the epoch, accepted for old rows.
 */
export function logTimeMs(ts: unknown): number | null {
  const fromNumber = (n: number) => (n > 1e14 ? Math.floor(n / 1000) : n);
  if (typeof ts === "number") return Number.isFinite(ts) ? fromNumber(ts) : null;
  if (typeof ts !== "string" || !ts.trim()) return null;
  const s = ts.trim();
  if (/^\d+$/.test(s)) return fromNumber(Number(s));
  const iso = /([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export type StopMode = "fast" | "smart" | "immediate" | "not-logged";
export type BootKind = "clean" | "crash-recovery" | "not-logged";

export interface ShutdownReading {
  stopMode: StopMode;
  shutdownCheckpointLogged: boolean;
  shutDownLogged: boolean;
  nextBoot: BootKind;
  /** Matching lines at or after the cut-off, oldest first, as "<iso> <message>". */
  lines: string[];
}

const REQUEST = /received (fast|smart|immediate) shutdown request/;
const SHUTDOWN_CHECKPOINT = /checkpoint starting: shutdown/;
const SHUT_DOWN = /database system is shut down/;
const CLEAN_BOOT = /database system was shut down at/;
const CRASH_BOOT = /database system was (not properly shut down|interrupted)/;

/** Rows older than `sinceMs` are dropped: the query window is an hour and may hold an earlier restart. */
export function classifyShutdownLog(rows: LogLine[], sinceMs: number): ShutdownReading {
  const kept = rows
    .map((r) => ({
      t: logTimeMs(r.timestamp),
      m: typeof r.event_message === "string" ? r.event_message.trim() : "",
    }))
    .filter((r): r is { t: number; m: string } => r.t !== null && r.t >= sinceMs && r.m !== "")
    .sort((a, b) => a.t - b.t);

  let stopMode: StopMode = "not-logged";
  let shutdownCheckpointLogged = false;
  let shutDownLogged = false;
  let nextBoot: BootKind = "not-logged";
  for (const { m } of kept) {
    const req = REQUEST.exec(m);
    if (req && stopMode === "not-logged") stopMode = req[1] as StopMode;
    if (SHUTDOWN_CHECKPOINT.test(m)) shutdownCheckpointLogged = true;
    if (SHUT_DOWN.test(m)) shutDownLogged = true;
    if (CRASH_BOOT.test(m)) nextBoot = "crash-recovery";
    else if (CLEAN_BOOT.test(m) && nextBoot === "not-logged") nextBoot = "clean";
  }
  return {
    stopMode,
    shutdownCheckpointLogged,
    shutDownLogged,
    nextBoot,
    lines: kept.map(({ t, m }) => `${new Date(t).toISOString()} ${m}`.slice(0, 200)),
  };
}

/** Logs ingestion lags the event (32 s in audit-integrity); the read is done once the next boot shows. */
export function bootLogged(r: ShutdownReading): boolean {
  return r.nextBoot !== "not-logged";
}

export function shutdownMeasurements(r: ShutdownReading): Record<string, string | number> {
  return {
    log_stop_mode: r.stopMode,
    log_shutdown_checkpoint: r.shutdownCheckpointLogged ? "yes" : "no",
    log_shut_down: r.shutDownLogged ? "yes" : "no",
    log_next_boot: r.nextBoot,
    log_lines: r.lines.length,
  };
}
```

- [x] **Step 4: Run the tests to make sure they pass**

Run: `bun test experiments/platform-downtime/lib; echo "exit $?"`

Expected: ` 13 pass`, ` 0 fail`, `exit 0`.

- [x] **Step 5: The logs read in `lib/setup.ts`**

**Replace in `experiments/platform-downtime/lib/setup.ts`:**

```text
import { sql } from "../../../harness/src/platform";
import { restProbe, authProbe, storageProbe, realtimeProbe, poolerProbe } from "./probes";
```

**with:**

```text
import { logsQuery, sql } from "../../../harness/src/platform";
import { restProbe, authProbe, storageProbe, realtimeProbe, poolerProbe } from "./probes";
import { bootLogged, classifyShutdownLog, type ShutdownReading } from "./signal";
```

**Replace in `experiments/platform-downtime/lib/setup.ts`:**

```text
/**
 * `PATCH /v1/projects/{ref}/database/password` - verified against the LIVE
```

**with:**

```text
/**
 * #67: Postgres's own account of a stop and the next boot, from
 * `postgres_logs` (the query shape jit-db-access JA01 used to find "received
 * fast shutdown request" on a managed project). Ingestion lags the event, so
 * this polls until the next boot is logged or `polls` reads have been spent;
 * the logs endpoint allows few requests per window, so keep `polls` small.
 * Never throws: a logs error is returned for the caller to record.
 */
export const SHUTDOWN_LOG_SQL =
  "select timestamp, event_message from logs where source = 'postgres_logs' and (" +
  "event_message like '%shutdown request%' or event_message like '%checkpoint starting: shutdown%' or " +
  "event_message like '%database system is shut down%' or event_message like '%database system was %') " +
  "order by timestamp asc limit 100";

export async function readShutdownLog(
  ctx: Ctx,
  sinceMs: number,
  polls = 8,
  everyMs = 20_000,
): Promise<{ reading: ShutdownReading; error: string }> {
  let reading = classifyShutdownLog([], sinceMs);
  let error = "";
  for (let i = 0; i < polls; i++) {
    const r = await logsQuery(ctx, SHUTDOWN_LOG_SQL, 1).catch((e: unknown) => ({
      status: 0,
      rows: [],
      error: e instanceof Error ? e.message : String(e),
    }));
    error = r.error;
    if (!r.error) reading = classifyShutdownLog(r.rows, sinceMs);
    if (bootLogged(reading)) break;
    if (i < polls - 1) await Bun.sleep(everyMs);
  }
  return { reading, error };
}

/**
 * `PATCH /v1/projects/{ref}/database/password` - verified against the LIVE
```

- [x] **Step 6: D01 reads both, around the restart**

**Write `experiments/platform-downtime/tests/d01-restart.ts` (whole file):**

```ts
/**
 * D01 - client-visible outage across a project restart, per connection path.
 *
 * DESTRUCTIVE: restarts the project.
 *
 * Generalises t14-restart.ts (privatelink-aws), which measured ONE path (a
 * Lambda on 6543) at its PROBE_EVERY_MS = 5000 resolution, so every window
 * there is quantised to +/- 5s and a short one reports "no client-visible
 * failure observed". The result worth carrying forward from that run: the
 * failure mode was "timeout expired", not a refusal - a caller with a long
 * client timeout spends its whole budget on a single attempt.
 *
 * intervalMs / settleMs / maxWaitMs are chosen starting values, not measured
 * optima. The interval is recorded as a column so no number here is readable
 * without the resolution it was taken at.
 *
 * Since 2026-10-13 (work-supabase-lab#20, #67) the run also records what the
 * restart did to Postgres itself: `pg_postmaster_start_time()` and the
 * checkpointer's `stats_reset` before and after (D05's read), and the
 * shutdown/boot lines Postgres wrote to `postgres_logs` (lib/signal.ts). They
 * are measurements only; the pass/fail verdict is still the per-path outage.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { sampleDuring } from "../../../harness/src/sampler";
import {
  buildProbes,
  verdict,
  INTERVAL_MS,
  SETTLE_MS,
  readRestartSignal,
  readRestartSignalRetrying,
  readShutdownLog,
} from "../lib/setup";
import { shutdownMeasurements, signalMeasurements } from "../lib/signal";

const MAX_WAIT_MS = 420_000;
/** Log timestamps are the server's clock, and the stop may begin before the API call returns. */
const LOG_SLACK_MS = 30_000;

const mod: TestModule = {
  id: "D01",
  title: "Restart: client-visible outage per connection path",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx): Promise<TestResult> {
    const { probes, note } = await buildProbes(ctx);
    ctx.log(note);

    // Read before sampling starts, so the read is not inside the outage window.
    const before = await readRestartSignal(ctx);
    ctx.log(
      `before: postmaster_start=${before.startTime ?? "?"} ` +
        `${before.checkpointerSource ?? "checkpointer"}.stats_reset=${before.checkpointerStatsReset ?? "?"}` +
        (before.error ? ` (${before.error})` : ""),
    );

    let requestedMs = Date.now();
    const windows = await sampleDuring(
      probes,
      { intervalMs: INTERVAL_MS, maxWaitMs: MAX_WAIT_MS, settleMs: SETTLE_MS, log: ctx.log },
      async () => {
        requestedMs = Date.now();
        const res = await fetch(`https://api.supabase.com/v1/projects/${ctx.ref}/restart`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.pat}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`restart request failed: HTTP ${res.status}`);
        ctx.log(`restart API: HTTP ${res.status}`);
      },
    );

    const after = await readRestartSignalRetrying(ctx);
    ctx.log(
      `after: postmaster_start=${after.startTime ?? "?"} ` +
        `${after.checkpointerSource ?? before.checkpointerSource ?? "checkpointer"}.stats_reset=${after.checkpointerStatsReset ?? "?"}`,
    );
    const { reading, error } = await readShutdownLog(ctx, requestedMs - LOG_SLACK_MS);
    ctx.log(`postgres_logs: stop=${reading.stopMode} next_boot=${reading.nextBoot} lines=${reading.lines.length}${error ? ` error=${error}` : ""}`);

    const base = verdict("D01", mod.title, windows);
    const sig = signalMeasurements(before, after);
    return {
      ...base,
      detail:
        `${base.detail}; restart confirmed by pg_postmaster_start_time: ${sig.restart_confirmed}; ` +
        `${sig.checkpointer_source}.stats_reset changed: ${sig.checkpointer_stats_reset_changed}; ` +
        `postgres_logs: stop ${reading.stopMode}, next boot ${reading.nextBoot}` +
        (error ? ` (logs error: ${error.slice(0, 80)})` : ""),
      measurements: { ...base.measurements, ...sig, ...shutdownMeasurements(reading) },
      evidence: reading.lines.join("\n") || (error ? `logs error: ${error}` : "no matching postgres_logs lines"),
    } as TestResult;
  },
};
export default mod;
```

- [x] **Step 7: Makefile runs from source off Linux and can publish**

**Replace in `experiments/platform-downtime/Makefile`:**

```text
TS := $(shell date +%Y%m%d-%H%M%S)
```

**with:**

```text
TS := $(shell date +%Y%m%d-%H%M%S)

# The harness build is linux-x64 only; elsewhere run the same entry from source
# (the governed-starter-kit Makefile's switch).
ifeq ($(shell uname -s),Linux)
RUNNER := $(ROOT)/harness/dist/pvlab
BUILD  := cd $(ROOT)/harness && bun run build >/dev/null
else
RUNNER := bun $(ROOT)/harness/src/run.ts
BUILD  := cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null
endif
```

**Replace in `experiments/platform-downtime/Makefile`:**

```text
.PHONY: init fmt validate apply probe probe-destructive destroy
```

**with:**

```text
.PHONY: init fmt validate apply probe probe-destructive publish-evidence destroy
```

**Replace in `experiments/platform-downtime/Makefile`:**

```text
	@cd $(ROOT)/harness && bun run build >/dev/null
```

**with:**

```text
	@$(BUILD)
```

**Replace in `experiments/platform-downtime/Makefile`:**

```text
		$(ROOT)/harness/dist/pvlab --where local --experiment platform-downtime \
```

**with:**

```text
		$(RUNNER) --where local --experiment platform-downtime \
```

**Replace in `experiments/platform-downtime/Makefile`:**

```text
destroy:
	@tofu plan -destroy
```

**with:**

```text
# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)

destroy:
	@tofu plan -destroy
```

- [x] **Step 8: Verify**

Run:

```bash
bunx tsc --noEmit -p harness/tsconfig.json; echo "tsc exit $?"
(cd harness && bun test > /tmp/w3-bun-test.txt 2>&1; echo "bun test exit $?"); tail -4 /tmp/w3-bun-test.txt
(cd harness && bun scripts/gen-registry.ts >/dev/null); rm -rf /tmp/w3-skip/platform-downtime
env -u SUPABASE_ACCESS_TOKEN -u PVLAB_REF -u SUPABASE_ANON_KEY -u DB_PASSWORD -u PVLAB_ORG_SLUGS \
  bun harness/src/run.ts --where local --experiment platform-downtime --only D01 --destructive --out /tmp/w3-skip/platform-downtime
jq -c '.results[] | {id,status,detail}' /tmp/w3-skip/platform-downtime/run-*.json
make -C experiments/platform-downtime -n probe-destructive ONLY=D01 SUPABASE_ACCESS_TOKEN=x PW=x | rg 'run.ts|dist/pvlab'
```

Expected: `tsc exit 0`; `bun test exit 0` with ` 1782 pass` and ` 0 fail`
(1780 + 2 files scanned); `pvlab: 0 to run, 1 skipped (...)` and
`{"id":"D01","status":"skip","detail":"missing capability: pat, anon-key"}`;
on macOS one line containing `bun <repo>/harness/src/run.ts --where local --experiment platform-downtime`
(on Linux it names `harness/dist/pvlab`). The `make -n` line runs
`tofu output` to compute `REF`, which reads local state only.

- [ ] **Step 9: Commit**

```bash
git add experiments/platform-downtime/lib/signal.ts experiments/platform-downtime/lib/signal.test.ts \
  experiments/platform-downtime/lib/setup.ts experiments/platform-downtime/tests/d01-restart.ts \
  experiments/platform-downtime/Makefile
git commit -m "feat(platform-downtime): D01 reads the restart signal and postgres_logs stop lines"
```

Executed 2026-10-13: Steps 1-8 as written (red `Cannot find module`,
0 pass / 1 fail / 1 error; green 13 pass; `tsc exit 0`; 1782 pass; D01 skip
`missing capability: pat, anon-key`; `make -n` names `bun <repo>/harness/src/run.ts`).
Deviation: Step 9, plan said `git add` + `git commit`; the agent session
cannot commit, so the operator's commit script commits these paths with the
same subject (pathspec commit, nothing else in the tree swept in).

### Task O2: pg_graphql-aware GraphQL reads in DA03 and T22 (#129)

**Files:**
- Create: `harness/src/graphql.ts` (`GRAPHQL_TYPENAME_QUERY`, `graphqlState`, `pgGraphqlInstalled`)
- Test: `harness/src/graphql.test.ts`
- Modify: `experiments/data-api-reenable/tests/da03-dashboard-reenable.ts`
- Modify: `experiments/privatelink-aws/tests/t22-dataapi-disable.ts`
- Modify: `experiments/data-api-reenable/Makefile` (run from source off Linux)
- Modify: `experiments/privatelink-aws/RUNLOG.md` (open item for the T22 re-run)

data-api-reenable's own GraphQL probe already POSTs `{ __typename }` and
treats an errors envelope as not-ok (`lib/reenable.ts`), so on a project
without pg_graphql its column read `200 not-ok` before and after: it measured
nothing. DA03 now reads `pg_extension` and, when pg_graphql is absent,
installs it for the measurement and drops it in `finally`. T22 sent a bare
`GET /graphql/v1` and recorded the status only; it now POSTs the same query
and records `graphqlState` (the DD02e fix, moved into the harness so both
modules share it).

- [x] **Step 1: Write the failing test**

**Create `harness/src/graphql.test.ts`:**

```ts
import { describe, expect, test } from "bun:test";
import { graphqlState } from "./graphql";

describe("graphqlState", () => {
  test("a served { __typename } is ok:<type>", () => {
    expect(graphqlState(200, '{"data":{"__typename":"Query"}}')).toBe("200 ok:Query");
  });

  test("pg_graphql absent: 200 with an errors envelope is not served (DD02e)", () => {
    expect(graphqlState(200, '{"data":null,"errors":[{"message":"pg_graphql extension is not enabled."}]}')).toBe(
      "200 pg_graphql extension is not enabled.",
    );
  });

  test("graphql_public not exposed: the PostgREST code", () => {
    expect(
      graphqlState(406, '{"code":"PGRST106","details":null,"hint":null,"message":"The schema must be one of the following: public"}'),
    ).toBe("406 PGRST106");
  });

  test("a message-only body, a non-JSON body and an empty body", () => {
    expect(graphqlState(401, '{"message":"Invalid API key"}')).toBe("401 Invalid API key");
    expect(graphqlState(502, "<html>bad gateway</html>")).toBe("502 <html>bad gateway</html>");
    expect(graphqlState(204, "")).toBe("204");
    expect(graphqlState(200, "null")).toBe("200");
  });
});
```

- [x] **Step 2: Run it to make sure it fails**

Run: `(cd harness && bun test src/graphql.test.ts; echo "exit $?")`

Expected: `exit 1`, with `error: Cannot find module './graphql' from '<repo>/harness/src/graphql.test.ts'`
under "Unhandled error between tests" and the summary ` 0 pass`, ` 1 fail`,
` 1 error`.

- [x] **Step 3: Write the helper**

**Create `harness/src/graphql.ts`:**

```ts
/**
 * What `/graphql/v1` is actually saying (work-supabase-lab#129).
 *
 * pg_graphql is not enabled on new projects and its introspection is off by
 * default from 1.6.0 (changelog 42180 / 46320; data-api-defaults DD02). On a
 * project without it, `/graphql/v1` still answers HTTP 200, with an errors
 * envelope ("pg_graphql extension is not enabled."), so a status code alone
 * reads "GraphQL up" on a project that has no GraphQL. DD02e measured the fix
 * iap-lockdown uses: POST `{ __typename }` (it needs no introspection) and read
 * the body. A served query is `200 ok:Query`; anything else carries the first
 * error message or the PostgREST code (`406 PGRST106` when `graphql_public` is
 * not in the exposed schemas).
 */
import { sql } from "./platform";
import type { Ctx } from "./types";

export const GRAPHQL_TYPENAME_QUERY = "{ __typename }";

/** "<status> <what the body says>", e.g. `200 ok:Query`, `200 pg_graphql extension is not enabled.`, `406 PGRST106`. */
export function graphqlState(status: number, body: string): string {
  let said = "";
  try {
    const j = JSON.parse(body) as {
      data?: { __typename?: unknown } | null;
      errors?: { message?: unknown }[];
      code?: unknown;
      message?: unknown;
    } | null;
    if (j && typeof j.data?.__typename === "string") said = `ok:${j.data.__typename}`;
    else if (j && Array.isArray(j.errors) && j.errors.length > 0) said = String(j.errors[0]?.message ?? "error");
    else if (j && j.code !== undefined && j.code !== null) said = String(j.code);
    else if (j && j.message !== undefined && j.message !== null) said = String(j.message);
  } catch {
    said = body.trim().slice(0, 60);
  }
  return said ? `${status} ${said.slice(0, 80)}` : String(status);
}

/** Whether pg_graphql is installed, via the Management query endpoint; null when the read failed. */
export async function pgGraphqlInstalled(ctx: Ctx): Promise<boolean | null> {
  const r = await sql(ctx, "select count(*)::int as n from pg_extension where extname = 'pg_graphql'");
  if (r.status !== 201 || !r.rows[0]) return null;
  return Number(r.rows[0].n ?? 0) > 0;
}
```

- [x] **Step 4: Run the tests to make sure they pass**

Run: `(cd harness && bun test src/graphql.test.ts; echo "exit $?")`

Expected: ` 4 pass`, ` 0 fail`, `exit 0`.

- [x] **Step 5: DA03 checks pg_extension and installs pg_graphql for the measurement**

**Replace in `experiments/data-api-reenable/tests/da03-dashboard-reenable.ts`:**

```text
 * DESTRUCTIVE: switches the Data API off. Restores the exact baseline config.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys } from "../../../harness/src/platform.js";
```

**with:**

```text
 * DESTRUCTIVE: switches the Data API off. Restores the exact baseline config.
 *
 * pg_graphql (work-supabase-lab#129): new projects do not have it, and then
 * `/graphql/v1` answers 200 with an errors envelope whether or not the Data
 * API works, so the graphql column measured nothing. The module now reads
 * `pg_extension` first; when pg_graphql is absent it installs it for the
 * measurement (DD02b: served at the first poll) and drops it again in
 * `finally` (DA03y).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { pgGraphqlInstalled } from "../../../harness/src/graphql.js";
import { fetchKeys, sql } from "../../../harness/src/platform.js";
```

**Replace in `experiments/data-api-reenable/tests/da03-dashboard-reenable.ts`:**

```text
    const out: TestResult[] = [];

    try {
      await setSchemas(ctx, base, withExtra);
```

**with:**

```text
    const out: TestResult[] = [];
    const gqlAtStart = await pgGraphqlInstalled(ctx);
    let gqlInstalledHere = false;

    try {
      if (gqlAtStart === false) {
        const c = await sql(ctx, "create extension pg_graphql");
        gqlInstalledHere = c.status === 201;
        ctx.log(`pg_graphql absent at start; create extension -> HTTP ${c.status}${c.error ? ` ${c.error}` : ""}`);
      }
      await setSchemas(ctx, base, withExtra);
```

**Replace in `experiments/data-api-reenable/tests/da03-dashboard-reenable.ts`:**

```text
          db_schema_after: cfg.db_schema,
```

**with:**

```text
          db_schema_after: cfg.db_schema,
          pg_graphql_at_start: gqlAtStart === null ? "unread" : gqlAtStart ? "yes" : "no",
          pg_graphql_installed_by_module: gqlInstalledHere ? "yes" : "no",
```

**Replace in `experiments/data-api-reenable/tests/da03-dashboard-reenable.ts`:**

```text
        detail: back.status === 200 ? "restored" : `restore HTTP ${back.status}`,
      });
    }
```

**with:**

```text
        detail: back.status === 200 ? "restored" : `restore HTTP ${back.status}`,
      });
      if (gqlInstalledHere) {
        const d = await sql(ctx, "drop extension pg_graphql");
        out.push({
          id: "DA03y",
          title: "drop the pg_graphql this module installed",
          status: d.status === 201 ? "pass" : "fail",
          detail: d.status === 201 ? "dropped" : `drop HTTP ${d.status} ${d.error}`,
        });
      }
    }
```

- [x] **Step 6: T22 POSTs `{ __typename }` and records what the body says**

**Replace in `experiments/privatelink-aws/tests/t22-dataapi-disable.ts`:**

```text
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const MGMT
```

**with:**

```text
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { GRAPHQL_TYPENAME_QUERY, graphqlState, pgGraphqlInstalled } from "../../../harness/src/graphql";

const MGMT
```

**Replace in `experiments/privatelink-aws/tests/t22-dataapi-disable.ts`:**

```text
async function snapshot(ctx: Ctx): Promise<Snapshot> {
```

**with:**

```text
/**
 * POST `{ __typename }`, not a bare GET (work-supabase-lab#129): on a project
 * without pg_graphql the endpoint answers 200 with an errors envelope, so the
 * status alone said nothing. `graphqlState` reads the body.
 */
async function postGraphql(ctx: Ctx): Promise<Probe> {
  const key = ctx.anonKey ?? "";
  try {
    const res = await fetch(`https://${ctx.apiHost}/graphql/v1`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: GRAPHQL_TYPENAME_QUERY }),
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, body: (await res.text()).slice(0, 300) };
  } catch (e) {
    return { status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

async function snapshot(ctx: Ctx): Promise<Snapshot> {
```

**Replace in `experiments/privatelink-aws/tests/t22-dataapi-disable.ts`:**

```text
    graphql: await get(ctx, "/graphql/v1"),
```

**with:**

```text
    graphql: await postGraphql(ctx),
```

**Replace in `experiments/privatelink-aws/tests/t22-dataapi-disable.ts`:**

```text
    const live = await snapshot(ctx);
```

**with:**

```text
    const live = await snapshot(ctx);
    const gqlInstalled = await pgGraphqlInstalled(ctx);
```

**Replace in `experiments/privatelink-aws/tests/t22-dataapi-disable.ts`:**

```text
        root_status: live.root.status,
        db_schema: baseline.db_schema,
      },
```

**with:**

```text
        root_status: live.root.status,
        db_schema: baseline.db_schema,
        graphql_state: graphqlState(live.graphql.status, live.graphql.body),
        pg_graphql_installed: gqlInstalled === null ? "unread" : gqlInstalled ? "yes" : "no",
      },
```

**Replace in `experiments/privatelink-aws/tests/t22-dataapi-disable.ts`:**

```text
          disabled_graphql_status: dead.last.graphql.status,
```

**with:**

```text
          disabled_graphql_status: dead.last.graphql.status,
          disabled_graphql_state: graphqlState(dead.last.graphql.status, dead.last.graphql.body),
```

**Replace in `experiments/privatelink-aws/tests/t22-dataapi-disable.ts`:**

```text
        detail: `${classify(held)}; root still HTTP ${held.root.status}, graphql HTTP ${held.graphql.status}`,
```

**with:**

```text
        detail: `${classify(held)}; root still HTTP ${held.root.status}, graphql ${graphqlState(held.graphql.status, held.graphql.body)}`,
```

**Replace in `experiments/privatelink-aws/tests/t22-dataapi-disable.ts`:**

```text
          graphql_status: held.graphql.status,
```

**with:**

```text
          graphql_status: held.graphql.status,
          graphql_state: graphqlState(held.graphql.status, held.graphql.body),
```

- [x] **Step 7: data-api-reenable Makefile runs from source off Linux**

**Replace in `experiments/data-api-reenable/Makefile`:**

```text
TS := $(shell date +%Y%m%d-%H%M%S)
```

**with:**

```text
TS := $(shell date +%Y%m%d-%H%M%S)

# The harness build is linux-x64 only; elsewhere run the same entry from source
# (the governed-starter-kit Makefile's switch).
ifeq ($(shell uname -s),Linux)
RUNNER := $(ROOT)/harness/dist/pvlab
BUILD  := cd $(ROOT)/harness && bun run build >/dev/null
else
RUNNER := bun $(ROOT)/harness/src/run.ts
BUILD  := cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null
endif
```

**Replace in `experiments/data-api-reenable/Makefile`:**

```text
	@cd $(ROOT)/harness && bun run build >/dev/null
```

**with:**

```text
	@$(BUILD)
```

**Replace in `experiments/data-api-reenable/Makefile`:**

```text
		$(ROOT)/harness/dist/pvlab --where local --experiment data-api-reenable \
```

**with:**

```text
		$(RUNNER) --where local --experiment data-api-reenable \
```

- [x] **Step 8: Record the unrun T22 change**

**Append to `experiments/privatelink-aws/RUNLOG.md`:**

```text
- [ ] Re-run T22 after work-supabase-lab#130: since 2026-10-13 its GraphQL
      probe POSTs `{ __typename }` and records `graphql_state`
      (`harness/src/graphql.ts`) and `pg_graphql_installed`, because a bare
      GET status reads "up" on a project without pg_graphql (#129). Changed,
      typechecked, not run.
```

- [x] **Step 9: Verify**

Run:

```bash
bunx tsc --noEmit -p harness/tsconfig.json; echo "tsc exit $?"
(cd harness && bun test > /tmp/w3-bun-test.txt 2>&1; echo "bun test exit $?"); tail -4 /tmp/w3-bun-test.txt
(cd harness && bun scripts/gen-registry.ts >/dev/null); rm -rf /tmp/w3-skip/data-api-reenable /tmp/w3-skip/privatelink-aws
for spec in "data-api-reenable DA03" "privatelink-aws T22"; do set -- $(echo $spec)
  env -u SUPABASE_ACCESS_TOKEN -u PVLAB_REF -u SUPABASE_ANON_KEY -u DB_PASSWORD -u PVLAB_ORG_SLUGS \
    bun harness/src/run.ts --where local --experiment $1 --only $2 --destructive --out /tmp/w3-skip/$1 | rg '^pvlab:'
  jq -c '.results[] | {id,status,detail}' /tmp/w3-skip/$1/run-*.json
done
make -C experiments/data-api-reenable -n probe-destructive ONLY=DA03 SUPABASE_ACCESS_TOKEN=x PW=x | rg 'run.ts|dist/pvlab'
```

Expected: `tsc exit 0`; `bun test exit 0` with ` 1788 pass` and ` 0 fail`
(1782 + 4 tests + 2 files scanned);
`{"id":"DA03","status":"skip","detail":"missing capability: pat"}` and
`{"id":"T22","status":"skip","detail":"runs on \"runner\", this process is \"local\""}`;
on macOS one line naming `harness/src/run.ts --where local --experiment data-api-reenable`.

- [ ] **Step 10: Commit**

```bash
git add harness/src/graphql.ts harness/src/graphql.test.ts \
  experiments/data-api-reenable/tests/da03-dashboard-reenable.ts experiments/data-api-reenable/Makefile \
  experiments/privatelink-aws/tests/t22-dataapi-disable.ts experiments/privatelink-aws/RUNLOG.md
git commit -m "fix(data-api-reenable,privatelink-aws): read GraphQL by body and pg_extension, not status"
```

Executed 2026-10-13: Steps 1-9 as written (red `Cannot find module`; green
4 pass; `tsc exit 0`; 1788 pass; DA03 and T22 skip details as expected;
`make -n` names `bun <repo>/harness/src/run.ts`). Deviation: Step 10 goes
to the operator's commit script (agent commits blocked), same paths and subject.

### Task O3: platform-facts F07, eligibility across the lab orgs (#41)

**Files:**
- Create: `experiments/platform-facts/lib/eligibility.ts` (pure: rows without refs or names, summary)
- Test: `experiments/platform-facts/lib/eligibility.test.ts`
- Create: `experiments/platform-facts/tests/f07-eligibility-fleet.ts`
- Modify: `experiments/platform-facts/Makefile` (`fleet` and `publish-evidence` targets)

F06 reads one project. The one `eligible: null` (RUNLOG "F06, the upgrade
window", 2026-08-04) came from a hand sweep that kept no record of the
project's state. F07 reads status, age and region (`GET /v1/projects/{ref}`)
and the eligibility payload for every project in the orgs given, two GETs per
project with a fixed pause between calls (`PACE_MS`). Projects are numbered
oldest first and orgs are labelled by role, so the artifact carries no ref,
slug or name. It lists by org (`/organizations/{slug}/projects`) instead of
`GET /v1/projects`, so it never reads a project outside the lab orgs.

- [x] **Step 1: Write the failing test**

**Create `experiments/platform-facts/lib/eligibility.test.ts`:**

```ts
import { describe, expect, test } from "bun:test";
import { ageDays, byCreation, eligibleValue, rowLine, summarise, toRow } from "./eligibility";

const NOW = Date.UTC(2026, 9, 13);

describe("eligibleValue", () => {
  test("null, missing and unreadable are three different answers", () => {
    expect(eligibleValue(200, { eligible: null })).toBe("null");
    expect(eligibleValue(200, { current_app_version: "x" })).toBe("absent");
    expect(eligibleValue(404, { eligible: true })).toBe("unread");
    expect(eligibleValue(200, undefined)).toBe("unread");
    expect(eligibleValue(200, [])).toBe("unread");
  });

  test("booleans", () => {
    expect(eligibleValue(200, { eligible: true })).toBe("true");
    expect(eligibleValue(200, { eligible: false })).toBe("false");
  });
});

describe("toRow", () => {
  test("an eligible aged project", () => {
    const r = toRow(
      3,
      { org: "pro", created_at: "2026-08-04T00:00:00Z", status: "ACTIVE_HEALTHY", region: "ap-southeast-1" },
      200,
      {
        eligible: true,
        current_app_version: "17.6.1.141",
        latest_app_version: "17.6.1.155",
        duration_estimate_hours: 1,
        target_upgrade_versions: [{}],
        validation_errors: [],
      },
      NOW,
    );
    expect(r.index).toBe("p03");
    expect(r.ageDays).toBe(70);
    expect(r.eligible).toBe("true");
    expect(r.targets).toBe(1);
    expect(r.keys).toBe("current_app_version,duration_estimate_hours,eligible,latest_app_version,target_upgrade_versions,validation_errors");
    expect(rowLine(r)).toBe(
      "p03 org=pro age_d=70 status=ACTIVE_HEALTHY region=ap-southeast-1 http=200 eligible=true current=17.6.1.141 latest=17.6.1.155 targets=1 validation_errors=0 keys=current_app_version,duration_estimate_hours,eligible,latest_app_version,target_upgrade_versions,validation_errors",
    );
  });

  test("eligible null with no version fields (the 2026-08-04 shape; the error text is a fixture)", () => {
    const r = toRow(1, { created_at: "garbage", status: "INACTIVE" }, 200, { eligible: null, validation_errors: ["project is paused"] }, NOW);
    expect(r.ageDays).toBeNull();
    expect(r.eligible).toBe("null");
    expect(r.current).toBe("n/a");
    expect(r.region).toBe("unknown");
    expect(r.org).toBe("?");
    expect(r.firstValidationError).toBe("project is paused");
    expect(rowLine(r)).toContain("first_error=project is paused");
  });

  test("a non-200 has no payload keys", () => {
    const r = toRow(2, { status: "ACTIVE_HEALTHY" }, 500, { message: "boom" }, NOW);
    expect(r.eligible).toBe("unread");
    expect(r.httpStatus).toBe(500);
  });
});

describe("byCreation and ageDays", () => {
  test("oldest first, undated last", () => {
    const sorted = byCreation([
      { created_at: "2026-10-01T00:00:00Z", status: "b" },
      { status: "undated" },
      { created_at: "2026-08-01T00:00:00Z", status: "a" },
    ]);
    expect(sorted.map((p) => p.status)).toEqual(["a", "b", "undated"]);
  });

  test("whole days, floor", () => {
    expect(ageDays("2026-10-12T01:00:00Z", NOW)).toBe(0);
    expect(ageDays(undefined, NOW)).toBeNull();
  });
});

describe("summarise", () => {
  test("counts, and the null rows set beside their status and payload shape", () => {
    const rows = [
      toRow(1, { status: "INACTIVE" }, 200, { eligible: null }, NOW),
      toRow(2, { status: "ACTIVE_HEALTHY" }, 200, { eligible: true, current_app_version: "a" }, NOW),
      toRow(3, { status: "ACTIVE_HEALTHY" }, 200, { eligible: false, current_app_version: "a" }, NOW),
      toRow(4, { status: "ACTIVE_HEALTHY" }, 200, { eligible: null, current_app_version: "a" }, NOW),
      toRow(5, { status: "COMING_UP" }, 503, undefined, NOW),
    ];
    expect(summarise(rows)).toEqual({
      projects_read: 5,
      eligible_true: 1,
      eligible_false: 1,
      eligible_null: 2,
      eligible_absent: 0,
      eligible_unread: 1,
      status_by_eligible: "ACTIVE_HEALTHY/false:1|ACTIVE_HEALTHY/null:1|ACTIVE_HEALTHY/true:1|COMING_UP/unread:1|INACTIVE/null:1",
      null_statuses: "ACTIVE_HEALTHY:1|INACTIVE:1",
      null_with_version_fields: 1,
      null_payload_keys: "current_app_version,eligible:1|eligible:1",
    });
  });

  test("no projects", () => {
    expect(summarise([]).null_statuses).toBe("none");
  });
});
```

- [x] **Step 2: Run it to make sure it fails**

Run: `bun test experiments/platform-facts/lib; echo "exit $?"`

Expected: `exit 1`, with `error: Cannot find module './eligibility' from '<repo>/experiments/platform-facts/lib/eligibility.test.ts'`
under "Unhandled error between tests" and the summary ` 0 pass`, ` 1 fail`,
` 1 error`.

- [x] **Step 3: Write the pure helpers**

**Create `experiments/platform-facts/lib/eligibility.ts`:**

```ts
/**
 * F07 support (work-supabase-lab#41): read upgrade eligibility across every
 * project a token can list, so `eligible: null` (seen once on 2026-08-04,
 * RUNLOG "F06, the upgrade window") can be set beside each project's status, age and
 * payload shape instead of being one unexplained row.
 *
 * Rows carry NO project ref and NO name: projects are numbered in creation
 * order, so the artifact can be published as is. Pure: unit-tested in
 * eligibility.test.ts.
 */

export type EligibleValue = "true" | "false" | "null" | "absent" | "unread";

export interface ListedProject {
  /** A label for the organization (its PVLAB_ORG_<ROLE> role, else o1, o2, ...), never the slug. */
  org?: unknown;
  created_at?: unknown;
  status?: unknown;
  region?: unknown;
}

export interface EligibilityRow {
  /** p01, p02, ... in creation order. */
  index: string;
  org: string;
  ageDays: number | null;
  status: string;
  region: string;
  httpStatus: number;
  eligible: EligibleValue;
  /** Top-level keys of the eligibility payload, sorted, comma-joined. */
  keys: string;
  current: string;
  latest: string;
  targets: number;
  validationErrors: number;
  firstValidationError: string;
}

/** What `eligible` was, keeping "the field is null" apart from "the field is missing" and "no payload". */
export function eligibleValue(httpStatus: number, json: unknown): EligibleValue {
  if (httpStatus !== 200 || !json || typeof json !== "object" || Array.isArray(json)) return "unread";
  const rec = json as Record<string, unknown>;
  if (!("eligible" in rec)) return "absent";
  if (rec.eligible === null) return "null";
  if (rec.eligible === true) return "true";
  if (rec.eligible === false) return "false";
  return "unread";
}

const str = (v: unknown, fallback = "n/a") => (typeof v === "string" && v ? v : fallback);

export function ageDays(createdAt: unknown, nowMs: number): number | null {
  if (typeof createdAt !== "string") return null;
  const t = Date.parse(createdAt);
  return Number.isNaN(t) ? null : Math.floor((nowMs - t) / 86_400_000);
}

/** One row per project. `position` is 1-based creation order. */
export function toRow(position: number, project: ListedProject, httpStatus: number, json: unknown, nowMs: number): EligibilityRow {
  const rec = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const errors = Array.isArray(rec.validation_errors) ? rec.validation_errors : [];
  const first = errors[0];
  return {
    index: `p${String(position).padStart(2, "0")}`,
    org: str(project.org, "?"),
    ageDays: ageDays(project.created_at, nowMs),
    status: str(project.status, "unknown"),
    region: str(project.region, "unknown"),
    httpStatus,
    eligible: eligibleValue(httpStatus, json),
    keys: Object.keys(rec).sort().join(","),
    current: str(rec.current_app_version),
    latest: str(rec.latest_app_version),
    targets: Array.isArray(rec.target_upgrade_versions) ? rec.target_upgrade_versions.length : 0,
    validationErrors: errors.length,
    firstValidationError: (first === undefined ? "" : typeof first === "string" ? first : JSON.stringify(first)).slice(0, 120),
  };
}

/** Oldest first, so p01 is the oldest project and the numbering is stable between runs. */
export function byCreation(projects: ListedProject[]): ListedProject[] {
  const t = (p: ListedProject) => (typeof p.created_at === "string" ? Date.parse(p.created_at) : Number.NaN);
  return [...projects].sort((a, b) => {
    const ta = t(a);
    const tb = t(b);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });
}

function histogram(values: string[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, n]) => `${k}:${n}`).join("|") || "none";
}

export function summarise(rows: EligibilityRow[]): Record<string, string | number> {
  const nulls = rows.filter((r) => r.eligible === "null");
  return {
    projects_read: rows.length,
    eligible_true: rows.filter((r) => r.eligible === "true").length,
    eligible_false: rows.filter((r) => r.eligible === "false").length,
    eligible_null: nulls.length,
    eligible_absent: rows.filter((r) => r.eligible === "absent").length,
    eligible_unread: rows.filter((r) => r.eligible === "unread").length,
    status_by_eligible: histogram(rows.map((r) => `${r.status}/${r.eligible}`)),
    null_statuses: histogram(nulls.map((r) => r.status)),
    null_with_version_fields: nulls.filter((r) => r.keys.split(",").includes("current_app_version")).length,
    null_payload_keys: histogram(nulls.map((r) => r.keys || "(empty)")),
  };
}

export function rowLine(r: EligibilityRow): string {
  return [
    r.index,
    `org=${r.org}`,
    `age_d=${r.ageDays ?? "?"}`,
    `status=${r.status}`,
    `region=${r.region}`,
    `http=${r.httpStatus}`,
    `eligible=${r.eligible}`,
    `current=${r.current}`,
    `latest=${r.latest}`,
    `targets=${r.targets}`,
    `validation_errors=${r.validationErrors}`,
    `keys=${r.keys || "(empty)"}`,
    ...(r.firstValidationError ? [`first_error=${r.firstValidationError}`] : []),
  ].join(" ");
}
```

- [x] **Step 4: Run the tests to make sure they pass**

Run: `bun test experiments/platform-facts/lib; echo "exit $?"`

Expected: ` 9 pass`, ` 0 fail`, `exit 0`.

- [x] **Step 5: The module**

**Create `experiments/platform-facts/tests/f07-eligibility-fleet.ts`:**

```ts
/**
 * F07 - upgrade eligibility across every project in the lab organizations
 * (work-supabase-lab#41).
 *
 * F06 reads one project. The 2026-08-04 hand sweep across the account found
 * one project answering `eligible: null` with no version fields, and nothing
 * recorded what that project was doing. F07 reads, for every project in the
 * organizations given by PVLAB_ORG_SLUGS, the project's status, age and region
 * (`GET /v1/projects/{ref}`) and its eligibility payload, so a null can be set
 * beside a status (paused? coming up?) and a payload shape.
 *
 * Read-only: two GETs per project, paced under the 120-per-minute budget. The
 * module never upgrades anything. Measurements and evidence carry no ref and
 * no name: projects are numbered oldest first, organizations are labelled by
 * their PVLAB_ORG_<ROLE> role (else o1, o2, ...).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt, type MgmtResponse } from "../../../harness/src/mgmt";
import { byCreation, rowLine, summarise, toRow, type ListedProject } from "../lib/eligibility";

const MAX_PROJECTS = 60;
const PACE_MS = 600;

/** One GET, retried once after a minute if the budget ran out. */
async function get(ctx: Ctx, path: string): Promise<MgmtResponse> {
  let r = await mgmt(ctx, "GET", path);
  if (r.status === 429 || r.throttled) {
    ctx.log(`throttled on ${path.replace(/\/projects\/[^/]+/, "/projects/{ref}")}; waiting 65 s`);
    await Bun.sleep(65_000);
    r = await mgmt(ctx, "GET", path);
  }
  await Bun.sleep(PACE_MS);
  return r;
}

function orgLabel(ctx: Ctx, slug: string, i: number): string {
  const role = Object.entries(ctx.orgs).find(([, s]) => s === slug)?.[0];
  return role ?? `o${i + 1}`;
}

const mod: TestModule = {
  id: "F07",
  title: "Upgrade eligibility across the lab organizations' projects (what eligible: null goes with)",
  where: "local",
  requires: ["pat", "org"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const refs: { ref: string; org: string }[] = [];
    const listErrors: string[] = [];
    for (const [i, slug] of ctx.orgSlugs.entries()) {
      const l = await get(ctx, `/organizations/${slug}/projects`);
      if (l.status !== 200) {
        listErrors.push(`${orgLabel(ctx, slug, i)}: HTTP ${l.status}`);
        continue;
      }
      const arr = Array.isArray(l.json) ? l.json : ((l.json as { projects?: unknown[] } | undefined)?.projects ?? []);
      for (const p of arr as { ref?: unknown; id?: unknown }[]) {
        const ref = typeof p.ref === "string" ? p.ref : typeof p.id === "string" ? p.id : "";
        if (ref) refs.push({ ref, org: orgLabel(ctx, slug, i) });
      }
    }
    if (refs.length === 0) {
      return [
        {
          id: "F07a",
          title: "Upgrade eligibility, every project in the lab organizations",
          status: listErrors.length ? "fail" : "info",
          detail: listErrors.length ? `could not list projects: ${listErrors.join("; ")}` : "no projects listed",
        },
      ];
    }

    const read: { project: ListedProject; httpStatus: number; json: unknown }[] = [];
    for (const { ref, org } of refs.slice(0, MAX_PROJECTS)) {
      const p = await get(ctx, `/projects/${ref}`);
      const pj = (p.json ?? {}) as Record<string, unknown>;
      const e = await get(ctx, `/projects/${ref}/upgrade/eligibility`);
      read.push({
        project: { org, created_at: pj.created_at, status: pj.status, region: pj.region },
        httpStatus: e.status,
        json: e.json,
      });
    }

    const now = Date.now();
    const ordered = byCreation(read.map((r) => r.project));
    const rows = ordered.map((project, i) => {
      const hit = read.find((r) => r.project === project);
      return toRow(i + 1, project, hit?.httpStatus ?? 0, hit?.json, now);
    });
    const summary = summarise(rows);
    const truncated = refs.length > MAX_PROJECTS ? `; ${refs.length - MAX_PROJECTS} project(s) past the cap of ${MAX_PROJECTS} not read` : "";

    return [
      {
        id: "F07a",
        title: "Upgrade eligibility, every project in the lab organizations",
        status: "info",
        detail:
          `${rows.length} project(s): eligible true ${summary.eligible_true}, false ${summary.eligible_false}, ` +
          `null ${summary.eligible_null} (statuses ${summary.null_statuses}; ${summary.null_with_version_fields} with version fields), ` +
          `absent ${summary.eligible_absent}, unread ${summary.eligible_unread}` +
          truncated +
          (listErrors.length ? `; list errors: ${listErrors.join("; ")}` : ""),
        measurements: summary,
        evidence: rows.map(rowLine).join("\n"),
      },
    ];
  },
};
export default mod;
```

- [x] **Step 6: Makefile targets**

**Replace in `experiments/platform-facts/Makefile`:**

```text
.PHONY: init fmt validate apply probe diff destroy
```

**with:**

```text
.PHONY: init fmt validate apply probe fleet diff publish-evidence destroy
```

**Replace in `experiments/platform-facts/Makefile`:**

```text
# Compare the two most recent runs.
```

**with:**

```text
# F07 (work-supabase-lab#41): upgrade eligibility of every project in the
# organizations given, read-only, no project ref or name in the output. Needs
# no tofu project. Run from source: harness/dist/pvlab is linux-x64 only.
#   make fleet ORGS=slug-a,slug-b   (PAT from SUPABASE_ACCESS_TOKEN)
fleet:
	@test -n "$(SUPABASE_ACCESS_TOKEN)" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(ORGS)" || (echo "ORGS=slug-a,slug-b required (the lab organizations)"; exit 1)
	@cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && PVLAB_ORG_SLUGS="$(ORGS)" bun harness/src/run.ts --where local --experiment platform-facts \
		--only F07 --out experiments/platform-facts/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)

# Compare the two most recent runs.
```

- [x] **Step 7: Verify**

Run:

```bash
bunx tsc --noEmit -p harness/tsconfig.json; echo "tsc exit $?"
(cd harness && bun test > /tmp/w3-bun-test.txt 2>&1; echo "bun test exit $?"); tail -4 /tmp/w3-bun-test.txt
(cd harness && bun scripts/gen-registry.ts >/dev/null); rm -rf /tmp/w3-skip/platform-facts
env -u SUPABASE_ACCESS_TOKEN -u PVLAB_REF -u SUPABASE_ANON_KEY -u DB_PASSWORD -u PVLAB_ORG_SLUGS \
  bun harness/src/run.ts --where local --experiment platform-facts --only F07 --out /tmp/w3-skip/platform-facts | rg '^pvlab:'
jq -c '.results[] | {id,status,detail}' /tmp/w3-skip/platform-facts/run-*.json
make -C experiments/platform-facts -n fleet ORGS=org-a SUPABASE_ACCESS_TOKEN=x | rg 'run.ts'
```

Expected: `tsc exit 0`; `bun test exit 0` with ` 1791 pass` and ` 0 fail`
(1788 + 3 files scanned);
`{"id":"F07","status":"skip","detail":"missing capability: pat, org"}`;
one line `cd <repo> && PVLAB_ORG_SLUGS="org-a" bun harness/src/run.ts --where local --experiment platform-facts \`.

- [ ] **Step 8: Commit**

```bash
git add experiments/platform-facts/lib/eligibility.ts experiments/platform-facts/lib/eligibility.test.ts \
  experiments/platform-facts/tests/f07-eligibility-fleet.ts experiments/platform-facts/Makefile
git commit -m "feat(platform-facts): F07 reads upgrade eligibility across the lab orgs"
```

Executed 2026-10-13: Steps 1-7 as written (red `Cannot find module`; green
9 pass; `tsc exit 0`; 1791 pass; F07 skip `missing capability: pat, org`;
the `make -n fleet` line as expected). Deviation: Step 8 goes to the
operator's commit script (agent commits blocked), same paths and subject.

### Task O4: rate-limits L02, the breach shape per endpoint and burst (#42)

**Files:**
- Create: `experiments/rate-limits/lib/burst.ts` (pure: body class, cell summary, shapes)
- Test: `experiments/rate-limits/lib/burst.test.ts`
- Create: `experiments/rate-limits/tests/l02-burst-shapes.ts`
- Create: `experiments/rate-limits/Makefile`
- Modify: `experiments/rate-limits/RUNLOG.md` (the run instruction names a script that is not in the repo)

L01c met the JSON throttler on one cheap read; the HTML page other
experiments met is unexplained. L02 bursts five read-only GETs in three
shapes and records the first breach's status, body class, `retry-after`, and
whether a 2xx comes back after a 65 s cooldown. The rate-limits experiment
has no Makefile; its RUNLOG names `.pi/probe-rate-limits.sh`, which is
gitignored local tooling and is not on disk.

- [x] **Step 1: Write the failing test**

**Create `experiments/rate-limits/lib/burst.test.ts`:**

```ts
import { describe, expect, test } from "bun:test";
import { bodyClass, SHAPES, summariseCell, type Sample } from "./burst";

const s = (n: number, status: number, extra: Partial<Sample> = {}): Sample => ({
  n,
  status,
  contentType: "application/json",
  retryAfter: "",
  rateLimitRemaining: "",
  body: "",
  ...extra,
});

describe("bodyClass", () => {
  test("the API's own throttler (L01c's body)", () => {
    expect(bodyClass("application/json", '{"message":"ThrottlerException: Too Many Requests"}')).toBe("json-throttler");
  });

  test("an HTML page, by header or by body shape", () => {
    expect(bodyClass("text/html; charset=UTF-8", "<!DOCTYPE html><html>...")).toBe("html");
    expect(bodyClass("application/json", "<html><body>nope</body></html>")).toBe("html");
  });

  test("other JSON, plain text and an empty body", () => {
    expect(bodyClass("application/json", '{"message":"Unauthorized"}')).toBe("json-other");
    expect(bodyClass("text/plain", "Internal Server Error")).toBe("text");
    expect(bodyClass(null, "  ")).toBe("empty");
  });
});

describe("summariseCell", () => {
  test("a serial burst that hits the JSON throttler at request 118", () => {
    const samples = [
      ...Array.from({ length: 117 }, (_, i) => s(i + 1, 200, { rateLimitRemaining: i === 0 ? "119" : "" })),
      s(118, 429, { retryAfter: "60", body: '{"message":"ThrottlerException: Too Many Requests"}' }),
    ];
    const c = summariseCell(samples);
    expect(c.requests_sent).toBe(118);
    expect(c.ok_2xx).toBe(117);
    expect(c.first_non2xx_at).toBe(118);
    expect(c.first_non2xx_status).toBe(429);
    expect(c.first_non2xx_class).toBe("json-throttler");
    expect(c.retry_after).toBe("60");
    expect(c.statuses).toBe("200:117|429:1");
    expect(c.classes).toBe("json-throttler:1");
    expect(c.remaining_at_first).toBe("119");
  });

  test("a spike where the edge answers HTML, samples out of order", () => {
    const c = summariseCell([
      s(3, 403, { contentType: "text/html", body: "<!DOCTYPE html><title>Just a moment...</title>" }),
      s(1, 200),
      s(2, 0, { contentType: "", body: "TimeoutError" }),
    ]);
    expect(c.first_non2xx_at).toBe(2);
    expect(c.first_non2xx_status).toBe(0);
    expect(c.first_non2xx_class).toBe("text");
    expect(c.classes).toBe("html:1|text:1");
    expect(c.statuses).toBe("0:1|200:1|403:1");
  });

  test("no breach", () => {
    const c = summariseCell([s(1, 200), s(2, 200)]);
    expect(c.first_non2xx_at).toBe("none");
    expect(c.first_non2xx_class).toBe("none");
    expect(c.retry_after).toBe("none");
    expect(c.classes).toBe("none");
  });
});

describe("SHAPES", () => {
  test("every shape issues at most 150 requests; only the spike ignores the first breach", () => {
    for (const shape of Object.values(SHAPES)) expect(shape.max).toBe(150);
    expect(SHAPES["spike-150"].stopOnFirstNon2xx).toBe(false);
    expect(SHAPES.serial.concurrency).toBe(1);
  });
});
```

- [x] **Step 2: Run it to make sure it fails**

Run: `bun test experiments/rate-limits/lib; echo "exit $?"`

Expected: `exit 1`, with `error: Cannot find module './burst' from '<repo>/experiments/rate-limits/lib/burst.test.ts'`
under "Unhandled error between tests" and the summary ` 0 pass`, ` 1 fail`,
` 1 error`.

- [x] **Step 3: Write the pure helpers**

**Create `experiments/rate-limits/lib/burst.ts`:**

```ts
/**
 * L02 support (work-supabase-lab#42): what a Management API rate-limit breach
 * looks like, per endpoint and burst shape.
 *
 * L01c saw the API's own JSON throttler (`429`, `{"message":"ThrottlerException:
 * Too Many Requests"}`, `retry-after: 60`) on a cheap scoped read. Other
 * experiments met an HTML page from the edge instead (harness/src/mgmt.ts
 * `classifyBody`). A client has to back off on both, but only the JSON one
 * says how long; this names which endpoints and shapes produce which.
 *
 * Pure: unit-tested in burst.test.ts.
 */
import { classifyBody } from "../../../harness/src/mgmt";

export type BodyClass = "json-throttler" | "json-other" | "html" | "empty" | "text";

export function bodyClass(contentType: string | null, body: string): BodyClass {
  if (!body.trim()) return "empty";
  const c = classifyBody(contentType, body);
  if (c.throttled) return "html";
  if (c.json === undefined) return "text";
  return /ThrottlerException/.test(body) ? "json-throttler" : "json-other";
}

export interface Sample {
  /** Issue order, 1-based. */
  n: number;
  status: number;
  contentType: string;
  retryAfter: string;
  rateLimitRemaining: string;
  /** Kept only for non-2xx samples, first 200 characters. */
  body: string;
}

export interface CellSummary {
  requests_sent: number;
  ok_2xx: number;
  first_non2xx_at: number | "none";
  first_non2xx_status: number | "none";
  first_non2xx_class: BodyClass | "none";
  first_non2xx_content_type: string;
  retry_after: string;
  statuses: string;
  classes: string;
  remaining_at_first: string;
}

function histogram(values: (string | number)[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, n]) => `${k}:${n}`).join("|") || "none";
}

/** Status 0 is a transport failure (timeout, reset), recorded as its own class. */
export function summariseCell(samples: Sample[]): CellSummary {
  const ordered = [...samples].sort((a, b) => a.n - b.n);
  const bad = ordered.filter((s) => s.status < 200 || s.status >= 300);
  const first = bad[0];
  const cls = (s: Sample) => (s.status === 0 ? ("text" as const) : bodyClass(s.contentType || null, s.body));
  return {
    requests_sent: ordered.length,
    ok_2xx: ordered.length - bad.length,
    first_non2xx_at: first ? first.n : "none",
    first_non2xx_status: first ? first.status : "none",
    first_non2xx_class: first ? cls(first) : "none",
    first_non2xx_content_type: first?.contentType || "none",
    retry_after: first?.retryAfter || "none",
    statuses: histogram(ordered.map((s) => s.status)),
    classes: histogram(bad.map(cls)),
    remaining_at_first: ordered[0]?.rateLimitRemaining || "none",
  };
}

export type Shape = "serial" | "parallel-20" | "spike-150";

/** How many requests a shape may issue and how many run at once. */
export const SHAPES: Record<Shape, { max: number; concurrency: number; stopOnFirstNon2xx: boolean }> = {
  serial: { max: 150, concurrency: 1, stopOnFirstNon2xx: true },
  "parallel-20": { max: 150, concurrency: 20, stopOnFirstNon2xx: true },
  "spike-150": { max: 150, concurrency: 150, stopOnFirstNon2xx: false },
};
```

- [x] **Step 4: Run the tests to make sure they pass**

Run: `bun test experiments/rate-limits/lib; echo "exit $?"`

Expected: ` 7 pass`, ` 0 fail`, `exit 0`.

- [x] **Step 5: The module**

**Create `experiments/rate-limits/tests/l02-burst-shapes.ts`:**

```ts
/**
 * L02 - which Management API endpoints and burst shapes get the edge's HTML
 * page instead of the API's JSON 429 (work-supabase-lab#42).
 *
 * L01c burst one cheap scoped read serially and met the JSON throttler at
 * request 118 (`retry-after: 60`). Earlier experiments met an HTML page on
 * aggressive polling instead. This module runs a matrix: five read-only GET
 * endpoints x three shapes (serial, 20 in parallel, 150 at once), each cell
 * until the first non-2xx (the spike sends all 150 regardless), and records
 * the status, the body class (`lib/burst.ts`), `retry-after`, and whether the
 * endpoint answers 2xx again after a 65 s cooldown.
 *
 * DESTRUCTIVE in the L01 sense: it exhausts the PAT's rate budget ~15 times
 * over about 20 minutes. Nothing on any project changes. Do not run anything
 * else with the same token meanwhile. Project-scoped rows read
 * ctx.peers.scoped (PVLAB_PEER_SCOPED), else the run's own ref, and skip
 * without one. Only non-2xx bodies are kept (a 2xx body names projects).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmtBase } from "../../../harness/src/mgmt";
import { SHAPES, summariseCell, type Sample, type Shape } from "../lib/burst";

const COOLDOWN_MS = 65_000;
const RECOVER_MAX_MS = 120_000;

interface Target {
  key: string;
  path: (ref: string) => string;
  needsRef: boolean;
}

const TARGETS: Target[] = [
  { key: "projects_list", path: () => "/projects", needsRef: false },
  { key: "orgs_list", path: () => "/organizations", needsRef: false },
  { key: "project_get", path: (r) => `/projects/${r}`, needsRef: true },
  { key: "functions_list", path: (r) => `/projects/${r}/functions`, needsRef: true },
  { key: "health", path: (r) => `/projects/${r}/health?services=rest`, needsRef: true },
];

async function fire(ctx: Ctx, url: string, n: number): Promise<Sample> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ctx.pat}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const ok = res.status >= 200 && res.status < 300;
    return {
      n,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      retryAfter: res.headers.get("retry-after") ?? "",
      rateLimitRemaining: res.headers.get("x-ratelimit-remaining") ?? "",
      body: ok ? "" : text.slice(0, 200),
    };
  } catch (e) {
    return { n, status: 0, contentType: "", retryAfter: "", rateLimitRemaining: "", body: e instanceof Error ? e.name : String(e) };
  }
}

async function runCell(ctx: Ctx, url: string, shape: Shape): Promise<Sample[]> {
  const { max, concurrency, stopOnFirstNon2xx } = SHAPES[shape];
  const samples: Sample[] = [];
  let issued = 0;
  let stop = false;
  const worker = async () => {
    while (!stop && issued < max) {
      const n = ++issued;
      const one = await fire(ctx, url, n);
      samples.push(one);
      if (stopOnFirstNon2xx && (one.status < 200 || one.status >= 300)) stop = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, max) }, () => worker()));
  return samples;
}

/** Seconds from the end of the cell until a 2xx again; the first read is after the full cooldown. */
async function recover(ctx: Ctx, url: string): Promise<number | "timeout"> {
  const t0 = Date.now();
  await Bun.sleep(COOLDOWN_MS);
  while (Date.now() - t0 < COOLDOWN_MS + RECOVER_MAX_MS) {
    const one = await fire(ctx, url, 0);
    if (one.status >= 200 && one.status < 300) return Math.round((Date.now() - t0) / 1000);
    await Bun.sleep(10_000);
  }
  return "timeout";
}

const mod: TestModule = {
  id: "L02",
  title: "Rate-limit breach shape per endpoint and burst shape (JSON 429 vs edge HTML)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ref = ctx.peers.scoped ?? ctx.ref;
    const base = mgmtBase(ctx);
    const out: TestResult[] = [];
    for (const t of TARGETS) {
      for (const shape of Object.keys(SHAPES) as Shape[]) {
        const id = `L02-${t.key}-${shape}`;
        const title = `${t.key} x ${shape}`;
        if (t.needsRef && !ref) {
          out.push({ id, title, status: "skip", detail: "no project ref (PVLAB_PEER_SCOPED or PVLAB_REF)" });
          continue;
        }
        const url = `${base}${t.path(ref)}`;
        ctx.log(`${id}: bursting`);
        const t0 = Date.now();
        const samples = await runCell(ctx, url, shape);
        const burstMs = Date.now() - t0;
        const c = summariseCell(samples);
        const recovered = await recover(ctx, url);
        const first = [...samples].sort((a, b) => a.n - b.n).find((x) => x.status < 200 || x.status >= 300);
        out.push({
          id,
          title,
          status: "info",
          detail:
            c.first_non2xx_at === "none"
              ? `${c.requests_sent} requests, no non-2xx`
              : `first non-2xx at request ${c.first_non2xx_at}: ${c.first_non2xx_status} ${c.first_non2xx_class}, retry-after ${c.retry_after}; 2xx again after ${recovered} s`,
          measurements: { endpoint: t.key, shape, burst_ms: burstMs, ...c, recovered_s: recovered },
          evidence: first ? `${first.status} ${first.contentType}\n${first.body}` : "",
        });
      }
    }
    return out;
  },
};
export default mod;
```

- [x] **Step 6: A Makefile, and the RUNLOG's run instruction**

**Create `experiments/rate-limits/Makefile`:**

```make
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# No OpenTofu state. L01 and L02 read the Management API and deliberately
# exhaust the PAT's rate budget (both --destructive for that reason; nothing on
# any project changes). Run from source: harness/dist/pvlab is linux-x64 only.
#   SUPABASE_ACCESS_TOKEN   Management API token (never written to a file here)
#   PVLAB_REF               any project the token can read, for the
#                           project-scoped rows (a throwaway is fine)
# Do not run anything else with the same token while this runs (~20 min for L02).
ONLY ?= L02

.PHONY: probe publish-evidence

probe:
	@test -n "$(SUPABASE_ACCESS_TOKEN)" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_REF)" || (echo "export PVLAB_REF=<a project ref the token can read>"; exit 1)
	@cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment rate-limits \
		--only $(ONLY) --destructive --out experiments/rate-limits/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
```

**Replace in `experiments/rate-limits/RUNLOG.md`:**

~~~text
and confirms recovery). Run it with:

```
.pi/probe-rate-limits.sh L01
```
~~~

**with:**

~~~text
and confirms recovery). Run it with (since 2026-10-13; the
`.pi/probe-rate-limits.sh` named here before was gitignored local tooling):

```
sx SUPABASE_ACCESS_TOKEN -- make probe ONLY=L01 PVLAB_REF=<any project ref>
```
~~~

- [x] **Step 7: Verify**

Run:

```bash
bunx tsc --noEmit -p harness/tsconfig.json; echo "tsc exit $?"
(cd harness && bun test > /tmp/w3-bun-test.txt 2>&1; echo "bun test exit $?"); tail -4 /tmp/w3-bun-test.txt
(cd harness && bun scripts/gen-registry.ts >/dev/null); rm -rf /tmp/w3-skip/rate-limits
env -u SUPABASE_ACCESS_TOKEN -u PVLAB_REF -u SUPABASE_ANON_KEY -u DB_PASSWORD -u PVLAB_ORG_SLUGS \
  bun harness/src/run.ts --where local --experiment rate-limits --only L02 --destructive --out /tmp/w3-skip/rate-limits | rg '^pvlab:'
jq -c '.results[] | {id,status,detail}' /tmp/w3-skip/rate-limits/run-*.json
make -C experiments/rate-limits -n probe SUPABASE_ACCESS_TOKEN=x PVLAB_REF=abcdefghijklmnopqrst | rg 'run.ts'
```

Expected: `tsc exit 0`; `bun test exit 0` with ` 1795 pass` and ` 0 fail`
(1791 + 4 files scanned: three `.ts` and the Makefile);
`{"id":"L02","status":"skip","detail":"missing capability: pat"}`;
one line `cd <repo> && bun harness/src/run.ts --where local --experiment rate-limits \`.

- [ ] **Step 8: Commit**

```bash
git add experiments/rate-limits/lib/burst.ts experiments/rate-limits/lib/burst.test.ts \
  experiments/rate-limits/tests/l02-burst-shapes.ts experiments/rate-limits/Makefile experiments/rate-limits/RUNLOG.md
git commit -m "feat(rate-limits): L02 breach shape per endpoint and burst, and a Makefile"
```

Executed 2026-10-13: Steps 1-7 as written (red `Cannot find module`; green
7 pass; `tsc exit 0`; 1795 pass; L02 skip `missing capability: pat`; the
`make -n probe` line as expected). Deviation: Step 8 goes to the operator's
commit script (agent commits blocked), same paths and subject.

### Task O5: offline close-out

- [x] **Step 1: Full sensors and every experiment test touched**

```bash
bunx tsc --noEmit -p harness/tsconfig.json; echo "tsc exit $?"
(cd harness && bun test > /tmp/w3-bun-test.txt 2>&1; echo "bun test exit $?"); tail -4 /tmp/w3-bun-test.txt
bun test experiments/platform-downtime/lib experiments/platform-facts/lib experiments/rate-limits/lib; echo "exit $?"
git status --short
```

Expected: `tsc exit 0`; ` 1795 pass`, ` 0 fail`, `bun test exit 0`;
` 29 pass`, ` 0 fail`, `exit 0` for the three lib directories (13 + 9 + 7);
`git status` clean after the four commits.

- [x] **Step 2: Board comments (code ready, not run)**

```bash
vkctl comment work-supabase-lab#20 "Code ready (W3 plan Task O1): D01 reads pg_postmaster_start_time and stats_reset around POST /restart. Runs in batch B01."
vkctl comment work-supabase-lab#67 "Code ready (W3 plan Task O1): D01 records postgres_logs stop and boot lines around the restart; that is the managed-side signal. Runs in batch B01."
vkctl comment work-supabase-lab#129 "Code ready (W3 plan Task O2): harness/src/graphql.ts; DA03 installs pg_graphql for the measurement; T22 POSTs { __typename }. DA03 runs in B03; T22 waits for #130."
vkctl comment work-supabase-lab#41 "Code ready (W3 plan Task O3): platform-facts F07, make fleet ORGS=... Runs in batch B02."
vkctl comment work-supabase-lab#42 "Code ready (W3 plan Task O4): rate-limits L02 burst matrix and a Makefile. Runs in batch B02."
```

Executed 2026-10-13: Step 1 `tsc exit 0`, 1795 pass / 0 fail, lib
directories 29 pass / 0 fail. Deviation: `git status` was not clean, because
the four commits are in the operator's commit script rather than made by the
agent; the tree held exactly the O1-O4 paths plus this plan file. Step 2: the
five comments posted.

---

## B01 - restart signals (#20, #67), detailed

Cost: one Pro-org Micro project in ap-southeast-1 (`experiments/platform-downtime/experiment.tfvars`)
for about 90 minutes, three restarts. Kept up for B02 if B02 starts within the hour.

### Task B01-1: Pre-flight

- [x] **Step 1: Tree, secrets, tofu**

```bash
git pull --ff-only; git status --short
make secrets-decrypt
cut -d= -f1 secrets.tfvars | tr -d ' ' | sort
make -C experiments/platform-downtime init
```

Expected: `git status` prints nothing; `secrets.tfvars written (gitignored)`;
the key list includes `db_password`, `supabase_access_token` and
`supabase_org_id`; `OpenTofu has been successfully initialized!`.

- [x] **Step 2: Status-page gate for the region**

```bash
mkdir -p ~/.local/state/agent-work/w3-b01
bun harness/src/run.ts --where local --experiment lifecycle-ops --only LO01 \
  --out ~/.local/state/agent-work/w3-b01/lo01 | tee ~/.local/state/agent-work/w3-b01/lo01.log
```

Expected: `[LO01]` result lines; read LO01c's decision for
`ap-southeast-1`. If the gate refuses the region (an open incident there),
stop and reschedule: an incident inside the restart window makes the run
uninterpretable.

Executed 2026-10-13: `secrets.tfvars` was already byte-identical to the
decrypted `secrets.enc.tfvars` (checked with `cmp`, nothing printed);
`make secrets-decrypt` rewrote the same bytes; tofu initialized. LO01c:
`ap-southeast-1 restart: proceed (region status operational, 11 components,
0 blockers, 2 warnings)`; the two warnings were open region-less incidents
(Edge Function degradation, Realtime latency, both monitoring, minor).
Deviations: `git status` was not empty (the O1-O4 changes and this file,
uncommitted, see O5); the key list shows `supabase_access_token` commented
out, so the token comes from `sx` only, as every step here passes it.

### Task B01-2: Provision and wait for readiness

- [x] **Step 1: Apply**

```bash
sx SUPABASE_ACCESS_TOKEN -- make -C experiments/platform-downtime apply
```

Expected: tofu `Apply complete! Resources: 1 added, 0 changed, 0 destroyed.`
then `project_ref = <20 lowercase letters>`.

- [x] **Step 2: Wait for per-service health, then one more minute**

```bash
REF=$(tofu -chdir=experiments/platform-downtime output -raw project_ref)
sx SUPABASE_ACCESS_TOKEN -- sh -c 'for i in $(seq 1 30); do
  s=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/'"$REF"'/health?services=auth&services=rest&services=db" \
    | jq -r "[.[].status] | unique | join(\",\")"); echo "$i $s"
  [ "$s" = "ACTIVE_HEALTHY" ] && break; sleep 10; done'
sleep 60
```

Expected: a line `<n> ACTIVE_HEALTHY` within about 3 minutes (AGENTS.md
"ACTIVE_HEALTHY is not readiness": the extra minute is deliberate).

Executed 2026-10-13. Deviation, Step 1: plan said `make apply` into a Pro
org; `secrets.tfvars`'s `supabase_org_id` is the lab's Team-plan org (read
with `GET /v1/organizations/{slug}`, plan only), so the apply overrode it on
the command line (`VARS="... -var=supabase_org_id=<pro slug from the API
listing>"`), which kept the batch's Pro-org cost class. `Creation complete
after 4s`; the project's `created_at` was about 12 minutes before the apply
and it answered `ACTIVE_HEALTHY` at the first health poll, so the platform
handed over an already-provisioned instance (not investigated further).
Step 2: `1 ACTIVE_HEALTHY`, then the minute.

### Task B01-3: Three D01 runs

- [x] **Step 1: Run**

```bash
for i in 1 2 3; do
  sx SUPABASE_ACCESS_TOKEN -- make -C experiments/platform-downtime probe-destructive ONLY=D01
  sleep 120
done 2>&1 | tee ~/.local/state/agent-work/w3-b01/d01.log
```

Expected per run (about 8-11 minutes each: up to 7 minutes of sampling,
then up to 160 s of log polling):

```text
pvlab: 1 to run, 0 skipped (vantage=local, capabilities=...)
[D01] Restart: client-visible outage per connection path (destructive)
  -> pass: outage on <paths>; restart confirmed by pg_postmaster_start_time: yes; pg_stat_checkpointer.stats_reset changed: <yes|no>; postgres_logs: stop <fast|smart|immediate|not-logged>, next boot <clean|crash-recovery|not-logged>
wrote evidence/<ts>/run-<stamp>.{json,md} - 1 pass, 0 fail, 0 skip
```

A `fail` (a path never recovered within 420 s) is data, not a reason to
retry. Stop and look before the next iteration if: the result is `skip`
with "path(s) already failing" (wait 2 minutes, run that iteration again);
`restart confirmed ...: no` (the restart did not land inside the window);
or the detail carries `logs error:` on every poll (the logs endpoint is
refusing; the counters still answer #20).

Executed 2026-10-13: three passes (outage auth/storage/pooler 78/82/185 s,
46/45/46 s, 45/45/43 s), restart confirmed on all three, no `logs error:`.
Deviations: each run was its own `caffeinate -i sx ... make
probe-destructive ONLY=D01` invocation with its own log (`d01.log`,
`d01-run2.log`, `d01-run3.log`) so each result could be read before the next
restart; the gaps between runs were about 70 s and 30 s, not 120 s (each
started after the previous one's log polling had ended). After runs 1, 2 and
3 a read-only diagnostic query of `postgres_logs` (wider patterns, session
scratch) was run, because D01's own patterns had found nothing on run 1; its
lines are in the platform-downtime RUNLOG.

### Task B01-4: Read the three runs

- [x] **Step 1: Facts and log lines**

```bash
for f in $(ls -t experiments/platform-downtime/evidence/*/run-*.json | head -3); do
  echo "== $f"
  bun harness/src/run.ts --facts "$f" --only D01
  jq -r '.results[] | select(.id=="D01") | .evidence' "$f"
done | tee ~/.local/state/agent-work/w3-b01/facts.txt
```

Expected: per run a facts table with `restart_confirmed`,
`checkpointer_stats_reset_changed`, `log_stop_mode`, `log_shutdown_checkpoint`,
`log_shut_down`, `log_next_boot`, the per-path `*_window_s`, and the
timestamped log lines.

- [x] **Step 2: Decide what the runs say** (checkpointer-reset key facts give the 17.x pairing)

| reading (all three runs agree) | #20 | #67 |
|---|---|---|
| stats_reset unchanged, next boot `clean` | a managed API restart keeps checkpointer stats; the motivating reset came from another path | the stop path is a logged clean (fast) shutdown; record the request-to-"shut down" seconds from the log lines as the observed grace |
| stats_reset changed, next boot `crash-recovery` | a managed restart resets the stats because the stop is not clean | the platform kills Postgres before the shutdown checkpoint completes; the gap between the request line and the recovery line bounds the grace period |
| stats_reset changed, next boot `clean` | reset without a crash: on 17.x this points away from the stop path (checkpointer-reset: "look for something other than the stop path") | file a follow-up card: explicit `pg_stat_reset_shared` or a restore during the managed restart |
| `log_next_boot` `not-logged` on every run | counters still answer #20 | no managed-side signal in `postgres_logs`; #67 stays open with that negative (scoped: one project, one region, one day) |
| runs disagree | report the split with n=3 | same; do not average |

Executed 2026-10-13. Deviation, Step 1: `ls -t` in the agent's shell is
aliased to a replacement that rejects `-t`; the loop ran with `command ls -t`
(same for B01-5). Step 2: the runs agree on #20 (stats_reset unchanged 3/3)
and on next boot `not-logged` 3/3, so row 4 applies: #67 has no next-boot
signal. They disagree on the stop line (`fast` on run 2 only); the wider
diagnostic read showed the fast-shutdown opening (`terminating connection
due to administrator command`) on all three, recorded as a partial signal.

### Task B01-5: Publish

- [x] **Step 1: Publish the three runs**

```bash
for f in $(ls -t experiments/platform-downtime/evidence/*/run-*.json | head -3); do
  make -C experiments/platform-downtime publish-evidence RUN="${f#experiments/platform-downtime/}"
done
rg -n '"name": "' experiments/platform-downtime/out/ | rg -v '"name": "(log_|unindexed|auth_rls|unused_)'
rg -l '/Users/|/home/' experiments/platform-downtime/out/
git status --short --untracked-files=all experiments/platform-downtime/out | wc -l
```

Expected: three lines `published run-<stamp>.json -> <repo>/experiments/platform-downtime/out/<date> (1 results; 0 unredacted ref-shaped tokens remain; 0 unredacted credential ids remain)`;
no output from either `rg`; `6`.

- [x] **Step 2: Sensors**

Run the two sensors. Expected: `tsc exit 0`; ` 1801 pass` (1795 + 6
published files), ` 0 fail`.

Executed 2026-10-13 as written: three `published ... (1 results; 0
unredacted ref-shaped tokens remain; 0 unredacted credential ids remain)`,
both `rg` empty, `6`; an extra scan of the six files (20-letter lowercase
runs without word boundaries, emails, home paths, the account's project and
org identifiers and names, token and hex-password shapes) found 0 of each.
Sensors: `tsc exit 0`, 1801 pass / 0 fail.

### Task B01-6: Write it down, commit, board

- [x] **Step 1: RUNLOG entries**

**Append to `experiments/platform-downtime/RUNLOG.md`:**

```text

## <date> - D01 x3 with the restart signal and the stop path (work-supabase-lab#20, #67)

Harness: `make probe-destructive ONLY=D01`, three runs two minutes apart on
one Micro project in ap-southeast-1 (Pro org), lab commit <short sha>.
Published: `out/<date>/run-<stamp>.facts.md` for each run.

| run | restart confirmed | stats_reset changed | log stop | shutdown checkpoint | "shut down" logged | next boot | auth / storage / pooler window (s) |
|---|---|---|---|---|---|---|---|
| 1 | <yes> | <no> | <fast> | <yes> | <yes> | <clean> | <n> / <n> / <n> |
| 2 | ... |
| 3 | ... |

Read: <the matching row of the B01 decision table in
docs/plans/2026-10-13-lab-w3-batches.md, stated as what was measured>.
Request-to-"shut down" in the log lines: <s> s, <s> s, <s> s.

Not settled: <for example: one project, one region, idle cluster (the
checkpointer-reset rig showed a slow shutdown checkpoint changes the
outcome); integration-provisioned projects>.
```

**Append to `experiments/checkpointer-reset/RUNLOG.md`:**

```text

## <date> - the managed stop path, read from postgres_logs (work-supabase-lab#67)

platform-downtime D01 (three `POST /restart` runs, <date>, its RUNLOG) now
records the stop and boot lines Postgres writes to `postgres_logs` beside
`stats_reset`. On the managed project: stop <mode>, next boot <kind>,
stats_reset <changed|kept> on <n> of 3. Against this experiment's table that
is the <row> shape. <One sentence on the grace period, or that no signal was
logged.>
```

- [x] **Step 2: AGENTS.md key fact**

**Replace in `AGENTS.md`:**

```text
  `vercel integration accept-terms` first). For "does a managed restart
  reset the checkpointer", read the same pair around D01's `POST /restart`.
```

**with:**

```text
  `vercel integration accept-terms` first).
- **D01 <date> (work-supabase-lab#20, #67): a managed `POST /restart`
  <keeps|resets> `pg_stat_checkpointer.stats_reset`** (3 of 3 runs), and
  `postgres_logs` records the stop as <mode> with a <clean|crash-recovery>
  next boot. <One clause on what that rules in or out.>
```

- [ ] **Step 3: Commit and board**

```bash
git add experiments/platform-downtime/RUNLOG.md experiments/platform-downtime/out \
  experiments/checkpointer-reset/RUNLOG.md AGENTS.md
git commit -m "docs(platform-downtime): D01 restart signal and stop path, three runs"
vkctl comment work-supabase-lab#20 "B01 ran <date>: stats_reset <kept|reset> on <n>/3 restarts, commit <sha>."
vkctl comment work-supabase-lab#67 "B01 ran <date>: postgres_logs stop <mode>, next boot <kind>, commit <sha>."
vkctl mv work-supabase-lab#20 work-supabase-lab#67 review
```

Move #67 to review only if the logs gave a signal; otherwise comment the
negative and leave it in To-Do.

Executed 2026-10-13: Steps 1-2 filled from the facts tables and the
diagnostic read (dates, values; the `lab commit` slot names 1a7158f plus the
uncommitted O1 change, which is what the artifacts record). Deviations,
Step 3: the commit is in the operator's commit script (agent commits
blocked), with `AGENTS.md` as it stood at the end of B01 so B02's AGENTS.md
lines land in the B02 commit; the two comments were posted without a sha
("commit pending"); no card was moved (the session was told not to move
cards). Step 4: skipped, B02 started at once and B02-3 tears the project
down.

- [ ] **Step 4: Teardown, unless B02 starts within the hour**

```bash
sx SUPABASE_ACCESS_TOKEN -- make -C experiments/platform-downtime destroy
```

Expected: `Destroy complete! Resources: 1 destroyed.`

---

## B02 - Management API reads (#41, #42), detailed

Cost: no project created. F07 makes two GETs per lab project; L02 exhausts
the token's rate budget about 15 times in 20 minutes and needs one project
ref for its project-scoped rows (B01's project, still up; any lab project the
token can read otherwise). Run nothing else with the same token during L02.

### Task B02-1: F07, eligibility across the lab orgs

- [x] **Step 1: Run**

```bash
sx SUPABASE_ACCESS_TOKEN -- make -C experiments/platform-facts fleet \
  ORGS="$PVLAB_ORG_PRO,$PVLAB_ORG_TEAM,$PVLAB_ORG_FREE"
```

Expected:

```text
pvlab: 1 to run, 0 skipped (vantage=local, capabilities=...)
[F07] Upgrade eligibility across the lab organizations' projects (what eligible: null goes with)
  -> info: <n> project(s): eligible true <a>, false <b>, null <c> (statuses <status:count|...>; <d> with version fields), absent <e>, unread <f>
wrote experiments/platform-facts/evidence/<ts>/run-<stamp>.{json,md} - 0 pass, 0 fail, 0 skip
```

(`info` is not counted in the pass/fail/skip summary.) If `null` is 0 on
this run, the state that produced it on 2026-08-04 is not present now; record
that and keep #41 open only if the user wants a watch.

- [x] **Step 2: Read it**

```bash
F=$(ls -t experiments/platform-facts/evidence/*/run-*.json | head -1)
bun harness/src/run.ts --facts "$F" --only F07
jq -r '.results[] | select(.id=="F07a") | .evidence' "$F"
```

Decide: every null row `INACTIVE` (paused) -> `eligible: null` is what a
paused project answers; null rows `ACTIVE_HEALTHY` with no version keys ->
still unexplained, record `null_payload_keys`; null rows with version fields
-> eligibility not computable for that version pair, record the pair.

Executed 2026-10-13. Deviation, Step 1: `PVLAB_ORG_*` were not in the
agent's environment; they were set for the command from
`GET /v1/organizations` plus `GET /v1/organizations/{slug}` (`plan`), never
printed. The account has four orgs (Pro, Team, two Free), so `ORGS` named
all four (`PVLAB_ORG_FREE2` for the second Free) instead of three. Result:
`4 project(s): eligible true 3, false 1, null 0`, all four in the Pro org.
Step 2: null is 0, so none of the three decisions applies; recorded as "the
2026-08-04 state is not present now".

### Task B02-2: L02, the burst matrix

- [x] **Step 1: Run** (about 20 minutes)

```bash
REF=$(tofu -chdir=experiments/platform-downtime output -raw project_ref)
sx SUPABASE_ACCESS_TOKEN -- make -C experiments/rate-limits probe PVLAB_REF="$REF" \
  2>&1 | tee ~/.local/state/agent-work/w3-b01/l02.log
```

Expected: 15 `-> info:` lines, one per `L02-<endpoint>-<shape>`, each either
`150 requests, no non-2xx` or `first non-2xx at request <n>: <status> <class>, retry-after <s>; 2xx again after <s> s`,
then `wrote experiments/rate-limits/evidence/<ts>/run-<stamp>.{json,md} - 0 pass, 0 fail, 0 skip`.
A `recovered_s` of `timeout` means the token was still refused 185 s after
the cell; let the next cells run (they record their own state) and note it.

- [x] **Step 2: Read it**

```bash
F=$(ls -t experiments/rate-limits/evidence/*/run-*.json | head -1)
bun harness/src/run.ts --facts "$F" --only L02
```

The finding is the endpoint x shape table of `first_non2xx_class`
(`json-throttler`, `html`, ...), `retry_after` and `recovered_s`.

Executed 2026-10-13 as written (wrapped in `caffeinate -i`, log to
`l02.log` without `tee`): 15 `-> info:` lines, every one `429
json-throttler`, `retry-after` 59 or 60, `2xx again after 65 s`; about 18
minutes. Step 2 read with `command ls -t` (see B01-4).

### Task B02-3: Teardown B01's project

- [x] **Step 1: Destroy**

```bash
sx SUPABASE_ACCESS_TOKEN -- make -C experiments/platform-downtime destroy
```

Expected: `Destroy complete! Resources: 1 destroyed.`

Executed 2026-10-13 with the same `supabase_org_id` override as the apply.
Deviation in the output only: tofu printed `Apply complete! Resources: 0
added, 0 changed, 1 destroyed.` (the Makefile applies a saved destroy plan).
Confirmed: state holds 0 resources, `GET /v1/projects/{ref}` answers 404, and
`GET /v1/projects` lists the same three projects as before B01.

### Task B02-4: Publish, write down, commit

- [x] **Step 1: Publish both runs**

```bash
make -C experiments/platform-facts publish-evidence RUN="$(cd experiments/platform-facts && ls -t evidence/*/run-*.json | head -1)"
make -C experiments/rate-limits publish-evidence RUN="$(cd experiments/rate-limits && ls -t evidence/*/run-*.json | head -1)"
for e in platform-facts rate-limits; do
  rg -n '"name": "' experiments/$e/out/ | rg -v '"name": "(log_|unindexed|auth_rls|unused_)'
  rg -l '/Users/|/home/' experiments/$e/out/
  git status --short --untracked-files=all experiments/$e/out | wc -l
done
```

Expected: `published ... (1 results; 0 ... ; 0 ...)` for F07 and
`(15 results; ...)` for L02; no `rg` output; `2` and `2`. Sensors:
` 1805 pass` (1801 + 4), ` 0 fail`.

Executed 2026-10-13 as written (with `command ls -t`): both `published`
lines with 0 and 0, no `rg` output, `2` and `2`; the extra scan (as in
B01-5) found 0 of each class in the four files, and the F07 artifact was
read whole: no project or org name, ref or slug. Sensors `tsc exit 0`,
1805 pass / 0 fail.

- [x] **Step 2: RUNLOG entries**

**Append to `experiments/platform-facts/RUNLOG.md`:**

```text

## <date> - F07: eligibility across the lab orgs (work-supabase-lab#41)

Harness: `make fleet ORGS=<pro>,<team>,<free>` (slugs from the environment),
lab commit <short sha>; published `out/<date>/run-<stamp>.facts.md`.
<n> projects: eligible true <a>, false <b>, null <c>, absent <e>, unread <f>.
Null rows: statuses <...>, payload keys <...>, <d> with version fields.
Read: <the matching decision from the W3 plan, B02-1 Step 2>.
```

**Append to `experiments/rate-limits/RUNLOG.md`:**

```text

## <date> - L02: breach shape per endpoint and burst (work-supabase-lab#42)

Harness: `make probe ONLY=L02`, lab commit <short sha>, one throwaway Pro
project for the project-scoped rows; published `out/<date>/run-<stamp>.facts.md`.

| endpoint | serial | parallel-20 | spike-150 |
|---|---|---|---|
| projects_list | <first non-2xx n, status, class, retry-after> | ... | ... |
| orgs_list | ... | ... | ... |
| project_get | ... | ... | ... |
| functions_list | ... | ... | ... |
| health | ... | ... | ... |

Read: <which cells, if any, got `html`; whether the JSON throttler held for
every endpoint; recovery>. Not settled: one token, one vantage, one day; write
endpoints were not burst.
```

- [x] **Step 3: AGENTS.md key facts**

**Replace in `AGENTS.md`:**

```text
  `null` with no version fields; do not treat it as always-boolean.
```

**with:**

```text
  `null` with no version fields; do not treat it as always-boolean. F07
  (<date>, work-supabase-lab#41): <what null went with across <n> projects>.
```

**Replace in `AGENTS.md`:**

```text
it. L01b needs `PVLAB_PAT2` in the env.
```

**with:**

```text
it. L01b needs `PVLAB_PAT2` in the env. L02 (<date>, work-supabase-lab#42):
<which endpoint x burst shapes answer the edge HTML page instead of the JSON
429, and the recovery>. `make probe ONLY=L02` (~20 min) exhausts the token's
budget about 15 times; run nothing else with that token meanwhile.
```

- [ ] **Step 4: Commit and board**

```bash
git add experiments/platform-facts/RUNLOG.md experiments/platform-facts/out \
  experiments/rate-limits/RUNLOG.md experiments/rate-limits/out AGENTS.md
git commit -m "docs(platform-facts,rate-limits): F07 eligibility sweep and L02 burst matrix"
vkctl comment work-supabase-lab#41 "B02 ran <date>: <one line>, commit <sha>."
vkctl comment work-supabase-lab#42 "B02 ran <date>: <one line>, commit <sha>."
vkctl mv work-supabase-lab#41 work-supabase-lab#42 review
```

Deviation, Step 4: the commit is in the operator's commit script (agent
commits blocked), with this commit taking `AGENTS.md` whole (B01's commit
carries its snapshot from the end of B01); the two comments were posted
without a sha ("commit pending"); no card was moved (the session was told
not to move cards).

---

## Later batches (entries; each gets its own detailed plan when started)

Each entry: what to run, prerequisite, expected artifact, RUNLOG line. The
first task of every batch that touches a tofu experiment switches its
Makefile to the `RUNNER`/`BUILD` block from Task O1 Step 7 if it still calls
`harness/dist/pvlab`.

### B03 - GraphQL re-run (#129)

- Run: `sx SUPABASE_ACCESS_TOKEN -- make -C experiments/data-api-reenable apply`,
  wait as in B01-2, then `sx SUPABASE_ACCESS_TOKEN -- make -C experiments/data-api-reenable probe-destructive ONLY=DA03`,
  publish, destroy. T22 waits for #130 (W4).
- Prerequisite: Task O2.
- Artifact: DA03 run with `pg_graphql_at_start`, `pg_graphql_installed_by_module`,
  `after_graphql`, and DA03y.
- RUNLOG (data-api-reenable): "<date> DA03 re-run with pg_graphql installed for
  the measurement (#129): GraphQL before off `<state>`, after the Studio-value
  enable `<state>`; extra schema `<state>`; DA03y <dropped|failed>."

### B04 - lifecycle drill (#150)

- Run: write `experiments/lifecycle-ops/RUNBOOK-cluster-b.md` (detect a hung
  project: which probes, thresholds and how long to wait; when to self-restart
  through `POST /restart` behind the LO01 gate; what to record), then drill it
  once on a Pro Micro by inducing a stall the probes see (design at batch
  start; candidates: connection saturation, a long lock) and following the
  runbook to recovery.
- Prerequisite: read #120's cluster B description and LO05's restart envelope.
- Artifact: the runbook plus one drill run (timings per step).
- RUNLOG (lifecycle-ops): "<date> cluster B drill (#150): detect <s> s, restart
  issued at <s> s, recovered <s> s; runbook steps that did not match reality: <...>."

### B05 - edge-function limits (#64, #65, #83)

- Run: EF09 on a Free-org project (apply with the Free org's id; it asks for
  450 s and records the cut); EF07 brackets narrowed to the documented
  2 s CPU / 256 MB (for example 1.5/2.5 s and 200/300 MB); EF10 with a chain
  deeper than 30 calls inside one trace.
- Prerequisite: for #83, read how the runtime defines a trace (which header
  carries it, whether nested `fetch` to `/functions/v1` propagates it) before
  writing code; one Free-org slot.
- Artifact: EF07/EF09/EF10 runs.
- RUNLOG (edge-function-limits): "<date> EF09 on Free: stream cut at <s> s
  (<shape>); EF07 CPU <ok>/<546> at <x>/<y> s, memory <ok>/<546> at <x>/<y> MB;
  EF10 depth <n>: first refusal at call <k> with <status/body>."

### B06 - third-party token reach (#55, #61)

- Run: on one Pro Micro with the self-hosted-auth own-key issuer (SH06 rig),
  a Storage read of a private object under RLS keyed on a claim, and a
  Realtime private-channel join, each with the third-party token; then the
  legacy-key revoke with apikey probes at 10, 30, 60, 90, 120, 180 s
  (separating "gateway matches apikey by value" from "gateway cache").
- Prerequisite: modules written; local Docker for GoTrue; the revoke is
  irreversible, so it runs last and the project is destroyed after.
- Artifact: new module runs in self-hosted-auth.
- RUNLOG (self-hosted-auth): "<date> Storage <accepts|refuses> a third-party
  token under RLS on a claim; Realtime private join <...>; after the legacy-key
  revoke the apikey path answered 200 until <s> s, then <status>."

### B07 - OIDC issuer auth (#58, #59, #62)

- Run: cross-project-auth with the hub's OAuth 2.1 server enabled, a token
  from it presented to the spoke, and an `aud` mismatch; identity-transfer
  `make up` then `make probe ONLY=IT01,IT02,IT03`; tenant-promotion with a user
  signed in through the lab OIDC Worker as a custom OIDC provider, then
  promoted (identities, refresh, session carry).
- Prerequisite: #58 and #62 modules; the AU01 Worker issuer deployed.
- Artifact: X-module, IT01-IT03 and P-module runs.
- RUNLOG: one entry per experiment: "<date> <module>: <spoke accepts|refuses>
  an OAuth-2.1-server token; aud mismatch <enforced|not>"; "IT02/IT03 first
  managed run: hook arms on <CreateAccount only|...>, config reaches Auth in
  <s> s"; "promotion with an OIDC identity: identities <carried|lost>, refresh
  <ok|fails>".

### B08 - Ed25519 issuer (#56, #57)

- Run: write and run RC01-RC04 (local multi-node PostgREST with an Ed25519
  JWKS), RC05 on three managed projects, TPA05/TPA06 (Ed25519 issuer and
  rotation on managed), per `docs/plans/2026-10-02-replica-cluster-tpa.md`.
- Prerequisite: that plan's tasks; local Docker.
- Artifact: RC01-RC05 and TPA05/TPA06 runs.
- RUNLOG (replica-cluster-tpa, third-party-auth): "<date> RC<n>: <...>;
  TPA05 Ed25519 issuer <trusted|refused>, TPA06 rotation gap <s> s."

### B09 - restrict-all background jobs (#53)

- Run: a security-lockdown module that, on a Pro Micro restricted to a CIDR
  excluding every client, schedules a pg_cron job that writes a row and a
  database webhook (pg_net) to a lab endpoint, and records whether each fires.
- Prerequisite: module written.
- Artifact: new L-module run.
- RUNLOG (security-lockdown): "<date> under restrict-all: pg_cron <ran|did
  not>, database webhook <delivered|not> (<status>)."

### B10 - storage objects (#163, #164)

- Run: `caffeinate -dims` around client-keyed-objects CK04/CK06 on region-b;
  storage-surface SS03e (overwrite, then read through the CDN and with a fresh
  signed URL over time), objects past 2 GiB, parallel part uploads, TUS with
  two clients on one URL, MinIO space before and after deletes on the local rig.
- Prerequisite: #164 modules; local disk headroom for 2 GiB objects.
- Artifact: CK and SS runs.
- RUNLOG: "<date> CK04 region-b <pass|fail> under caffeinate; CK06 <...>";
  "SS03e stale copy served for <s> s after overwrite; >2 GiB <...>; parallel
  parts <...>; TUS concurrent <...>; MinIO reclaimed <n> of <m> bytes."

### B11 - control-plane client faults (#166, #167)

- Run: mgmt-api-faults through a local proxy (reuse client-retries
  `lib/faultproxy.ts`) injecting reset, refusal, TLS failure and DNS failure
  on create; a create loop that renames on retry; an orphan check; and one
  terraform-edge-functions parallel apply with `TF_LOG=DEBUG` and per-slug
  listing reads every few seconds.
- Prerequisite: #166 modules.
- Artifact: MF runs; a trace excerpt (redacted) and listing timeline.
- RUNLOG: "<date> MF<n>: <client> on <fault>: <retried|gave up>, orphans
  <n>"; "parallel apply trace: <mechanism observed>."

### B12 - pooler checkout timeout (#165)

- Run: search the docs, Supavisor source and changelogs for the 15 000 ms
  figure (compute size, release, client setting); then measure the one
  candidate on PC01.
- Prerequisite: research. If the candidate is a larger compute size, ask the
  user before provisioning (it becomes live-paid).
- Artifact: PC01 run on the candidate configuration.
- RUNLOG (pooler-checkout): "<date> 15 s source: <...>; measured <ms> on <config>."

### B13 - residency on an aged project (#66)

- Run: on the standing project (older than 4 days), query `postgres_logs`
  for the oldest available row per day window to bound partition retention;
  upload a private object, read it through a signed URL repeatedly, and record
  when the cached copy stops being served after an overwrite.
- Prerequisite: retention module written; the drain line is #52 (W4).
- Artifact: R-module run.
- RUNLOG (residency-facts): "<date> oldest log row <h> h back; private cache
  served the old object for <s> s."

### B14 - production auto-pause (#44)

- Run: create one Free project per Free org (2-active-project cap), start the
  s2z-wake sampler first, leave them idle past the platform's inactivity
  window (check the current docs for the figure before starting), then run the
  wake arm (Z04).
- Prerequisite: Free orgs with a free slot.
- Artifact: pause time, then wake timings on production.
- RUNLOG (s2z-wake): "<date> production Free: paused after <d> days idle;
  wake <s> s; <same|different> state as a manual pause."

### B15 - local rigs (#156, #168)

- Run: multigres on kind with the operator, failover under pgbench beside
  the all-in-one results; self-hosted-defaults Realtime and Edge Functions
  with `sb_` keys and `utils/upgrade-pg17.sh` on a PG15 data directory.
- Prerequisite: kind and Docker; manifests and rig changes written.
- Artifact: MG-style runs; SD runs.
- RUNLOG: "<date> kind operator: failover <s> s, lost commits <n>"; "sb_ keys:
  Realtime <...>, functions <...>; PG15 to PG17 upgrade <ok|fails at ...>."

### B16 - amd64 host (#157, and #168's amd64 row)

- Run: cli-surface native stack on linux/amd64 (a hosted CI runner or an
  amd64 box), glibc floor, idle stops; the self-hosted-defaults amd64 row on
  the same host.
- Prerequisite: the operator picks the host or runner. A workflow on the
  public mirror runs in public; keep it free of credentials.
- Artifact: CI log plus RUNLOG.
- RUNLOG (cli-surface): "<date> linux/amd64: stack <ok|fails>, glibc floor
  <x>, idle stop after <m> min."

### B17 - server runtimes (#154)

- Run: edge-runtime-auth matrix (auth mode x token type) on a Bun server
  locally and on a Vercel deployment, plus the named-key syntax.
- Prerequisite: Vercel account and token (user).
- Artifact: matrix run.
- RUNLOG (edge-runtime-auth): "<date> Bun: <matrix>; Vercel: <matrix>;
  named-key syntax <...>."

### B18 - write-op wake (#45)

- Run: s2z-wake Z02 with `PVLAB_ORG_SLUGS` set to a production free-plan org
  and `PVLAB_S2Z_TERMINAL` unset (the module creates, parks, sweeps and
  deletes its own project), run from source as Z01 was on 2026-10-13. Z02
  does not read Z01's `SILENT_DEGRADERS` list (the one Z01e tripped on that
  day); its table is `lib/write-ops.ts`.
- Prerequisite: the user's go-ahead for one production write sweep (the
  README intended staging); a free slot in the Free org (B05 and B14 use the
  same cap). Staging remains possible once #15's credential exists.
- Artifact: Z02 run.
- RUNLOG (s2z-wake): "<date> Z02: <n> of 73 write operations woke a paused
  project: <list>."

### H1 - Dashboard checks (#33, #63, #152, #158), HUMAN SESSION

Checklist for the user (an agent runs the probes alongside). Dashboard menu
names below are from memory, not from a session; follow the current UI.

- [ ] Before: agent applies data-api-reenable and branching-nogit projects
      (Pro), confirms a clone source with at least one daily backup (the
      standing project or one up for more than 24 h), and has the #158
      key-taking module written.
- [ ] #33 (user): Dashboard account settings, Access Tokens: create the
      scoped tokens in `experiments/scoped-pats/README.md`'s hand-off table
      except `PVLAB_SCOPED_PAT_MEMBER` (needs a second human, W4 #35/#153).
      Hand them to the agent through the vault, not chat. Agent: `make -C
      experiments/scoped-pats all-scoped`, then `watch-revoke` while the user
      deletes the revoke token on cue.
- [ ] #63 (user, after the agent starts DA06 with `PVLAB_DA_DRILL=1`): the
      project's Data API settings: toggle off, wait 30 s, toggle on.
- [ ] #152 branch merge (user): on a branch, change the schema in the SQL
      Editor and in the Table Editor, then merge from the Dashboard. Agent
      reads the migration history and `GET /diff` before and after.
- [ ] #152 clone (user): restore the clone source to a new project from its
      backups page. Agent times the new project to ACTIVE_HEALTHY and checks
      data, password and Storage on it, then deletes it.
- [ ] #158 (user): create an S3 access key in the project's Storage settings;
      hand it over through the vault. Agent runs the S3 checks with it, then
      the user revokes the key.
- [ ] After: agent destroys every project it created, publishes, writes one
      RUNLOG line per check.
- Artifact: SP02-SP09 runs, DA06 run, branch-merge and clone RUNLOG lines,
  S3-key run.
- Cost: live-cheap; the clone adds one Pro project for under an hour.

### H2 - governed-starter-kit interactive (#71, #78, #161), HUMAN SESSION

Checklist for the user:

- [ ] Before: agent re-provisions the kit project (Team org Micro) and
      deploys the app and functions per `experiments/governed-starter-kit`.
- [ ] #78 (agent, no human): right after `make bff-deploy`, call the fanout
      once, keep the 502 body (per-upstream status), then read the upstream
      mock's function logs for boot time.
- [ ] #161 (user): from Claude Code (interactive), add the kit's MCP server,
      complete the Claude OAuth login and the consent page; the agent records
      each redirect and the scopes granted.
- [ ] #71 (user): in that session ask for a destructive SQL statement
      (DROP, TRUNCATE, UPDATE without WHERE) and answer the confirmation
      dialog with accept, decline and Esc in turn; ask for `create_project`
      to see the paid-resource confirmation (decline it).
- [ ] #71 (user): in the Dashboard Logs Explorer run the query from
      `experiments/governed-starter-kit/docs/OBSERVABILITY.md` and screenshot
      the result for the agent (no project ref in the shot).
- [ ] After: agent destroys the kit project, writes one RUNLOG section per
      path.
- Artifact: RUNLOG sections in governed-starter-kit.
- Cost: live-cheap (one Team Micro project for the session).

### P1 - managed Pipelines and OrioleDB (#93, #155), HUMAN SESSION, REQUIRES USER GO-AHEAD (cost)

- Run: on a Pro project, the user creates a pipeline in the Dashboard to one
  managed destination (BigQuery with the service account wrappers-delete-scope
  already uses, or a DuckLake destination backed by Supabase projects); the
  agent measures initial copy time, steady lag, retained WAL and disk while
  paused, duplicates after a forced restart, and DDL propagation; on the same
  pipeline, OrioleDB tables, a PITR restore of an oriole table, and a 64-bit
  XID check.
- Prerequisite: go-ahead for Pipelines hours plus the PITR add-on; a
  destination credential.
- Artifact: pipelines and orioledb runs (managed figures beside PL01-PL08's
  engine figures).
- RUNLOG: "<date> managed Pipelines: copy <s> s for <rows>, lag <ms>,
  paused WAL <MB/h>, billing while paused <...>"; "oriole: pipeline <...>,
  PITR restore <...>, XID <...>."

### P2 - read replica (#68, #169), REQUIRES USER GO-AHEAD (cost)

- Run: one Small primary with a read replica (PITR if the platform requires
  it); tls-surface TL12/TL16/TL20/TL21 re-run (their changes since the first
  spin are unrun) plus the replica's TLS; replica-routing with the replica
  made unhealthy or lagging and Auth, Storage, Realtime and GraphQL traffic
  through the load balancer endpoint; the IPv6 rows only from an IPv6-capable
  vantage.
- Prerequisite: go-ahead; an IPv6 vantage for those rows (otherwise record
  them as not run). If declined, TL12/TL16/TL20/TL21 alone can run on a Micro.
- Artifact: TL and RR runs.
- RUNLOG: "<date> TL re-run: <...>; replica TLS <...>"; "RR: LB stops routing
  to a lagging replica after <s> s (<n> s lag); Auth/Storage/Realtime via LB
  <...>."

### P3 - PITR restore ages (#170), REQUIRES USER GO-AHEAD (cost)

- Run: a Pro project with PITR kept for several days and a database grown
  past 1 GB; restores to targets hours and days old, and to the PITR window
  start; restore time per size.
- Prerequisite: go-ahead for PITR days and compute.
- Artifact: RP runs.
- RUNLOG (restore-paths): "<date> restore to <h> h old: <min>; to <d> d old:
  <min>; 1 GB: <min>; window start <...>."

---

## Dry-run status

Dry-run 2026-10-13 on a copy of the repo at c8501f6 (b270a45 plus two
docs-only commits from a concurrent session; neither touches a file this plan
changes): rsync without `.git`, `node_modules` (symlinked back),
`secrets.tfvars`, tofu state and plan files and `evidence/`, then a fresh git
index built from the real repo's `git ls-files` so the identifier scan sees
the same tracked set. Every Create/Write/Replace/Append block of Tasks O1-O4
(38 blocks) was applied by a script that parses this file and refuses a
Replace whose old text does not occur exactly once; each task's red run,
green run and Verify block were run as written, with `tofu` on `PATH`
replaced by a stub that exits 1 (the `make -n` lines evaluate
`tofu output`). No network call, no Management API call, no tofu.

- Baseline: `tsc exit 0`; `bun test exit 0` with 1779 pass / 0 fail; 1780
  with this plan file added.
- Red states: each of the four test files fails to load (`Cannot find
  module`), ` 0 pass`, ` 1 fail`, ` 1 error`, exit 1, as written above.
- After O1 / O2 / O3 / O4: 1782 / 1788 / 1791 / 1795 pass, 0 fail, `tsc exit 0`
  each time; lib tests 13 (platform-downtime), 4 (graphql), 9
  (platform-facts), 7 (rate-limits); O5's three-directory run 29 pass.
- Skip-runs: D01 `missing capability: pat, anon-key`, DA03 `missing
  capability: pat`, T22 `runs on "runner", this process is "local"`, F07
  `missing capability: pat, org`, L02 `missing capability: pat`; every
  `make -n` line named `bun <repo>/harness/src/run.ts`.
- The files the blocks produced are byte-identical to the working copy they
  were developed in.

Plan defects found and fixed during the dry-run:

- The first `make -n probe` check printed `DB_PASSWORD` from
  `secrets.tfvars`. Verify lines now pass `PW=x`, the conventions warn
  against `make -n` without it, and the dry-run copy excludes
  `secrets.tfvars`.
- `harness/dist/pvlab` is a linux-x64 ELF (`exec format error` on the lab
  Mac), and the platform-downtime and data-api-reenable Makefiles called it.
  Tasks O1 and O2 add the governed-starter-kit `RUNNER`/`BUILD` switch; the
  new targets run from source.
- F07's first draft listed `GET /v1/projects`, which returns every project the
  account can see, including outside the lab orgs; it now lists per lab org
  and labels orgs by role.
- An eligibility test named an invented validation-error text as the
  2026-08-04 observation; retitled as a fixture.
- `graphqlServed` was exported but used only by its own test; removed.
- Skip-run output directories accumulate across re-runs; each skip-run now
  clears its directory first.
- #45's batch moved from "blocked on the staging token" to a production
  free-plan run after the concurrent session's Z01 run on 2026-10-13
  (s2z-wake RUNLOG).

Not verifiable in the dry-run: everything live (B01, B02 and every entry);
whether `postgres_logs` carries the shutdown checkpoint, "shut down" and boot
lines for a managed restart (only `received fast shutdown request` is on
record, jit-db-access JA01); whether `drop extension pg_graphql` succeeds at
the end of DA03 (create was measured in DD02b, drop never); the item shape of
`/organizations/{slug}/projects` beyond `ref` (F07 reads `created_at`,
`status` and `region` from `GET /v1/projects/{ref}`, the fields DD01S and
`readProjectRegion` read); L02's run time (about 20 minutes is arithmetic:
15 cells x burst plus a 65-185 s cooldown).

## Self-review

- Coverage against the request: batch table with cards, cost class, wall
  time, human need and blockers ("Batch table"); execution order with offline
  prep first, live-cheap next, live-paid last and each live-paid batch marked
  REQUIRES USER GO-AHEAD (cost), human batches marked HUMAN SESSION with
  checklists (H1, H2, P1); detailed offline tasks O1-O5 and the first two
  live-cheap batches B01, B02; every later batch as an entry with run,
  prerequisite, artifact and RUNLOG line; status banner; dry-run status.
- Card coverage, by script: the waves plan's triage table has 41 rows with
  wave W3; the batch table has 23 batches holding 41 cards, each once, no
  card missing or extra; every card number also appears in a section after
  the table.
- Placeholders: no TBD/TODO. The `<...>` slots left are run-time values
  (dates, short shas, measured values, the project ref from `tofu output`) in
  B01/B02 write-up templates and the entries.
- Names: `readShutdownLog`, `SHUTDOWN_LOG_SQL`, `classifyShutdownLog`,
  `bootLogged`, `ShutdownReading`, `signalMeasurements`,
  `shutdownMeasurements` (O1); `GRAPHQL_TYPENAME_QUERY`, `graphqlState`,
  `pgGraphqlInstalled` (O2); `toRow`, `summarise`, `rowLine`, `byCreation`,
  `ListedProject` (O3); `SHAPES`, `summariseCell`, `Sample`, `Shape` (O4) are
  spelled the same in tests, helpers and modules; `tsc` passed after each task.
- Confidentiality: no project ref, org slug, email, home path, customer or
  partner name; org slugs appear only as environment variable names; the
  status-page incident ids in #120's description were not copied. The
  identifier scan passes with this file in the tree.
- Estimates: wall times are estimates from cards and RUNLOGs; the cost
  classes are by kind of resource, not priced.
