# mgmt-api-faults

What the supabase CLI, the OpenTofu supabase provider and the lab's own
Management API client do when `api.supabase.com` answers 5xx, 429 or slowly:
whether each retries, what a failed write leaves behind, and what a repeated
non-idempotent POST does.

Method: a small fault-injecting reverse proxy runs in a container (`oven/bun`)
in front of `https://api.supabase.com`. Each tool is pointed at it (CLI: a
profile file whose `api_url` is the proxy; provider: `endpoint`; harness:
`mgmtBase`).
Rules pick requests by method and path and either answer an error without
contacting upstream (`error-before`: the operation did not happen), forward and
then replace the answer with an error (`error-after`: it happened and the
caller was told it failed), or hold the request (`delay-before`,
`delay-after`). The proxy log is the attempt count at the wire. Nothing is
patched or intercepted inside the tools. The proxy never logs request bodies or
the Authorization header.

Self-provisioning: modules that write create `mf-` projects on the
Pro org (`PVLAB_ORG_PRO`) and delete them in `finally`; state is a scratch
directory with local OpenTofu state, not a state in this repo.

## Modules

| id | claim |
|---|---|
| MF01 | harness `mgmt()` / `functionPresent()`: attempts per call on persistent 5xx, one transient 500, 429 x2, and a hold past the 30 s timeout (read-only) |
| MF02 | harness project create whose answer is lost: held past the client timeout, 500 after upstream created it, and the same-name retry |
| MF03 | CLI: attempts per invocation on 5xx/429 for GET, POST, PUT, DELETE; retry budget; a create answered 500 after upstream created it; a 100 s hold |
| MF04 | OpenTofu provider: transient 500 on create, 500 after create (orphan), the re-apply recovery, settings writes (before and after upstream applied), reads during refresh, destroy faults |
| MF05 | a create answered after the client's own timeout: CLI (75 s hold) and provider (130 s hold) |
| MF06 | connection reset, clean close, refused, TLS failure and DNS failure before upstream, for a GET and a create POST: CLI, Bun `fetch()`, Node `fetch()`; attempts and what each reports (creates nothing) |
| MF07 | a create whose connection is reset after upstream created the project (CLI, Bun `fetch()`), a fresh-name retry, a list-before-retry client, and the reconciler against their ledger (creates five; the 2026-10-23 run used a first version that filtered on `created_at`, see RUNLOG) |
| MF08 | `lib/reconcile.ts` on one induced orphan (first-seen grace, exit 3), and `created_at` against the time the create was sent (creates one) |

## Run

```bash
# MF01 only, no project is created
sx SUPABASE_ACCESS_TOKEN -- env PVLAB_ORG_PRO=<pro-org-slug> make read
# everything; MF01-MF04 take about 10 minutes, MF05 about 4 more
sx SUPABASE_ACCESS_TOKEN -- env PVLAB_ORG_PRO=<pro-org-slug> make all
# MF06-MF08, connection-level faults and the reconciler (no docker; about 2 minutes, 6 creates)
sx SUPABASE_ACCESS_TOKEN -- env PVLAB_ORG_PRO=<pro-org-slug> make conn
# orphan check for a tool that keeps a JSON Lines ledger of its acknowledged creates
sx SUPABASE_ACCESS_TOKEN -- env PVLAB_ORG_PRO=<pro-org-slug> make reconcile LEDGER=<ledger.jsonl>
# panic button: delete every project named mf-*
make sweep
```

MF06-MF08 do not use the container: connection faults (an RST, a clean
close, a refused port, a self-signed certificate, an unresolvable `.invalid`
host) come from a listener in the test process itself (`lib/connfault.ts`):
the container's port forwarder sits between the proxy and the client, and
whether it passes a reset through unchanged was not tested.

Needs docker, tofu, the supabase CLI and bun (MF06-MF08: the CLI, node, bun
and openssl). A module whose tool is missing
(or whose docker daemon is unreachable) reports `skip` with the reason. Results
are in `RUNLOG.md`.
