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
| OB04 | a generic HTTP log drain to a Cloudflare Worker sink: entitlement, sink self-test, drain creation through the v2 API, and (only if creation succeeds) batch size, flush spacing, content-encoding, lag | ~2 min when creation is refused |
| OB05 | `supabase notebooks pull` / `push` round trip against the v2 notebooks API | ~2 min, one project |

## Run

```bash
make -C experiments/observability-surface install     # apps/: three supabase-js releases via npm aliases, OTel SDK, esbuild
# per command, with the secrets injected rather than exported:
#   SUPABASE_ACCESS_TOKEN, PVLAB_ORG_PRO,
#   CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID (OB04 only)
make -C experiments/observability-surface probe IDS=OB01,OB05
make -C experiments/observability-surface probe IDS=OB02      # OB02_ARMS=a,b selects arms
make -C experiments/observability-surface probe IDS=OB03      # OB03_MINUTES shortens the canary
make -C experiments/observability-surface cleanup             # deletes any project named ob-surface-*
```

Raw captures (poll logs, canary rows, client outputs) go to
`evidence/<stamp>/` (gitignored: they carry project refs and client
addresses).

## Layout

- `tests/ob0*.ts` - the modules; each header names the claim, the vantage and
  what it does not settle.
- `lib/ob.ts` - project provisioning and teardown, the logs endpoint helper,
  `runAdvisors`; `lib/cf.ts` - Worker upload/delete over the Cloudflare REST API.
- `apps/` - `client.template.ts` (OB01 client) and the pinned dependency set.
- `worker/sink.js` - the drain sink (Worker + SQLite-backed Durable Object).
