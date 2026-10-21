# WAL on object storage: OrioleDB S3 mode and Turso Cloud (2026-10-21)

Question: are OrioleDB's experimental S3 mode and Turso Cloud's "diskless,
WAL-on-S3" storage the same idea arriving from two directions? Raw notes with
verbatim quotes: `raw/2026-10-21-wal-on-s3-convergence/`. Measurements:
`experiments/wal-on-s3` (WS01) and `experiments/orioledb` (OR11).

## The one difference that decides durability

| | OrioleDB S3 mode | Turso Cloud |
|---|---|---|
| Commit acknowledged after | local WAL flush; S3 sync is asynchronous (docs; WS01e measured commit rates within 1.5% of each other with S3 on and off, n = 2) | the WAL write to S3 Express One Zone, batched across databases and in time (Turso durability docs; AWS storage blog, 6.4 ms average 4 KB PUT) |
| What S3 holds | data files at each checkpoint, WAL as whole 16 MB archived segments (WS01a), a lock object (WS01b start errors; raw notes, section 3) | WAL in S3 Express One Zone, the database file in S3 Standard after checkpoints |
| Recovery after losing the node | "the state of the last PostgreSQL checkpoint" (docs); measured: after a crash with no clean shutdown since setup, no restore started in any of three variants (WS01b, WS01c); after a clean stop and start, a restore started only with the lock object deleted and a patched loader, and returned 100,000 of 100,000 rows from before the checkpoint and 0 of 1,000 committed after it (WS01f) | a replacement node serves reads from S3 Express while it warms its cache (AWS storage blog) |
| Local disk | write target for commits and a cache of S3 data; `s3_desired_size` evicts to S3 (WS01d) | write-through cache |
| Status | experimental; ignored in builds without `IS_DEV=1` since beta17 (supabase/postgres builds beta19 without it); on a hosted project running public beta 14, off and not settable by the `postgres` role (OR11) | out of beta on Turso's AWS regions (https://turso.tech/blog/turso-aws-out-of-beta) |

Both put the write-ahead log in S3 and treat local disk as a cache, which is
the resemblance. They differ on whether a commit waits for S3: Turso's does,
OrioleDB's does not. That makes Turso's S3 copy the durable record, and
OrioleDB's a lagging backup: the one restore that started returned the
checkpoint and 0 of 1,000 rows committed after it (WS01f, no WAL switch). The
loader replays no archived WAL (loader source at beta19), and the one
research-rig probe that archived late rows lost them too (raw notes, section
7, n = 1, unpublished); the archived-segment case in WS01c never restored. A
GitHub code search of tursodatabase/turso on 2026-10-21 found no S3 storage
code; the S3 path is presumably in Turso's hosted service (inference).

## Not settled

- Turso's commit latency and cold reads were not measured: the lab's Turso
  account could not create a group or write on its plan (operator note).
