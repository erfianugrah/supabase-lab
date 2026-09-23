# github-branching

Two Supabase projects connected to one GitHub repository.

## The use case

A monorepo holds two apps, each with its own `supabase/` directory and its own
Supabase project:

```
apps/a/supabase/   -> project A, GitHub integration workdir apps/a
apps/b/supabase/   -> project B, GitHub integration workdir apps/b
```

Both projects have Automatic branching on. Two questions decide whether the
setup is usable:

1. Which pull requests create a preview branch on which project? A pull
   request that only touches app A should not also create a preview on B.
   Does that depend on "Supabase changes only", and does that setting match
   against the project's workdir or against the whole repository?
2. When a pull request touches both apps, both projects report a check on the
   same head commit. The branching docs' CI example waits on a check by name
   (`Supabase Preview`). Can a CI job tell the two projects' checks apart, so a
   seed or test job waits on the right one?

## What is in state and what is not

`supabase.tf` creates the two projects (micro). The GitHub side is not in
tofu: the provider has no resource for a GitHub connection, so the Supabase
GitHub App is installed on the probe repository and each project is connected
from the dashboard (Project Settings -> Integrations -> GitHub, Working
directory `apps/a` or `apps/b`, Automatic branching on). The probe repository
is a private throwaway created for the run and deleted after it.

`fixture/` is the repository's initial `main`: two `supabase init` directories,
one migration and one seed file each.

## Modules

| id | question |
|---|---|
| GB00 | both projects healthy, both connected to the same repository with distinct workdirs; records each connection's settings from `GET /v2/organizations/{slug}/integrations/github/connections` |
| GB01 | opens five pull requests at once (root README, app A non-Supabase file, A migration, B migration, both migrations), watches both projects' branch lists and the head commits' check-runs (`filter=all`) for 10 minutes, then closes them and records which previews survive the close |
| GB02 | the docs' wait-by-check-name workflow (`fixture-ci/wait-a.yaml`, path filter `apps/a/supabase/**`) on an A-only and a two-app pull request: which project's run the wait step returned, and each action run's `check_run_id` |
| GB03 | one pull request, A's migration fails and B's succeeds: branch `status`, latest action-run steps and check-runs per project, every 15 s for 480 s |

GB01-GB03 are DESTRUCTIVE (git branches, pull requests, billed preview
branches). GB01 runs once per "Supabase changes only" setting; GB00's reading
of the toggle is the label on each run.

## Run

```
make init apply
make push-fixture REPO=owner/name     # after creating the empty private repo
# dashboard: install the GitHub App on the repo, connect A (apps/a) and B (apps/b)
make probe REPO=owner/name            # changes-only as connected
# dashboard: flip "Supabase changes only" on both projects
make probe REPO=owner/name
make push-ci REPO=owner/name          # GB02's workflow onto main, over SSH
make probe REPO=owner/name ONLY=GB02
make probe REPO=owner/name ONLY=GB03
make destroy
```

Results and dated evidence: RUNLOG.md.
