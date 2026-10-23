# platform-downtime - run log

What a platform operation costs a client, per connection path. The number that
matters is not one duration but the SHAPE: the paths do not move together, and
the failure mode decides how a real client behaves.

Every window below was sampled at **500 ms**, and no number here is readable
without that. All of it is **n=1** - one run per operation, on one Micro project
in `ap-southeast-1`, from a single vantage. These are observations, not a
distribution.

The 2026-10-23 section at the end of this file re-measures REST and Realtime
with data-path probes (n=2 per operation on Micro, plus Medium to Large) and
withdraws the "REST and Realtime never failed" readings below; with them, the
paths moved together under a restart and a resize.

## 2026-08-04 - D01 restart, D02 restriction flip

Project: Micro, `ap-southeast-1`, created and destroyed the same session.

### D01 - restart

| path | bit after | outage | mode |
| --- | --- | --- | --- |
| rest | - | **never failed** | - |
| realtime | - | **never failed** | - |
| auth | 2 s | 75 s | `HTTP 521` |
| storage | 2 s | 78 s | `HTTP 500` |
| pooler | 2 s | **158 s** | `Failed to connect to database: {:error, :timeout}` |

> **Correction 2026-10-23 (#204):** the `rest` and `realtime` rows above
> measured the HTTP tier only. `rest` was an anon `GET /rest/v1/`, which the
> API gateway answers with 401 before PostgREST or the database is reached,
> and any status below 500 counted as up; `realtime` stopped at the WebSocket
> handshake. Re-measured with a row read (`rest_read`) and a joined channel
> with a delivered broadcast (`realtime_join`) on 2026-10-23 (section at the
> end of this file): a restart took the REST data path down for 194 and 247 s
> and Realtime joins for 191 and 242 s (Micro, n=2), while the HTTP-tier
> probes again had no failed sample. The paragraph below is the 2026-08-04
> reading and is wrong for data reads.

**REST and Realtime served continuously through a full project restart**, at
500 ms resolution. That is the result worth carrying: an application whose read
path is PostgREST may not notice a restart at all, while one that signs users in
during the same window fails for over a minute.

**The pooler is down roughly twice as long as the HTTP tier** - 158 s against
75-78 s. Its error is the interesting part: Supavisor answers and reports the
BACKEND unreachable rather than refusing the connection itself, so the pooler
process is alive the whole time and the wait is for Postgres behind it.

Auth and Storage fail differently from each other - 521 against 500. A client
retrying on 5xx treats them the same; a client matching on a specific status
does not.

This refines T14 (privatelink-aws), which measured a restart on ONE path at
5 s resolution and recorded `timeout expired`. Same operation, more paths,
better resolution: the single number was never representative, and the mode
differs by path.

### D02 - network restriction flip

| path | bit after | outage | mode |
| --- | --- | --- | --- |
| rest, auth, storage, realtime | - | **never failed** | - |
| pooler | 1 s | see caveat | `(EADDRNOTALLOWED) address not in tenant allow_list` |

> **Correction note 2026-10-23 (#204):** the rest and realtime entries in the
> row above were HTTP-tier probes (Auth and Storage stand). Re-run with the
> data-path probes on 2026-10-23 (end of
> this file), the conclusion holds for data reads too: `rest_read` and
> `realtime_join` had 0 failed samples in both D02 runs while the pooler was
> refused for 60 and 61 s.

**A network restriction is a database-socket control and the HTTP tier does not
notice it.** Four HTTP paths, zero failed samples, twice. Locking the database
to a CIDR that excludes you does NOT lock down REST, Auth, Storage or Realtime -
they keep serving, because they reach Postgres from inside.

It reaches the POOLER, which is the part worth knowing: Supavisor enforces the
database allow-list against the CLIENT address, so `6543` is covered by the
restriction and not only direct `5432`. The refusal names the rejected address,
so the failure is self-diagnosing - unlike a restart, where the pooler reports a
timeout and tells you nothing about why.

It bites **1 s** after sampling starts (not after the API returns 201 - t0 is
set before the probe loops, so the apply call's own latency is inside that 1 s).

**Caveat on the outage duration: it is an artifact, not a measurement.** The
module holds the restriction for a fixed 60 s dwell before restoring, so the
62 s window is the dwell plus about two seconds of recovery. The real platform
facts here are the 1 s to bite and the ~2 s to recover; the middle is a
parameter this test chose.

### D03 / D04 - compute resize, up then down

`PATCH /v1/projects/{ref}/billing/addons` with
`{addon_variant: "ci_small"|"ci_micro", addon_type: "compute_instance"}`. There
is no resize endpoint; compute size is an addon mutation. Worth stating because
a previous investigation on a related question concluded a size could not be
changed programmatically after searching only for resize-shaped and
branch-shaped paths. Returning to micro REMOVES the addon rather than setting
one - micro is the absence of a compute addon, and the GET afterwards reports
`null`.

| path | D03 up, bit after / outage | D04 down, bit after / outage |
| --- | --- | --- |
| rest | - / **never failed** | - / **never failed** |
| realtime | - / **never failed** | - / **never failed** |
| auth | 2 s / 131 s | 2 s / 99 s |
| storage | 2 s / 127 s | 2 s / 100 s |
| pooler | 3 s / 207 s | 3 s / 196 s |

> **Correction 2026-10-23 (#204):** `rest` and `realtime` above are
> HTTP-tier probes (anon `GET /rest/v1/` counted 401 as up; WebSocket
> handshake only). Re-measured on 2026-10-23 with a row read and a joined
> channel (end of this file): Micro to Small took `rest_read` down for 171 and
> 218 s and `realtime_join` for 168 and 214 s; Small to Micro 54 s
> (`rest_read`) and 67 s (`realtime_join`) in the one run that sampled them.

**The asymmetry hypothesis is half right.** On the HTTP tier, growing costs
about a third more than shrinking (131 s against 99 s for Auth). On the pooler
the two are within 5 % of each other (207 s against 196 s), so whatever
dominates the pooler's window is something neither direction escapes.

**A resize is not a restart with extra steps - it is roughly twice one.** Auth
75 s on restart against 131 s resizing up; the pooler 158 s against 207 s.
Anyone planning a maintenance window off the restart number will under-budget.

## The full matrix

Four operations, five paths, 500 ms resolution, n=1 each.

| operation | rest | realtime | auth | storage | pooler |
| --- | --- | --- | --- | --- | --- |
| restart | - | - | 75 s | 78 s | 158 s |
| restriction flip | - | - | - | - | bites in 1 s |
| resize up | - | - | 131 s | 127 s | 207 s |
| resize down | - | - | 99 s | 100 s | 196 s |

**REST and Realtime never failed under any of the four.** One operation could
be luck; four is a pattern worth relying on, at this resolution and from this
vantage.

> **Correction 2026-10-23 (#204):** withdrawn for data reads. The `rest` and
> `realtime` columns came from HTTP-tier probes (see the D01 correction). With
> a row read and a joined channel, restart and both resize directions took the
> REST and Realtime data paths down for about as long as Auth and Storage; only
> the restriction flip left them untouched. Figures in the 2026-10-23 section
> at the end of this file.

**The pooler reports a different error for every operation**, which makes the
mode diagnostic of what is happening rather than merely that something is:

| operation | pooler mode |
| --- | --- |
| restart | `Failed to connect to database: {:error, :timeout}` |
| restriction flip | `(EADDRNOTALLOWED) address not in tenant allow_list` |
| resize up | `Failed to connect to database: {:error, :econnrefused}` |
| resize down | `terminating connection due to administrator command` |

Only the last is a Postgres message; the rest are Supavisor's. So the pooler is
alive throughout all four, and what changes is how the backend is unavailable -
unreachable, refused, deliberately shut down, or the client not permitted.

Auth and Storage keep their own modes across every operation: `HTTP 521` and
`HTTP 500` respectively. A client retrying on any 5xx treats them alike; one
matching a specific status does not.

## Defects found by running it

**The first D02 restored in a `finally`, after sampling had stopped.** Recovery
could therefore never be observed: the run burned the full window and reported
"never recovered" every time. It proved a restriction bites and could not
measure anything else. The restore moved inside the sampled operation, with the
`finally` kept as an idempotent safety net.

**`first_fail_s` was missing from the report.** With the original D02 the only
column was the window, which was `n/a` - so a run that had genuinely measured
"the restriction bites almost immediately" reported nothing at all. Time to bite
and time to recover are different facts and the first survives a run that ends
early.

**The Realtime probe had an unreachable branch.** It treated a non-5xx upgrade
as healthy via ws's `unexpected-response` event, which **Bun does not
implement** - it prints a warning saying so. Verified against the live project:
an upgrade with no apikey returns 401 to curl, while ws reports
`failed: Expected 101 status code` with no status attached. So a Realtime 4xx
reads as DOWN here. Survivable rather than correct - the probe sends a valid
key, and a bad key would fail from sample zero and trip the healthy-at-start
guard rather than publishing a fake outage. The branch was removed and the
limitation written next to the probe.

## Cost / teardown

Two Micro projects, roughly twenty minutes each, both destroyed. D03/D04 ran on
the second one and put the compute size back themselves, so the only cleanup is
the project. Restrictions were confirmed restored to `0.0.0.0/0` before the
first teardown rather than assumed.

Not run here, and each needs its own justification: major upgrade, PITR
restore, and read-replica add/remove.

## D05 - db-password reset vs pg_stat_checkpointer (added and run 2026-10-01: no restart)

Motivating question: on a managed Postgres 17 project,
`pg_stat_checkpointer.stats_reset` can move to a restart timestamp even
though the server's own log calls the shutdown a "fast shutdown request" -
normally a CLEAN mode. A local `docker.exe` + `postgres:17.4-alpine` control
(CHECKPOINT, then `docker restart` vs `kill -9`) showed a clean restart does
NOT reset `pg_stat_checkpointer`, only a crash restart does - so a managed
"clean" restart that resets it behaves like a crash for this one counter.
D05 tests one candidate trigger, a database-password change, and checks
whether `pg_stat_checkpointer.stats_reset` moves across it.

D05 (`tests/d05-db-password-restart.ts`) measures two things in one pass:

1. The same per-path outage shape D01 measures for a direct `/restart` call,
   but for a password-reset-triggered restart (`PATCH
   /v1/projects/{ref}/database/password`) - minus the pooler probe, which
   would be confounded by the password change happening mid-window (see the
   module's doc comment).
2. Whether `pg_stat_checkpointer.stats_reset` (or `pg_stat_bgwriter.stats_reset`
   on pre-17) changes across that restart, cross-checked against
   `pg_postmaster_start_time()` so "stats survived" and "nothing restarted" are
   never conflated.

### Why this is a `platform-downtime` module, not a new experiment

Read the whole experiment before deciding: one project, no AWS, Management-
API-triggered restarts, per-connection-path outage measurement via the shared
`lib/setup.ts` + `lib/probes.ts` + the harness `sampler.ts`. The project's own
`supabase.tf` docstring already frames the scope as "what a platform OPERATION
costs a client" across restart, restriction-flip and resize. A password-reset-
triggered restart is the same kind of operation, measured with the same
infrastructure, with one more signal (checkpointer stats survival) layered on
top of the outage window D01-D04 already capture. There is no second project,
no peer, no AWS resource to justify a separate OpenTofu state - the
dir-per-blast-radius rule in AGENTS.md is about blast radius, and this
module's blast radius is identical to D01's (one Micro project, restarted).

### Why this does NOT provision a Vercel-Marketplace project

Investigated before writing any code, per the task's safety boundary (real
money, a real third-party account, explicitly out of scope to run here).
Findings, each checked against Vercel's own current docs rather than recalled:

- **Neither the `supabase/supabase` nor the `vercel/vercel` OpenTofu/Terraform
  provider exposes a resource for a Marketplace native-integration
  installation or a provisioned resource inside one.** The Vercel provider's
  resources are `vercel_project`, `vercel_domain`, etc. - project/deployment
  management, not the Marketplace installation flow. There is no
  `vercel_marketplace_*` resource to write a `.tf` file against.
- **The Marketplace REST API (`/docs/integrations/create-integration/marketplace-api`)
  is the PARTNER's side of the contract, not a consumer's.** Its endpoints
  (`POST /v1/installations/{id}/resources`, `PUT .../resources/{resourceId}`,
  etc.) are called BY Vercel, to be implemented by whoever builds the
  integration server (i.e. Supabase, for the Supabase-on-Vercel integration).
  We are a Vercel end-user here, not an integration author; nothing on that
  API surface is ours to call.
- **The only consumer-side automation path is the Vercel CLI**:
  `vercel integration add supabase` (alias `vercel install` / `vc i`), which
  supports non-interactive flags (`--name`, `--metadata`, `--plan`,
  `--environment`, `--format=json`, ...) once an integration is already
  installed on the team. BUT: installing a Marketplace integration for the
  FIRST time on a team requires `vercel integration accept-terms <integration>`,
  and Vercel's own CLI reference states plainly that this command **"requires
  an interactive terminal and human confirmation. It does not replace
  integrations that require a browser flow or device attestation."** That is
  a one-time, per-team, Vercel-side design decision - not a gap in our
  tooling. (Sources: `https://vercel.com/docs/cli/integration`,
  `https://vercel.com/changelog/vercel-cli-for-marketplace-integrations-optimized-for-agents`,
  `https://vercel.com/docs/integrations/create-integration/marketplace-flows`,
  read 2026-10-01.)
- **Conclusion**: a Vercel-Marketplace-provisioned Supabase project cannot be
  stood up unattended from OpenTofu, the Supabase Management API, or even the
  Vercel CLI in a from-scratch CI/agent context - the first installation on
  any given Vercel team needs one human to type a confirmation. This is
  exactly the kind of step this session's safety boundary says a human must
  run, so D05 was scoped to NOT need it: it calls `database/password`
  directly on an ordinary OpenTofu-provisioned lab project (the existing
  `supabase_project.probe` resource in `supabase.tf`). Whether an
  integration-provisioned project handles a credential change differently is
  outside what this module can reach.

### Run 2026-10-01 (published: `out/2026-10-01/`): no restart

D05 reported `fail`: `pg_postmaster_start_time()` read
`2026-10-01T06:38:25.763Z` before and after the 7-minute window, every probe
path stayed up (`rest/auth/storage/realtime_mode = none`), and
`pg_stat_checkpointer.stats_reset` stayed at `2026-09-29T12:45:56.639Z`. On a
plain project a password PATCH does not restart Postgres, so the
checkpointer question is unanswered by this module.

Side observation, inferred rather than measured: that `stats_reset` predates
the project's own postmaster start by two days, so the stats survived the
project's first boot - most likely carried in the image the project was
created from, which would have been written by a clean shutdown.

Cheaper next step for the managed-restart question: read the same
`pg_postmaster_start_time()` + `stats_reset` pair around D01's direct
`POST /restart`. That answers "does a managed restart reset
pg_stat_checkpointer" directly; it does not answer whether other restart
triggers behave differently.

### To actually run it

```
cd experiments/platform-downtime
make apply                              # provisions one Micro project (same as D01-D04)
make probe-destructive ONLY=D05         # resets the DB password, samples the restart, restores it
make destroy                            # tear down when done
```

Needs `SUPABASE_ACCESS_TOKEN` (or a decrypted `secrets.tfvars`) and
`db_password` in `secrets.tfvars`, same as every other module here. Expect the
run to take up to `MAX_WAIT_MS` (7 minutes) if the outage never recovers, plus
the restore step; budget D05 alone, not stacked with D03/D04 in the same
invocation, because both mutate project-level state that a second concurrent
module could race.

## 2026-10-13 - D01 x3 with the restart signal and the stop path (work-supabase-lab#20, #67)

Harness: `make probe-destructive ONLY=D01`, three runs on one Micro project
in ap-southeast-1 (Pro org), started 04:50, 04:57 and 05:01 UTC. The
artifacts record lab commit 5f373b8; the D01 change from the W3 plan's Task
O1 was in the working tree, uncommitted, and is the commit before this
entry. Published: `out/2026-10-13/run-<stamp>.facts.md` for each run
(stamps `2026-10-13T04-50-42-266Z`, `2026-10-13T04-57-36-867Z`,
`2026-10-13T05-01-37-966Z`).

| run | restart confirmed | stats_reset changed | log stop | shutdown checkpoint | "shut down" logged | next boot | auth / storage / pooler window (s) |
|---|---|---|---|---|---|---|---|
| 1 | yes | no | not-logged | no | no | not-logged | 78 / 82 / 185 |
| 2 | yes | no | fast | no | no | not-logged | 46 / 45 / 46 |
| 3 | yes | no | not-logged | no | no | not-logged | 45 / 45 / 43 |

REST and Realtime had no failed sample in any run (500 ms interval).
(Correction 2026-10-23, #204: HTTP-tier probes, anon `GET /rest/v1/` and a
WebSocket handshake; the data paths were not sampled in these three runs and
were not re-run for this module. See the 2026-10-23 section.)
`pg_stat_checkpointer.stats_reset` read `2026-10-02T17:53:10.203Z` before and
after all three restarts, on a project created that day, so it also survived
the project's first boot (the D05 side observation of 2026-10-01 again).

Read (the W3 plan's B01 decision table, row "`log_next_boot` `not-logged` on
every run"): a managed `POST /restart` kept the checkpointer's `stats_reset`
on 3 of 3 restarts, which answers #20 for this path. D01's log columns found
no shutdown checkpoint, no "database system is shut down" and no startup line
on any run, so they give no request-to-"shut down" figure.

D01's query matches only the lines in `lib/signal.ts`. A wider read-only
query of `postgres_logs` after the runs (session scratch, not a module; the
lines below are its output, timestamps UTC) showed what the logs do hold for
each stop:

- run 1, 04:50:45.776: two `terminating connection due to administrator
  command`, then `the database system is shutting down` x2; no `received ...
  shutdown request` row.
- run 2, 04:57:39.275: `received fast shutdown request`, `aborting any active
  transactions`, three `terminating connection due to administrator command`,
  `the database system is shutting down` x2; at 04:58:24.051 `the database
  system is starting up` x2.
- run 3, 05:01:40.377: two `terminating connection due to administrator
  command`, `the database system is shutting down` x5; no request row.
- The project's provisioning restart at 04:38:14.549 logged the same opening
  as run 2.

Per run, the first stop line to the new `pg_postmaster_start_time()`:
75.9 s, 44.7 s, 43.3 s. In run 1 the pooler window ran past the database's
return: from +66 s the pooler answered `(ECIRCUITBREAKER) too many
authentication failures` until it recovered at +188 s.

Not settled: one project, one region, one day, an idle cluster (the
checkpointer-reset rig showed a slow shutdown checkpoint changes the
outcome). Whether the shutdown checkpoint ran is inferred from the kept
`stats_reset`, not logged. Why the request line is missing on runs 1 and 3
and why no line after `shutting down` or before `starting up` reaches
`postgres_logs` (log shipping stopped across the restart, or lines dropped)
was not separated. Integration-provisioned projects were not run. The status
page had an open region-less Realtime latency incident during the runs.

## 2026-10-23 - data-path re-measure: REST and Realtime were probed at the HTTP tier (#204)

**Why.** Every REST and Realtime row in this file before 2026-10-23 came from
two probes that never reach the data. `rest` sent an anon `GET /rest/v1/` and
counted any status below 500 as up; the API gateway answers that request with
401 (`Invalid API key`, hint `Only the service_role API key can be used for
this endpoint.`) before PostgREST or the database is reached, so it reads as
up whether or not the database is there (http-tier-lockdown saw the same 401
keep answering while PostgREST was wedged). `realtime` counted a completed WebSocket handshake as up,
which never joins a channel or touches the project's database. Both are kept,
renamed `rest_http` and `realtime_ws`, and two data-path probes run beside them
(`harness/src/real-probes.ts`):

- `rest_read`: anon `GET /rest/v1/pvlab_probe?id=eq.1&select=id`, up only on
  HTTP 200 with exactly `[{"id":1}]`.
- `realtime_join`: a new socket, `phx_join` with a Postgres Changes
  subscription on `pvlab_probe` and broadcast self-echo; up only when the join
  is acknowledged, the `postgres_changes` system message says `ok`, and the
  probe's own broadcast (fresh nonce) comes back.

`buildProbes` seeds the table, grant, RLS policy and `supabase_realtime`
publication entry and waits for three consecutive passes before sampling.
Each module also reports `<path>_failed_samples` beside the window.

**How.** `make selfprov` (new, `lib/selfprov.ts`): a throwaway `pd-` project on
the Pro org in `ap-southeast-1`, the modules run against it `PD_PASSES` times,
deleted in `finally`. Sampling at 500 ms as before, but a failing request often
takes its full timeout (5 s for the HTTP probes and `realtime_ws`, 10 s for
`realtime_join`), so a path's samples are coarser than 500 ms while it is
down; read the windows to the second, not finer. Medium to Large used
`PD_RESIZE_UP=ci_large PD_RESIZE_DOWN=ci_medium` on a project created at
Medium. Projects A and B, and then A and C, ran at the same time from one
machine (artifact start and finish times), alongside a lifecycle-ops LO05
project.

Artifacts, all in `out/2026-10-23/`:

| artifact | project | modules |
| --- | --- | --- |
| `run-2026-10-23T01-43-22-996Z` | Micro A, pass 1 | D01-D04 (D04 without data-path probes, see below) |
| `run-2026-10-23T02-07-03-305Z` | Micro A, pass 2 | D01-D04 |
| `run-2026-10-23T01-43-23-054Z` | Medium B, pass 1 | D03 to Large; D04 threw on HTTP 429 |
| `run-2026-10-23T01-47-38-287Z` | Medium B, pass 2 | D03 a no-op (already Large), D04 to Medium |
| `run-2026-10-23T01-55-35-451Z` | Medium C | D03 to Large, D04 to Medium |

**Results, outage window in seconds (pass 1 / pass 2 on Micro A):**

| operation | rest_http | rest_read | realtime_ws | realtime_join | auth | storage | pooler |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D01 restart | 0 of 651, 0 of 422 failed | 247 / 194 | 0 of 606, 0 of 376 failed | 242 / 191 | 247 / 192 | 250 / 195 | 329 / 216 |
| D02 restriction flip | 0 of 130, 0 of 128 failed | 0 of 128, 0 of 125 failed | 0 of 120, 0 of 111 failed | 0 of 115, 0 of 103 failed | 0 of 128, 0 of 125 failed | 0 of 123, 0 of 120 failed | 60 / 61 |
| D03 Micro to Small | 0 of 383, 0 of 429 failed | 171 / 218 | 0 of 356, 0 of 383 failed | 168 / 214 | 171 / 218 | 174 / 218 | 189 / 216 |
| D04 Small to Micro | 1 of 403 failed, 0 of 302 | not sampled / 54 | 0 of 351, 0 of 268 failed | not sampled / 67 | 191 / 54 | 196 / 51 | 249 / 150 |

**Medium to Large and back (projects B and C):**

| operation | rest_http | rest_read | realtime_ws | realtime_join | auth | storage | pooler |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D03 Medium to Large, B | 0 of 237 failed | 113 | 0 of 220 failed | 107 | 115 | 113 | 113 |
| D03 Medium to Large, C (VOID: host asleep 263 s inside it, #211) | 1 of 88 failed | 299 | 0 of 82 failed | 298 | 299 | 299 | 298 |
| D04 Large to Medium, B | 0 of 670 failed | 217 | 0 of 623 failed | 217 | 216 | 217 | 217 |
| D04 Large to Medium, C (outage start unobserved: host asleep 43 s, #211) | 0 of 383 failed | 101 | 0 of 336 failed | 98 | 101 | 104 | 200 |

Modes: `rest_read` failed with `HTTP 521` (and `HTTP 525` in B's D04);
`realtime_join` with `pg_changes: {:error, "Too many database timeouts"}` or a
`pg_changes: {:error, :rpc_error, ...}` Postgrex error. The join itself was
acknowledged; it was the Postgres Changes subscription that failed, which the
handshake probe cannot see.

Reading:

- **REST reads and Realtime subscriptions go down for about as long as Auth
  and Storage** under a restart and under a resize in either direction, on
  Micro and on Medium. The HTTP-tier probes had at most one failed sample per
  run through the same windows, which is what every "REST and Realtime never failed" line in this
  file measured.
- **A network restriction still leaves the data paths alone** (D02, 0 failed
  `rest_read` and `realtime_join` samples in both runs): REST and Realtime
  reach Postgres from inside the platform, as the 2026-08-04 reading said.
- The pooler window was the longest by 15 to 96 s in six of the nine valid
  operations above that had an outage (A pass 1 D01, D03, D04; A pass 2 D01,
  D04; C D04, whose windows are lower bounds) and within 2 s of the longest
  other path in the other three (A pass 2 D03, B D03, B D04); C D03 is void
  (#211). In C's D04 the run's console output (not
  the published artifact) shows Supavisor's circuit breaker (`(ECIRCUITBREAKER)
  too many authentication failures`) answering the correct password until
  about +240 s; the restore-paths key facts describe the same hazard.
- The two `rest_http` failures were single samples that ended in `The
  operation timed out.`; their windows in the artifacts (41 s and 262 s) are
  how long that one request took to come back, not a sustained outage.
  Corrected 2026-10-23 (#211): both are the orchestrator Mac asleep
  (43 s and 263 s in `pmset -g log`) with the request in flight; see the
  #211 section below.

Gaps and anomalies:

- **Micro A pass 1 D04 has no data-path columns.** Its seed step never saw
  three consecutive passes in 180 s (the run's console note, not in the
  published artifact, shows both probes passing on the last check), probably
  the project still settling from D03; the module ran with the HTTP-tier
  probes only. Corrected 2026-10-23 (#211): the seed loop's 180 s budget is
  wall time, and a 263 s sleep of the orchestrator fell at the D03/D04
  boundary (+202 s into D03 by the reconstruction, within about 6 s), so the
  budget most likely ran out while the process was frozen; "settling" was
  not shown. So Small to Micro on the data path is n=1 (54 s and 67 s).
- **B pass 1 D04 threw** on `429 We are still processing addon changes`
  because it followed D03 at once. `setComputeSize` now retries a 429 every
  60 s and the module reports `addon_429_retries`; B pass 2's D04 needed 2
  retries, so its `first_fail_s` of 123 s includes 120 s of retries (the
  window is unaffected). **B pass 2's D03 was a no-op**: the project was
  already Large because pass 1's D04 never ran, so its near-zero row is not a
  resize measurement.
- **An extra Micro D03/D04 pass on a fourth project (Micro, not in the
  tables) stalled** about 265 s into D03, from the run's console log and a
  process sample (no artifact): every probe stopped logging at once and the
  process sat at 0 % CPU with the main thread idle in `kevent64` for
  13 minutes. Killed, project deleted. An LO05 run (lifecycle-ops) stalled the
  same way. Both stalls happened before the sampler capped each `probe.run()`
  at 30 s (`sampleDeadlineMs`); a deadline may not fix an idle event loop,
  and the cause is not established. Corrected 2026-10-23 (#211): the event
  loop was not stuck. Most likely (the log shows where each path stopped, not
  what it awaited) the pooler loop had been awaiting a `select 1` with no
  query timeout since about +109 s, the Mac slept 66 s at about +122 s, and
  at +264.7 s the last two failing paths came back, which the sampler did not
  log (it logged only a path's first recovery). After `maxWaitMs` the sampler
  awaited the pinned pooler loop forever; idle in `kevent64` at 0 % CPU is
  what that looks like, and it reproduces locally (#211 section). The LO05
  stall has no per-sample log; it ran the same pg probes on the pre-cap
  sampler, and between its start (01:31:40 UTC, its evidence directory name)
  and its console log's last write (02:46 UTC, file time, local only) the
  sleep log has seven sleeps; which, if any, fell in the stalled restart is
  not traceable. Not explained further.
- One region, one vantage, n=2 per cell at most, consecutive operations on
  the same project. Between the two runs of one operation the Auth window
  varied by 1.3x (restart: 247 and 192 s; Micro to Small: 171 and 218 s) to
  3.5x (Small to Micro: 191 and 54 s); on Medium, 113 and 299 s (Medium to
  Large) and 216 and 101 s (Large to Medium). The 299 s is void and the
  101 s a lower bound (#211 section).
- The D01 restart windows here (191 to 250 s for Auth, Storage and the data
  paths) are well above the 2026-08-04 D01 (75 to 78 s) and the 2026-10-10
  LO05 p50s (54 to 58 s). Not explained: different day, different project.
- D05 (password reset) was not re-run here; its "REST and Realtime had no
  failed sample" line above was an HTTP-tier observation until the #208
  re-run (next section), which found the data paths untouched as well.

## 2026-10-23 - D05 re-run with the data-path probes (#208)

**Why.** The 2026-10-01 D05 run's "every probe path stayed up" came from the
HTTP-tier probes the #204 section above describes. D05 now builds its probes
with `buildProbes(ctx, { pooler: false })`, so `rest_read` and
`realtime_join` run beside `rest_http`, `realtime_ws`, Auth and Storage; the
pooler stays out for the reason in the module header (it authenticates with
the password being changed).

**How.** `make selfprov PD_ONLY=D05 PD_PASSES=2`: one throwaway Micro project
on the Pro org in ap-southeast-1, two passes. The wrapper now writes each
pass's project facts next to the artifact (`run-<stamp>.project.json`:
project age, compute, database size, Postgres image, `postmaster_start`, the
platform's `created_at`).

| pass | artifact (`out/2026-10-23/`) | age at start (since the create call) | sampled | failed samples |
| --- | --- | --- | --- | --- |
| 1 | `run-2026-10-23T07-54-24-330Z` | 10 s | 420 s (`MAX_WAIT_MS`, nothing failed) | 0 on every path: `rest_read` 0 of 767, `realtime_join` 0 of 662, Auth 0 of 772, Storage 0 of 738, `rest_http` 0 of 788, `realtime_ws` 0 of 697 |
| 2 | `run-2026-10-23T08-03-36-243Z` | 562 s | about 83 s, see below | `rest_read` 0 of 154, `realtime_join` 0 of 132, Auth 0 of 154, Storage 0 of 147, `rest_http` 0 of 157; `realtime_ws` 1 of 140 (at +77 s, recovered within 1 s) |

Both passes: `pg_postmaster_start_time()` read `2026-10-23T07:44:20.792Z`
before and after, and `pg_stat_checkpointer.stats_reset` read
`2026-10-02T17:53:10.203Z` before and after. Postgres image `17.11.0.003`.
Both artifacts show D05 as `fail`: the module fails when no restart is
confirmed, which is the expected outcome here.

Reading:

- **A database-password PATCH on a plain project did not restart Postgres
  and did not touch the data paths** (two passes, one project): no failed
  `rest_read` or `realtime_join` sample, `postmaster_start` unchanged. This
  repeats the 2026-10-01 result with the data-path probes, so its "REST and
  Realtime stayed up" now holds on the data path too. The checkpointer
  question stays unanswered by this module (no restart to observe).
- **Pass 2 sampled for about 83 s, not 420 s.** The sampler stops once every
  path that failed has recovered and settled (`harness/src/sampler.ts`,
  `allSettled`), and the one `realtime_ws` failure at +77 s met that rule. So
  pass 2 covers the first 83 s after the PATCH; pass 1 covers 420 s.
- **The project predates its create call.** The create call (07:54:13 UTC,
  wrapper log) came back `ACTIVE_HEALTHY` within about 10 s; the platform's
  `created_at` was `2026-10-23T07:42:12Z`, about 12 minutes earlier,
  `postmaster_start` `07:44:20Z`, and `stats_reset` `2026-10-02T17:53:10Z`,
  three weeks earlier. The two Medium projects created for #208 the same
  morning (medium-serverless RUNLOG) reported `postmaster_start` about 39
  hours and about 6 hours before their create calls. That is consistent with the 2026-10-01 side observation above
  (`stats_reset` two days before `postmaster_start`) and with the create
  call handing out an already-provisioned instance; inferred from these
  timestamps, not from a platform statement.

## 2026-10-23 - the "event-loop stall" was the orchestrator asleep and a pinned pooler loop (#211)

**Question.** Two runs on 2026-10-23 went silent with the process at 0 % CPU
and the main thread in `kevent64`, and one `fetch` with
`AbortSignal.timeout(5000)` took 262 s. Bun bug, or ours? Runtime: Bun
1.3.14 (`0d9b296af`) on the macOS orchestrator, whose `pmset -g` has system
sleep set to 1 minute. All clock times below are UTC.

**Finding 1: the long requests and the shared silences are the Mac
asleep.** The sleep log has a system sleep (idle, or the maintenance sleep
after a dark wake) at each of them (`out/2026-10-23/host-sleep/pm-events.tsv`:
the Sleep, Wake and DarkWake lines of `pmset -g log`, converted to UTC, with
the sleep reason, trimmed to the run windows: only events within 5 min of a
scanned artifact's start to finish, plus both ends of any sleep overlapping
one, 41 of the 155 events from 2026-10-22T05:00Z to 2026-10-23T09:30Z. The
trim is `harness/scripts/sleep-overlap.ts --trim`; every figure below is the
same from the full and the trimmed log):

- Medium C D03: every path failing until the gap (last samples started at
  +34.1 s on `pooler`, +38.8 to +39.2 s on the others), then every path
  except `rest_http` (+301307) `recovered at +300805ms` (`realtime_join`
  +300804); sleep 01:56:21 to 02:00:44 (263 s). The `rest_http` sample that
  "took 262 s" started at +39.153 s.
- Medium C D04: first failure on `storage`, `rest_read` and `auth` all at
  +40447 ms; sleep 02:00:54 to 02:01:37 (43 s), starting about when the
  resize PATCH went out.
- The extra Micro pass: every path quiet from about +122 s, next samples at
  +187248 to +187250 ms; sleep 02:32:17 to 02:33:23 (66 s). No artifact:
  placed by its console clock (the pass began at 02:30:08) and by the 65 s
  gap matching the only 66 s sleep after pass 2 ended at 02:29:42.

Console lines: `out/2026-10-23/host-sleep/console-excerpts.md` (refs
removed). `durationMs` comes from `performance.now()`, which did not advance
during these sleeps while `Date.now()` did. Walking each artifact's tests
forward from `startedAt` and skipping the logged sleeps lands within 5 to 6 s
of `finishedAt` for the three runs that spanned sleeps; for the two that did
not, wall span and summed `durationMs` are equal (134.7 and 134.7 s, 434.2
and 434.2 s). Both in `out/2026-10-23/host-sleep/overlap.txt`, from
`harness/scripts/sleep-overlap.ts`. By that placement:

| artifact | test | sleep inside it |
| --- | --- | --- |
| `run-2026-10-23T01-43-22-996Z` (Micro A, pass 1) | D03 | 263 s at about +202 s, at the D03/D04 boundary after D03's last recovery (pooler at 192 s: first failure 3 s plus window 189 s in the artifact) |
| same | D04 | 43 s at +9 s, inside the outage; paths failing on both sides of the gap |
| `run-2026-10-23T01-55-35-451Z` (Medium C) | D03 | 263 s at +46 s, inside the outage; every path up on the first sample after it |
| same | D04 | 43 s at +1 s, before the first failure |
| `run-2026-10-23T02-07-03-305Z` (Micro A, pass 2) | D01 | 193, 243 and 103 s at +304, +528, +781 s, after its windows closed |

So: **C D03 is void**: the recovery happened somewhere inside a 263 s blind
spot, the 298 to 299 s windows include the 263 s sleep, and the 262 s
`rest_http` sample is the sleep. **C D04's windows (98 to 104 s, pooler
200 s) are lower bounds**: the outage may have begun unobserved during the
43 s sleep (first failures at +40447 ms, right after the wake). A pass 1
D04's windows span a 40 s gap with failures on both sides and stand, but its
one `rest_http` failure (41 s) is the sleep, and its missing data-path
columns are most likely the seed loop's 180 s wall budget running out across
the 263 s sleep: D04's `durationMs` is 219 s in all, too short to hold 180 s
of awake seeding plus its 191 to 249 s windows. The rest of the table is
unaffected by placement (two more passes had no sleep at all).

**Finding 2: the 13-minute silence was a pooler loop pinned by a query with
no timeout.** In the extra Micro pass the `pooler` path logged a failure on
every sample until `+108781ms` and never logged again. Inference, as the
log cannot show where a sample waits: its next sample's `select 1` got
through startup and was never answered, the one unbounded await in that
probe (`connectionTimeoutMillis` ends at ReadyForQuery; no `query_timeout`
was set). `rest_read` and `auth` went quiet at +264.7 s most likely because
they came back up a second time: each had already logged its first recovery
(+250712 and +249424 ms), and the sampler logged only that one; the other
reading, two fetches hanging past their abort timeout at once, did not
reproduce (below). After `maxWaitMs`, `sampleDuring` awaited every loop,
including the pinned one, forever. With nothing due, Bun waits in
`kevent64`: the observed state. Reproduced locally with no project
(`harness/scripts/repro-pinned-loop.ts`, a fake pooler that holds the 4th
connection's query): the sampler from before the cap (`1e4cb33`) was still
running 20 s after start, 14 s past its 6 s `maxWaitMs`, `STAT SN`, 0.0 %
CPU, 872 of 873 main-thread samples in `kevent64`
(`out/2026-10-23/host-sleep/repro-precap.txt`). The current sampler returns
after 7013 ms with `probe did not answer within 3000 ms` twice
(`repro-current.txt`); with `query_timeout` the probe itself fails with
`Query read timeout` (`repro-current-query-timeout.txt`). No Bun fault
found: in local scratch probes (one trial each, not kept),
`AbortSignal.timeout` (1000 ms; 500 ms for DNS) aborted a fetch stuck in DNS
(a `.local` name that takes 10 s to fail), in TCP connect to an unroutable
address, in a TLS handshake, on a response body, and on a reused keep-alive
socket that went silent, each within 2 ms of its timeout.

**Changes.** `harness/src/host-pause.ts`: the runner holds a macOS
idle-sleep assertion for its own lifetime (`caffeinate -i -w <pid>`, skip
with `PVLAB_ALLOW_SLEEP=1`), and stamps any test whose wall time exceeds its
monotonic time by more than 2 s with `host_suspended_s` and a detail note,
also when the test threw. `sampler.ts` logs `host paused N s at +X ms (...
the host was suspended)` when its watchdog wakes late, carries `pausedMs`
per path (pause time inside [0, recovery]), and logs `<path> up again` for
every later recovery. The pooler (`lib/probes.ts`) and lifecycle-ops
`direct` probes set `query_timeout` (5 s). `caffeinate -i` blocks idle sleep
only, not a lid-close sleep; the stamp and the sampler line are what catch
that.

**Other artifacts spanning a sleep, not audited here (work-supabase-lab#234)**
(`out/2026-10-23/host-sleep/artifacts-spanning-sleep.txt`: each committed
pvlab artifact under `out/2026-10-22/` and `out/2026-10-23/`, start and
finish against the published sleep log): data-api-capacity (three runs,
2026-10-22/23), realtime-surface RT05 (2026-10-22), restore-paths RP06 and
RP07 (seven artifacts). Whether a given number in them is affected depends
on where the sleep fell. The lifecycle-ops LO05 artifact
(`run-2026-10-23T02-47-19-611Z`, started 02:47:19) holds two sleeps,
02:52:17 to 02:55:27 and 02:55:37 to 02:56:04; by its own
`first_restart_accepted_after_healthy_s=698` both fell in the post-create
wait before the first measured restart, so its restart windows are not
affected. LO05f, timed for +300 s, went out at +489 s because the sleep
froze its timer; the 489 s acceptance is real wall time.
