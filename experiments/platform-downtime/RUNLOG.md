# platform-downtime - run log

What a platform operation costs a client, per connection path. The number that
matters is not one duration but the SHAPE: the paths do not move together, and
the failure mode decides how a real client behaves.

Every window below was sampled at **500 ms**, and no number here is readable
without that. All of it is **n=1** - one run per operation, on one Micro project
in `ap-southeast-1`, from a single vantage. These are observations, not a
distribution.

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
