# wal-on-s3 RUNLOG

Published artifacts are in `out/2026-10-21/`. Every cell below names its row
id; values are pasted from the artifacts. Pin citations to the lab commit that
adds this directory.

## 2026-10-21 - WS01 (OrioleDB S3 mode, local rig)

Shape: n = 2 runs of the whole module, run 1 `run-2026-10-21T05-42-10-259Z`
(05:42 to 06:06 UTC) and run 2 `run-2026-10-21T06-06-20-830Z` (06:06 to 06:19
UTC), on one laptop with Docker Desktop. Image `orioledb/orioledb:beta19-pg17`:
`PostgreSQL 17.11 OrioleDB beta 19`, extension version 1.10. S3 server RustFS
1.0.3 on the same Docker network, so S3 latency here is local, not AWS. Each
case starts a new S3 server, bucket and cluster. Both artifacts record lab
commit 02d3083, which predates this directory: the module ran from an
uncommitted tree (the one committed with this RUNLOG), and the `region` field
is the harness default, not part of the rig.

Four earlier runs the same day used earlier versions of the module and are not
published: the first aborted at start (cluster initialised without S3 mode),
and none had WS01f. In the other three, WS01a, WS01b and WS01c gave the same
values and errors as these (the first of them had no lock-deleted restore).
Their WS01e S3-on against S3-off rates were 23945.910095 / 23999.126730,
18880.892944 / 20257.511062 and 24534.809678 / 24720.928501 tps, so one of the
three was 6.8% lower with S3 mode on.

S3 mode is fixed at initialisation. The first module version initialised the
cluster without it and restarted with it on; the server refused:
`FATAL: database files are incompatible with server`, `OrioleDB was
initialized with S3 mode off, but the extension is configure[d with it on]`
(unpublished run, operator note). Every published case starts in S3 mode.

### WS01a - what reaches the bucket at a checkpoint

200,000 rows of about 200 B in one OrioleDB table (`table_bytes_local`
54624256), then `CHECKPOINT`.

| measurement | run 1 | run 2 |
|---|---|---|
| objects after start, before any table | 143 | 143 |
| `CHECKPOINT` time | 921 ms | 867 ms |
| highest checkpoint listed right after `CHECKPOINT` returned | 2 | 2 |
| highest checkpoint listed 10 s later | 2 | 2 |
| objects / bytes 10 s later | 270 / 148206023 | 270 / 148206023 |
| `data/` (Postgres files) | 144 objects, 26053239 B | same |
| `orioledb_data/` (OrioleDB files) | 122 objects, 55043920 B | same |
| `wal/` (archived segments) | 4 objects, 67108864 B | same |

In both runs the first bucket listing after `CHECKPOINT` returned (one
aws-cli container run later) already held objects under checkpoint 2. The
module records only the highest checkpoint number at that listing, not its
object count, so whether the whole checkpoint was there is not measured; the
source has the checkpoint hook wait for its uploads (raw notes, section 3).
WAL goes up as whole 16 MB segments (4 x 16777216 B).

### WS01b, WS01c, WS01f - committed rows after losing the instance and its disk

100,000 rows marked A, `CHECKPOINT`, then 1,000 rows marked B, committed.
The instance is then killed with SIGKILL and its container and volume removed.
Each restore uses the upstream `orioledb_s3_loader.py` at tag beta19 into a
new volume, then starts a server on it with the same S3 settings. WS01c adds
`pg_switch_wal()` after B and waits until that segment is in the bucket.
WS01f stops and starts the server cleanly after the checkpoint, before B.
The restores run in this order on one bucket: as documented, lock copied in,
lock deleted, then (WS01f only) patched; the lock-copied start passed the lock
check before failing, so the lock-deleted attempt followed it.

| restore | WS01b run 1 / run 2 | WS01c run 1 / run 2 | WS01f run 1 / run 2 |
|---|---|---|---|
| as documented | `FATAL: A lock file from a different OrioleDB instance already exists on the S3 bucket` / same | same / same | loader `ValueError: too many values to unpack (expected 2)` / same |
| dead instance's lock copied into the restored directory | `FATAL: could not open file "global/2672": No such file or directory` / same | `ws3-pg2 not ready in 90000 ms` / `could not open file "global/2672"` | loader `ValueError` / same |
| lock object deleted from the bucket | `could not open file "global/2672"` / same | same / same | loader `ValueError` / same |
| lock deleted, loader with the one-line `.items()` fix (patched) | not run | not run | `ready`, A 100000 of 100000, B 0 of 1000 / same |

Other cells: the late segment in WS01c was found at the first listing after
`pg_switch_wal()` returned, 0.5 s later, in both runs
(`late_segment_archived_s`); no WS01c restore
started, so whether its B rows would have come back is not measured.
`bucket_wal_segments_at_loss`: WS01b 3, WS01c 4, WS01f 5, both runs.

What this shows, for this image and rig:

- After a crash, the documented restore does not start: the dead instance's
  lock stays in the bucket, and the new instance carries a different lock
  identifier. Deleting the lock object, an operator step the docs do not
  describe, gets past that check.
- Without a clean shutdown since setup, every restore that reached a start
  failed with `could not open file "global/2672"`. A debug restore (operator
  note, not an artifact) found seven files missing from the restored
  `global/` (`1261`, `2672`, `2695`, `2965`, `4176`, `4183`, `6244`), present
  in the crashed instance's directory, and neither `file_checksums` nor
  `small_file_checksums` listed them; the patched loader was not run on these
  buckets.
- After a clean stop and start, the stock loader fails on that bucket in
  `download_unchanged_small_files` (line 482 at beta19); upstream PR #1271
  proposed the one-line `.items()` fix and was closed unmerged on 2026-10-01
  (https://github.com/orioledb/orioledb/pull/1271). With that one-line fix and the lock deleted, the restore returned the checkpoint
  state: all 100,000 rows from before the checkpoint and none of the 1,000
  committed after it, in both runs.
- The loader fetches the last checkpoint and the one WAL segment its redo
  starts from; nothing configures `restore_command`, so archived WAL past
  that point is not replayed (loader source at beta19). The docs promise "the
  state of the last PostgreSQL checkpoint", and that is what came back when a
  restore worked.

None of the three behaviours (the stale lock after a crash, the files missing
from the bucket, the loader crash) has an open upstream issue as of
2026-10-21 (searched `s3 loader`, `s3 restore missing file`, `s3_lock`); the
loader fix exists only in the closed PR. The open issues #350 ("Cluster stuck at
stop with loop of s3 file don't exist error") and #377 ("Loop of s3 workers
crashes at attempt to get s3 file from checkpoint not yet created") are about
a running cluster, not a restore. Nothing has been
filed.

### WS01d - eviction to S3 and reads after it

`orioledb.s3_desired_size = 20MB`, 50,000 rows of 2,500 B, `CHECKPOINT`, wait
until the local `orioledb_data` directory is at or under 20 MB, restart the
server, then read.

| measurement | run 1 | run 2 |
|---|---|---|
| local `orioledb_data` after the checkpoint, then after eviction | 134416 kB -> 676 kB | 134416 kB -> 700 kB |
| eviction wait | 14 s | 6 s |
| eight point reads after the restart, ms | 17111.1, 125.3, 125.9, 131.2, 122.1, 113.5, 128.0, 1.3 | 15049.6, 91.6, 126.7, 127.0, 127.3, 132.8, 127.1, 0.6 |
| the same eight reads again, ms | 52.0, 0.7, 0.7, 0.6, 0.6, 0.6, 0.6, 0.6 | 108.0, 1.2, 1.2, 1.0, 0.6, 0.6, 0.7, 0.6 |
| full `count(*)`, three in a row, ms | 40541, 12174, 10301 | 43205, 247730, 10962 |
| local kB before each count | 134208, 3036, 134040 | 134280, 3024, 134176 |
| `count(*)` result | 50000 (pass) | 50000 (pass) |

The first read after the restart took 17111.1 ms (run 1) and 15049.6 ms
(run 2); reads two to seven took 113.5 to 131.2 ms (run 1) and 91.6 to 132.8
ms (run 2), and the eighth 1.3 and 0.6 ms. On the second pass, after a first
read of 52.0 and 108.0 ms, reads took 0.6 to 1.2 ms. By the first count the
local `orioledb_data` was back at 134208 and 134280 kB; whether reads two to
seven fetched parts from S3 or read local files was not measured. The full
counts do not separate cold from warm: the local size swung between about
3000 kB and 134000 kB (`du -k`) between counts as data was evicted and loaded
back, and the second count took 12174 ms in run 1 and 247730 ms in run 2 (an
unpublished earlier run also had a 247107 ms second count). Why was not
isolated.

### WS01e - commit latency with S3 mode on and off

pgbench, 4 clients, 15 s, one single-row INSERT per transaction, inside the
container; S3 mode on, then a new cluster with it off.

| | run 1 | run 2 |
|---|---|---|
| S3 mode on | 24186.209406 tps, 0.165 ms average | 23706.629666 tps, 0.169 ms |
| S3 mode off | 24175.451334 tps, 0.165 ms | 24042.922573 tps, 0.166 ms |

The commit rate with S3 mode on was within 1.5% of the rate with it off in
both runs, which fits the docs ("Data are synced with S3 asynchronously"); the
local RustFS PUT latency was not measured, and one of the three earlier runs
was 6.8% lower with S3 mode on.

### Not measured

- Turso Cloud (see README); the contrast in
  `docs/research/2026-10-21-wal-on-s3-convergence.md` rests on Turso's
  published documentation.
- AWS S3 latency, request cost and egress; any region.
- A restore after a clean stop with no commits after it (upstream's
  `test_s3_data_dir_load`); replicas on one bucket; PostgreSQL 18.
- Why the seven catalog files were not uploaded, beyond their absence from
  both checksum lists.

### Cleanup

Each case removes its containers and volumes, and the module removes the S3
server at the end (`make clean` removes anything left). Operator note: a
debug volume `ws3-dbg` and two volumes left by a research rig were removed by
hand afterwards.
