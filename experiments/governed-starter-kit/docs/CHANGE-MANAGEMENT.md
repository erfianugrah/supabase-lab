# Change management: environments, direct changes, drift

<!-- doc-drift: off -->
<!-- Cites paths in a user workspace (describes the CLI layout of a user project, not this repo); doc-drift.py in ~/dotfiles. -->

Questions a central IT team asks before letting business teams build on the
kit: how do sandbox, staging and production relate; can anyone change
production on the spot; and when a fix does go straight into production, how
does it get back into the repository? This page says what the platform
documents, what the lab measured (K08, 2026-11-06), and what is still open
(K09).

## What to do about it

| Practice | Rests on |
|---|---|
| Keep builders off production: Read-only or no access there, project-scoped Developer on sandbox projects | Access-control permission table (doc); ACCESS-CONTROL.md "How the two planes combine" (lab, 2026-10-07) |
| Change production only through the deploy path (GitHub integration on merge, or `db push --remote` from CI) | Deployment docs (doc); K08.07 for the CLI path |
| Run `supabase db diff --remote=<prod ref>` on a schedule and fail on any printed SQL, not on the exit code | K08.03 and K08.06: exit 0 with and without drift |
| After a direct fix, `supabase db pull <name> --remote=<prod ref> --yes` and commit the file before the next deploy or branch | K08.05 to K08.07; K08.04 and K08.08 for branches |
| Before testing on a new branch, read its schema (or migration history), not its status | K08.04 run B: no table at the first ready status |
| Do not rely on branch roles to split builders from production until K09 has run | K09 not yet run (ACCESS-CONTROL.md "Roles on branches") |

## Environments (doc-cited, not run here)

- Local development runs on the CLI's Docker stack; schema changes become
  migration files in `supabase/migrations`.
- Branching gives each pull request a preview branch, deleted when the pull
  request merges or closes, and persistent branches for staging or QA that
  are not deleted automatically. Each branch is a separate instance with its
  own credentials and no production data by default
  (https://supabase.com/docs/guides/deployment/branching). Branching needs
  the Pro plan or above (https://supabase.com/docs/guides/deployment).
- Production is the project itself. The GitHub integration deploys
  migrations from `main` on any plan; the CLI or Terraform in your own CI is
  the alternative (https://supabase.com/docs/guides/deployment).
- Separate projects per environment, deployed by the CLI from CI, are the
  other shape; not from a docs page, and not run here.

## Who can change production

The access-control permission table gives Owner, Administrator and Developer
the SQL editor's Run action without restriction; Read-only is limited to
SELECT, run as `supabase_read_only_user`
(https://supabase.com/docs/guides/platform/access-control, read
2026-11-06). The access-control, branching and deployment docs (read
2026-11-06) describe no setting that freezes a project's schema, so the
control is the role:

- Builders get Read-only, or no access at all, on production projects, and
  project-scoped Developer on sandbox projects. Any dashboard role on a
  production project is a cross-department grant: Read-only still reads every
  department's rows (`supabase_read_only_user` has BYPASSRLS), and Developer
  adds the secret API key, which writes `app_metadata` (ACCESS-CONTROL.md,
  "How the two planes combine").
- Changes reach production only through the deploy path: the GitHub
  integration on merge, or `supabase db push --remote` from CI.
- Whether a project-scoped role on production carries to its branches is
  K09, not yet measured (ACCESS-CONTROL.md, "Roles on branches").

## The hotfix loop (K08)

Two module runs on 2026-11-06, CLI 3.0.0, each on its own Team-org project
in ap-southeast-1 at the API's default size, git-less preview branches:
run A `out/2026-11-06/run-2026-11-06T08-17-18-384Z.json` and run B
`out/2026-11-06/run-2026-11-06T08-40-45-318Z.json` (facts in the `.facts.md`
beside each). Both scored 7 pass checks of 7, plus 3 info rows (K08.02,
K08.04, teardown). Run B adds two later reads of the K08.04 branch, made
after a review pointed out that run A read it once, about 10 s after create.
A hand run on another throwaway project earlier that day gave the same
outcomes and left no artifact. It covered push, direct change, `migration
list`, `db diff`, `db pull`, diff, next push, a branch after the pull, and a
branch made after a second, unpulled change; that branch was read once,
soon after its status read ready (time not recorded), and lacked the
unpulled column.

The direct change goes through the Management API SQL route
(`POST /v1/projects/{ref}/database/query`) with the org owner's PAT. The
dashboard SQL Editor has its own route, which a PAT cannot call
(bu-attribution BA06), and the git-less branching announcement says changes
made in the SQL Editor or Table Editor are tracked (quoted in the
branching-nogit RUNLOG). So K08.02 holds for the API route; whether a hotfix
typed into the SQL Editor writes a history row was not measured.

| Step | Command or action | Observed (both runs unless marked) |
|---|---|---|
| K08.00 | One migration (`items` table), `supabase db push --remote=<ref> --yes`, no `--password`; the module adds only the PAT to the environment it inherits | exit 0; remote history holds that one version |
| K08.01 | Direct change as the owner through the Management API SQL route: `add column hotfix_note`, `create index items_name_idx` | 201; the column is on the table |
| K08.02 | `supabase migration list --remote=<ref>` | history unchanged, 1 row; local and remote agree |
| K08.03 | `supabase db diff --remote=<ref>` | prints the `ADD COLUMN` and the `CREATE INDEX`; exit code 0 |
| K08.04 | Preview branch created before the pull | lacks `hotfix_note`. Run A, one read at the first ready status (10 s): columns `id,name`, history the one migration. Run B: at the first ready status (11 s) no `items` table and no history yet; at 60 s and at 120 s after create, columns `id,name`, history the one migration |
| K08.05 | `supabase db pull hotfix_items --remote=<ref> --yes` | exit 0; one new migration file holding exactly the two statements; the CLI printed "Repaired migration history: [<version>] => applied" and the remote history gained that version |
| K08.06 | `supabase db diff --remote=<ref>` again | "No schema changes found", exit 0 |
| K08.07 | A new migration (`add column owner_dept`), `db push --remote=<ref> --dry-run`, then `db push` | the dry run listed only the new file; the push applied it |
| K08.08 | Preview branch created after the pull and after K08.07's push | has `hotfix_note` and `owner_dept`; its history matches production's three versions (one read, at the first ready status) |

What follows from it:

- **A direct change through the API route writes no migration history**
  (K08.02); a schema diff against production shows it (K08.03). For the SQL
  Editor route, see above.
- **`db diff` exits 0 whether or not it finds drift** (K08.03 and K08.06), so
  a CI drift check has to fail on the printed SQL, not on the exit code.
  Which of stdout and stderr carries the SQL was not separated in this run.
- **Once production has a migration history, a git-less preview branch
  lacks an unpulled hotfix** (K08.04, both runs; in run B still at 120 s
  after create). The dashboard branching docs state the mechanism: a branch
  "reads your base project's migration history and applies each entry as a
  migration", and with no history it dumps the base project's schema as its
  first migration (https://supabase.com/docs/guides/deployment/branching/dashboard).
  The same page says the branch "ends up with the same schema as your base
  project", which K08.04 contradicts for a change made outside the history.
  On a project with no history the dump path applies: in K09's owner
  baseline a table created only by direct SQL was on both branches
  (ACCESS-CONTROL.md). So tests on a branch can run against a schema
  production no longer has; pull a hotfix before the next branch.
- **A branch's ready status comes before its schema** (run B: no table at
  the first ready status, 11 s; the migration applied by 60 s). Read a fresh
  branch's schema, not its status, before testing on it. K08.08 read once at
  the first ready status and found the full schema, so the lag varies.
- **`db pull` closes the loop in one command** (K08.05): the change becomes a
  migration file to commit, and its version is marked applied on production,
  so the next deploy does not try to run it again (K08.07).

To run it: `sx SUPABASE_ACCESS_TOKEN -- make cm-probe` (needs Docker; creates
and deletes a `kit-cm-hotfix-*` project and its branches).

## CLI 3.0.0

From `--help` on 3.0.0 (2026-11-06):

- `db push`, `db pull` and `db diff` target the local database by default;
  `--remote` selects the linked project and `--remote=<ref|branch|url>` any
  other. A bare `supabase db push` does not reach a hosted project.
- `--yes`, or `SUPABASE_YES` exported in the shell, answers prompts; the help
  says hosted changes accept only those.

From K08 (artifact above): with no `--password` and the PAT added to the
environment, `db push --remote` printed "Initialising login role..." and
applied the migration (K08.00, K08.07).

Hand checks with a dummy token, no artifact:

- `--project-ref` still parses but prints "--project-ref is deprecated and
  will be removed in v4. Use --remote=<ref> instead".
- A hosted change whose stdout is not a terminal stops at "Confirmation
  required: ... This run can't ask because stdout is not a terminal. Nothing
  was changed." `secrets set` (stdout to `/dev/null`) then exited 1;
  `functions deploy` printed the same message, exit code not recorded. With
  `--yes` both went on to the API.

The kit's Makefile and K06 use `--remote=<ref> --yes` since 2026-11-06; K06
re-ran with it that day and deployed its function
(`out/2026-11-06/run-2026-11-06T08-24-17-224Z.json`).

## Not covered

- A GitHub-integration deploy after a pull (the connection is set up in the
  dashboard only); persistent branches in K08; declarative schemas; a direct
  change in the `auth` or `storage` schemas, which `db pull` handles
  differently by diff engine
  (https://supabase.com/docs/guides/deployment/database-migrations).
- A hotfix made through the dashboard SQL Editor (see above).
- Roles on branches (K09) and the SSO auto-join role list are in
  ACCESS-CONTROL.md.
