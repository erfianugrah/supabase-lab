# lifecycle-ops

What a client can know before it changes a project (create, restart, resize,
upgrade) and what it sees when it does: the public status page as a change
gate, project creation through a region-fallback wrapper, an identical create
sent twice, and a restart envelope over five connection paths.

Self-provisioning: destructive modules create throwaway `lo-*`
projects in the Pro organization (`PVLAB_ORG_PRO`) and delete them in
`finally`. No OpenTofu state. One full pass makes 5 to 6 creates. Sibling
experiments: `platform-downtime` (D01 is the n=1 restart this extends),
`edge-resilience` (FAILURE-MATRIX 10.1, "capacity blocks create, resize,
restart", was `[doc]` only).

## Modules

| id | claim |
|---|---|
| LO01 | read-only, no credential: the shape of status.supabase.com `components.json` and `incidents.json` (region names repeated 10 to 11 times, no region field on incidents, no `unresolved.json`), the gate's decision per region now, and a replay of the incident feed through the gate |
| LO03 | create through `createWithFallback` ([unknown region, ap-southeast-1], then two plain creates): status and body of requests that must fail, orphan check, status transitions and seconds to `ACTIVE_HEALTHY` (n=3), delete-to-gone |
| LO04 | `POST /v1/projects` whose response the caller abandoned, then the identical request re-sent: duplicate or name collision |
| LO05 | restart envelope: one Micro project restarted 5 times behind the gate, REST, Auth, Storage, pooler (6543) and direct (5432) sampled at 500 ms; per-path p50 and max of first failure and outage window; a restart refused or accepted inside the post-create window; a second restart sent while one is in flight |

LO02 is not used. The restart module first ran under that id, failed at
readiness (the direct probe's name lookup, see `lib/probes.ts` and RUNLOG), and
was re-run as LO05.

`lib/gate.ts` is the change gate (pure decision functions plus a fetcher);
`lib/gate.test.ts` covers it with fixtures (`make test`).

## Run

```bash
make test                      # gate unit tests, offline
make status                    # LO01, no credential
# live, destructive: about 30 min wall clock, 5 to 6 creates, deletes everything
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make run-destructive
# or one module
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make run-destructive ONLY=LO03
```

The runner is invoked from source (`bun harness/src/run.ts`), because
`harness/dist/pvlab` is built for linux-x64. Direct (5432) in LO05 needs an
IPv6-capable vantage: without the IPv4 add-on the host resolves to AAAA only.
If it never answers, LO05 drops that column and records the error instead of
failing the run.

## Findings

See `RUNLOG.md`.
