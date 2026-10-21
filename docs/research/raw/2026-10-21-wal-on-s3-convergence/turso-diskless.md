# Turso Cloud diskless / WAL-on-S3: raw notes (public sources)

Collected 2026-10-21. Every quote below was fetched from the URL that precedes it,
by curl + HTML-to-text, the Turso docs `.md` endpoint, `gh api`, or WebFetch, unless
marked otherwise. Verbatim quotes are in quotation marks; anything outside quotes is a
paraphrase or an inference and is labelled as such. Smart punctuation inside quotes has
been folded to ASCII (em dash -> "-", curly quotes -> straight); wording is unchanged.

## 0. Provenance of the phrase "diskless, WAL-on-S3"

https://turso.tech/blog/turso-is-joining-supabase (Glauber Costa, dated Oct 2, 2026)

> "We rewrote it from the ground up as open source, lifted its core limitations for
> server workloads like concurrent writes, and delivered it through a cloud service
> built on a diskless, WAL-on-S3 architecture. The result is databases that can be
> provisioned on demand, per agent, at a fraction of the traditional cost, both in our
> cloud and on your own through BYOC."

> "Turso keeps running. Your databases, APIs, and workflows continue as they do today."

> "Open source stays open. Turso Database remains open source and actively developed."

Note: the post is dated 2026-10-02 on turso.tech; press coverage also dates the
announcement 2026-10-02.

## 1. Turso Cloud storage architecture

### 1a. Launch post: "Turso Cloud Goes Diskless" (Apr 7, 2025, Glauber Costa)

https://turso.tech/blog/turso-cloud-goes-diskless

Previous architecture (async backup, not diskless):

> "We've been storing backups on S3 for a long time. But writes to the database were
> returned to the client right away, with backups done asynchronously. The common wisdom
> is that writing to S3 before acknowledging the write to the client is both unacceptably
> slow and expensive. This means that despite the S3 component, our architecture was not
> diskless: there was a period when writes were not really durable anywhere except the
> local disk."

> "A truly diskless architecture means that database compute nodes behave how Kubernetes
> expects: they can be moved anywhere, at any time, and the data can always be retrieved
> from S3."

S3 Standard numbers they measured (from us-east-1 EC2, 1000 ops; table flattened by
text extraction, columns avg / p95 / p99 ms):

> Download 4kB 19 / 23 / 42; Download 128kB 24 / 33 / 46; Download 512kB 25 / 34 / 48;
> Upload 4kB 31 / 60 / 102; Upload 128kB 53 / 124 / 199; Upload 512kB 83 / 176 / 233

(Column split of the flattened text "Download 4kB192342" etc. is my reading; the same
split is consistent across all rows.)

S3 Express One Zone, same AZ (avg / p95 / p99 ms):

> Download 4kB 3.8 / 4 / 4; Download 128kB 4.3 / 5 / 6; Download 512kB 5.5 / 6 / 7;
> Upload 4kB 6.4 / 7 / 7; Upload 128kB 5.5 / 7 / 7; Upload 512kB 7.5 / 8 / 10

S3 Express One Zone, different AZ same region:

> Download 4kB 4.4 / 5 / 5; Download 128kB 4.9 / 6 / 6; Download 512kB 6.1 / 7 / 8;
> Upload 4kB 7 / 8 / 8; Upload 128kB 6.2 / 7 / 8; Upload 512kB 7.7 / 9 / 10

> "S3 Express comes with some limitations. For starters, it's not available in all regions
> yet. Also, as the name suggests, it's not replicated to multiple availability zones. Data
> durability is still guaranteed to be 99.999999999% (that's 11 9s) by AWS SLAs, but the
> uptime SLA is that of a single availability zone, which according to AWS is 99.95%."

> "even with a local disk, data isn't really durable until you call the fsync system call,
> which can cost around ~2ms. This means S3 Express is only adding about 4ms in the 4kB
> case-perfectly acceptable for most traditional SQL workloads."

Batching across tenants:

> "our server is a massive multitenant system designed to host millions of SQLite files per
> node. Of course, to get to millions, most databases would have to be inactive. But even if
> we host 100 very active SQLite databases per node, we can batch writes for all active
> databases."

> "We may wait a couple of extra milliseconds even when we could start a new upload to S3
> Express right away. This gives us the chance to accumulate transactions for a large number
> of databases."

Read path / local disk:

> "The data still resides on local media-there's no need to run the system without any
> disks, just without any local state that marries the compute nodes to the local disk. The
> local disk becomes a write-through cache. Once data is on S3 Express, we also write it
> locally."

> "If a pod needs to be replaced, you can stream the data from S3 into the new pod and switch
> when ready. If a pod suddenly dies, another one can be brought in immediately and start
> reading directly from S3. This isn't fast, but in disaster scenarios, you'd have to restore
> from a backup anyway. With a diskless architecture, you don't lose availability: the data
> can be served immediately from the new pod, at the expense of higher latencies while a
> background recovery process executes."

Multi-AZ (future, not shipped per this post):

> "For those who need more, it's always possible to write data to multiple availability
> zones, which is something we consider doing in the future."

Checkpoint to S3 Standard:

> "Every couple of minutes, the database's write-ahead-log (the most recent changes) is
> folded back into the database file in a process call checkpointing. The end result of that
> is then moved to S3, where it is now highly available. Because S3 storage is relatively
> cheap, there is no need to delete the old version of the database when uploading new
> ones."

### 1b. "How does Turso Cloud keep your data durable and safe?" (May 20, 2025, Glauber Costa)

https://turso.tech/blog/how-does-the-turso-cloud-keep-your-data-durable-and-safe

Most detailed public description of the object layout.

> "All data on Turso Cloud is durable on either S3, or S3 Express. The local storage on the
> server acts as a cache, making sure that they are served with both low latency and low
> cost. Each database region has its own S3 bucket, guaranteeing that data doesn't leave the
> jurisdiction where the compute takes place."

> "The Turso Cloud never has a full, one-piece copy of the database file for reasons which
> will become clear later. Instead, the database file is split into 128kB segments. The
> collection of all the segments that comprise a database file is called a generation."

> "When that database is moved to a new compute node in the Turso Cloud, or replicated to a
> physical server or device, it is not necessary to download the entire database before
> queries can be served: only the segments that are needed to serve the next query need to
> be brought to the local media. The rest can be lazily fetched, or not at all."

> "For example, we may limit a specific user to 1GB of local storage, meaning 1GB will be
> available locally, while the rest is evicted, and brought back from S3 on-demand."

> "All writes that have happened since the last generation, in other words, the most recent
> WAL, are sent to S3 Express, which has a write latency of a single-digit milliseconds.
> Only after the data is safely stored in S3 Express, is the transaction acknowledged to the
> user."

> "The entire WAL has to be present on the local storage of the server in order for any
> query to be serviced. Because of that, the Turso Cloud servers will checkpoint often,
> usually after each 1MB written, although the exact point depends on the specifics of the
> write pattern."

> "In those scenarios, as soon as the database is accessed, the latest WAL is brought back
> from S3 Express, and the database segments are lazily fetched from S3."

PITR and branching fall out of the layout:

> "All we need to do is find the latest generation before the specific timestamp we want to
> restore to, the WAL fragments written after that generation up to the specific timestamp,
> and the database can then be restored to that point."

> "The generations belonging to a database now become shared between databases, including
> the WAL fragments. This is a metadata-only operation, and no data copying occurs. That
> means that branching is instantaneous."

> "we can offer a service where users can create unlimited databases that come online in
> milliseconds"

So, per this post: S3 Express holds WAL fragments (everything since the last generation);
S3 Standard holds the database file as 128 kB segments grouped into generations;
new generations reuse unchanged segments.

### 1c. Durability Guarantees docs page

https://docs.turso.tech/cloud/durability (fetched as https://docs.turso.tech/cloud/durability.md)

> "The following are the durability guarantees provided by the Turso Cloud platform for
> users who registered or upgraded **after March 17, 2025**:"

| Plan | Durability | Added commit latency |
| - | - | - |
| Free | 99.999999999% | up to 100ms |
| Developer | 99.999999999% | up to 50ms |
| Scaler | 99.999999999% | up to 25ms |
| Pro and above | 99.999999999% | up to 10ms |

> "For all Turso AWS regions, we employ a diskless architecture where data is backed by a
> combination of S3-Express One Zone and S3."

> "Commits are only acknowledged once data is safely stored in either S3 or S3-express.
> Compute nodes can come and go at any time, and local disks act as a local cache."

> "Pro and Enterprise customers can use their own S3 / S3-express buckets, guaranteeing that
> data lives inside their infrastructure. In our future roadmap, compute will also be
> runnable inside your account, for a full BYOC solution"

> "New commits to the database that are sent to the Turso Cloud are stored in S3-express One
> Zone before they are acknowledged to the application. Periodically, the data is folded back
> into the main database file and stored on S3."

> "Due to Turso Cloud's multi-tenant architecture, commits are batched across many databases
> to amortize this cost. Furthermore, commits are also batched in time, that is the added
> commit latency as described in Table 1."

> "The commit latency is not the expected latency in every commit, but the ceiling of added
> latency in each commit."

Worked example (mermaid in the page), verbatim bullets:

> "The first commit (c1) to database d1 that happens at the beginning of the 10ms commit
> window must wait the full 10ms"
> "The commit (c1) to database d2 that happens 4ms into the window only waits the remaining
> 6ms"
> "The second commit (c2) to database d1 that arrives exactly at the end of the commit window
> has no added latency"

> "In addition to our simulator, we rely on Antithesis full-system Deterministic Simulation
> Hypervisor to test the interaction of the system with external components, like AWS S3
> and S3-Express One Zone."

### 1d. AWS Storage Blog case study (23 Jul 2026; Glauber Costa, Arushi Garg, Mateo Martinez)

https://aws.amazon.com/blogs/storage/how-turso-built-a-transactional-database-using-amazon-s3-express-one-zone/

> "By replacing local disk with Amazon S3 Express One Zone as the durability layer, Turso
> achieved durable transactional writes at 6.4 milliseconds average latency"

> "Turso found fsync took approximately 2 milliseconds in their environment."

> "Turso's architecture uses S3 Express One Zone as the source of truth for all committed
> transactions, with local NVMe storage serving as a cache for read performance."

Write path (numbered steps in the post):

> "The platform waits a few milliseconds to batch WAL entries from multiple databases on the
> same node."
> "The batched WAL entries are uploaded to S3 Express One Zone using a single S3 PUT
> request."
> "After the PUT request returns a successful response, confirming the data is durably
> stored, the transactions are acknowledged to the clients."
> "The data is also written to local NVMe storage for fast subsequent reads."

Read path:

> "The application reads from the local NVMe cache, avoiding the latency and cost of an S3
> request for data that already lives on local NVMe."
> "On a cache miss, data is fetched from S3 Express One Zone (single-digit millisecond
> latency)."
> "Fetched data is cached on local NVMe for future reads."

> "Every few minutes, the WAL is folded into the full database file through a checkpointing
> process. The resulting database file is then stored in S3 Standard for the long-term,
> benefiting from availability and durability across multiple Availability Zones."

> "Because S3 Standard has a lower storage cost and supports retaining previous versions
> using S3 Versioning, these checkpoints are retained at minimal additional cost."

> "If a pod fails, a replacement pod starts serving reads immediately from S3 Express One
> Zone while streaming data into its local cache in the background."

> "Even if the entire compute tier is lost, the database can be reconstructed from Amazon
> S3."

Discrepancies between sources (noted, not resolved):
- Checkpoint cadence: "Every couple of minutes" (2025-04 post), "usually after each 1MB
  written" (2025-05 post), "Every few minutes" (2026-07 AWS post).
- Cache-miss source: 2025-05 post says segments are "lazily fetched from S3"; the AWS post
  says "On a cache miss, data is fetched from S3 Express One Zone". Possibly both (WAL from
  Express, checkpointed segments from Standard); not stated.

### 1e. Cold starts and regions

https://turso.tech/blog/turso-aws-out-of-beta (Mar 17, 2025, "Turso Cloud on AWS is now available for everybody")

> "That means that all data is made durable on S3 express for every commit, and the local
> disks act as a cache for fast reads."

> "On our AWS regions, databases never have cold starts. That is made possible by our
> massively multitenant server, where every database is just a SQLite file, and the server
> itself is always up. Our S3-native architecture guarantees that databases can be moved to
> other servers when load increases."

Pre-AWS context, https://turso.tech/blog/a-deep-look-into-our-new-massive-multitenant-architecture (Oct 16, 2024):

> "Once you sign up for Turso, our control plane provisions a small VM for you. ... To keep
> costs under control, if you don't access any of your databases after a while, your VM
> scales to zero."

> "we have developed enough confidence in that server to finally release a version of our
> service that doesn't have any cold starts for anybody, in any situation."

Old scale-to-zero docs page https://docs.turso.tech/features/scale-to-zero now serves the
Turso Cloud index page (fetched 2026-10-21). A web-search snippet (NOT fetched, page gone)
attributed to it: free databases scaled to zero after an hour idle with a wake-up delay of
up to 500 ms. That is Fly-era behaviour; treat as historical and unverified.

Regions, https://turso.tech/blog/turso-cloud-new-regions (Oct 1, 2026):

> "We write the Write-Ahead Log (WAL) to S3 Express One Zone, AWS's low-latency storage
> class, and compact it back into S3 asynchronously."

> "Our choice of S3 Express came with a trade off: it was initially available in only a few
> regions."

> "On September 17, 2026, AWS brought S3 Express One Zone to seven more regions. S3 Express
> now runs in all four of today's new regions, so Turso Cloud can too."

> "Turso Cloud now runs in ten AWS regions across four continents."

Location codes listed: aws-us-east-1, aws-us-east-2, aws-us-west-2, aws-ca-central-1,
aws-sa-east-1, aws-eu-west-1, aws-eu-north-1, aws-ap-south-1, aws-ap-northeast-1,
aws-ap-southeast-2.

> "until today, an app in Sydney reached its database in Tokyo at about 109 ms per round
> trip, and an app in Sao Paulo reached N. Virginia at about 115 ms. In-region, that round
> trip takes about 1 ms (CloudPing medians, September 30, 2026)."

CLI: https://docs.turso.tech/cli/db/locations - `turso db locations`, flag
"`-l`, `--show-latencies` | Display latencies from your current location to each of
Turso's locations".

### 1f. Other docs relevant to tests

https://docs.turso.tech/features/point-in-time-recovery

> "Backups are created automatically at `COMMIT`. Free plan users can restore to any point
> in time within the last 24 hours. Developer, Scaler, and Pro users can restore to any
> point in time within the last 10, 30, or 90 days, respectively."

> "Restoring from a PITR creates a new database."

https://docs.turso.tech/cloud/limitations

> "`journal_mode` | Not supported. Turso Cloud manages journaling internally and does not
> allow changing the journal mode."
> "`busy_timeout` | Not supported. Turso Cloud manages concurrency internally, so setting a
> busy timeout has no effect."

https://docs.turso.tech/turso-cloud

> "Turso databases on Turso Cloud are in early preview - a reflection of how recently the
> offering landed on the platform, not of the engine itself. Create one with
> `turso db create --tursodb`."

https://turso.tech/blog/concurrent-writes-on-turso-cloud (Aug 3, 2026)

> "Available in early preview as of August 3, 2026."
> "During the early preview phase, you have to explicitly enable the feature in your
> dashboard."

This post says nothing about storage. Not found anywhere: whether `--tursodb` databases
on Turso Cloud use the same S3 Express WAL path as libSQL databases. Inference only: the
durability page says "For all Turso AWS regions" and does not distinguish engines.

https://docs.turso.tech/sync/partial (client-side lazy page fetch, embedded sync)

> "The client lazily fetches pages of the database file from the Turso Cloud when a query
> touches data that is not present locally."

## 2. libSQL bottomless (the earlier design)

https://github.com/tursodatabase/libsql/tree/main/bottomless (README fetched via `gh api`)

> "This project implements a virtual write-ahead log (WAL) which continuously backs up the
> data to S3-compatible storage and is able to restore it later."

> "All page writes committed to the database end up being asynchronously replicated to
> S3-compatible storage. On boot, if the main database file is empty, it will be restored
> with data coming from the remote storage. If the database file is newer, it will be
> uploaded to the remote location with a new generation number. If a local WAL file is
> present and detected to be newer than remote data, it will be uploaded as well."

README heading: "## Work in heavy progress". CLI `bottomless-cli` with `ls`, `restore`, `rm`.

Object layout, https://github.com/tursodatabase/libsql/blob/main/bottomless/src/replicator.rs (doc comment):

> "General schema is:
> - `{db-name}-{uuid-v7}` subdirectories:
>   - `.meta` file with database page size and initial WAL checksum.
>   - Series of files `{first-frame-no}-{last-frame-no}.{compression-kind}` containing
>     the batches of frames from which the restore will be made."

Defaults read from env in the same file: `LIBSQL_BOTTOMLESS_BATCH_INTERVAL_SECS` default
15, `LIBSQL_BOTTOMLESS_BATCH_MAX_FRAMES` default 10000, `LIBSQL_BOTTOMLESS_S3_PARALLEL_MAX`
default 32, `LIBSQL_BOTTOMLESS_COMPRESSION` default "zstd". Snapshot objects
`db.raw|db.gz|db.zstd` per generation. Generation id is UUIDv7 (time-sortable), which
backs point-in-time restore by timestamp.

Durability semantics (inference from README + defaults): commit is acknowledged after
local WAL write; S3 upload is asynchronous with a 15-second default batch interval, so the
loss window on node loss is bounded by unflushed frames. This matches the 2025-04 blog's
description of the "previous architecture". Last commits touching `bottomless/` (via
`gh api .../commits?path=bottomless`): 2025-01-23, 2024-12-31, 2024-10-09; repo itself
still active (pushed 2026-10-17).

## 3. Turso engine repo (tursodatabase/turso)

https://github.com/tursodatabase/turso (metadata via `gh api`, 2026-10-21): description
"A SQL database in Rust: SQLite-compatible, now also speaking Postgres (experimental). The
LLVM of databases."; latest release v0.9.0-pre.1 (2026-10-15), v0.8.3 (2026-10-12).

README FAQ, https://github.com/tursodatabase/turso#faq:

> "Yes - Turso powers production applications today at multiple organizations, including
> Turso Cloud ..."
> "That said, we have not yet reached 1.0. The project is under active development, and some
> features are explicitly marked experimental."

> "Rewriting SQLite in Rust started as an unassuming experiment, and due to its incredible
> success, replaces libSQL as our intended direction."

README features: "**`BEGIN CONCURRENT`** for improved write throughput using
multi-version concurrency control (MVCC)." Experimental list includes "**Multi-process WAL
coordination** via the `.tshm` sidecar".

S3 / diskless code: none found. GitHub code search `repo:tursodatabase/turso s3 bucket`
returned 2 unrelated hits (a SQL test file and `core/vdbe/hash_table.rs`);
`"S3 Express"` returned 0. Repo tree has no s3/object-store/bottomless paths.
Conclusion (absence in the public repo as of 2026-10-21; inference about where it lives):
the S3 storage layer is in the closed Turso Cloud server, not in the open-source engine.

Pluggable seams that exist in the open engine:
- `pub trait Wal` and a WAL coordination trait in
  https://github.com/tursodatabase/turso/blob/main/core/storage/wal.rs (methods such as
  `publish_commit`, `find_frame`, `ensure_local_frame_cache_covers`, `backend_name`).
- `pub trait DatabaseStorage` in
  https://github.com/tursodatabase/turso/blob/main/core/storage/database.rs (`read_page`,
  `write_page`, `write_pages`, `sync`, `size`, `truncate`).
- Sync engine with lazy storage:
  https://github.com/tursodatabase/turso/tree/main/sync/engine/src
  (`database_sync_lazy_storage.rs`, `sparse_io.rs`, `wal_session.rs`) backing the
  client-side partial sync feature.

Concurrent writes docs, https://docs.turso.tech/tursodb/concurrent-writes:

> "Turso with default configuration only allows one connection to write at a time. With
> MVCC (Multi-Version Concurrency Control), multiple connections can write simultaneously."
> `PRAGMA journal_mode = 'mvcc';` then `BEGIN CONCURRENT`.

## 4. Comparable designs (brief)

None of the Turso posts above cites these; listed because they are the obvious peers.
Each URL fetched 2026-10-21 via WebFetch (quotes as returned by the fetch tool).

- Cloudflare Durable Objects SQLite storage,
  https://blog.cloudflare.com/sqlite-in-durable-objects/ (Kenton Varda, 2024-09-26):
  "Every time SQLite commits a transaction, SRS will immediately forward the change log to
  five "follower" machines"; ack after "at least three of these followers respond";
  object-storage upload batched "over a period of up to 10 seconds, or up to 16 MB worth";
  PITR "at any point in time in the last 30 days". Durability = quorum of followers, not
  object store, on the commit path.
- Neon, https://neon.com/docs/introduction/architecture-overview: "A transaction is
  considered committed once a quorum of safekeepers has acknowledged the WAL record."
  "Commits do not wait for pages to be written or uploaded." Object storage holds
  long-term history.
- Litestream, https://litestream.io/how-it-works/: "continuously copies write-ahead log
  pages from disk to a replica"; "This asynchronous replication provides disaster
  recovery". v0.5 uses "TXID-based LTX files".
- LiteFS, https://docs.fly.io/litefs/how-it-works: "it does not confirm that writes are
  committed to other nodes before continuing to the next transaction."
- SlateDB, https://slatedb.io/docs/get-started/introduction/: "SlateDB writes all data to
  object storage"; suits workloads that "are tolerant to 50-100ms write latency".

Positioning (inference): Turso Cloud is the only one of these that puts an object store
(S3 Express One Zone) directly on the commit path; D1/DO and Neon use a replicated log
quorum, Litestream/LiteFS/old bottomless replicate asynchronously.

## 5. Client-observable predictions (all inference, derived from the quotes above; none measured)

Setup assumption: client in the same AWS region as the database group; compare against a
read-only round trip on the same connection to subtract network RTT. Thresholds below are
proposed falsification cut-offs, not documented numbers.

1. Commit latency floor and ceiling. write_rtt - read_rtt for a single autocommit INSERT
   should be roughly the S3 Express PUT (6.4 ms avg per the AWS post) plus a batch wait in
   [0, plan ceiling]: up to 100 ms Free, 50 Developer, 25 Scaler, 10 Pro. On Free the
   distribution should look near-uniform over 0-100 ms plus the PUT time if arrivals are
   random relative to a fixed window. Falsifier: Free-plan write-minus-read gap that stays
   close to the PUT time alone.
2. Serial commit throughput per connection. If windows are fixed-length and a client
   issues the next commit right after the previous ack, each commit may land at a window
   start and pay the full window. Prediction: serial autocommit rate on Free bounded near
   1 / (100 ms + PUT), roughly 9 per second; on Pro near 1 / (10 ms + PUT). Falsifier: rate
   independent of plan.
3. Batching inside one transaction. N inserts inside BEGIN..COMMIT pay the window once;
   N autocommits pay it N times. Ratio should approach N for small rows.
4. Ack clustering. Concurrent commits from several connections (or several databases in
   one group, if co-located on a node) should return acks clustered at window ends.
   Measure client-side ack timestamps modulo the window.
5. Client distance does not change the S3 component. The PUT happens server-side in the
   database's region, so (write_rtt - read_rtt) should be the same from a near and a far
   client; only the shared RTT term grows. Falsifier: the write-minus-read gap grows with
   distance.
6. Reads are not on S3 when warm. Warm point reads should cost only network RTT plus
   engine time, with no plan dependence.
7. Idle / cold. AWS-region claim: "databases never have cold starts". Prediction: first
   query after 1 h / 24 h idle on a small DB is about the same as warm latency. On a large
   DB (well over any per-tenant local cache; the docs example is 1GB) a full scan after
   long idle may pay lazy segment fetches (128kB segments; the 4kB GET averages in their
   tables are 3.8 ms for S3 Express and, by my reading of the flattened table, 19 ms for
   S3 Standard). Falsifier for "no cold starts": a consistent extra delay of the order of
   a VM wake (hundreds of ms) on the first trivial query after idle.
8. Creation and branching are metadata-only. `turso db create` and
   `turso db create --from-db` time should be flat regardless of source size (1 MB vs
   1 GB). Falsifier: branch time scales with size.
9. PITR granularity. "Backups are created automatically at COMMIT": restoring with
   `--timestamp` between two commits a few hundred ms apart should include the first and
   exclude the second (timestamp resolution of the API is unverified).
10. Ack implies branchable. A branch created immediately after a write is acknowledged
    should contain that write (both WAL fragments and generations are in S3).
11. Checkpoint visibility. If checkpoints happen "after each 1MB written", a sustained
    write stream may show periodic latency blips every ~1 MB of WAL. Weak prediction.
12. Pragmas. `PRAGMA journal_mode = wal` / `busy_timeout` should be rejected or ignored
    per the limitations page; `PRAGMA journal_mode = 'mvcc'` behaviour on `--tursodb`
    databases is a separate check.
13. Engine parity. Run 1-5 against a libSQL database and a `--tursodb` database in the
    same group; the same commit profile would support (not prove) a shared storage path.

Not testable from a client: single-AZ unavailability, compute-node loss recovery, bucket
layout, BYOC bucket behaviour.

## 6. Not found / open

- Exact batch window per plan (only ceilings are documented) and whether windows are
  fixed-clock or start at first commit.
- Whether `--tursodb` databases on Turso Cloud share the S3 Express WAL path.
- Public code for the Cloud server's S3 layer (none in tursodatabase/turso; libsql only
  has the older async bottomless crate).
- Current cold-read latency numbers on AWS regions; the 500 ms wake-up figure is Fly-era
  and from a removed page.
- Whether S3 Express directory buckets are per-AZ per region and which AZ compute runs in.
- Any Supabase-side technical description beyond the Turso blog sentence.
