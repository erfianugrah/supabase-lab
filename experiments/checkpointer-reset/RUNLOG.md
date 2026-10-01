# checkpointer-reset - RUNLOG

Local-only, no managed project, no PAT, no tofu state. See README.md for the
motivating question and method; this file is the per-run record.

## CR01 - first run, GREEN (2026-10-01)

Rig: `supabase/postgres:17.6.1.136` (the exact tag `docker/docker-compose.yml`
in github.com/supabase/supabase pins today, verified by cloning the `docker/`
directory the same day) and `postgres:17.11-alpine` (the latest 17.x tag on
Docker Hub the same day), both PG17, both freshly created (`make local-up`)
immediately before the run.

Two runs, same result both times. Artifacts:
`evidence/20261001-143717/run-2026-10-01T06-37-17-266Z.{json,md}` (the one
quoted below) and `evidence/20261001-143442/run-2026-10-01T06-34-42-254Z.{json,md}`
(an earlier run against the same two freshly-created containers, before a bug
fix to the log-evidence capture described below; the stats-reset measurements
in both runs agree).

Per target (`supabase`, `vanilla`): 3x `CHECKPOINT`, read `pg_stat_checkpointer`,
clean restart (`docker restart`, which sends the image's STOPSIGNAL - SIGINT
on both pinned tags, confirmed via `docker image inspect --format
'{{.Config.StopSignal}}'` - Postgres's fast-shutdown signal), read again, 2x
more `CHECKPOINT`, unclean restart (`docker kill -s SIGKILL` then `docker
start`), read again. 4 pass, 0 fail, 0 skip, both runs.

**Measured facts, quoted from the artifact:**

| target | restart mode | stats_reset before | stats_reset after | changed | num_requested after |
|---|---|---|---|---|---|
| supabase | clean | 2026-10-01 06:37:07.994094+00 | 2026-10-01 06:37:07.994094+00 | false | 5 |
| supabase | unclean | 2026-10-01 06:37:07.994094+00 | 2026-10-01 06:37:19.694786+00 | true | 1 |
| vanilla | clean | 2026-10-01 06:37:07.96934+00 | 2026-10-01 06:37:07.96934+00 | false | 5 |
| vanilla | unclean | 2026-10-01 06:37:07.96934+00 | 2026-10-01 06:37:22.461344+00 | true | 1 |

Both images, identically: a CLEAN restart does NOT reset
`pg_stat_checkpointer` (`stats_reset` unchanged, `num_requested` kept
accumulating); an UNCLEAN restart (SIGKILL) DOES reset it (`stats_reset`
jumps to the restart instant, `num_requested` drops back to 1). This
reproduces, on reusable infra, what the ad-hoc `docker restart` vs `kill -9`
probe against a throwaway `postgres:17.4-alpine` found before this
experiment existed - and extends it: the self-hosted Supabase image is
**indistinguishable from vanilla Postgres** on this question, at the
image/entrypoint layer, locally.

**Server-log evidence** (`docker logs`, scoped per restart to an exact
instant captured just before each `docker restart` / `kill` call - see bug 2
below for why a plain tail was not good enough):

- vanilla, clean: `received fast shutdown request` ->
  `aborting any active transactions` -> `checkpoint starting: shutdown
  immediate` -> `checkpoint complete: ...` -> `database system is shut down`
  -> clean restart, same data directory, `database system was shut down at
  ...` on the next boot. The exact "fast shutdown request" wording the
  managed restart's log carried.
- vanilla, unclean: next boot logs `database system was interrupted; last
  known up at ...` then `database system was not properly shut down;
  automatic recovery in progress`, redo, then ready. The crash-recovery path,
  as expected from a SIGKILL.
- supabase, clean: only `pg_cron scheduler shutting down` was visible. The
  vendored `command:` block (lifted verbatim from `docker-compose.yml`) sets
  `log_min_messages=fatal`, which suppresses LOG-level output including the
  "received fast shutdown request" / checkpoint / "database system is shut
  down" lines vanilla shows at its default log level - so **this rig cannot
  show that supabase/postgres actually goes through the same logged fast-
  shutdown sequence vanilla does**, only that its COUNTERS behave the same
  way. The stats-level result does not depend on logging level; the
  server-log confirmation does, and only vanilla's log confirms it directly
  here.
- supabase, unclean: only a stray `FATAL: the database system is starting
  up` from a connection attempt mid-restart was visible, same
  `log_min_messages=fatal` reason.

**Harness bugs found and fixed while building this** (both load-bearing for
trusting the log evidence above, neither affects the stats-reset measurement
itself):

1. `postgres` is NOT superuser on `supabase/postgres:17.6.1.136` even with
   NONE of the upstream `docker-entrypoint-initdb.d` migration scripts run -
   it is baked into the base image, not something `roles.sql` does.
   `select rolsuper from pg_roles where rolname in ('postgres',
   'supabase_admin')` reads `f` / `t`. `CHECKPOINT` as `postgres` throws
   `permission denied to execute CHECKPOINT command`; `supabase_admin` (same
   password, works over TCP) succeeds. `lib/rig.ts` runs `CHECKPOINT` as a
   per-target `checkpointRole` (`supabase_admin` / `postgres`) for exactly
   this reason - reads stay on `postgres` on both, since `pg_stat_checkpointer`
   is world-readable on both.
2. A first version of the log-evidence helper called `docker.exe logs` with a
   line-count tail and read only `.text()` from Bun's `$` shell, which
   captures STDOUT only. `docker logs` demuxes a container's stderr to its
   OWN stderr, and Postgres logs to stderr by default - so the helper
   silently returned empty for vanilla (and showed only the one stdout-side
   `pg_ctl` wrapper line for supabase) every time, with no error. Fixed by
   redirecting stderr into the captured stream and switching the tail-depth
   approach to an exact-instant scope captured just before each restart
   call, so two captures bracketing two different restarts can never show
   the same stale lines (the first version did exactly that on a container
   already bounced once - compare `evidence/20261001-143302` and
   `evidence/20261001-143442`, both before the fix, against
   `evidence/20261001-143717`, after it).

## Open question, not answered here

The compose rig's restarts never reproduce the managed discrepancy (a
clean-labelled shutdown nonetheless resetting the checkpointer): both images
agree with each other and with the documented vanilla behaviour, but every
restart here ran on a near-idle cluster whose shutdown checkpoint finished in
well under a second, so "preserves stats" holds for an unhurried clean stop
only. That rules out the self-hosted image/entrypoint layer, as far as an
unhurried stop exercises it. It does NOT rule in or out anything about the MANAGED platform's own
restart orchestration (what signal it actually sends, whether it waits for
the shutdown checkpoint to complete before anything else touches the
container/volume, whether "restart" on the managed control plane is the same
operation as a container restart at all) - that is not observable from a
local container and was not probed here. The honest read: the discrepancy, if
it reproduces again, is either managed-platform-specific orchestration, or a
shutdown that is interrupted between the log line and the checkpoint actually
landing on disk (a race this rig's restarts completed too fast to ever hit) -
and this run cannot tell those apart.

## 2026-10-01: SIGKILL during the shutdown checkpoint depends on the version

Shape: dirty ~2 GB of shared_buffers with an `UPDATE`, send the postmaster
SIGINT (fast mode), then SIGKILL 0.4-0.5 s later while the shutdown
checkpoint is still writing (it takes 1.6-2.6 s here). Containers kept alive
on `sleep infinity` with Postgres under `pg_ctl`, so killing the postmaster
does not tear down the namespace; both signals sent inside one `docker exec`
so exec latency cannot delay the SIGKILL. Two runs per row:

| version | killed | stop-side log | next start | stats |
|---|---|---|---|---|
| 17.4 (`postgres:17.4-alpine`) | postmaster only | `checkpoint complete` from the surviving checkpointer, no `database system is shut down` | `database system was shut down at` | kept |
| 17.11 (`postgres:17.11-alpine`) | postmaster only | same | same | kept |
| 18.6 (`postgres:18-alpine`) | postmaster only | same | same | reset |
| 18.6 (bare cluster, system binaries) | postmaster only | same | same | reset |
| 17.11 | every Postgres process (`pkill -9 postgres`) | `checkpoint starting`, no complete | `shutdown was interrupted`, `not properly shut down; automatic recovery in progress` | reset |
| 17.11 | nothing (clean `pg_ctl` stop) | `database system is shut down` | `was shut down at` | kept |

Read:

- On PostgreSQL 17 a postmaster-only kill mid-checkpoint leaves both logs
  clean AND keeps the cumulative stats. On 18.6 the same shape logs clean
  and loses them. Why the versions differ was not read from the source.
- On 17, the only shape here that reset the stats is the whole-process kill,
  and it is visible: the next start says `not properly shut down` and runs
  recovery. So on a 17.x project, a `stats_reset` that moved to a restart
  time should come with that startup line. If the startup log says `was shut
  down at` instead, look for something other than the stop path (an explicit
  `pg_stat_reset_shared`, a restore).
- The first bare-cluster attempt (PG 18.6) is where the earlier "clean logs
  plus a reset" note came from; it holds for 18 only. In that attempt zsh did
  not word-split `kill -9 $PM $KIDS`, so only the postmaster died - the same
  shape as the postmaster-only rows.

Which shape the managed platform's stop path produces, and its grace period,
is unknown. The scripts were session scratch; re-create them from this table.
