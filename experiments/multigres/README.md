# multigres

Failover window and acknowledged-but-lost commits when the primary of a
Multigres OSS cluster is killed under a write load, plus the pooler-semantics
feature matrix re-run through the Multigres gateway. Local: one Docker
container, no cloud resources, no OpenTofu state.

Sources for the claims under test (public):
https://supabase.com/blog/multigres-v0-1-alpha (2026-06-04) and
https://github.com/multigres/multigres/releases/tag/v0.1.0.

## What runs

The upstream repository ships an all-in-one image (`Dockerfile.cluster`,
`docker-compose.yml`): one container that runs etcd, multiadmin and, per cell,
pgctld + postgres, multipooler, multiorch and multigateway as child processes,
started by the `local` provisioner. The `v0.1.0` tag predates that Dockerfile,
so the Makefile builds a pinned commit of `main` instead (`MULTIGRES_REF`).
This is not the Kubernetes operator deployment the blog describes; it is the
same Multigres binaries under a different supervisor. See RUNLOG.md for what
that changes.

Three cells (the shard needs 2 poolers to elect a leader; 3 survives losing
one), each with its own postgres, multipooler, multiorch and multigateway.
Faults are delivered with `docker exec kill`.

## Modules

| id | claim |
|---|---|
| MG01 | read-only: versions, durability setting (`synchronous_standby_names`), primary cell, what the gateway shows a client |
| MG02 | SIGKILL the primary's postgres under 8 closed-loop writers: ack stall, orchestrator timeline, acknowledged-but-lost count (3 runs) |
| MG03 | SIGKILL postgres + multipooler + pgctld of the primary's cell (pod-loss shape); each run on a fresh container (3 runs) |
| MG04 | SIGSTOP the primary's cell for 45 s, then SIGCONT: hung primary, stale primary returning (2 runs) |
| MG05 | pgbench as the load: single run simple protocol, single run `-M prepared`, relaunch loop; its `-l` log is the commit log |
| MG06 | S01 feature matrix through the zone1 and zone2 gateways, with the direct primary as control |
| MG07 | per-user pools: which role the postgres backend runs as |
| MG08 | one standby SIGSTOPped for 20 s to lag, then primary + current standby SIGKILLed: does the orchestrator promote the stale node (3 runs) |
| MG09 | MG02's fault with one 10 writes/s client: does idle traffic change detection time (3 runs) |

## Run

Needs Docker, `bun`, `pgbench` on PATH.

```bash
make build            # clone the pinned commit into .src/, build multigres-cluster:local (several minutes)
make up               # 3-cell container, healthy about 20 s after start
make run              # MG01,MG06,MG07 then MG02..MG05,MG08,MG09 --destructive (about 16 min)
make down
```

`CONTAINER`, `IMAGE` and `REPS` (runs per module) are Makefile variables. The
tests read the same values as `PVLAB_ENDPOINT_CONTAINER`, `_IMAGE`, `_REPS`
and `_GATEWAY` (host:port of the zone1 gateway). They run from source
(`bun harness/src/run.ts`): the compiled `pvlab` targets linux-x64.
`make test` runs the unit tests of the commit-log analysis.

The tests recreate the container themselves (`docker rm -f`, `docker run`)
when a fault leaves it degraded, so `make up` is only needed for the first
run. Output goes to `evidence/<ts>/` (gitignored).
