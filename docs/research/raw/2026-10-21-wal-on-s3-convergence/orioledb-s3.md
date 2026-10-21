# OrioleDB experimental S3 mode - raw notes (2026-10-21)

Public sources only. Code citations pinned to orioledb/orioledb main
`75221ec1f22afcb19361dc338db6ae4a79d9614b` (2026-10-20) unless stated; latest
release tag `beta19` = `95f047d2d9696be360b5e70e1958a4861c36ddf1` (2026-10-01).
Base URL for code: https://github.com/orioledb/orioledb/blob/75221ec1f22afcb19361dc338db6ae4a79d9614b/

## 1. Docs: what S3 mode is

Source: https://www.orioledb.com/docs/usage/decoupled-storage
(repo copy: https://github.com/orioledb/orioledb/blob/75221ec1f22afcb19361dc338db6ae4a79d9614b/doc/usage/decoupled-storage.mdx)

> This feature is currently experimental and should be used with caution.

> S3 mode is an experimental feature available only in development builds ( IS_DEV=1 ). On production builds orioledb.s3_mode can't be turned on.

> Local storage implements caching of the data most often accessed. Also, it ensures that adding and updating data will be done at the speed of writing to local storage, rather than the S3 transfer rate. Data are synced with S3 asynchronously. However, all requirements of data integrity are ensured for all the data on S3 storage as well. So you can re-connect to the S3 bucket by another empty PostgreSQL instance (initialized with the utility described below) with the OrioleDB extension configured to use S3 with this bucket and get back all the data from S3 in the state of the last PostgreSQL checkpoint.

GUCs listed by the doc: `orioledb.s3_mode`, `archive_library = 'orioledb'`,
`archive_mode = on`, `orioledb.s3_region`, `orioledb.s3_host` ("without https://
prefix"), `orioledb.s3_prefix` ("may contain bucket name if it is not in
endpoint"), `orioledb.s3_use_https` (default on), `orioledb.s3_accesskey`,
`orioledb.s3_secretkey`, `orioledb.s3_num_workers` ("20 - is a recommended
value"), `orioledb.s3_desired_size`, `max_worker_processes`.

> orioledb.s3_desired_size -- This parameter defines the total desired size of OrioleDB tables on the local storage. Once this limit is exceeded, OrioleDB's background workers will begin evicting local data to the S3 bucket. [...] Effective support for this limit requires a filesystem that supports sparse files.

> In S3 mode, all tables and materialized views are incrementally synchronized with S3, meaning only modified blocks are uploaded to the S3 bucket. However, for tables and materialized views not created with using orioledb, OrioleDB's background workers will compute file checksums during each checkpoint.

> Only one database instance can connect to the same S3 bucket. During startup a database instance checks if another instance already is connected to the S3 bucket and if the bucket is compatible. Otherwise the instance will fail to start.

> While OrioleDB tables and materialized views are stored incrementally in the S3 bucket, the history is kept forever. There is currently no mechanism to safely remove the old data.
> In the primary/replica setup, each should have a separate S3 bucket.

Loader section (same page):

> The S3 loader utility allows getting data from the S3 bucket to any local machine into the specified directory. To use it you need to install boto3 and testgres
> `AWS_ACCESS_KEY_ID=<your access key> AWS_SECRET_ACCESS_KEY='<your secret key>' AWS_DEFAULT_REGION=<your region> python orioledb_s3_loader.py --endpoint=https://<your-bucket-endpoint> --data-dir='orioledb_data' --verbose`

## 2. Code: the IS_DEV gate

`src/orioledb.c` (orioledb_enable_s3_check_hook, ~L541-553):

```c
static bool
orioledb_enable_s3_check_hook(bool *newval, void **extra, GucSource source)
{
#ifndef IS_DEV
	if (*newval)
	{
		ereport(WARNING,
				errmsg("orioledb.s3_mode is only available in development builds (IS_DEV=1), ignoring"));
		*newval = false;
	}
#endif
	return true;
}
```

Introduced by commit 60b7e631 (2026-09-02) "Disable s3_mode and enable_rewind in
production builds": "Both orioledb.s3_mode and orioledb.enable_rewind are
experimental features. In production builds (without IS_DEV=1) these values are
ignored with a WARNING in the log."
https://github.com/orioledb/orioledb/commit/60b7e6310ed69d7684f2f8e5c283e9e99de8d30f
`git tag --contains 60b7e631` -> beta17, beta18, beta19 (+ nightlies).

GUC definitions (`src/orioledb.c` ~L1147-1250): `orioledb.s3_mode` bool default
false PGC_POSTMASTER; `s3_queue_size` default 1024 kB; `s3_headers_buffers`
1024 kB; `s3_num_workers` default 3; `s3_desired_size` default 10000 (MB),
PGC_SIGHUP; `s3_host`, `s3_region`, `s3_prefix` PGC_POSTMASTER;
`s3_use_https` default true. Tests also set `orioledb.s3_cainfo` (CA file for
https endpoints; not in the usage doc).

Build: `Makefile` L9 `SHLIB_LINK += -lzstd -lcurl -lssl -lcrypto` - libcurl and
the S3 code (`src/s3/*.o`, Makefile L64-71) are always compiled in; only the
`-DIS_DEV` define (Makefile L308-309) decides whether s3_mode can be enabled.

## 3. Code: what goes to S3, and when

Files: `src/s3/{archive,checkpoint,checksum,control,headers,queue,requests,worker}.c`.

**OrioleDB table data at checkpoint.** `src/checkpoint/checkpoint.c` L2211-2212,
at the end of the OrioleDB checkpoint:

```c
	if (orioledb_s3_mode)
		s3_perform_backup(flags, maxLocation);
```

`src/s3/checkpoint.c` `s3_perform_backup()` (L233-321) scans the data directory
(base backup style, exclusion list copied from basebackup), schedules file
writes to the S3 worker queue, flushes "small files" packed together, then
uploads `file_checksums` / `small_file_checksums` and waits
(`s3_queue_wait_for_location`). Non-OrioleDB files are uploaded only when
changed (release note beta6 "1807be3 feature: Put into S3 unchanged PostgreSQL
files only"). Undo files in the checkpoint range are also uploaded
(checkpoint.c ~L2008-2020 `s3_schedule_undo_file_write`).

In S3 mode OrioleDB data files are named per checkpoint
(`src/btree/io.c` btree_filename: `"%s/%u-%u", db_prefix, relnode, chkpNum`), so
each checkpoint writes new objects instead of overwriting; this is the "history
kept forever" in the doc. Observed bucket layout (see section 7):
`data/<chkpNum>/...` (Postgres files), `orioledb_data/<chkpNum>/<db>/<relnode>...`,
`wal/<segment>`, `data/orioledb_data/control`, `data/orioledb_data/s3_lock`.

**WAL.** `src/s3/archive.c` is a Postgres archive module
(`_PG_archive_module_init`), so WAL goes up per completed 16 MB segment through
the normal archiver:

```c
/*
 * We only allow S3 archiving if we're in S3 mode.
 */
static bool
s3_archive_configured(ArchiveModuleState *state)
{
	return orioledb_s3_mode;
}
```

`s3_archive_file()` schedules `s3_schedule_wal_file_write(file)` and blocks the
archiver on `s3_queue_wait_for_location(location)`. It also uses an
`archive_preload_file_cb` callback, which is from OrioleDB's patched Postgres
(not stock PG).

**Checkpoint waits for the WAL segment that holds the checkpoint record.**
`src/checkpoint/checkpoint.c` `o_after_checkpoint_cleanup_hook()` L2420-2480:

```c
		/*
		 * Wait till archiver finishes with the checkpoint record.
		 */
		switchpoint = RequestXLogSwitch(false);
		XLByteToPrevSeg(switchpoint, xlogsegno, wal_segment_size);
		XLogFileName(xlogfilename, 1,
					 xlogsegno, wal_segment_size);
		while (!check_archive_done(xlogfilename))
		{
			pg_usleep(100000L);
		}
	...
	location = s3_schedule_file_write(chkpNum, XLOG_CONTROL_FILE, false);
	...
	location = s3_schedule_file_write(chkpNum, CONTROL_FILENAME, false);
	...
	location = s3_schedule_root_file_write(CONTROL_FILENAME, false);
	...
	s3_queue_wait_for_location(maxLocation);
```

(added in df9e21b, 2024-03-04, "On checkpoint wait till corresponding WAL
archived into S3", https://github.com/orioledb/orioledb/commit/df9e21b3).
So each checkpoint = forced WAL switch + archived segment + pg_control and
OrioleDB control uploaded last; the root `data/orioledb_data/control` object
marks the newest complete checkpoint.

**Commit durability.** No code path makes a commit wait on S3: commits are
local WAL flushes; WAL reaches S3 only when the archiver ships a full (or
switched) segment; table data reaches S3 only at checkpoint. Doc: "Data are
synced with S3 asynchronously". (Inference from the code read: S3 lag for WAL is
bounded by segment fill time / `archive_timeout` / checkpoint interval; for
table data by checkpoint interval.)

**Eviction (`s3_desired_size`).** `src/workers/bgwriter.c` L226-227 calls
`s3_headers_try_eviction_cycle()` on every bgwriter loop in S3 mode.
`src/s3/headers.c` L1323-1333:

```c
void
s3_headers_try_eviction_cycle(void)
{
	uint64		desiredNumParts = (uint64) s3_desired_size * (uint64) (1024 * 1024) / (uint64) ORIOLEDB_S3_PART_SIZE;
	...
	if (pg_atomic_read_u64(&meta->numberOfLoadedParts) < desiredNumParts)
		return;

	iterate_files(eviction_callback);
}
```

`ORIOLEDB_S3_PART_SIZE (1024 * 1024)` (include/orioledb.h L128): local cache is
tracked in 1 MB parts with states NotLoaded / Loading / Loaded / Evicting
(include/s3/headers.h L26-29). Evicted ranges are hole-punched
(`src/btree/io.c` ~L880-895: `fallocate(FALLOC_FL_PUNCH_HOLE|FALLOC_FL_KEEP_SIZE)`
on Linux, `F_PUNCHHOLE` on macOS), hence the sparse-file requirement.

**Cold read.** `src/s3/headers.c` `s3_header_lock_part()` ~L670-700: if a
part's status is NotLoaded the backend calls
`s3_load_file_part(...)` (`src/s3/worker.c` L903-911), which schedules a read
for an S3 worker and blocks in `s3_queue_wait_for_location()` - the reading
backend waits synchronously on a 1 MB-part GET.

**Bucket lock.** `src/s3/control.c` `s3_put_lock_file()` L141-260: writes
`data/orioledb_data/s3_lock` with a conditional PUT (`s3_put_file(objectname,
LOCK_FILENAME, true)`; tests patch moto for `If-None-Match`). On conflict:

> FATAL: A lock file from a different OrioleDB instance already exists on the S3 bucket

The lock is deleted on clean shutdown (`src/orioledb.c` L1738
`s3_delete_lock_file()`). `s3_check_control()` (control.c L40-135) then
compares local vs bucket control file identifier, last checkpoint number and
`sysTreesStartPtr` and refuses to start if the local instance is behind the
bucket. The S3-mode flag is also stored in the control file
(`src/checkpoint/control.c` L121-127: mismatch between `control->s3Mode` and
the GUC is an error).

## 4. Restore: orioledb_s3_loader.py

https://github.com/orioledb/orioledb/blob/75221ec1f22afcb19361dc338db6ae4a79d9614b/orioledb_s3_loader.py

`run()` (L117-151):
1. `last_checkpoint_number()` - newest `data/<n>/` that has both
   `global/pg_control` and `orioledb_data/control`.
2. Download `data/<n>/...` (Postgres files) and from `orioledb_data/<n>/` only
   the `.map` files (`filter_orioledb` returns `is_map`). Table data parts are
   NOT downloaded; they are fetched lazily on first read (cold-read path).
3. Walk back through earlier checkpoints for unchanged files
   (`file_checksums`, `small_file_checksums`).
4. Download undo ranges from the OrioleDB control file.
5. Download exactly one WAL file:
   ```python
   wal_file = control["Latest checkpoint's REDO WAL file"]
   ...
   wal_file = os.path.join(self.prefix, f"wal/{wal_file}")
   self.download_file(self.bucket_name, wal_file, local_path)
   ```
No `restore_command` is configured; nothing in `src/` references
`restore_command`. Result = state of the last checkpoint uploaded to S3, not
last-checkpoint-plus-archived-WAL (confirmed in section 7).

Loader bug present on main and beta19 (L482): when unchanged small files must
be fetched from more than one checkpoint back, it iterates a dict without
`.items()`:

```python
			for filename, checkpoint in file_checksums:
```

-> `ValueError: too many values to unpack (expected 2)` (reproduced in
section 7 on a 3-checkpoint bucket; the sibling function at L385 uses
`.items()` correctly). A fix was proposed in
https://github.com/orioledb/orioledb/pull/1271 (closed unmerged 2026-10-01).

## 5. Status, releases, issues

Releases (gh api repos/orioledb/orioledb/releases): beta4 2023-12-13 ... beta16
2026-06-18, beta17 2026-09-04, beta18 2026-09-23, beta19 2026-10-01 (latest,
not marked prerelease). S3 is still described as experimental in the docs and
gated to IS_DEV builds since beta17.

beta4 notes (https://github.com/orioledb/orioledb/releases/tag/beta4):
> The fourth beta release of OrioleDB incorporates the following changes. Along with bug fixes, this release introduces experimental S3 mode.
Commits listed include "61c65e1 Implement S3 WAL achiever", "21e7943 Implement
checkpoint of non-OrioleDB files to S3", "1451037 Implement the fleet of S3
workers", "930ab00 Command-line utility for loading data from S3".

beta5 (https://github.com/orioledb/orioledb/releases/tag/beta5): "86e6c6c
orioledb_s3_loader.py load only map files from orioledb_data dir", "cf62758
orioledb_s3_loader now uses last checkpoint only if control files present",
"df9e21b On checkpoint wait till corresponding WAL archived into S3".

beta6 (https://github.com/orioledb/orioledb/releases/tag/beta6): "3a75cb0
feature: Lock S3 bucket on startup (#371)", "fa95eb7 Additional S3 parameters:
s3_use_https and s3_prefix", "1807be3 feature: Put into S3 unchanged
PostgreSQL files only".

beta7 .. beta19 release notes: no S3 mentions (grep -c s3 = 0 each). Later
S3 commits on main: 7ab94115 (2026-08-13) "Only declare an S3 part loaded when
the transition is ours to make"; 51e75759 (2026-09-08) "Disable flaky S3 tests
under valgrind (#1128)"; 60b7e631 IS_DEV gate.

Open issues mentioning S3 (gh search issues, 2026-10-21):
- https://github.com/orioledb/orioledb/issues/979 (open) "Transient S3 error crashes postmaster / hard breaks DB on PG18" - S3 worker exit -> "pmchild freelist for backend type 6 is corrupt"; reporter: present on PG18, not PG17.
- https://github.com/orioledb/orioledb/issues/1414 (open, 2026-10-20) "s3_queue_get_task() copies split task bytes in the wrong direction" - memcpy src/dst swapped on ring-buffer wraparound; "The same code is on v1.10".
- https://github.com/orioledb/orioledb/issues/334 (open) "Bloating data and orioledb_data on s3 with cluster start-stops" - 11.8 GB/174K files -> 25 GB/475K files over 16 restarts with no data changes.
- https://github.com/orioledb/orioledb/issues/373 (open) "Checkpointer gets stuck in case of error on S3 workers"
- https://github.com/orioledb/orioledb/issues/315 (open) "Process possible S3 errors"
- https://github.com/orioledb/orioledb/issues/544 (open) "Bug in S3 task queue"
- https://github.com/orioledb/orioledb/issues/283 (open) "Compatibility of clusters with and without s3"
- https://github.com/orioledb/orioledb/issues/350, /351, /355, /356, /377 (open, S3 load/loop/assert bugs)
- https://github.com/orioledb/orioledb/issues/366 (closed) "Minio support" - maintainer comment 2024-06-05 with a working MinIO config:
  ```
  orioledb.s3_num_workers = 20
  orioledb.s3_mode = true
  orioledb.s3_host = '127.0.0.1:9000'
  orioledb.s3_prefix = 'orioledb-test'
  orioledb.s3_use_https = false
  orioledb.s3_region = 'us-east-1'
  orioledb.s3_accesskey = 'XXX'
  orioledb.s3_secretkey = 'YYY'
  ```
- https://github.com/orioledb/orioledb/pull/1271 (closed unmerged) - fixes for #979, PG18 logical decoding, and the loader multi-checkpoint bug; "found while evaluating beta19 (PG 18.6) in S3 mode against MinIO".

## 6. Docker images and tests

Publishing: `.github/workflows/docker.yml` (on release) and `nightly.yml` both
call `.github/workflows/_docker-build-publish.yml`: `REGISTRY_IMAGE:
orioledb/orioledb` (Docker Hub only), matrix `cpu: [amd64, arm64]`, `postgres:
[16, 17, 18]`, `distr: [alpine, ubuntu]`; release tags get suffix `-pg{N}` and
`-ubuntu`; nightlies `pg{N}-nightly` and `pg{N}-nightly-<yyyymmdd>-<sha7>`.
No ghcr image (`ghcr.io/v2/orioledb/orioledb/tags/list` -> NAME_UNKNOWN).

Both Dockerfiles build the extension with IS_DEV=1
(`docker/Dockerfile` L203-206, same in `docker/Dockerfile.ubuntu` L225-228):

```
	# Remove any stale generated SQL files that may have leaked into the
	# build context, so the Makefile regenerates them with IS_DEV=1.
	make USE_PGXS=1 clean; \
	make USE_PGXS=1 IS_DEV=1 -j "$(nproc)"; \
	make USE_PGXS=1 IS_DEV=1 install; \
```

So the public Docker Hub images can enable S3 mode. Verified on
`orioledb/orioledb:beta19-pg17` (digest
sha256:9c90f83e82c3f0000a1d22d1e348461ca133e2f662b894562dc55d6c62f5f3ec, same
as `latest-pg17`): `postgres --version` = "PostgreSQL 17.11 OrioleDB beta 19
PGTAG=patches17_22 alpine:3.21+clang build:2026-10-01T04:58:38+00:00";
`orioledb.so` links `libcurl.so.4`; the dev-only SQL function `s3_put`
(defined only in `sql/orioledb--1.0_dev.sql`) is present in the installed
`orioledb--1.0.sql`; the "only available in development builds" warning string
is absent from the .so (grep count 0). Extension version reported: 1.10.

Docker Hub tags seen (hub.docker.com API, 2026-10-21): `latest-pg16`,
`latest-pg17`, `latest-pg18` (+`-ubuntu`), `beta19-pg16/17/18` (+`-ubuntu`),
`pg16/17/18-nightly`, e.g. `pg17-nightly-20261020-75221ec`. Historic
`beta3-s3-pg15/pg16` tags exist (S3 branch builds, pre-beta4).

The default image config (`docker/init/postgresql.docker.conf`) has no
`include_dir`; pass S3 GUCs as `-c` args to `postgres -D /etc/postgresql`.

Tests:
- `test/t/s3_test.py` + `test/t/s3_base_test.py` use moto (in-process
  `MotoServerSSL` on localhost:5001, self-signed cert via `make_ssl_devcert`,
  bucket `test-bucket`, region `us-east-1`; `requirements.txt` pins
  `moto==5.1.22`, `boto3==1.43.0`, `testgres==1.11.0`). Typical config
  (test_s3_data_dir_load):
  ```
  orioledb.s3_mode = true
  orioledb.s3_host = '{host}:{port}/{bucket}'
  orioledb.s3_region = '{region}'
  orioledb.s3_accesskey = '...'
  orioledb.s3_secretkey = '...'
  orioledb.s3_cainfo = '{cert}'
  orioledb.s3_num_workers = 3
  archive_mode = on
  archive_library = 'orioledb'
  ```
  `test_s3_data_eviction` sets `orioledb.s3_desired_size = 20MB`, loads 20000
  rows of 2500 bytes, CHECKPOINTs, waits until local data <= 20 MB, then
  counts rows (cold reads) and restarts.
- MinIO: `test/antithesis/config/setup/s3/` (added 37e6ef87, 2026-07-17,
  "antithesis: add configuration for s3/minio"). `postgres.conf`:
  ```
  orioledb.s3_mode = on
  archive_mode = on
  archive_library = orioledb
  orioledb.s3_host = minio:9000
  orioledb.s3_region = us-east-1
  orioledb.s3_prefix = orioledb
  orioledb.s3_use_https = off
  orioledb.s3_accesskey = minio
  orioledb.s3_secretkey = minio-secret
  ```
  `compose.yaml` pins `quay.io/minio/minio@sha256:14cea493...` and
  `quay.io/minio/mc@sha256:a7fe349e...` ("latest as of 2026-07-15"), creates
  bucket `orioledb` with `mc mb --region us-east-1`, and mounts the conf into an
  antithesis-built image that appends `include_dir 'conf.d'`.
  Observed 2026-10-21 from this machine: both quay digests return
  "unauthorized", and `minio/minio` on Docker Hub returns "pull access denied"
  without login. The rig below used RustFS instead.

## 7. Local probe (2026-10-21, n=1, disposable containers)

Setup: `rustfs/rustfs:1.0.3` (S3-compatible, already cached locally) with
`RUSTFS_ACCESS_KEY=minio RUSTFS_SECRET_KEY=minio-secret`, bucket `orioledb`
created with `aws s3 mb`; `orioledb/orioledb:beta19-pg17` started as
`postgres -D /etc/postgresql -c orioledb.s3_mode=on -c archive_mode=on -c
archive_library=orioledb -c orioledb.s3_host=minio:9000 -c
orioledb.s3_prefix=orioledb -c orioledb.s3_use_https=off -c
orioledb.s3_region=us-east-1 -c orioledb.s3_accesskey=minio -c
orioledb.s3_secretkey=minio-secret -c orioledb.s3_num_workers=3 -c
orioledb.s3_desired_size=64`.

Observations:
- Started with "orioledb s3 worker 0..2 started", no IS_DEV warning;
  `SHOW orioledb.s3_mode` = on. The conditional-PUT lock worked on RustFS.
- 200,000 rows x 500 B into an orioledb table + CHECKPOINT -> bucket had
  `data/1/`, `data/2/`, `orioledb_data/<chkp>/...`, `wal/0000000100000000000000{01..08}`,
  `data/orioledb_data/control`, `data/orioledb_data/s3_lock`; 334 objects,
  ~292 MB (mostly 16 MB WAL segments).
- Inserted 100 more rows, `pg_switch_wal()`, clean stop: the shutdown
  checkpoint (#3) was uploaded as `data/3/`, the lock object was removed.
- Restarted, inserted 50 rows, `pg_switch_wal()` (archiver reported segment
  ...0B archived; object `wal/00000001000000000000000B` updated), inserted 10
  more rows (not archived), then `docker kill -s KILL`. Lock object stayed in
  the bucket.
- Loader (stock main/beta19 copy) on that bucket: failed with the L482
  `ValueError`. With the one-line `.items()` fix it completed; restored dir
  38.7 MB (map files only) plus `pg_wal/00000001000000000000000B`.
- Starting a fresh instance on the restored dir with the same GUCs: `FATAL: A
  lock file from a different OrioleDB instance already exists on the S3
  bucket` (stale lock from the killed primary). After `aws s3 rm
  s3://orioledb/data/orioledb_data/s3_lock` it started ("database system was
  shut down at 04:55:22", i.e. no WAL replay) and returned 200,100 rows:
  checkpoint-3 state. The 50 rows in the archived segment and the 10
  unarchived rows were both absent. `count(*)` over the table worked, so lazy
  part loads from S3 worked.

## 8. Supabase relation

Blog https://supabase.com/blog/supabase-acquires-oriole (2024-04-15),
"Decoupled Storage and Compute" section:

> The Oriole storage engine's reduction in disk IO is significant enough that it unlocks performant databases backed by S3 compatible blob storage. We've been working with the Oriole team for a few months to develop experimental support decoupled storage and compute:
> Local storage implements caching of the data most often accessed, ensuring good performance, and then synced with S3 asynchronously. You can connect an empty Postgres instance to an s3 bucket (using an S3 loader utility). The Oriole roadmap includes the ability to connect multiple read-replicas to the same S3 bucket as leader.

supabase/postgres at `1bc542d75e9d0dd3b1f14da25b9cf095f74804ea` (2026-10-20):
- `nix/ext/orioledb.nix` builds `rev = "beta19"` with
  `make USE_PGXS=1 ORIOLEDB_PATCHSET_VERSION=22` - no `IS_DEV=1`
  (https://github.com/supabase/postgres/blob/1bc542d75e9d0dd3b1f14da25b9cf095f74804ea/nix/ext/orioledb.nix).
  curl and openssl are build inputs (S3 code compiles in), but per the
  orioledb.c check hook s3_mode would be ignored with a WARNING in this build.
- `rg 's3_mode|orioledb\.s3|s3_host|archive_library|S3_ENABLED'` over the repo:
  no hits. No orioledb S3 GUCs in its configs.

Supabase CLI (supabase/cli develop `8803a3e90dd1`) still has
`[experimental] s3_host / s3_region / s3_access_key / s3_secret_key` and, when
`db.orioledb_version` is set, passes `S3_ENABLED=true`, `S3_HOST`, `S3_REGION`,
`S3_ACCESS_KEY`, `S3_SECRET_KEY` env to the DB container
(`apps/cli/src/command-internal/db-bootstrap/postgres.service.ts` L172-184).
No consumer of `S3_ENABLED` was found in supabase/postgres or orioledb repos
(gh code search, 2026-10-21) - unresolved; may be a legacy image entrypoint.

## 9. Comparisons made by OrioleDB itself

https://www.orioledb.com/blog/orioledb-neon-differences (2025-06-20):

> OrioleDB can also leverage distributed S3 object storage. In the experimental mode, OrioleDB can automatically evict cold data to S3, synchronize the hot storage with S3 on checkpoint, and archive WAL files to S3. In this mode, local storage acts as a cache for the data stored in S3. In this mode, multiple replicas can connect to the same S3 storage (development is in progress), but their local storage is still necessary. Similarly to Neon, OrioleDB in S3 mode can seamlessly scale to zero when the database has no load.

> Neon was designed around a hard split from day one. A stateless (besides node's shared memory) compute node streams WAL to a quorum of Safekeepers (a replicated log service) and serves reads by pulling 8KB pages from Page servers.

Table in the post: Cold data - OrioleDB "Must fit S3", Neon "Must fit S3";
Hot data - OrioleDB "Must fit local storage with low latency", Neon "Must fit
page servers, network latency for access"; Scale down to zero - Yes / Yes.

No OrioleDB doc or blog mention of Turso/libSQL bottomless found
(`rg -il 'bottomless|turso|libsql'` over `doc/` = no hits).

## 9. Added 2026-10-21 after review (main session)

- PR #1271 diff, `gh pr diff 1271 -R orioledb/orioledb`: the loader hunk is the
  one-line change at `download_unchanged_small_files`
  `for filename, checkpoint in file_checksums:` ->
  `for filename, checkpoint in file_checksums.items():`. PR state CLOSED,
  closedAt 2026-10-01T16:40:30Z, mergedAt null.
- Issue search (gh search issues --repo orioledb/orioledb), 2026-10-21:
  `s3 loader` -> #356 "Failed Assert(\"status == S3PartStatusLoaded\")", #326
  "Test stuck: s3_queue_wait_for_location" (both open, neither about restore);
  `s3 restore missing file` -> none; `s3_lock` -> none. Open #350 "Cluster stuck at stop
  with loop of s3 file don't exist error" and #377 "Loop of s3 workers crashes
  at attempt to get s3 file from checkpoint not yet created" are about a
  running cluster, not a restore.
- Upstream restore test: `test/t/s3_test.py` at tag beta19, `test_s3_data_dir_load`
  (L466-515): CHECKPOINT, `node.stop`, wait for the WAL archive, then load into
  a new node; no writes after the checkpoint, no crash.
