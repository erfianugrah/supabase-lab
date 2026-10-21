# wal-on-s3

Write-ahead logs and data on object storage. Two designs share the phrase and
differ on the one thing that matters for durability, which is whether a commit
waits for the object store:

- OrioleDB's experimental S3 mode (decoupled storage): table data synced to S3
  at checkpoint, WAL archived to S3 per segment, local disk as a cache
  (https://orioledb.com/docs/usage/decoupled-storage).
- Turso Cloud's "diskless, WAL-on-S3" storage: commits acknowledged after an
  S3 Express One Zone write, batched in time
  (https://turso.tech/blog/how-does-the-turso-cloud-keep-your-data-durable-and-safe,
  https://docs.turso.tech/cloud/durability).

This experiment measures the OrioleDB side on a local rig. The Turso side is
documented in `docs/research/raw/2026-10-21-wal-on-s3-convergence/` and not
measured here (see "Not covered"). A hosted OrioleDB project's S3-mode settings
are read by `experiments/orioledb` OR11.

## Rig

`lib/rig.ts`: Docker only, on a private network `ws3`.

| piece | image | notes |
|---|---|---|
| OrioleDB | `orioledb/orioledb:beta19-pg17` (PostgreSQL 17.11, OrioleDB beta 19) | the public images are built with `IS_DEV=1`, which S3 mode needs since beta17 |
| S3 server | `rustfs/rustfs:1.0.3` | on 2026-10-21 MinIO images could not be pulled from Docker Hub without a login, and quay.io answered `unauthorized` |
| client | `amazon/aws-cli` | bucket listings |
| restore | `orioledb_s3_loader.py` at tag beta19, fetched into `evidence/tools/` at run time (third-party, not committed) | run inside the OrioleDB image with `py3-boto3` and `testgres` |

S3 mode is fixed when the cluster is initialised: a cluster initialised with
it off refuses to start with it on, so every case starts its cluster in S3
mode from the first boot. The S3 credentials are throwaway values for a
server reachable only on the private network.

## Modules

| id | what |
|---|---|
| WS01a | bucket contents after the first CHECKPOINT, CHECKPOINT time, whether the checkpoint is listed when CHECKPOINT returns |
| WS01b | 1,000 rows committed after the last checkpoint, then the instance and its disk destroyed; restore with the upstream loader and start: as documented, with the dead instance's lock copied in, with that lock deleted from the bucket |
| WS01c | as WS01b, with `pg_switch_wal()` after the late commits and a wait until that segment is in the bucket |
| WS01d | `orioledb.s3_desired_size = 20MB` on 50,000 rows of 2,500 B: local size after eviction, point reads cold then repeated, three full counts |
| WS01e | commit latency: pgbench single-row INSERT, 4 clients, 15 s, S3 mode on against off |
| WS01f | as WS01b with a clean stop and start after the checkpoint, and a fourth restore with a copy of the loader carrying the one-line fix from upstream PR #1271 (labelled patched) |

## Run

```bash
make -C experiments/wal-on-s3 probe ONLY=WS01   # 13 to 25 min, Docker only
make -C experiments/wal-on-s3 clean             # ws3-* containers, volumes, network
make -C experiments/wal-on-s3 publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

## Not covered

- Turso Cloud measurements. The lab's Turso account could not create a group
  or write on its plan (operator note); the client-side predictions are
  listed in the research notes.
- Real S3 latency and cost: RustFS runs on the same machine.
- A restore after a clean stop with no commits after it (upstream's
  `test_s3_data_dir_load` covers it); replicas on one bucket; PostgreSQL 18.
- Anything on a hosted project beyond the settings OR11 reads.

Results: `RUNLOG.md`.
