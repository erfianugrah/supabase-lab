# RUNLOG - github-branching

Ephemeral: provision -> connect in the dashboard -> probe -> destroy. Two
Micro projects on a Pro-plan org in `ap-southeast-1`, one private throwaway
repository created for the run and deleted after it. The fixture (`fixture/`)
is two `supabase init` directories, `apps/a/supabase/` and `apps/b/supabase/`.
Project A is connected with Working directory `apps/a`, project B with
`apps/b`; Automatic branching on for both; Branch limit raised from the
form's default of 3 to 10 before GB01 so the cap could not hide a preview.

All runs 2026-09-23. `2bad035` in the artifacts is the repository HEAD at run
time, which does not contain this experiment; the module revisions are the ones
this directory was first committed with, except where Run 1 says otherwise.
Redacted artifacts and facts tables: `out/2026-09-23/`.

## Run 0 - 01:47, 01:49:08 and 01:49:44 UTC - GB00 control

- 01:47: GB00 fail. A connected (`workdir=apps/a`, changes only false,
  automatic branching true, limit 3); B absent from
  `GET /v2/organizations/{slug}/integrations/github/connections`. B was not in
  the list (the operator's first dashboard connection had not saved); the
  operator reconnected it.
- 01:49:08: GB00 pass, both connected to the same repository, `apps/a` and
  `apps/b`, changes only false and `limit=3` on both (the connection form's
  default). The dashboard accepted a second project's connection to a
  repository another project already uses.
- 01:49:44: GB00 pass, `limit=10` on both after the operator raised it.

Artifacts: `run-2026-09-23T01-47-40-105Z.*`, `run-2026-09-23T01-49-08-899Z.*`,
`run-2026-09-23T01-49-44-317Z.*`.

## Run 1 - 01:49 UTC - GB01, "Supabase changes only" OFF on both

`out/2026-09-23/run-2026-09-23T01-49-50-172Z.*`

| PR shape | files changed | preview on A | preview on B |
|---|---|---|---|
| root | `README.md` | yes, 30 s | yes, 30 s |
| a-app | `apps/a/README.md` | yes, 30 s | yes, 30 s |
| a-db | `apps/a/supabase/migrations/...` | yes, 30 s | yes, 30 s |
| b-db | `apps/b/supabase/migrations/...` | yes, 97 s | yes, 97 s |
| both-db | one migration in each | yes, 30 s | yes, 30 s |

- With the setting off, each project created a preview for all five pull
  request shapes, including a root README change neither working directory
  contains. With the setting off, the working directory did not limit which
  pull requests previewed.
  (First-seen times are the 30 s poll interval, not creation latency.)
- Closing the five pull requests removed all ten previews within the 2 min
  settle; 0 left for cleanup to delete.
- This run's module revision read check-runs through the endpoint's default
  view only, so the artifact's `*_checks = 1` and
  `both_identifying_fields = none` describe what that code could see; the
  commits carried more. A
  `filter=all` snapshot taken during the run (kept in the ignored `evidence/`;
  refs replaced by project role) shows, on every one of the five head commits:
  10 check-runs, all named `Supabase Preview`, all from app `supabase`, all in
  one check suite. Per project, 5 runs: 1 `skipped` and 1 left `in_progress`
  whose `details_url` is the parent project's `/project/<ref>/branches`
  page, then 1 `success` and 2 left `in_progress` whose `details_url` is the
  preview branch's own project. Six of ten still `in_progress` when the
  snapshot was taken at 01:59:12 UTC, about 9 min after the first git branch
  was created (branch stamp 01:49:52) and inside the 600 s window. `external_id` empty on all ten; output title
  `Supabase Preview` or empty.

## Run 2 - 02:05 UTC - GB01, "Supabase changes only" ON on both

`out/2026-09-23/run-2026-09-23T02-05-54-247Z.*` (GB00 before it:
`run-2026-09-23T02-05-48-118Z.*`)

| PR shape | preview on A (first seen) | preview on B (first seen) | check-runs A / B (still open at 600 s) |
|---|---|---|---|
| root | no | no | 2 / 2 (0 / 0) |
| a-app | no | no | 2 / 2 (0 / 0) |
| a-db | yes, 187 s | no | 5 / 2 (3 / 0) |
| b-db | no | yes, 187 s | 2 / 5 (0 / 3) |
| both-db | yes, 187 s | yes, 187 s | 5 / 6 (3 / 4) |

- First-seen times in this run cannot be earlier than about 180 s: this
  revision polls the branch lists only after the 150 s `latest_sequence`
  phase, then every 30 s. 187 s is that first poll, not creation latency, and
  is not comparable with Run 1's 30 s.
- With the setting on, a project previews a pull request only when it changes
  files under that project's `<workdir>/supabase/` (tested with migrations
  only; `config.toml`, `seed.sql` and functions were not changed). `apps/a/README.md` sits
  inside A's working directory and did not trigger A.
- On every pull request head commit read, each connected project posted at
  least one `skipped` run, whether or not it branched; a project that did not
  branch posted only `skipped` runs, 2 of them. Commits on `main` and pushes
  outside a pull request were not read.
- `latest_sequence` - the name-filtered default view, sampled every 3 s for the
  first 150 s: on a-db (A-only migration) it showed two different B `skipped`
  runs in turn before A's first `in_progress`, then `A:success`. On both-db it moved between A and
  B and showed `B:skipped` mid-build before settling on `A:success`.
- Attribution: of `external_id`, `details_url`, output title and summary,
  only `details_url` carried a project ref.

## Run 3 - 02:22 UTC - GB02, the docs' wait workflow, changes only ON

`out/2026-09-23/run-2026-09-23T02-22-06-701Z.*`

`.github/workflows/wait-a.yaml` (from `fixture-ci/`, pushed with
`make push-ci`): the branching docs' `wait` + `migrate` jobs using
`fountainhead/action-wait-for-check@v1.2.0` with `checkName: Supabase
Preview`, path filter `apps/a/supabase/**`, migrate job reduced to an echo.

| PR | wait step returned | run it read belonged to | migrate job | A's own first `success` (first seen, s after the PRs opened, 30 s poll) |
|---|---|---|---|---|
| a-db (A only) | `skipped` | B | skipped | 108 s |
| both-db | `success` | B | success | 108 s |

- On an A-only pull request, app A's workflow took project B's `skipped` run
  and skipped the migrate job; the B `skipped` run it read started 02:22:13,
  A's own `success` run 02:22:58. On a pull request touching both, it
  proceeded on B's `success`. GB02 opened no B-only pull request, so what the
  path filter does there was not measured; the filter cannot stop B's runs
  being on A's commits.
- Each commit also carried 2 check-runs from app `github-actions`: the
  workflow's own `wait` and `migrate` jobs (confirmed by check-run id against
  the GitHub API after the run). They match neither project's refs and are
  the `?` rows in the artifact.
- The action (source read at v1.2.0) calls `checks.listForRef` with
  `check_name` and no `filter`, and returns the first `completed` run's
  conclusion.
- Action runs: a-db, 1 of 3 action runs with a `check_run_id` was on the
  commit, the A preview's; both-db, 2 of 4, one per preview project; the rest
  were the two parent projects', whose `check_run_id`s are not on these
  commits (not identified further). Each of those 3 check-runs (1 on a-db, 2
  on both-db) was left `in_progress`, while the matching action run's steps
  were all `EXITED`.

## Run 4 - 02:35 UTC - GB03, A's migration fails, B's succeeds

`out/2026-09-23/run-2026-09-23T02-35-42-488Z.*`

One pull request: a migration under `apps/a` altering a table that does not
exist, a valid migration under `apps/b`. Sampled every 15 s for 480 s.

| t (first sample showing the value) | A branch `status` | B branch `status` |
|---|---|---|
| 15 s | `FUNCTIONS_DEPLOYED` | `FUNCTIONS_DEPLOYED` |
| 32 s | `CREATING_PROJECT` | `CREATING_PROJECT` |
| 65 s | `RUNNING_MIGRATIONS` | `RUNNING_MIGRATIONS` |
| 81 s | `MIGRATIONS_FAILED` | `FUNCTIONS_DEPLOYED` |

- The branch `status` from `GET /v1/projects/{parent}/branches` (matched on
  `git_branch`) separates the two projects and reports the failure. The first
  sample (15 s) read `FUNCTIONS_DEPLOYED` on both branch rows; `CREATING_PROJECT`
  appeared at 32 s, so a wait on that value alone can return before the
  preview project is created. The OpenAPI document (read, not probed) marks
  the field deprecated in favour of action runs.
- Latest action run on each preview project at 81 s: A `migrate:DEAD` with
  `deploy` and `seed` still `CREATED`; B every step `EXITED`.
- Check-runs at the end: A `failure` + `skipped` + 3 `in_progress`; B
  `success` + `skipped` + 3 `in_progress`.
- One failure sample, a migration error only.

## Not settled

- A single connected project on its own: whether its own `skipped` run is ever
  what a wait-by-name step reads. In Run 2's a-db, A's `skipped` run was
  followed by its next run 29 s later, but in that window the name-filtered
  view showed only B's `skipped` runs, never A's.
- Failures other than a migration error; whether a `DEAD` step always means
  failure.
- Anything about the Vercel integration.

## Teardown

`make destroy` 2026-09-23: 2 resources destroyed (both projects). The probe
repository is deleted by the operator, outside this state.
