# sqlite-edge-compare: documented facts (read 2026-10-15)

Vendor-documented facts the `sqlite-edge-compare` plan
(`docs/plans/2026-10-15-sqlite-edge-compare.md`) rests on. Every line is a
documented default, not a measurement; the experiment measures what it can.
Pricing figures marked (marketing) were read through a summarizer and get
re-read from the page before any write-up quotes them.

## Turso

- Ownership: Supabase announced it is acquiring Turso on 2026-10-02
  (https://supabase.com/blog/supabase-is-acquiring-turso). Turso's post:
  "The Turso platform continues ... Your databases, APIs, and workflows
  continue as they do today" (https://turso.tech/blog/turso-is-joining-supabase).
- Engines on Turso Cloud: libSQL (the default, "battle-tested in production")
  and the Rust rewrite "Turso", which is "in early preview" and created with
  `turso db create --tursodb` (https://docs.turso.tech/turso-cloud.md). No
  engine field found in the Platform API create body.
- Concurrent writes: Turso-engine MVCC, opt-in via `PRAGMA journal_mode`
  then `BEGIN CONCURRENT`; conflicting transactions get an error and retry
  (https://docs.turso.tech/tursodb/concurrent-writes.md). The TS SDK table
  lists `@libsql/client` concurrent writes as "Not supported"
  (https://docs.turso.tech/sdk/ts/reference.md). Docs disagree on the
  default and on whether `journal_mode` is settable on Cloud: measure.
  Measured 2026-10-16 (sqlite-edge-compare RUNLOG, TD04m1): on Cloud the
  Turso-engine database reports `mvcc` and refuses `PRAGMA journal_mode = wal`.
- Vector: native, `F32_BLOB`, `vector32()`, `libsql_vector_idx()`
  (https://docs.turso.tech/features/ai-and-embeddings.md, written for libSQL).
- Full-text: the Turso engine has a Tantivy-backed `USING fts` index, "not
  SQLite's FTS3/FTS4/FTS5" (https://docs.turso.tech/sql-reference/functions/fts.md);
  libSQL databases are SQLite-compatible, so FTS5 is the comparable path.
- Sync: embedded replicas "fully supported in production", writes go to the
  primary (https://docs.turso.tech/features/embedded-replicas/introduction.md);
  Turso Sync (`@tursodatabase/sync`) recommended for new projects
  (https://docs.turso.tech/sync/usage.md).
- Multi-region edge replicas: deprecated for new users
  (https://docs.turso.tech/features/data-edge.md).
- Platform API (https://docs.turso.tech/api-reference/): base
  `https://api.turso.tech`; `POST /v1/organizations/{org}/groups`
  (`name`, `location`); `POST /v1/organizations/{org}/databases` (`name`,
  `group`); `POST /v1/organizations/{org}/databases/{db}/auth/tokens`
  (`expiration`, `authorization`); `GET /v1/locations`. "Creating more than
  one group is limited to Scaler, Pro and Enterprise plans."
- Locations, live `GET /v1/locations` on 2026-10-15: aws-ap-northeast-1,
  aws-ap-south-1, aws-ap-southeast-2, aws-ca-central-1, aws-eu-north-1,
  aws-eu-west-1, aws-sa-east-1, aws-us-east-1, aws-us-east-2, aws-us-west-2.
  No ap-southeast-1.
- Free plan (https://turso.tech/pricing, re-read 2026-10-15): 100 databases,
  5 GB, 500M rows read and 10M rows written per month. One group below
  Scaler (https://docs.turso.tech/api-reference/groups/create). Not on the
  pricing page, read in the docs bundle https://docs.turso.tech/llms-full.txt
  (source page not pinned): Free databases are archived after 10 days of
  inactivity; Hrana-over-HTTP transactions time out at 5 s and idle
  connections close at 10 s.
- Workers access: `@libsql/client/web` (fetch-based) or
  `@tursodatabase/serverless`; HTTP endpoint `https://<db>-<org>.turso.io/v2/pipeline`
  (https://docs.turso.tech/sdk/ts/reference.md).

## Cloudflare D1

All from https://developers.cloudflare.com/d1/ unless noted.

- Limits (platform/limits): 10 GB per database on Paid, 500 MB on Free,
  "cannot be further increased"; 50,000 databases per account on Paid
  (raisable on request), 10
  on Free; 30 s query duration; 100 bound parameters per query; 2 MB row;
  1000 queries per Worker invocation on Paid, 50 on Free (the Workers limits
  page counts D1 calls as subrequests with a higher ceiling: measure).
- Concurrency: each database "is inherently single-threaded, and processes
  queries one at a time"; throughput is about 1 / query duration
  (platform/limits); overflow queues, then fails with "D1 DB is overloaded.
  Too many requests queued." (observability/debug-d1). Read-only queries auto-retry up to twice
  (`meta.total_attempts`).
- Transactions: `batch()` runs statements sequentially and rolls the whole
  batch back on failure (worker-api/d1-database); every query runs in an
  implicit transaction.
- Read replication: public beta since 2025-04-10, Sessions API only through
  the Worker binding (best-practices/read-replication).
- Location hints: wnam, enam, weur, eeur, apac, oc; where an APAC/OC primary
  physically lands is not documented (configuration/data-location).
- Time Travel: restore to any minute in 30 days (Paid) / 7 days (Free);
  databases with virtual tables (FTS5) cannot be exported
  (reference/time-travel, best-practices/import-export-data).
- SQL: FTS5 and JSON supported; foreign keys enforced and cannot be turned
  off. No vector support found in D1 docs (Vectorize is a separate product);
  treated as found-no-evidence.
- Pricing (platform/pricing): Paid includes 25B rows read and 50M rows
  written per month, then $0.001 per million read and $1.00 per million
  written; storage $0.75/GB-month past 5 GB. Free: 5M rows read and 100K
  written per day. Enforcement announced from 2025-02-10
  (https://developers.cloudflare.com/d1/platform/release-notes/); the
  2026-09-01 changelog says Workers Free queries over the daily limit fail
  (https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).
- Backing: "Each individual D1 database is backed by a single Durable Object."

## Cloudflare Hyperdrive

- Limits (https://developers.cloudflare.com/hyperdrive/platform/limits/):
  about 100 origin connections per config on Paid (soft), 60 s max query
  duration, 15 s initial connect timeout.
- Caching (https://developers.cloudflare.com/hyperdrive/concepts/query-caching/):
  on by default, max_age 60 s; writes do not invalidate cached results;
  queries using STABLE/VOLATILE functions such as `NOW()` are not cached.

## Cloudflare Durable Objects (SQLite storage), read 2026-10-16

Raw excerpts: `docs/research/raw/2026-10-16-do-workerd-celld/durable-objects.md`.

- SQLite-backed Durable Objects GA on 2025-04-07 per the release notes
  (https://developers.cloudflare.com/durable-objects/release-notes/); a
  2026-07-09 changelog says "generally available in 2024" (raw notes).
- SQL API: `ctx.storage.sql.exec()`; "cannot execute transaction-related
  statements like `BEGIN TRANSACTION` or `SAVEPOINT`"; transactions through
  `ctx.storage.transaction()` / `transactionSync()`; FTS5 among the available
  extensions (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
- Placement: `locationHint` values include `oc`; "Hints are a best effort and
  not a guarantee"; objects "do not currently change locations after they are
  created" (https://developers.cloudflare.com/durable-objects/reference/data-location/).
- Limits: "An individual Object has a soft limit of 1,000 requests per
  second"; 10 GB per object on Workers Paid (the same page's FAQ gives 1 GB on
  Free; the plan that applies to this account was not determined)
  (https://developers.cloudflare.com/durable-objects/platform/limits/).
- D1 relation: "Each individual D1 database is backed by a single Durable
  Object" (https://developers.cloudflare.com/d1/platform/limits/); SQLite in
  Durable Objects is "a lower-level compute with storage building block"
  (https://developers.cloudflare.com/workers/platform/storage-options/).
- Measured against these (sqlite-edge-compare RUNLOG, r3 battery): `sql.exec`
  refused `BEGIN TRANSACTION` and `sqlite_version()`; FTS5 worked; no
  `vector32`; with hint `oc` the object reported BNE (from an in-object
  `/cdn-cgi/trace`, not a documented Durable Objects API; `/meta` only).

