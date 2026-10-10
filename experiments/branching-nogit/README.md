# branching-nogit

Branching without git: what a schema change made on a git-less preview branch
does when the branch is merged. Public claim under test: the 2026-05-04 blog
https://supabase.com/blog/branching-without-git-is-now-the-default says every
schema change made in the SQL Editor or Table Editor on a branch is tracked,
and merging applies the migration pg-delta generates (pg-delta is described as
alpha there). Sibling measurement: MS15 in `medium-serverless` (merge answered
201 and applied nothing after `prisma db push`).

Self-provisioning: each module creates a throwaway parent project in a Pro org
(`PVLAB_ORG_PRO`), one branch off it, and deletes both in `finally`. No
OpenTofu state.

## Modules

| id | claim |
|---|---|
| BN01 | change written to the branch through `POST /projects/{branch_ref}/database/query` (table, RLS, policy, privilege narrowing, function, column, index): what `GET /diff` shows in three variants and what `POST /merge` applies to the parent |
| BN02 | one branch, two write paths (`/database/query` set and `/database/migrations` set), one merge: which set reaches the parent |
| BN03 | BN01 with `PATCH /branches/{ref} {request_review: true}` before the merge |

Each module also records branch create time, when the parent's schema arrives
on the branch (the `pull` step of the branch's workflow run), the parent's and
branch's migration history, and teardown.

## Run

```bash
# Pro org slug and PAT are injected, never written to a file
PVLAB_ORG_PRO=<pro-org-slug> sx SUPABASE_ACCESS_TOKEN -- make probe ONLY=BN01,BN02,BN03
```

`make probe` regenerates the registry, runs from source (`bun harness/src/run.ts`;
the compiled `pvlab` target is linux-x64) and writes `evidence/<ts>/`.
Results and the run log: `RUNLOG.md`.
