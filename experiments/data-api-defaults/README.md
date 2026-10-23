# data-api-defaults

What a project created through `POST /v1/projects` does today with the Data
API defaults the platform has been changing since 2026-03: table privileges
in `public`, pg_graphql and its introspection, the `GET /rest/v1/` OpenAPI
spec, and the extension-version and realtime-schema lockdowns met by the
`postgres` role. Each module measures the behaviour a public changelog or
rollout notice describes, on one fresh project, and records the verbatim
status and body next to the notice's wording.

Self-provisioning: DD01-DD04 share one Pro-org project (ap-southeast-1)
created on first use; DD99 deletes it. No OpenTofu state. Sibling context:
`iap-lockdown` (L08 grant lockdown, L02 Data API levers; its GraphQL probe
was fixed from this experiment), `data-api-reenable`.

## Modules

| id | claim measured |
|---|---|
| DD01 | `pg_default_acl` for `public` on an API-created project; a SQL-created table read by anon; after the opt-in `ALTER DEFAULT PRIVILEGES ... REVOKE` the same read is 42501 with the "Grant the required privileges" hint; GRANT re-opens it |
| DD02 | pg_graphql absent by default; `CREATE EXTENSION`; `__schema` / `__type` refused; the `comment on schema public is e'@graphql({"introspection": true})'` opt-in and explicit `false`; the fixed iap-lockdown GraphQL probe against each state |
| DD03 | as `postgres`: `CREATE EXTENSION ... VERSION` and `ALTER EXTENSION ... UPDATE TO` (warning text, resulting `extversion`); DDL and `schema_migrations` writes in schema `realtime`, with a `realtime.messages` policy as the control |
| DD01S | the DD01 reading on a STANDING project (`PVLAB_REF`): reading date, `created_at`, exposed schemas, `pg_default_acl` rows for `public` verbatim; one probe table created in SQL, anon and publishable `GET /rest/v1/<probe>` status/code/hint/body verbatim, table dropped in `finally`. No GRANT/REVOKE or `ALTER DEFAULT PRIVILEGES` |
| DD04 | `GET /rest/v1/` with no key, anon, publishable, service_role and `sb_secret_` keys; `GET /v1/projects/{ref}/database/openapi` with a PAT |
| DD05 | the lab fixtures' explicit GRANTs are load-bearing: after DD01c's revoke, the edge-resilience `w_probe` seed (publishable read), usage-metering M05's `metering_hourly` (service_role and `sb_secret_` insert) and edge-resilience W12 itself (no GRANT, table GRANT only, table + sequence GRANT) each with the GRANT left out and then issued. Run as `ONLY=DD05,DD99` so DD05a reads the untouched default |
| DD99 | teardown |

## Run

```bash
export SUPABASE_ACCESS_TOKEN=...            # Management API token
export PVLAB_ORG_PRO=<pro-org-slug> PVLAB_ORG_SLUGS=<pro-org-slug>
export PVLAB_DD_PREFIX=pvlab-dd-            # project-name prefix, default shown
make run                                    # DD01-DD04 then DD99, artifacts in evidence/<ts>/
make clean                                  # list leftover prefixed projects; DELETE=1 deletes
```

### Standing-project baseline (DD01S)

DD01-DD04 measure a project created today. The notice applies the
no-auto-expose default to EXISTING projects on 2026-10-30, so DD01S reads a
project that already exists, created before 2026-05-30, twice: once before
2026-10-30 and once on or after it. Each reading records its own date and
the project's `created_at`, so the pair describes itself.

```bash
export SUPABASE_ACCESS_TOKEN=...
export PVLAB_REF=<ref of a project created before 2026-05-30>
make run-standing                           # DD01S only, artifacts in evidence/<ts>/
# after 2026-10-30, same project, same command; then compare the two:
bun ../../harness/src/run.ts --diff evidence/<pre>/run-<stamp>.json,evidence/<post>/run-<stamp>.json --out evidence/diff
```

DD01S writes one table (`dd01s_probe_<ms>`) and drops it in a `finally`
block (DD01Sb records `probe_gone`); every SQL statement goes through a guard
that refuses GRANT, REVOKE and ALTER. It does not restore a paused project:
a project that is not `ACTIVE_HEALTHY` is a recorded fail with nothing
probed. Measurement keys carry no probe name, so `--diff` shows only what
moved.

The harness entry point (`harness/src/run.ts`) has a facts mode that renders
an artifact's measurements as a table; its header comment gives the syntax.

## Not run

- DD01S re-run on or after 2026-10-30 on the same project as the 2026-10-13
  baseline (RUNLOG), then `--diff` the pair.
- A project created from the dashboard with the "Automatically expose new
  tables" checkbox in either state.
- A real `ALTER EXTENSION ... UPDATE` where the installed version is older
  than the default (a version pin is ignored at create, so no older version
  can be installed to update from).

Results and caveats: `RUNLOG.md`.
