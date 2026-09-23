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
  only; `config.toml`, `seed.sql` and functions were not changed here, Run 5
  covers them). `apps/a/README.md` sits
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

| PR | wait step returned | run it read belonged to | migrate job | A's own first `success` (first seen, s after the run started creating the PRs, 30 s poll) |
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

## Second session - 03:27 to 04:03 UTC - fresh projects, changes only ON

Two new Micro projects (same names, same org, `make apply` again) and a new
private throwaway repository with the same fixture, both connected in the
dashboard with the same working directories, "Supabase changes only" on and
Branch limit 10. GB00 at 03:27:26 read both connections on the same
repository, `apps/a` and `apps/b`, changes only true, automatic branching
true and limit=10 on both (`run-2026-09-23T03-27-26-360Z.*`). The artifacts
record lab commit `2ebb438`; the GB04-GB06 modules ran from the working tree
and are the revisions committed next.

### Run 5 - 03:27 UTC - GB04, kinds of file under supabase/

`out/2026-09-23/run-2026-09-23T03-27-33-845Z.*`

| PR changes (all under `apps/a/supabase/`) | preview on A (first seen) | preview on B |
|---|---|---|
| `seed.sql` (a second insert) | yes, 56 s | no |
| `config.toml` (a comment line appended) | yes, 56 s | no |
| `functions/probe/index.ts` (new function) | yes, 56 s | no |
| `NOTES.md` (a file the CLI does not read) | yes, 56 s | no |

- All four files under A's `<workdir>/supabase/` triggered a preview on A,
  including one the CLI does not read. First-seen times count from when the
  module started creating the pull requests, at a 30 s poll.
- On the a-function pull request A's comment marked Edge Functions with a
  warning, "Only Functions declared in config.toml will be automatically
  deployed to branches". The module did not check whether `probe` was
  deployed to the preview.
- Every pull request got 2 comments from `supabase[bot]`, one per connected
  project. Each body starts with a `[supa]:<ref>` marker line. B's comment
  carried B's parent ref and read "This pull request has been ignored for the
  connected project `<ref>` because there are no changes detected in
  `apps/b/supabase` directory." A's comment carried A's preview ref (not A's
  parent), a deployments and tasks table, and "Tasks are run on every commit
  but only new migration files are pushed. Close and reopen this PR if you
  want to apply changes from existing seed or migration files."
- In the artifact, `preview:B` on B's comment is B's parent ref matched
  through B's default branch row, which the module's preview-ref map
  includes; B had no preview.
- So on a one-app pull request the ignored project's comment is identifiable
  by its parent ref. A branching project's comment carries only its preview
  ref; GB04 opened no two-app pull request, so two branching projects'
  comments were not compared. Check-run `details_url` still carries parent
  refs on the early runs (Run 1, Run 2).

### Run 6 - 03:42 UTC - GB05, changes that arrive after the PR opened

`out/2026-09-23/run-2026-09-23T03-41-58-215Z.*`

| Step (20 s poll) | preview on A |
|---|---|
| PR opened with `apps/a/README.md` only, watched 120 s | no |
| migration under `apps/a/supabase/` pushed to it, watched 240 s | no |
| PR closed, reopened 15 s later | yes, first poll (20 s) |

- With the setting on, a pull request that opened without Supabase changes
  did not get a preview when one was pushed later; closing and reopening it
  did.
- A separate pull request opened with a migration (A previewed, settled at
  `FUNCTIONS_DEPLOYED`); a commit adding a row to `seed.sql` was then pushed.
  240 s later the new row was absent from A's preview database (read with
  `select count(*)` through the Management API query endpoint on the preview
  project), which matches the comment text above.

### Run 7 - about 03:57 UTC - GB06, merging an A-only pull request (same battery as Run 6)

Same artifact as Run 6; the time is from the merged migration's version,
`20260923035722`. Both projects' default branch rows read `git_branch` `main`
(the module skips otherwise; not recorded in the artifact). The dashboard form
writes that field only when Deploy to production is enabled
(`gitBranch: data.enableProductionSync ? data.branchName : ''` in the Studio
source), so the toggle was on for both.

- A pull request with one migration under `apps/a/supabase/` was merged
  (squash, 200) after A's preview settled. In the 240 s after the merge each
  parent project got 1 new action run: A and B both
  `clone:EXITED,configure:PAUSED,deploy:EXITED,health:EXITED,migrate:EXITED,pull:EXITED,seed:EXITED`.
- The merged migration's version was in A's migrations list and not in B's.
- Read at the end of the 240 s watch, the merge commit carried 6 check-runs
  from app `supabase`, 3 per project by the parent ref in `details_url`:
  `success` + 2 `in_progress` each.
- "Supabase changes only" (last read on for B by GB00 at 03:27) did not stop
  B's production run on a merge that changed nothing under `apps/b/`. One
  merge was tried. Whether B's `deploy` step redeployed
  anything was not measured; B had no functions.

## Not settled

- A single connected project on its own: whether its own `skipped` run is ever
  what a wait-by-name step reads. In Run 2's a-db, A's `skipped` run was
  followed by its next run 29 s later, but in that window the name-filtered
  view showed only B's `skipped` runs, never A's.
- Failures other than a migration error; whether a `DEAD` step always means
  failure.
- Anything about the Vercel integration.
- A push that changes an existing migration file; a `config.toml` change that
  alters a value rather than a comment.
- Branch `notify_url` as a per-branch push signal (not run).

## Teardown

`make destroy` 2026-09-23 after each session: 2 resources destroyed each time
(both projects). The first session's probe repository was deleted by the
operator the same day (the GitHub API answered 404 for it afterwards); the
second session's is deleted by the operator, outside this state.
