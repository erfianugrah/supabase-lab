# SQLite-backed Durable Objects - raw doc notes (2026-10-16)

Fetched 2026-10-16 from the `index.md` (View as Markdown) variant of each
developers.cloudflare.com page via curl. Excerpts are verbatim unless marked
[paraphrase]. "Last updated" stamps are the page's own. Smart punctuation and
glyphs in the source were converted to ASCII; check-mark cells written as yes/no.

Context: benchmark Worker forwards SQL over RPC to one named DO (and many, for
database-per-tenant), executed with `ctx.storage.sql.exec`, data in Sydney
(location hint `oc`).

---

## 1. SQLite-backed DOs: status, plans, limits, SQL API

### GA and plan availability

Source: https://developers.cloudflare.com/durable-objects/release-notes/ (page "Last updated Apr 21, 2026", but lists a 2026-06-30 entry)

> ## 2025-04-07
> **SQLite in Durable Objects GA**
> SQLite-backed Durable Objects and corresponding Storage API methods like `sql.exec` have moved from beta to general availability. New Durable Object classes should use wrangler configuration for SQLite storage over key-value storage.
> SQLite storage per Durable Object has increased to 10GB for all existing and new objects.

> ## 2025-04-07
> **Durable Objects on Workers Free plan**
> SQLite-backed Durable Objects are now available on the Workers Free plan with these limits.

> ## 2024-09-26
> **(Beta) SQLite storage backend & SQL API available on new Durable Object classes**
> ... During the initial beta, Storage API billing is not enabled for Durable Object classes using SQLite storage backend. SQLite-backed Durable Objects will incur charges for requests and duration. We plan to enable Storage API billing ... in the first half of 2025 ...

> ## 2024-04-03
> **Durable Objects support for Oceania region**
> Durable Objects can reside in Oceania, lowering Durable Objects request latency for eyeball Workers in Oceania locations.

Changelog post, 2026-07-09: https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/

> If your account does not already have a key-value (KV) backed Durable Object namespace, you can no longer create new ones. New Durable Object namespaces must use the SQLite storage backend, which has been recommended for all new Durable Objects since it became generally available in 2024.

(Note: "generally available in 2024" conflicts with the release-notes GA date 2025-04-07; see Counter-evidence.)

Limits page note (https://developers.cloudflare.com/durable-objects/platform/limits/, "Last updated Jun 1, 2026"):

> - **Workers Free plan**: Only Durable Objects with SQLite storage backend are available.
> - **Workers Paid plan**: Durable Objects with the SQLite storage backend are available. The key-value storage backend is only available to accounts that already have a key-value-backed namespace.

### General limits (SQLite-backed)

Source: https://developers.cloudflare.com/durable-objects/platform/limits/

| Feature | Limit |
| --- | --- |
| Number of Objects | Unlimited (within an account or of a given class) |
| Maximum Durable Object classes (per account) | 500 (Workers Paid) / 100 (Free) |
| Storage per account | Unlimited (Workers Paid) / 5GB (Free) |
| Storage per class | Unlimited |
| Storage per Durable Object | 10 GB (footnote 3: "Accounts on the Workers Free plan are limited to 5 GB total Durable Objects storage.") |
| Key size | Key and value combined cannot exceed 2 MB |
| Value size | Key and value combined cannot exceed 2 MB |
| WebSocket message size | 32 MiB (only for received messages) |
| CPU per request | 30 seconds (default) / configurable to 5 minutes of active CPU time |
| Simultaneous outgoing connections/request | 6 (same as Workers) |

Footnote 2: "Durable Objects both bills and measures storage based on a gigabyte (1 GB = 1,000,000,000 bytes) and not a gibibyte (GiB)."

Footnote 4: "Each incoming HTTP request or WebSocket *message* resets the remaining available CPU time to 30 seconds. ... If you consume more than 30 seconds of compute between incoming network requests, there is a heightened chance that the individual Durable Object is evicted and reset."

CPU raise: `limits.cpu_ms` in Wrangler config, e.g. `cpu_ms = 300_000`.

Same page, FAQ "What happens when a Durable Object exceeds its storage limit?":

> When a SQLite-backed Durable Object reaches its maximum storage limit (10 GB on Workers Paid, or 1 GB on the Free plan), write operations (such as `INSERT`, `UPDATE`, or calls to the `put()` and `sql.exec()` storage APIs) will fail with the following error: `database or disk is full: SQLITE_FULL`
> Read operations ... will continue to work, and `DELETE` operations will also succeed so that you can remove data to free up space.

(1 GB per-object Free figure does not appear in the limits table; see Counter-evidence.)

### SQL storage limits

Source: https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits

| SQL | Limit |
| --- | --- |
| Maximum number of columns per table | 100 |
| Maximum number of rows per table | Unlimited (excluding per-object storage limits) |
| Maximum string, `BLOB` or table row size | 2 MB |
| Maximum SQL statement length | 100 KB |
| Maximum bound parameters per query | 100 |
| Maximum arguments per SQL function | 32 |
| Maximum characters (bytes) in a `LIKE` or `GLOB` pattern | 50 bytes |

These match D1's per-query limits row-for-row (https://developers.cloudflare.com/d1/platform/limits/): 100 columns, 2,000,000 bytes row/BLOB, 100,000 bytes statement, 100 bound params, 32 function args, 50-byte LIKE/GLOB. D1 adds "Maximum SQL query duration 30 seconds", which the DO page does not list.

### Extensions

Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ("Last updated Sep 21, 2026")

> Durable Objects support a subset of SQLite extensions for added functionality, including:
> - FTS5 module for full-text search (including `fts5vocab`).
> - JSON extension for JSON functions and operators.
> - Math functions.
> Refer to the source code for the full list of supported functions.

The "source code" link is pinned to workerd commit 4c42a4a9d3390c88e9bd977091c9d3395a6cd665, `src/workerd/util/sqlite.c++#L269`.

No vector extension (sqlite-vec, vec0) is mentioned anywhere in the DO docs fetched. The function allowlist in workerd `src/workerd/util/sqlite.c++` at HEAD 762775503a5d72d024a28ed1bc9e56739c484284 (fetched 2026-10-16) lists json/jsonb functions, FTS5 `match`/`highlight`/`bm25`/`snippet`, and R*Tree `rtreecheck`; no vector functions. [source code, not docs]

Release notes 2025-02-19: "SQLite-backed Durable Objects now support `PRAGMA optimize` command".

Rules page (https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/, "Last updated Aug 20, 2026"):

> `PRAGMA user_version` is not supported by Durable Objects SQLite storage. You must use an alternative approach to track your schema version.

### Foreign keys

Not stated in any DO doc page fetched (searched sqlite-storage-api, limits, access-storage, rules, release notes, FAQ for "foreign"/"pragma").

Source code evidence (not docs):
- workerd `build/BUILD.sqlite3` defines `SQLITE_DEFAULT_FOREIGN_KEYS=1` (found via GitHub code search on cloudflare/workerd, 2026-10-16). This is the open-source build; that production uses the same define is an inference.
- workerd `src/workerd/util/sqlite.c++` pragma allowlist includes `foreign_keys` (BOOLEAN), `defer_foreign_keys` (BOOLEAN), `foreign_key_check`, `foreign_key_list`.

D1 for comparison (https://developers.cloudflare.com/d1/sql-api/foreign-keys/):

> By default, D1 enforces that foreign key constraints are valid within all queries and migrations. This is identical to the behaviour you would observe when setting `PRAGMA foreign_keys = on` in SQLite for every transaction.

### SQL API

Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

`exec(query: string, ...bindings: any[])`: `SqlStorageCursor`

> `query` can contain `?` placeholders for parameter bindings. Multiple SQL statements, separated with a semicolon, can be executed in the `query`. With multiple SQL statements, any parameter bindings are applied to the last SQL statement in the `query`, and the returned cursor is only for the last SQL statement.

Cursor methods: `next()`, `toArray()`, `one()` (throws unless exactly one row), `raw()` (iterator of value arrays). Properties: `columnNames`, `rowsRead`, `rowsWritten` ("The final value is used for SQL billing").

> Any numeric value in a column is affected by JavaScript's 52-bit precision for numbers.

Cursor snapshot warning:

> Although a cursor object can technically be held across an `await`, it does not provide a stable snapshot of the query results. ... For predictable behavior, fully consume cursors synchronously before the next `await`, for example with `.toArray()` or `Array.from(cursor)`.

`databaseSize`: "The current SQLite database size in bytes."

Billing-relevant notes on the same page:

> - When writing data, every row update of an index counts as an additional row.
> - Writing to SQLite virtual tables also counts towards rows written.

KV API on SQLite DOs stores data in hidden table `__cf_kv` ("you will be able to view this table when listing all tables, but you will not be able to access its content through the SQL API").

### BEGIN / COMMIT in sql.exec (verbatim)

Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

> SQL transactions
> Note that `sql.exec()` cannot execute transaction-related statements like `BEGIN TRANSACTION` or `SAVEPOINT`. Instead, use the `ctx.storage.transaction()` or `ctx.storage.transactionSync()` APIs to start a transaction, and then execute SQL queries in your callback.

workerd source corroborates: the SQLite authorizer rejects `SQLITE_TRANSACTION` and `SQLITE_SAVEPOINT` actions unless `regulator->allowTransactions()` (src/workerd/util/sqlite.c++ ~L1212-1245 at 762775503a). [source code]

### transactionSync / transaction

Same page:

> `transactionSync(callback)`: `any`
> - Only available when using SQLite-backed Durable Objects.
> - Invokes `callback()` wrapped in a transaction, and returns its result.
> - If `callback()` throws an exception, the transaction will be rolled back.
> - The callback must complete synchronously, that is, it should not be declared `async` nor otherwise return a Promise. Only synchronous storage operations can be part of the transaction. This is intended for use with SQL queries using `ctx.storage.sql.exec()`, which complete synchronously.

> `transaction(closureFunction(txn))`: `Promise`
> - Explicit transactions are no longer necessary. Any series of write operations with no intervening `await` will automatically be submitted atomically, and the system will prevent concurrent events from executing while `await` a read operation (unless you use `allowConcurrency: true`). ...
> - When using the SQLite-backed storage engine, the `txn` object is obsolete. Any storage operations performed directly on the `ctx.storage` object, including SQL queries using `ctx.storage.sql.exec()`, will be considered part of the transaction.

`sync()`: "Synchronizes any pending writes to disk."

### Input/output gates, write coalescing, implicit transactions

sqlite-storage-api page, table footnote 1:

> Each method is implicitly wrapped inside a transaction, such that its results are atomic and isolated from all other storage operations, even when accessing multiple key-value pairs.

> Automatic write coalescing
> If you invoke `put()` (or `delete()`) multiple times without performing any `await` in the meantime, the operations will automatically be combined and submitted atomically. In case of a machine failure, either all of the writes will have been stored to disk or none of the writes will have been stored to disk.

`allowUnconfirmed` option on put/delete:

> By default, the system will pause outgoing network messages from the Durable Object until all previous writes have been confirmed flushed to disk. If the write fails, the system will reset the Object, discard all outgoing messages, and respond to any clients with errors instead.

Rules page (https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/):

> **Input gates** block new events (incoming requests, fetch responses) while synchronous JavaScript execution is in progress. Awaiting async operations like `fetch()` or KV storage methods opens the input gate, allowing other requests to interleave. However, storage operations provide special protection:
> **Output gates** hold outgoing network messages (responses, fetch requests) until pending storage writes complete. This ensures clients never see confirmation of data that has not been persisted:
> **Write coalescing:** Multiple storage writes without intervening `await` calls are automatically batched into a single atomic implicit transaction:
> Input gates only protect during storage operations. Non-storage I/O like `fetch()` or writing to R2 allows other requests to interleave, which can cause race conditions:

> Because `blockConcurrencyWhile()` blocks *all* concurrency unconditionally, it significantly reduces throughput. If each call takes ~5ms, that individual Durable Object is limited to approximately 200 requests/second.

Write confirmation mechanics (blog, not docs): https://blog.cloudflare.com/sqlite-in-durable-objects/ (2024-09-26, Kenton Varda):

> Every time SQLite commits a transaction, SRS will immediately forward the change log to five "follower" machines across our network. Once at least three of these followers respond that they have received the change, SRS informs the application that the write is confirmed. (As discussed earlier, the write confirmation opens the Durable Object's "output gate", unblocking network communications to the rest of the world.)

> Each of a database's five followers is located in a different physical data center.

> SRS batches changes over a period of up to 10 seconds, or up to 16 MB worth, whichever happens first, then uploads the whole batch as a single object.

Benchmark implication [inference]: a write's RPC response is held by the output gate until 3 of 5 followers ack, so write latency includes an inter-datacenter round trip even though `sql.exec` itself is synchronous.

### Point-in-time recovery

Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api

> ... restore a Durable Object's embedded SQLite database to any point in time in the past 30 days. These methods apply to the entire SQLite database contents, including both the object's stored SQL data and stored key-value data using the key-value `put()` API. The PITR API is not supported in local development because a durable log of data changes is not stored locally.

> `ctx.storage.getCurrentBookmark()`: `Promise<string>`
> `ctx.storage.getBookmarkForTime(timestamp: number | Date)`: `Promise<string>` - Returns a bookmark representing approximately the given point in time, which must be within the last 30 days.
> `ctx.storage.onNextSessionRestoreBookmark(bookmark: string)`: `Promise<string>` - Configures the Durable Object so that the next time it restarts, it should restore its storage to exactly match what the storage contained at the given bookmark. After calling this, the application should typically invoke `ctx.abort()` to restart the Durable Object, thus completing the point-in-time recovery.

Blog: "There's no need to opt into this feature in advance; it's on by default for all SQLite-backed DOs." Retention is the same 30 days on all plans per DO docs (no Free/Paid split stated), whereas D1 Time Travel is "30 days (Workers Paid) / 7 days (Free)" (https://developers.cloudflare.com/d1/platform/limits/).

---

## 2. Placement

Source: https://developers.cloudflare.com/durable-objects/reference/data-location/ ("Last updated Jun 26, 2026")

> Durable Objects do not currently change locations after they are created<sup>1</sup>. By default, a Durable Object is instantiated in a data center close to where the initial `get()` request is made. This may not be in the same data center that the `get()` request is made from, but in most cases, it will be in close proximity.

> To manually create Durable Objects in another location, provide an optional `locationHint` parameter to `get()`. Only the first call to `get()` for a particular Object will respect the hint.

> Caution
> Hints are a best effort and not a guarantee. Unlike with jurisdictions, Durable Objects will not necessarily be instantiated in the hinted location, but instead instantiated in a data center selected to minimize latency from the hinted location.

Supported locations (verbatim table):

| Parameter | Location |
| --- | --- |
| wnam | Western North America |
| enam | Eastern North America |
| sam | South America (2) |
| weur | Western Europe |
| eeur | Eastern Europe |
| apac | Asia-Pacific |
| apac-ne | Northeast Asia-Pacific (3) |
| apac-se | Southeast Asia-Pacific (3) |
| oc | Oceania |
| afr | Africa (2) |
| me | Middle East (2) |

> 1 Dynamic relocation of existing Durable Objects is planned for the future.
> 2 Durable Objects currently do not spawn in this location. Instead, the Durable Object will spawn in a nearby location which does support Durable Objects. For example, Durable Objects hinted to South America spawn in Eastern North America instead.
> 3 `apac-ne` (Northeast Asia-Pacific) and `apac-se` (Southeast Asia-Pacific) are narrower sub-regions within `apac` (Asia-Pacific). Prefer `apac` for general Asia-Pacific placement.

> - You can find our more about where Durable Objects are located using the website: Where Durable Objects Live (https://where.durableobjects.live/).

Jurisdictions (hard constraint, unlike hints): `eu`, `us`, `fedramp`. Readable inside the object via `ctx.id.jurisdiction`.

`apac-ne` / `apac-se` added 2026-06-19: https://developers.cloudflare.com/changelog/post/2026-06-19-apac-ne-apac-se-location-hints/

> The default behavior and what we generally recommended is not adding a location hint unless absolutely needed, this will create the Durable Object as close to the initializing request as possible to reduce latency. As with all location hints, these are best-effort suggestions.

Namespace API (https://developers.cloudflare.com/durable-objects/api/namespace/): both `get(id, options)` and `getByName(name, options)` accept "An optional object with the key `locationHint` and value of a locationHint string." `getByName` added 2025-08-21 (release notes).

Rules page (https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/):

> By default, a Durable Object is created near the location of the first request it receives. ... Location hints are suggestions, not guarantees.

Data-location page also warns:

> It can negatively impact latency to pre-create Durable Objects prior to the first client request or when the first client request is not representative of where the majority of requests will come from.

How to read where an object runs: NO documented API found. `request.cf.colo` is documented generically for Workers requests (https://developers.cloudflare.com/workers/runtime-apis/request/ - "`colo` string - The three-letter IATA airport code of the data center that the request hit"), but no DO page documents `request.cf` inside a DO fetch handler, and RPC calls carry no Request. The only DO-docs pointer is the third-party site https://where.durableobjects.live/. Common practice (undocumented by Cloudflare): `fetch("https://www.cloudflare.com/cdn-cgi/trace")` from inside the DO and read `colo=`. [unverified pattern]

---

## 3. Limits

CPU: 30 s default per request, raise to 5 min via `limits.cpu_ms` (limits page above). Wall time for DO RPC/HTTP: "Unlimited - No hard limit while the caller stays connected to the Durable Object." Alarm handlers: 15 minutes.

Throughput, limits page FAQ (verbatim):

> - An individual Object has a soft limit of 1,000 requests per second. You can have an unlimited number of individual objects per namespace.
> A Durable Object that receives too many requests will, after attempting to queue them, return an overloaded error to the caller.

Rules page (verbatim):

> A single Durable Object can handle approximately **500-1,000 requests per second** for simple operations.
> | Simple pass-through (minimal parsing) | ~1,000 req/sec |
> | Moderate processing (JSON parsing, validation) | ~500-750 req/sec |
> | Complex operations (transformation, storage writes) | ~200-500 req/sec |

Overloaded errors (https://developers.cloudflare.com/durable-objects/observability/troubleshooting/, "Last updated Oct 8, 2026"):

> - `Error: Durable Object is overloaded. Too many requests queued.` The total count of queued requests is too high.
> - `Error: Durable Object is overloaded. Too much data queued.` The total size of data in queued requests is too high.
> - `Error: Durable Object is overloaded. Requests queued for too long.` The oldest request has been in the queue too long.
> - `Error: Durable Object is overloaded. Too many requests for the same object within a 10 second window.` ... This error indicates a more extreme level of overload.
> These errors and others that are due to overload will have an `.overloaded` property set on their exceptions, which can be used to avoid retrying overloaded operations.

Also on that page:

> ### Your account is generating too much load on Durable Objects. Please back off and try again later.
> There is a limit on how quickly you can create new stubs for new or existing Durable Objects. Those lookups are usually cached ...

> ### Your account is doing too many concurrent storage operations. Please back off and try again later.

(No numeric value is given for the stub-creation rate limit.)

Number of objects: "Unlimited (within an account or of a given class)" (limits page). But changelog 2026-06-19 (https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/) says "The Durable Object's existing per-account instance limits still apply." - no number found.

Subrequests (https://developers.cloudflare.com/workers/platform/limits/#subrequests):

| Limit | Workers Free | Workers Paid |
| --- | --- | --- |
| Subrequests per invocation | 50 | 10,000 (up to 10M) |
| Subrequests to internal services | 1,000 | Matches configured limit (default 10,000) |

Whether a DO RPC call counts as a subrequest is not stated on that page (it lists Fetch, R2, KV, D1). Simultaneous open connections: 6 per invocation. Memory: 128 MB per isolate.

RPC (https://developers.cloudflare.com/workers/runtime-apis/rpc/):

> The maximum serialized RPC limit is 32 MiB. Consider using `ReadableStream` when returning more data.

Billing note relevant to RPC (pricing page footnote 1): "Every RPC method call on a Durable Objects stub is its own RPC session and therefore a single billed request." Calls on an `RpcTarget` stub returned from a method are part of the same session.

Lifecycle (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/): hibernation "after 10 seconds of inactivity" when eligible. Changelog 2026-06-19: non-hibernatable objects are "evicted after 70-140 seconds of no incoming traffic". Changelog 2026-10-01 (https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/): pending RPC/service-binding/waitUntil keep a DO alive, "Each pending operation prevents idle shutdown for up to 15 minutes" (default for compat date >= 2026-10-01).

Known issues (https://developers.cloudflare.com/durable-objects/platform/known-issues/): code updates roll out eventually-consistently; a DO "may be replaced in the event of a network partition or a software update"; enabling `wrangler tail` or dashboard logs "requires a software update" (i.e. resets objects).

---

## 4. Pricing (Workers Paid)

Source: https://developers.cloudflare.com/durable-objects/platform/pricing/ ("Last updated Sep 30, 2026")

Compute:

|  | Free plan | Paid plan |
| --- | --- | --- |
| Requests | 100,000 / day | 1 million / month, + $0.15/million. Includes HTTP requests, RPC sessions, WebSocket messages, and alarm invocations |
| Duration | 13,000 GB-s / day | 400,000 GB-s / month, + $12.50/million GB-s |

> Duration billing charges for the 128 MB of memory your Durable Object is allocated, regardless of actual usage.

> Durable Objects that are idle and eligible for hibernation are not billed for duration, even before the runtime has hibernated them.

> For each metered dimension, billable usage is the amount consumed in excess of the included monthly allocation. This billable usage is rounded up to the next billable unit before the corresponding rate is applied.

SQLite storage backend:

|  | Workers Free plan | Workers Paid plan |
| --- | --- | --- |
| Rows reads | 5 million / day | First 25 billion / month included + $0.001 / million rows |
| Rows written | 100,000 / day | First 50 million / month included + $1.00 / million rows |
| SQL Stored data | 5 GB (total) | 5 GB-month, + $0.20/ GB-month |

Footnotes: "Rows read and rows written included limits and rates match D1 pricing"; KV-API calls are billed as rows; "Each `setAlarm()` is billed as a single row written"; "Deletes are counted as rows written"; stored data billed "until the data is removed".

Free plan: "If you exceed any one of the free tier limits, further operations of that type will fail with an error. Daily free limits reset at 00:00 UTC."

Storage billing enablement:
- Changelog 2025-12-12: https://developers.cloudflare.com/changelog/post/2025-12-12-durable-objects-sqlite-storage-billing/ - "Storage billing for SQLite-backed Durable Objects will be enabled in January 2026, with a target date of January 7, 2026 (no earlier). ... Developers on the Workers Free plan will not be charged. Compute billing for SQLite-backed Durable Objects has been enabled since the initial public beta."
- Release notes entry dated 2026-01-07 repeats the same future-tense text and links to https://developers.cloudflare.com/changelog/durable-objects/2026-01-07-durable-objects-sqlite-storage-billing/ which returned HTTP 404 on 2026-10-16.
- The pricing page (updated Sep 30, 2026) still uses the future-tense "will be enabled in January 2026" callout. No post confirming billing actually went live was found in the changelog RSS (https://developers.cloudflare.com/changelog/rss/index.xml, fetched 2026-10-16).

---

## 5. Durable Objects vs D1

Source: https://developers.cloudflare.com/workers/platform/storage-options/ (also duplicated on https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/#sql-in-durable-objects-vs-d1)

SQL database options (verbatim):

> - **Hyperdrive** if you have an existing Postgres or MySQL database, require large (1TB, 100TB or more) single databases, and/or want to use your existing database tools. ...
> - **D1** for lightweight, serverless applications that are read-heavy, have global users that benefit from D1's read replication, and do not require you to manage and maintain a traditional RDBMS.
> - **Durable Objects** for stateful serverless workloads, per-user or per-customer SQL state, and building distributed systems (D1 and Queues are built on Durable Objects) where Durable Object's strict serializability enables global ordering of requests and storage operations.

"SQL in Durable Objects vs D1" (verbatim):

> **D1 is a managed database product.**
> D1 fits into a familiar architecture for developers, where application servers communicate with a database over the network. Application servers are typically Workers; however, D1 also supports external, non-Worker access via an HTTP API, which helps unlock third-party tooling support for D1.
> D1 aims for a "batteries included" feature set, including the above HTTP API, database schema management, data import/export, and database query insights.
> With D1, your application code and SQL database queries are not colocated which can impact application performance. If performance is a concern with D1, Workers has Smart Placement to dynamically run your Worker in the best location to reduce total Worker request latency, considering everything your Worker talks to, including D1.
> **SQLite in Durable Objects is a lower-level compute with storage building block for distributed systems.**
> By design, Durable Objects are accessed with Workers-only.
> Durable Objects require a bit more effort, but in return, give you more flexibility and control. With Durable Objects, you must implement two pieces of code that run in different places: a front-end Worker which routes incoming requests from the Internet to a unique Durable Object, and the Durable Object itself, which runs on the same machine as the SQLite database. You get to choose what runs where, and it may be that your application benefits from running some application business logic right next to the database.
> With SQLite in Durable Objects, you may also need to build some of your own database tooling that comes out-of-the-box with D1.
> SQL query pricing and limits are intended to be identical between D1 (pricing, limits) and SQLite in Durable Objects (pricing, limits).

The DO-side copy of this page, https://developers.cloudflare.com/durable-objects/platform/storage-options/, rendered with an empty body on 2026-10-16 (title only).

D1 backed by a DO (https://developers.cloudflare.com/d1/platform/limits/ and https://developers.cloudflare.com/d1/reference/faq/):

> Each individual D1 database is backed by a single Durable Object. When using D1 read replication each replica instance is a different Durable Object and the guidelines apply to each replica instance independently.

> Each individual D1 database is inherently single-threaded, and processes queries one at a time.
> - If your average query takes 1 ms, you can run at most 1,000 queries per second.

D1 per-database size: "10 GB (Workers Paid) / 500 MB (Free)"; databases per account 50,000 (Paid) / 10 (Free).

Benchmark implication [inference]: DO-direct removes the Worker-to-D1 network hop only if the SQL runs inside the DO; with the Worker forwarding SQL over RPC, both paths are Worker -> single-threaded SQLite-in-DO, so differences come from D1's query layer, not storage.

---

## 6. Read replication / multi-region reads for DO SQLite

No documented or announced read-replica feature for SQLite-backed Durable Objects found:
- DO release notes (https://developers.cloudflare.com/durable-objects/release-notes/) and changelog RSS (https://developers.cloudflare.com/changelog/rss/index.xml): no DO replica entry as of 2026-10-16.
- Data-location page footnote: "Dynamic relocation of existing Durable Objects is planned for the future." (relocation, not replication; no date).
- Blog 2024-09-26 (https://blog.cloudflare.com/sqlite-in-durable-objects/) frames replication as an application concern: "you would need to create a set of objects that each handle a subset of traffic and then replicate state to each other." It also stated "By the end of 2024, D1 will support automatic read replication".
- D1 read replication (built on DOs) public beta 2025-04-10: https://developers.cloudflare.com/changelog/post/2025-04-10-d1-read-replication-beta/ - "Read replicas are automatically created by Cloudflare (currently one in each supported D1 region) ... Workers can leverage read-only database copies ... by using D1 Sessions API."

---

## 7. Local dev / self-hosting (workerd, wrangler dev)

Local data persistence (https://developers.cloudflare.com/workers/local-development/local-data/):

> For Durable Objects, unlike KV, D1, and R2, there are no CLI commands to populate them with local data. To add data to Durable Objects during local development, you must write application code that creates Durable Object instances and calls methods on them that store state.
> By default, both Wrangler and the Vite plugin store local binding data in the same location: the `.wrangler/state` folder in your project directory. This folder stores data in subdirectories for all local bindings: KV namespaces, R2 buckets, D1 databases, Durable Objects, etc.
> Use the `--persist-to` flag with `wrangler dev`. You need to specify this flag every time you run the `dev` command: `npx wrangler dev --persist-to <DIRECTORY>`

Local runtime (https://developers.cloudflare.com/workers/local-development/):

> ... Miniflare, a simulator that executes your Worker code using the same runtime used in production, `workerd`.
> - **Durable Objects**: Enabling remote connections for Durable Objects may be supported in the future, but currently will always run locally.

PITR is not available locally (sqlite-storage-api page, quoted in section 1).

Known issues page (https://developers.cloudflare.com/durable-objects/platform/known-issues/, "Last updated Jul 3, 2026"):

> `wrangler dev` has read access to Durable Object storage, but writes will be kept in memory and will not affect persistent data. However, if you specify the `script_name` explicitly in the Durable Object binding, then writes will affect persistent data.

(This conflicts with the local-data page; see Counter-evidence.)

workerd self-hosting (GitHub, not developers.cloudflare.com; pinned HEAD 762775503a5d72d024a28ed1bc9e56739c484284):

README https://github.com/cloudflare/workerd/blob/762775503a5d72d024a28ed1bc9e56739c484284/README.md:

> You might use it: **As an application server**, to self-host applications designed for Cloudflare Workers. ...
> ### WARNING: `workerd` is not a hardened sandbox

Config schema https://github.com/cloudflare/workerd/blob/762775503a5d72d024a28ed1bc9e56739c484284/src/workerd/server/workerd.capnp:

> durableObjectStorage :union {
>   none - Default. The worker has no Durable Objects.
>   inMemory - The `state.storage` API stores in-memory only. All stored data will persist for the lifetime of the process, but will be lost upon process exit. ... This mode is intended for local testing purposes.
>   localDisk :Text - ** EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE ** Durable Object data will be stored in a directory on local disk. This field is the name of a service, which must be a DiskDirectory service. For each Durable Object class, a subdirectory will be created using `uniqueKey` as the name. Within the directory, one or more files are created for each object, with names `<id>.<ext>` ... (Currently, the main storage is a file with the extension `.sqlite`, and in certain situations extra files with the extensions `.sqlite-wal`, and `.sqlite-shm` may also be present.)
> }
> # TODO(someday): Support distributing objects across a cluster. At present, objects are always local to one instance of the runtime.

> enableSql @4 :Bool; Whether or not Durable Objects in this namespace can use the `storage.sql` API to execute SQL queries. workerd uses SQLite to back all Durable Objects, but the SQL API is hidden by default to emulate behavior of traditional DO namespaces on Cloudflare that aren't SQLite-backed.

Implication [inference]: self-hosted workerd DOs are a single-process local SQLite file per object, with no SRS follower replication, no PITR, no placement; latency numbers from workerd are not comparable to Cloudflare-hosted DOs.

---

## Contradictions found

1. Free plan per-object storage: limits table says "Storage per Durable Object 10 GB" with Free footnote "limited to 5 GB total"; the FAQ on the same page says the maximum is "10 GB on Workers Paid, or 1 GB on the Free plan". https://developers.cloudflare.com/durable-objects/platform/limits/
2. Throughput: limits FAQ "soft limit of 1,000 requests per second" vs rules page "approximately 500-1,000 requests per second", ~200-500 for storage writes. https://developers.cloudflare.com/durable-objects/platform/limits/ vs https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
3. GA date: release notes say SQLite-in-DO GA on 2025-04-07; the 2026-07-09 changelog says it "became generally available in 2024" (beta was 2024-09-26).
4. Storage billing status: changelog (2025-12-12), release notes (2026-01-07) and pricing page (updated 2026-09-30) all still say billing "will be enabled ... target January 7, 2026"; the release-notes link to the 2026-01-07 changelog post returns 404. No confirmation it went live.
5. Object count: limits page "Number of Objects: Unlimited" vs changelog 2026-06-19 "existing per-account instance limits still apply" (no number published).
6. Local persistence: known-issues "wrangler dev ... writes will be kept in memory and will not affect persistent data" vs local-data page "`.wrangler/state` ... Durable Objects" persistence and `--persist-to`. The known-issues text likely predates local-mode default [inference].
7. Release notes page stamp "Last updated Apr 21, 2026" but contains a 2026-06-30 entry (cosmetic).
8. Beta release note promised storage billing "in the first half of 2025"; actual announced target was January 2026.
