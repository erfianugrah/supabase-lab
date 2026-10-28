# observability-surface

What the platform's observability surface does when it is probed from outside:
client trace propagation into logs, the Health Check Advisors, log ingestion
lag and which log sources the logs endpoint carries, the notebooks CLI round
trip, and log drains to an HTTP endpoint.

Self-provisioning: every module creates its own `ob-surface-` projects on a Pro
organization (`PVLAB_ORG_PRO`) and deletes them in `finally`. No OpenTofu
state. Measured values and their vantage are in `RUNLOG.md`; claims taken from
public docs are labelled as such there and are not repeated here.

## Modules

| id | question | runtime |
|---|---|---|
| OB01 | supabase-js trace propagation: is `traceparent` sent for REST and Edge Function calls, in which releases and packagings (unbundled, Bun bundle, esbuild bundle, bundle run without `node_modules`), is it withheld from non-Supabase hosts, and where does the client's trace id show up in the logs | ~12 min, one project |
| OB02 | `POST /v2/projects/{ref}/advisors/run`: which of the four `log_*_error_rate_high` lints fire after induced 5xx per service, at what failing share and volume, detection lag, cache refresh, clearing lag. One project per arm, arms run concurrently | ~25 min, 11 or 8 projects |
| OB03 | log ingestion canary (a marked REST and Edge Function request every minute, first-seen lag distribution), which `source` values the logs endpoint carries, request volume against the usage endpoints | ~50 min, one project |
| OB03d | logs endpoint and MCP `query_logs` edge cases: windows over 24 h, the default window, one-bound windows, `select *` and `count(*)`, the result row cap, the no-`sql` default, `logs.all`, and endpoint versus MCP parity on the same SQL | ~10 min (`OB03D_REPS=2`), one project |
| OB04 | a generic HTTP log drain to a Cloudflare Worker sink: entitlement, sink self-test, drain creation through the v2 API, and (only if creation succeeds) batch size, flush spacing, content-encoding, lag | ~2 min when creation is refused |
| OB05 | `supabase notebooks pull` / `push` round trip against the v2 notebooks API | ~2 min, one project |
| OB06 | which `alter role` / `alter database` setting of `pg_stat_statements.track_planning` reaches Data API queries (per arm: in-request value, `plans`, `total_plan_time`), and whether postgres-config takes the key; metrics endpoint families matching lock/wait/activity and what moves during a row-lock and an `ACCESS EXCLUSIVE` wait; restore-to-new-project paths in the OpenAPI documents (no clone created) | ~8 min, one Micro project |

## Measured (OB06, 2026-10-28, 2 runs, Micro, Postgres 17.11)

| question | result |
|---|---|
| `alter role <r> set pg_stat_statements.track_planning = on` as `postgres` | accepted for authenticator, authenticated, anon, postgres, service_role; `alter database` refused (`permission denied to set parameter`); `grant set on parameter ... to authenticator` refused |
| which setting puts planning into `pg_stat_statements` for Data API queries | only the one on `authenticator` (in-request value `on`, `calls=3 plans=3` for anon, authenticated and service_role); settings on anon, authenticated, service_role or postgres: `off` in the request, `plans` 0, requests still 200 |
| `SET ROLE` applies the role setting | no (`off` for all four roles); a fresh postgres login after `alter role postgres set`: `on` |
| postgres-config API / CLI with the key | `PUT` HTTP 400 `Unrecognized key`; CLI exit 1 `unknown Postgres config parameter` |
| metrics endpoint shows wait events or lock waits | no: 22 of 307 families match lock/wait/activity, none has a `state` or wait-event label, no `pg_locks`; only `pg_stat_activity_xact_runtime` (oldest open transaction age) moves during a wait, values change every 60 to 70 s |
| restore to a new project through the Management API | no path: 0 clone paths in v1 (115) and v2 (36), no source field in create-project; the Dashboard clone route refuses a PAT (401) |

Numbers and their vantage: `RUNLOG.md` section OB06.

## Run

```bash
make -C experiments/observability-surface install     # apps/: three supabase-js releases via npm aliases, OTel SDK, esbuild
# per command, with the secrets injected rather than exported:
#   SUPABASE_ACCESS_TOKEN, PVLAB_ORG_PRO,
#   CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID (OB04 only)
make -C experiments/observability-surface probe IDS=OB01,OB05
make -C experiments/observability-surface probe IDS=OB02      # OB02_ARMS=a,b selects arms
make -C experiments/observability-surface probe IDS=OB03      # OB03_MINUTES shortens the canary
make -C experiments/observability-surface probe IDS=OB03d     # OB03D_REPS (default 2), OB03D_BURST (default 1200)
make -C experiments/observability-surface probe-ob06          # OB06_HOLD_S per lock wait (default 130)
make -C experiments/observability-surface cleanup             # deletes any project named ob-surface-*
```

Raw captures (poll logs, canary rows, client outputs) go to
`evidence/<stamp>/` (gitignored: they carry project refs and client
addresses).

## Layout

- `tests/ob0*.ts` - the modules (OB03d imports the MCP client from
  `experiments/governed-starter-kit/lib/mcp-client.ts`, OB06 the
  session-pooler client from `experiments/replica-routing/lib/rr.ts`); each header names the claim, the vantage and
  what it does not settle.
- `lib/ob.ts` - project provisioning and teardown, the logs endpoint helper,
  `runAdvisors`; `lib/cf.ts` - Worker upload/delete over the Cloudflare REST API.
- `apps/` - `client.template.ts` (OB01 client) and the pinned dependency set.
- `worker/sink.js` - the drain sink (Worker + SQLite-backed Durable Object).
