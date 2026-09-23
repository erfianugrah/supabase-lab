# RUNLOG - wrappers-delete-scope

Question: when a user deletes or edits one row in the dashboard's Wrappers
list, how many connections does it remove?

No tofu here. Each run uses one throwaway free-org project, created with
`POST /v1/projects` and deleted with `DELETE /v1/projects/{ref}` within the
hour, since free orgs cannot take the `instance_size` the other experiments
pass. Everything goes through `/v1/projects/{ref}/database/query`; nothing
clicks the dashboard.

The Studio SQL is generated, not hand-copied. `scripts/gen-studio-sql.ts`
imports Studio's own `getCreateFDWSql` / `getDeleteFDWSql` /
`getUpdateFDWSql` and `wrapWithTransaction` from a pg-meta checkout and writes
`lib/studio-sql.generated.ts`, pinned to the commit it was built from. Run 1
used a hand copy, and that copy deleted the Vault secret `<fdw>_sa_key` where
Studio deletes `<fdw>_sa_key_id`; generating removes that class of error.

    # regenerate against current Studio
    git -C <supabase> archive origin/master packages/pg-meta | tar -x -C <dir>
    bun experiments/wrappers-delete-scope/scripts/gen-studio-sql.ts <dir>/packages/pg-meta/src <commit>

    # run against a disposable project
    cd harness && bun run build
    PVLAB_REF=<ref> SUPABASE_ACCESS_TOKEN=<pat> PVLAB_DB_PASSWORD=unused AWS_REGION=<region> \
      ./dist/pvlab --where local --experiment wrappers-delete-scope --only X01 --destructive \
      --out ../experiments/wrappers-delete-scope/evidence/<ts>

## Source read (supabase/supabase ab7783f2ca, 2026-09-23)

`packages/pg-meta/src/sql/studio/database/fdw.ts` and
`apps/studio/components/interfaces/Integrations/Wrappers/`:

- `getFDWsSql` returns one row per `pg_foreign_server`; the row's `name` is
  `w.fdwname`, the foreign data wrapper's name, not the server's.
- Delete (`DeleteWrapperModal` -> `getDeleteFDWSql`) runs
  `drop foreign data wrapper if exists <name> cascade`, then deletes the Vault
  secret `<name>_<encrypted option>`. The dialog reads "This will also remove
  all tables created with this wrapper" and names the FDW.
- Edit (`EditWrapperSheet` -> `getUpdateFDWSql`) is the same delete followed
  by a create for the edited row only. Its confirmation reads "Saving changes
  will drop the existing wrapper and recreate it."
- Create (`CreateWrapperSheet` -> `getCreateFDWSql`) always runs
  `create foreign data wrapper <wrapper_name>` and names the server
  `<wrapper_name>_server`, so every dashboard-created connection owns its FDW.

## Run 1 - 2026-09-23 - hand-copied Studio SQL

Superseded by Run 2 (same outcome on server and table counts; the Vault secret
name in the hand copy was wrong, so its secret handling is not evidence).

## Run 2 - 2026-09-23 - generated Studio SQL, Postgres 17.6, wrappers 0.6.2, ap-southeast-1

Five BigQuery connections per sub-case, one foreign table each, dummy
credentials (only the catalog is exercised, BigQuery is never contacted). The
shared-FDW builds (X01b-e) also carry one Vault secret per server, a view on
server 2's table and a materialized view (`with no data`) on server 3's. Three
consecutive executions gave identical counts.

| id | setup | action | list rows / distinct names | servers | foreign tables | views + matviews | Vault secrets |
|----|-------|--------|----------------------------|---------|----------------|------------------|---------------|
| X01a | FDW per connection (Studio create x5) | Studio delete | 5 / 5 | 5 -> 4 | 5 -> 4 | - | 5 -> 4 |
| X01b | one shared FDW | Studio delete | 5 / 1 | 5 -> **0** | 5 -> **0** | 2 -> **0** | 5 -> 5 |
| X01c | one shared FDW | Studio edit, saved unchanged | 5 / 1 | 5 -> **1** | 5 -> **1** | 2 -> **0** | 5 -> 6 |
| X01d | one shared FDW | `drop view` / `drop foreign table` / `drop server` | 5 / 1 | 5 -> 4 | 5 -> 4 | 3 -> 2 | 5 -> 5 |
| X01e | one shared FDW | Studio create reusing the FDW's name | 5 / 1 | 5 -> 5 | 5 -> 5 | 2 -> 2 | 5 -> 5 |

- X01a: a connection made in the dashboard is removed alone, with its secret.
- X01b: one row's Delete removed all five servers, all five foreign tables,
  the view and the materialized view on the siblings, and the FDW. The
  statement succeeded with no warning. All five Vault secrets were left behind,
  since Studio only deletes the secret named after the FDW.
- X01c: Edit on one row, changing nothing, leaves only the edited connection,
  drops the siblings' view and materialized view, and adds a new secret
  `<fdw>_sa_key_id` next to the five originals.
- In the shared setup all five list rows carry the same name, so nothing in
  the list tells a user which rows share a wrapper.
- X01d: the default RESTRICT refuses every over-reach with `2BP01 ... because
  other objects depend on it`:
  `drop foreign data wrapper` (no cascade) while servers exist,
  `drop server` while its foreign table exists, and
  `drop foreign table` while a view depends on it. Dropping the view, then the
  table, then the server removes exactly one connection and leaves the
  siblings, their view and their materialized view intact.
- X01d also ran the two catalog queries from the removal guidance verbatim
  (connections with their wrapper; foreign tables on one server via
  `pg_foreign_table.ftserver`). Both returned the expected rows.
- X01e: Studio's create refuses a name that is already an FDW
  (`42710: foreign-data wrapper "..." already exists`) and rolls back with no
  secret left behind. The dashboard cannot put a second server on an existing
  FDW, so the shared setup in X01b-d only arises from SQL.

Not tested: the dashboard UI itself (Studio's SQL is generated from source and
replayed, not captured from a browser session); Postgres 15 and the legacy
pgsodium branch of the secret handling (wrappers <= the last version in
Studio's legacy list); whether the cascade reaches functions whose bodies
reference a foreign table.
