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

## Run

```bash
# MF01 only, no project is created
sx SUPABASE_ACCESS_TOKEN -- env PVLAB_ORG_PRO=<pro-org-slug> make read
# everything; MF01-MF04 take about 10 minutes, MF05 about 4 more
sx SUPABASE_ACCESS_TOKEN -- env PVLAB_ORG_PRO=<pro-org-slug> make all
# panic button: delete every project named mf-*
make sweep
```

Needs docker, tofu, the supabase CLI and bun. A module whose tool is missing
(or whose docker daemon is unreachable) reports `skip` with the reason. Results
are in `RUNLOG.md`.
