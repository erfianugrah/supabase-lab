# checkpointer-reset

Does a clean Postgres restart ever reset `pg_stat_checkpointer`, and is the
self-hosted Supabase Postgres image any different from vanilla Postgres on
that question?

## Background

On a managed PG 17 project, `pg_stat_checkpointer.stats_reset` can move to
the timestamp of a restart whose server log reads "fast shutdown request",
which is a CLEAN shutdown mode, not a crash.

A throwaway `docker run postgres:17.4-alpine`, `CHECKPOINT`, then `docker
restart` vs `docker kill -9` showed the clean path does NOT reset the
checkpointer (the counters just keep accumulating across it); only the
unclean path zeroes it. That is the documented Postgres behaviour (stats are
written to disk on a clean shutdown and reloaded on the next start; a crash
loses them and the next start's recovery resets them) - so the managed
reading is the surprising one, not the ad-hoc test's.

Two explanations are live: the self-hosted Supabase stack's own
entrypoint/supervisor scripts could be doing something that behaves like a
crash despite the log line saying otherwise, or it is purely something the
managed, cloud-hosted platform's own orchestration does that no self-hosted
container can show. This experiment builds the reusable infrastructure to
tell the two apart, as far as a local container can reach.

## Method

Two throwaway Postgres 17 containers, no managed project, no PAT, no tofu
state - see `compose.yml`:

- `supabase_db` - `supabase/postgres:17.6.1.136`, the exact tag
  `docker/docker-compose.yml` in github.com/supabase/supabase pins today
  (verified by cloning the `docker/` directory the same day this was built).
  The `command:`, `environment:` and `healthcheck:` blocks are copied
  verbatim from that file's `db:` service. Dropped: the bind-mounted
  supplementary init SQL (`realtime.sql`, `webhooks.sql`, `roles.sql`,
  `jwt.sql`, `logs.sql`, `pooler.sql`, `_supabase.sql`) that bootstraps OTHER
  services' schemas - irrelevant to Postgres's own shutdown/checkpointer
  behaviour, and vendoring them would mean also vendoring files this
  experiment never reads. A published port was added (`127.0.0.1:45432`),
  which the real deployment does NOT do for the `db` service (production
  routes through Supavisor) - a necessary deviation for a rig that has to be
  dialable from the host.
- `vanilla_db` - `postgres:17.11-alpine`, the latest 17.x tag on Docker Hub
  the same day. No Supabase image layer, no custom command, no
  Supabase-specific environment.

Same major version (17) on both, so any difference in restart behaviour is
attributable to the image/entrypoint, not the Postgres version. `make
local-up` brings both up; `make local-probe` runs the test module (`tests/
cr01-restart-mode.ts`); `make local-down` tears everything down, including
the generated `.env` (a throwaway local password, nothing shared with any
real credential).

Per target: `CHECKPOINT` a few times, read `pg_stat_checkpointer`, CLEAN
restart (`docker restart`, which sends the image's STOPSIGNAL - verified as
SIGINT on both pinned tags via `docker image inspect`, Postgres's own
fast-shutdown signal), read again, `CHECKPOINT` a couple more times, UNCLEAN
restart (`docker kill -s SIGKILL` then `docker start`), read again. Whether
`stats_reset` changed and whether the counters reset to a fresh baseline is
read off both runs, not inferred from one signal alone (see `lib/rig.ts`:
`sameReset`).

`docker.exe` is the only Docker CLI on PATH in this WSL distro (Docker
Desktop runs on the Windows side); every shell-out in `lib/rig.ts` calls it
explicitly rather than assuming a bare `docker` works. Docker Compose here is
the `docker compose` plugin (v5.5.1 at build time), not a standalone
`docker-compose` binary.

## Where this lives

Not inside `platform-downtime`, even though both are "about restart" on the
surface. `platform-downtime` measures what a MANAGED platform restart costs
a CLIENT per connection path (REST/Auth/Storage/pooler, sampled over HTTP
against a live tofu-provisioned project, via the Management API) - a
client-visible-outage question. This experiment measures internal Postgres
state correctness (`pg_stat_checkpointer`) under two LOCAL container restart
modes, with no managed project, no PAT, no tofu state, and no connection-path
sampling at all. It shares nothing of `platform-downtime`'s infrastructure or
measurement shape; "restart" is where the resemblance ends.

It also is not a `local-up` tier bolted onto an existing experiment the way
`identity-transfer`'s `local/` rig is onto `identity-transfer` itself - that
precedent fits when the local question is a sub-question of an experiment
that already has a managed half asking a related question (ITL1-3 continue
IT01-3's own numbering and story). This question has no managed half at all:
it is answerable, in full, by two local containers, so it gets its own
experiment directory, following `identity-transfer`'s and `self-hosted-auth`'s
shape (a `local/`-style rig with its own compose file, `lib/`, `tests/`, a
`make local-up` / `local-probe` / `local-down` lifecycle) without any of the
tofu/PAT scaffolding those experiments also carry for their managed halves.

## Status

See RUNLOG.md for the measured result: both images behave identically (an
unhurried clean restart does not reset the checkpointer, an unclean one
does), which rules out the self-hosted image/entrypoint for that case. A
SIGKILL during a slow shutdown checkpoint depends on the version: on PG 17
(17.4 and 17.11) a postmaster-only kill keeps the stats, and a whole-process
kill resets them with a `not properly shut down` startup line; on PG 18.6 the
postmaster-only kill logs clean and still resets them. The managed
platform's own stop path and grace period remain untested.
