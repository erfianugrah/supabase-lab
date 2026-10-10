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
| DD04 | `GET /rest/v1/` with no key, anon, publishable, service_role and `sb_secret_` keys; `GET /v1/projects/{ref}/database/openapi` with a PAT |
| DD99 | teardown |

## Run

```bash
export SUPABASE_ACCESS_TOKEN=...            # Management API token
export PVLAB_ORG_PRO=<pro-org-slug> PVLAB_ORG_SLUGS=<pro-org-slug>
export PVLAB_DD_PREFIX=pvlab-dd-            # project-name prefix, default shown
make run                                    # DD01-DD04 then DD99, artifacts in evidence/<ts>/
make clean                                  # list leftover prefixed projects; DELETE=1 deletes
```

The harness entry point (`harness/src/run.ts`) has a facts mode that renders
an artifact's measurements as a table; its header comment gives the syntax.

## Not run

- The standing-project re-run on or after 2026-10-30 (enforcement of the
  no-auto-expose default on projects created before 2026-05-30): DD01 can run
  against such a project once a module variant takes `PVLAB_REF`; not built.
- A project created from the dashboard with the "Automatically expose new
  tables" checkbox in either state.
- A real `ALTER EXTENSION ... UPDATE` where the installed version is older
  than the default (a version pin is ignored at create, so no older version
  can be installed to update from).

Results and caveats: `RUNLOG.md`.
