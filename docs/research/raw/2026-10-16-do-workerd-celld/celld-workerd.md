# Raw notes: celld and workerd for self-hosted Durable Objects + D1 (2026-10-16)

Fetched 2026-10-16. Excerpts are verbatim unless marked [paraphrase] or [inference].
Non-ASCII punctuation in sources has been converted to ASCII.

## 0. Sources fetched

- celld repo README: https://github.com/denoland/celld
- celld docs (main == v0.6.2; repo pushed_at 2026-10-07T15:44:50Z, same minute as the v0.6.2 release):
  - https://github.com/denoland/celld/blob/main/docs/README.md
  - https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md
  - https://github.com/denoland/celld/blob/main/docs/guarantees.md
  - https://github.com/denoland/celld/blob/main/docs/limitations.md
  - https://github.com/denoland/celld/blob/main/docs/testing.md
  - https://github.com/denoland/celld/blob/main/docs/services/d1.md
  - https://github.com/denoland/celld/blob/main/docs/services/durable-objects.md
  - https://github.com/denoland/celld/blob/main/docs/services/workers.md
- celld releases: https://github.com/denoland/celld/releases (gh release list)
- celld site: https://celld.dev/
- Cloudflare blog: https://blog.cloudflare.com/deno-joins-cloudflare/
- workerd config schema: https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp
- workerd README: https://github.com/cloudflare/workerd/blob/main/README.md
- workerd DO sample: https://github.com/cloudflare/workerd/blob/main/samples/durable-objects-chat/config.capnp
- workerd D1 test wiring: https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/test/d1/d1-api-test.wd-test
- miniflare D1 plugin: https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/plugins/d1/index.ts
- miniflare Hyperdrive plugin: https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/plugins/hyperdrive/index.ts
- HN: https://news.ycombinator.com/item?id=49185430
- The Register: https://theregister.com/devops/2026/08/12/nodejs-creator-liberates-durable-objects-from-cloudflare-with-celld/5286954
- reptile.haus: https://reptile.haus/journal/celld-self-hosted-durable-objects-architecture-2026/
- MinIO repo: https://github.com/minio/minio

## 1. celld

### 1.1 Release, licence, packaging

`gh release list -R denoland/celld` (2026-10-16):

```
v0.6.2  Latest  2026-10-07T15:44:47Z
v0.6.1          2026-10-01T14:40:26Z
v0.6.0          2026-09-26T14:28:42Z
v0.5.1          2026-09-19T20:05:29Z
v0.5.0          2026-09-15T09:01:32Z
```

v0.6.2 assets: `celld-aarch64-apple-darwin.gz`, `celld-aarch64-unknown-linux-gnu.gz`,
`celld-x86_64-unknown-linux-gnu.gz`, LICENSE, NOTICE.
https://github.com/denoland/celld/releases/tag/v0.6.2

Repo metadata (gh api repos/denoland/celld): license Apache-2.0, created 2025-04-25, 58 open issues, ~5.7k stars.

limitations.md: "celld v0.6.2 is a beta release with these operational limits."
"The installer supplies binaries for Linux x86-64, Linux ARM64, and Apple Silicon. Windows is not supported."

Repo README:
"The installer downloads the `celld` binary (provenance is verifiable with gh attestation verify ): curl -fsSL https://celld.dev/install.sh | sh"
"Worker projects deployed with `celld deploy` need esbuild on PATH; asset-only projects do not."
"The release image contains the celld binary and is published for Linux x86-64 and ARM64: docker run --rm ghcr.io/denoland/celld --version"

Docker example (repo README, verbatim):

```
docker volume create celld-state
docker run --rm --network host \
  -e AWS_ACCESS_KEY_ID \
  -e AWS_SECRET_ACCESS_KEY \
  -e AWS_SESSION_TOKEN \
  -e CELLD_WATCH=/var/lib/celld/state \
  -v celld-state:/var/lib/celld \
  ghcr.io/denoland/celld \
  --bucket s3://my-cells-bucket \
  --endpoint https://ACCOUNT.r2.cloudflarestorage.com \
  --region auto \
  --listen 0.0.0.0:8080 \
  --internal-listen 10.0.0.12:8081 \
  --advertise node-a.internal:8081
```

"Drop --endpoint and --region for AWS S3. Expose port 8080 through the load balancer, and keep port 8081 on the private network."

Image inspection (docker buildx imagetools inspect, 2026-10-16):
- `ghcr.io/denoland/celld:latest`, `:v0.6.2` and `:0.6.2` all resolve to index digest
  sha256:b85983dcf410bcf710bbc30f400d8654123cb2b541ca4d84d7e299009a6ee97a
- platforms: linux/amd64 and linux/arm64 (plus attestation manifests)
- config: ENTRYPOINT ["/usr/local/bin/celld"]; layers only copy LICENSE/NOTICE and the binary.
  [inference] No esbuild/node in the image, so `celld deploy` of Worker code must run where esbuild is on PATH
  (host darwin-arm64 binary, or a custom image).

### 1.2 Minimum fleet config (S3-compatible bucket)

docs/README.md "Start a node" (verbatim):

```
celld \
  --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" \
  --region "$AWS_REGION" \
  --listen 0.0.0.0:8080 \
  --internal-listen 10.0.0.12:8081 \
  --advertise node-a.internal:8081
```

"`--advertise` requires an explicit `--internal-listen`, and so does a non-loopback `--listen`. You must route the
advertised address to the internal listener, not to the public listener; celld cannot verify this."

"Add nodes: Start each node with the same bucket settings and its own reachable `--advertise` address. The nodes find
each other through leases in the bucket; there is no join command."

Repo README: "celld rejects a literal public IP unless you supply --unsafe-public-advertise."
"The first current node creates fleet/peer-auth.json in the bucket."

Environment variables (docs/README.md table, verbatim rows):

| variable | purpose |
| --- | --- |
| `CELLD_BUCKET` | The fleet bucket, and an optional key prefix. The same as `--bucket` |
| `S3_ENDPOINT` | The S3-compatible endpoint. The same as `--endpoint` |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | The storage region |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Explicit AWS credentials. The standard AWS credential chain is also available |
| `CELLD_ADDR` | The public Worker listener. The same as `--listen` |
| `CELLD_INTERNAL_ADDR` | The peer and operator listener. The same as `--internal-listen` |
| `CELLD_ADVERTISE` | The internal address that peers can reach. The same as `--advertise` |
| `CELLD_NODE` | An explicit node-session ID: 1 to 128 ASCII letters, numbers, dots, dashes, or underscores, but not `.` or `..` |
| `CELLD_WATCH` | The local work directory for SQLite and replication |
| `CELLD_ESBUILD` | The path of the esbuild executable |
| `CELLD_DURABILITY` | `fleet` (default): the node sends each write to one or two other nodes and answers when they hold it on disk or the bucket upload finishes. A single node has no peer, so every write waits for the bucket. `bucket`: always wait for the bucket |
| `CELLD_TTL_MS` (from guarantees.md) | node lease lifetime, default 10000 ms, renewed after one third |
| `CELLD_IDLE_EVICT_S` | Seconds after which an idle cell leaves memory and hibernates (unset: only pressure or the residency cap removes an idle cell) |
| `CELLD_LTX_RETENTION_SECS` | Unset or `0` (default): celld deletes no epoch prefix. A positive value enables epoch GC ... |
| `CELLD_OPERATION_DEADLINE_MS` | The deadline for a non-restore operation (default: 15000) |
| `CELLD_LTX_DURABILITY_TIMEOUT_SECS` | The budget for one durability proof, and for the final snapshot of a handoff (default: 10). ... |
| `CELLD_V8_HEAP_LIMIT_MB` (repo README) | per-isolate heap, default 128 MB |
| `RUST_LOG` | The runtime log filter |

"For the full list, including advanced tuning switches, run `celld -h`."

Supervisor requirement (guarantees.md): "Run celld under a supervisor that restarts the process, such as systemd, Docker
with a restart policy, or Kubernetes. A node that loses its lease fences itself and exits, and without a restart the
fleet loses that capacity. The supervisor must restart without an attempt limit and wait at least one lease lifetime
between attempts."
"A fenced node logs a line starting with `SELF-FENCE:` and exits with code 3."

Local dev: "celld dev ... starts one celld node with a local object store, so it needs no Docker or cloud bucket. The
Worker listener uses http://127.0.0.1:9876." limitations.md: "Only `celld dev` can use the local SQLite object store."

### 1.3 Bucket requirements and MinIO

guarantees.md (verbatim):
"The qualified stores are Amazon S3, Cloudflare R2, Tigris, Google Cloud Storage, and Azure Blob Storage. The release
tests run against R2; the S3 path uses the same client and headers."
"Backblaze B2, Hetzner Object Storage, and DigitalOcean Spaces do not implement the required conditional writes, so
two nodes can own one cell on them. A store that accepts the conditional headers but ignores the condition fails late
and silently, so run the storage test."
"MinIO (the community edition) passes the storage test but is not qualified for production.
RELEASE.2025-09-06T17-38-46Z answers the conditional create of an absent object with `NoSuchKey`, so the first deploy
fails (denoland/celld#162). Use RELEASE.2025-09-07T16-13-09Z or later."

Storage test: "`celld diagnose` sends four conditional writes to the bucket:
`ok bucket conditional write (create, reject-create, update, reject-stale)`"
"Each node runs the same writes before it serves ... A node cannot disable this test."

MinIO status (gh api repos/minio/minio, 2026-10-16): archived=true; README: "THIS REPOSITORY IS NO LONGER MAINTAINED."
Latest release RELEASE.2025-10-15T17-29-55Z (published 2025-10-16), previous RELEASE.2025-09-07T16-13-09Z.
https://github.com/minio/minio
Docker Hub/quay availability of those tags: NOT verified (docker buildx imagetools inspect returned auth errors from
this machine even for minio/minio:latest, so no conclusion either way).

### 1.4 celld deploy and wrangler.json

cloudflare-compat.md "Wrangler configuration" (verbatim):
"`celld deploy` accepts `wrangler.jsonc` or `wrangler.json`, not `wrangler.toml`."
"The accepted top-level keys:
- `$schema`, `name`, `main`, and `no_bundle`
- `compatibility_date` and `compatibility_flags`
- `durable_objects` and `migrations`
- `assets`, `services`, `triggers`, and `vars`
- `d1_databases`, `kv_namespaces`, `queues`, `workflows`, and `r2_buckets`
- `worker_loaders` and `containers`
- `define` and `rules`
Any other top-level key, including `routes`, stops the deployment."

Repo README: "A fleet runs one application, and every node loads its latest successfully committed deployment from
deploy/current.json. celld deploy invokes esbuild from PATH for Worker code, accepts the supported Wrangler config subset
..., and writes the deployment objects directly".

docs/README.md: "Each node reads `deploy/current.json` every `CELLD_DEPLOY_POLL_S` seconds (default 30) and adopts a new
deployment in place. `POST /reload` on the internal listener adopts it now".

Deploy example: `celld deploy . --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"`

durable-objects.md: "A `migrations` entry accepts `tag` and `new_sqlite_classes` only. A class rename, a class delete,
and a class transfer stop the deployment."

Compatibility flags honoured: `delete_all_deletes_alarm`, `js_rpc`, `fetcher_no_get_put_delete`, `sqlite_vec`,
`websocket_standard_binary_type`, static-assets navigation flags. "celld accepts every other flag without effect."

### 1.5 Supported services and listed gaps (cloudflare-compat.md, verbatim)

Services table:

| service | status |
| --- | --- |
| Workers | Yes |
| Durable Objects | Yes |
| Durable Object Facets | Yes |
| Containers | Experimental |
| Static assets | Yes |
| Cron Triggers | Yes |
| Dynamic Workers | Yes |
| KV | Yes |
| Queues | Yes |
| D1 | Yes |
| Workflows | Yes |
| R2 | Yes |
| Workers AI | No |
| Vectorize | No |
| Hyperdrive | No |
| Browser Rendering | No |
| Email Workers | No |
| Python Workers | Partial - `fetch` handlers on the Pyodide 0.28 runtime line |

Runtime APIs: Node.js compatibility Partial; Cache Partial; BroadcastChannel No; everything else listed Yes
(Fetch, Bindings, Context, Handlers, RPC, Streams, Encoding, WebSockets, Web Crypto, Web standards, WebAssembly,
Performance and timers, Console, HTMLRewriter, TCP sockets, EventSource, MessageChannel).

Listed gaps (verbatim bullets):

Fetch:
- The `cache` request option is unavailable.
- An inbound `Request` has a `cf` object without Cloudflare edge fields. celld cannot prove the geolocation, colo, or TLS metadata.
- celld removes `Content-Length` from a Worker response, except for a `HEAD` response.
- A remote Durable Object call cannot retry after request-body transmission starts because celld keeps no replay copy.
- A remote Durable Object call waits for a rejected owner generation to change for at most `CELLD_OPERATION_DEADLINE_MS`.

Bindings: "Only the binding types in the services table are available."

Context:
- `passThroughOnException()` has no effect because celld has no CDN fallback.
- `ctx.facets` is available only inside a Durable Object.

Handlers: "The `tail` and `email` handlers are unavailable."

RPC:
- An RPC stub cannot cross an isolate boundary.
- An `AbortSignal` in a Durable Object RPC call does not cross a node boundary.
- A remote RPC retries only when the failed peer attempt did not start the method. Use a stable operation ID for an application retry.

Streams:
- celld expires an unclaimed and inactive HTTP stream after 60 seconds. A successful stream operation starts a new 60-second period.
- An expired or unknown stream reports an error instead of EOF.

WebSockets: (outbound socket closes when event ends; 1 MiB per-isolate input budget; transport cannot move to a new
owner; `acceptWebSocket()` throws above 90 percent of the V8 heap limit; etc.)

Web Crypto: "ECDSA supports only the P-256 curve with SHA-256." "A secret key cannot use `jwk` with `exportKey()` or
`wrapKey()`." (plus HMAC/AES-GCM/RSA-OAEP/Ed25519/X25519 notes)

Performance and timers: "`performance.timeOrigin` is `0`, and `performance.now()` matches `Date.now()`. Both clocks
advance at an I/O boundary and stay fixed during JavaScript execution."

Node.js compatibility:
- celld implements `node:assert`, `node:async_hooks`, `node:buffer`, `node:diagnostics_channel`, `node:events`, `node:fs`, `node:os`, `node:path`, `node:stream`, `node:timers/promises`, and `node:util`.
- `node:crypto` does not implement Diffie-Hellman, streaming signatures, ciphers, RSA-PSS, or DSA signatures and key generation.
- `node:zlib` implements only the synchronous gzip and deflate functions.
- "An import of another Node.js module succeeds, but its first call throws an error."
  [inference] node:net / node:tls are not in the implemented list, so Postgres drivers must use `cloudflare:sockets`.

Cache: "celld provides an always-miss cache because it has no shared edge cache."

TCP sockets:
- A socket cannot outlive its event. A Durable Object must reconnect during a later event.
- celld verifies a TLS server against its bundled Mozilla root store.
- celld does not block the destination ports that Cloudflare blocks. The fleet network controls the egress policy.

BroadcastChannel: "The class exists so that a bundle can load, but its constructor throws."

Workers service doc: "celld runs many requests in one isolate and retires isolates at any time, so a Worker must keep
its state in a binding, not in module scope." "celld does not supply a Workers AI binding."
https://github.com/denoland/celld/blob/main/docs/services/workers.md

### 1.6 Durability model

guarantees.md: "celld makes two promises. Exactly one node serves a cell at a time, so two machines never write the
same database. celld does not acknowledge a write until the write survives a failure, so an acknowledged write is never
lost. Both promises require a bucket with working conditional writes and ranged reads, and a supervisor that restarts
the process."

Ownership: "Each cell has one ownership record in the bucket. It names the owner node's session and carries a fencing
epoch. A node acquires a cell with a conditional create when no record exists, or a compare-and-swap on an existing
record, so two nodes cannot acquire the same cell. Every activation, a takeover or a local wake, advances the epoch, so
an epoch never has two writers."

LTX: "The replicator copies each cell's SQLite data to `cells/<cell>/ltx/e<epoch>/` with unconditional PUTs. The epoch in
the key is the fence: a node that lost ownership can keep writing, but only into a superseded prefix, and a restore
selects the current lineage."

Acknowledgement rule (RPO=0): "A gate holds each response until a durability proof covers every write it can reveal:
a write response; a read-only response when the object has an uncovered committed write; an error response ...; an R2
mutation ...; a raw TCP connect, write, TLS upgrade, or shutdown; and each chunk of a streamed body."
"After a bucket proof, celld reads the ownership record once and acknowledges only if it still names this node at this
epoch."
"A fleet proof needs no such read. The owner sends each write to one or two other nodes, its followers (together, the
ensemble), and every follower must fsync it."

"A node never counts itself as a follower, and one follower is enough, therefore a fleet needs two running celld nodes
before any node can complete a fleet proof. `CELLD_DURABILITY=fleet` is the default, so a one-node fleet requests the
fleet posture and does not get it."
"A node recruits up to two followers, so a fleet of three or more nodes holds three copies of an acknowledged write.
... Until then, a write that is not yet in the bucket is only on the owner and on that one follower."

Lease / self-fencing: "Each node holds a lease in the bucket with an expiry, renewed after one third of the lifetime
(`CELLD_TTL_MS`, default 10000 ms). ... When the expiry passes, the node fences itself: it stops each active cell and
fails every incomplete request."

Takeover recovery: "A cold activation checks the prior owner's log records before it reads the bucket. ... An open or
recovering record forces recovery before the restore". Recovery limits listed include: "A follower's HTTP error does not
prove its data is absent, even when its lease has expired, so persistent errors can block recovery and startup."
"Recovery of a large dead node can take minutes." Requests "fail with a resolve error only after
`CELLD_RECOVERY_RETRIES` (default 240) attempts" (retry `CELLD_RECOVERY_RETRY_MS`, default 1000).

Graceful shutdown (docs/README.md): SIGTERM hands cells off; `CELLD_SHUTDOWN_TOTAL_MS` default 40000.
"A remote call to a cell that is changing owner waits for the new owner, for at most `CELLD_OPERATION_DEADLINE_MS`
(default 15000)."

Alarms: "celld does not answer a successful `setAlarm()` until a durable wake entry in the bucket covers the alarm."
(durable-objects.md) Wake cleanup interval "defaults to 60 seconds; `CELLD_WAKER_TICK_MS` sets it and the due-scan
interval." (guarantees.md)

### 1.7 Documented numbers

testing.md "A few numbers we trust" (verbatim):
- "A request to a resident cell does zero bucket operations and returns in p50 ~1.1 ms and p99 ~7 ms (a fixed-host measurement)."
- "A lab fleet measured about 600 ms for a bucket proof and about 25 ms for a fleet proof."
- "The measured restore times come from the retired external replicator, so this page gives no number until a fleet run measures `celld-ltx`."
- "Ten nodes, each with 4 vCPU and 8 GB, held 10,000 resident cells and 20,000 concurrent WebSocket connections. With two of the ten nodes stopped, every cell was available again on another node in ~11 s at the tail (with reserve headroom)."
- "Five hundred concurrent claimants made 5,500 attempts on the same cells: one writer for each epoch, zero violations."

Repo README: "A write to a region-local store takes about 90 ms. One loaded lab fleet measured about 600 ms against a
store that was not region-local, and about 25 ms once a second node held the write."

celld.dev homepage (verbatim figures): "Durable write latency (one node, region-local) ~90 ms"; "Failover after node
loss, 0 lost ~20 s"; "Stateless request p50 / p99 0.2 / 0.3 ms"; "Stateless throughput / worker thread ~94k req/s";
"Wake a hibernated cell ~4 ms"; "RAM per resident cell 0.47 MB"; "Resident cells / 8 GB node 2,500 cells";
"$ / resident cell-month ~$0.02".

docs/README.md (same repo, differs from homepage): "One 8 GB node holds 1,000 resident cells, so one resident cell costs
approximately $0.05 each month."

testing.md methodology: differential tests vs workerd; TLA+ specs ("Heyang Zhou wrote the specifications against celld
v0.1.0. His model checking found four bugs and a split-brain that lost an acknowledged write. All are fixed."; "They do
not run in continuous integration."); deterministic simulation; live-fleet fault injection ("Across every run of every
scenario, the verification sweeps show zero body faults, zero status faults, and zero lost messages.").

## 2. celld D1

services/d1.md (verbatim):
"celld gives each database its own SQLite file inside one cell."
Repo README: "A KV namespace, a queue, a D1 database, and a Workflow are each a cell, so they get the same lease, the
same replication, and the same failover as a Durable Object."

"A `d1_databases` entry gives a `binding`, a `database_name`, and a `database_id`. celld uses the `database_id` as the
identity, or the `database_name` when the entry has no id. ... celld creates a database on first use, so a typo in the
name opens an empty database and does not cause an error."

"celld enforces these D1 limits: a statement of at most 100,000 bytes, at most 100 bound parameters, at most 100
columns in a table, and a string, a `BLOB`, or a row of at most 2,200,000 bytes."

"Every statement goes to the node that owns the database cell, so each call costs one cell dispatch. Group related
statements in one `batch()`, which costs one dispatch for all of them. ... An acknowledged write survives the loss of
the owner node."

"Application SQL cannot use `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `ATTACH`, `DETACH`, `VACUUM`, `load_extension()`,
or a temporary table, index, trigger, or view. celld allows the `fts5` and `fts5vocab` virtual tables".

Differences from Cloudflare (verbatim):
- A binding result can contain at most 100,000 rows or 32 MiB.
- A SQLite `TEXT` value that is not valid UTF-8 decodes with the replacement character U+FFFD, as workerd decodes it, and the stored bytes do not change. Store arbitrary bytes in a `BLOB`.
- A database has one writer. Use more databases to increase write capacity.
- celld has no read replica. `withSession()` always selects the primary, and `getBookmark()` returns `celld:primary`.
- A read-only statement reports `last_row_id` and `changes` as `0`. Cloudflare reports the values that the previous write left on the connection.
- `prepare()` accepts exactly one statement.
- `exec()` counts each statement. Cloudflare counts each input line.
- `dump()` throws. The database is a SQLite file in the operator's own bucket.
- Application SQL cannot use `BEGIN`, `SAVEPOINT`, `ATTACH`, `VACUUM`, `load_extension()`, or a temporary table.
- celld has no D1 REST API and no Time Travel. Use `celld d1` for SQL and for migrations.

CLI: `celld d1 migrations apply ledger --bucket s3://my-cells-bucket` (runs through a live node).
Open issue #272 "Add --local for D1 migrations" (2026-10-13): https://github.com/denoland/celld/issues/272

## 3. celld Durable Objects (SQL, transactionSync, alarms)

services/durable-objects.md (verbatim):
"A class that a `new_sqlite_classes` migration declares can use the key-value methods and `ctx.storage.sql.exec()`. The
`transactionSync()` callback receives no argument, as in workerd, and a throw rolls it back. A transaction can start a
nested transaction; a failed nested transaction discards only its own writes, and the enclosing transaction can still
commit."
"`storage.setAlarm()`, `getAlarm()`, and `deleteAlarm()` manage one alarm per object, and celld calls the
`alarm(alarmInfo)` handler."
"In a fleet of two or more nodes, the owner answers when each of its one or two followers holds the write on disk, and
the bucket upload follows. On a single node, every write waits for the object store."

Differences (selected, verbatim):
- celld makes no placement, migration, or jurisdiction promise. ... `newUniqueId({ jurisdiction })` and `namespace.jurisdiction()` throw.
- The key of a namespace contains the script name, so a rename of the script changes every id that `idFromName()` derives.
- A Durable Object event keeps pending I/O active after the handler returns, so a timer or a subrequest does not require `ctx.waitUntil()`.
- `storage.sync()` waits for the object store or the fleet ensemble to hold all earlier committed writes. The operation uses the shorter of the 10-second `CELLD_LTX_DURABILITY_TIMEOUT_SECS` default and the 15-second `CELLD_OPERATION_DEADLINE_MS` default.
- A transaction and `blockConcurrencyWhile()` have a 30-second limit. A timeout resets the object and rolls back an open transaction.
- Outside an explicit transaction, a SQL write cursor must finish before a response, an outbound effect, or `storage.sync()`. An unfinished `RETURNING` cursor holds uncommitted writes, so celld rejects that output with an error.
- `SqlStorage.Cursor.toArray()` gives a celld-specific error near the V8 heap limit.

## 4. workerd

### 4.1 Release and packaging

`gh release list -R cloudflare/workerd` (2026-10-16): latest v1.20261015.1, published 2026-10-15T01:04:37Z.
Assets: workerd-darwin-64.gz, workerd-darwin-arm64.gz, workerd-linux-64.gz, workerd-linux-arm64.gz, workerd-windows-64.gz.
https://github.com/cloudflare/workerd/releases/tag/v1.20261015.1
Licence: Apache-2.0 (gh api).

README: "workerd is tested on: ... Linux and macOS (x86-64 and arm64 architectures)".
"Prebuilt binaries are distributed via `npm`. Run `npx workerd ...` to use these." Linux needs "glibc 2.35 or higher".
"arm64 CPU with CRC extension (enabled by default under armv8.1-a)".
"`workerd`'s version number is simply a date, corresponding to the maximum compatibility date supported by that version."
README warning: "`workerd` is not a hardened sandbox".

Docker: no official image found. Issue #46 "Support for running via a docker image?" (closed) - mrbbot 2023-06-30 gave a
Dockerfile `FROM node:18 ... RUN npm install workerd@beta ... CMD ["./node_modules/.bin/workerd", "serve", "config.capnp"]`;
a 2025-12-03 comment asks for an official image. https://github.com/cloudflare/workerd/issues/46
ghcr.io/cloudflare/workerd: registry returned 401 (no public image found).

### 4.2 Durable Objects in workerd (single instance)

workerd.capnp (main, 2026-10-16), DurableObjectNamespace:
```
className @0 :Text;
union {
  uniqueKey @1 :Text;
  ephemeralLocal @2 :Void;
}
preventEviction @3 :Bool;
# By default, Durable Objects are evicted after 10 seconds of inactivity, and expire 70 seconds
# after all clients have disconnected. ...
enableSql @4 :Bool;
# Whether or not Durable Objects in this namespace can use the `storage.sql` API to execute SQL
# queries.
#
# workerd uses SQLite to back all Durable Objects, but the SQL API is hidden by default to
# emulate behavior of traditional DO namespaces on Cloudflare that aren't SQLite-backed. This
# flag should be enabled when testing code that will run on a SQLite-backed namespace.
container @5 :ContainerOptions;
```

```
durableObjectStorage :union {
  none @9 :Void;
  # Default. The worker has no Durable Objects. ...
  inMemory @10 :Void;
  # The `state.storage` API stores in-memory only. ... This mode is intended for local testing purposes.
  localDisk @12 :Text;
  # ** EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE **
  #
  # Durable Object data will be stored in a directory on local disk. This field is the name of
  # a service, which must be a DiskDirectory service. For each Durable Object class, a
  # subdirectory will be created using `uniqueKey` as the name. Within the directory, one or
  # more files are created for each object, with names `<id>.<ext>` ... (Currently, the main storage
  # is a file with the extension `.sqlite`, and in certain situations extra files with the
  # extensions `.sqlite-wal`, and `.sqlite-shm` may also be present.)
}

# TODO(someday): Support distributing objects across a cluster. At present, objects are always
#   local to one instance of the runtime.
```

Config shape (assembled from the schema and the D1 test below; keys verbatim):
```
services = [
  (name = "do-storage", disk = (path = "/data/do", writable = true)),
  (name = "app", worker = (
     compatibilityDate = "...",
     modules = [ (name = "worker.js", esModule = embed "worker.js") ],
     durableObjectNamespaces = [ (className = "Counter", uniqueKey = "<random>", enableSql = true) ],
     durableObjectStorage = (localDisk = "do-storage"),
     bindings = [ (name = "COUNTER", durableObjectNamespace = "Counter") ],
  )),
]
```
[inference] `disk = (path = ..., writable = true)` is the DiskDirectory service form; the D1 test uses
`( name = "TEST_TMPDIR", disk = (writable = true) )` and miniflare uses `disk: { path: persistPath, writable: true }`.

Sample comment (durable-objects-chat/config.capnp, stale wording, older than localDisk): "As of this writing, `workerd`
supports in-memory-only Durable Objects -- so, not really "durable", as all data is lost when workerd restarts."

Cloudflare blog 2026-10-09 (Kenton Varda's post): "workerd has always had one big gap in its production-readiness:
Durable Objects. Workerd implements them, but only in a single-instance way, good enough for local testing, but unable
to scale."

transactionSync in workerd: not separately documented in the capnp; celld's DO doc says its `transactionSync()` behaves
"as in workerd", and celld runs a differential conformance suite against workerd (testing.md).

Alarms: open issue #7191 (2026-08-30) "Durable Object alarm firing under `durableObjectStorage = (inMemory = void)`
crashes the workerd process" - "With `durableObjectStorage = (localDisk = "<writable disk service>")` the same alarm
fires and completes cleanly." https://github.com/cloudflare/workerd/issues/7191
Other open DO storage issues: #959 "unused SQL cursors lead to strange errors" (2023-08-02, open)
https://github.com/cloudflare/workerd/issues/959 ; #7605 local deleteAll() and facets (2026-10-03, open).

### 4.3 D1 in plain workerd

workerd ships only the D1 client API as an internal wrapped-binding module, `cloudflare-internal:d1-api`
(src/cloudflare/internal/d1-api.ts), which calls a `D1BindingService` (`query(params: QueryRequest)`). The database
backend is NOT built into workerd; you provide a service that speaks that protocol.

workerd's own test wires it to a mock DO (d1-api-test.wd-test, verbatim):
```
( name = "d1",
  wrapped = (
    moduleName = "cloudflare-internal:d1-api",
    innerBindings = [(
      name = "fetcher",
      service = "d1-mock"
    )],
  )
)
...
( name = "d1-mock",
  worker = (
    compatibilityFlags = ["experimental", "nodejs_compat"],
    ...
    durableObjectNamespaces = [ (className = "D1MockDO", uniqueKey = "...") ],
    durableObjectStorage = (localDisk = "TEST_TMPDIR"),
```
https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/test/d1/d1-api-test.wd-test

Miniflare does the same: binding `wrapped: { moduleName: "cloudflare-internal:d1-api", innerBindings: [{ name: "fetcher", service: ... }] }`
backed by a `D1DatabaseObject` worker with `compatibilityFlags: ["nodejs_compat", "experimental"]` and
`durableObjectStorage: { localDisk: D1_STORAGE_SERVICE_NAME }`.
https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/plugins/d1/index.ts
[inference] Plain workerd can host D1 only if you extract or reimplement miniflare's D1DatabaseObject worker; whether
the `experimental` flag (and workerd's experimental mode) is required for d1-api itself was not verified.

### 4.4 Hyperdrive and outbound network in workerd

workerd.capnp binding:
```
hyperdrive :group {
  designator @18 :ServiceDesignator;
  database @19 :Text;
  user @20 :Text;
  password @21 :Text;
  scheme @22 :Text;
}
# A binding for Hyperdrive. Allows workers to use Hyperdrive caching & pooling for Postgres
# databases.
```
Miniflare maps a dev Hyperdrive connection string to that binding with the designator pointing at
`external: { address, tcp: {} }`; for `sslmode` other than `disable` it starts a local Node proxy:
"SSL modes (require, prefer) need the proxy to handle TLS negotiation with the target database".
https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/plugins/hyperdrive/index.ts
[inference] In plain workerd the Hyperdrive binding is a direct TCP passthrough with no pooling or caching, and a
TLS Postgres target (Supabase) needs either sslmode=disable or your own TLS-handling sidecar.

Outbound network (workerd.capnp): "If you do not define any service called "internet", one is defined implicitly,
representing the ability to access public internet servers." Explicit form:
`( name = "internet", network = ( allow = ["public"], tlsOptions = (trustBrowserCas = true) ) )`.
Network: "allow @0 :List(Text) = ["public"]; ... The default allows publicly-routable IP addresses only, in order to
prevent SSRF attacks." "To prevent SSRF, by default Workers will not be permitted to reach internal network addresses
using global fetch()".
[inference] fetch() to public HTTPS (Turso, Supabase) works by default; fetch() to a container on a Docker bridge
(private range) needs an ExternalServer binding or a network service with allow = ["public", "private"].

## 5. Issues, write-ups, counter-evidence

celld issue list (gh issue list, open and closed, 151 issues total at 2026-10-16). Relevant:

Open:
- #273 (2026-10-13) "Production on v0.6.2: a store stall fences every node at once; recovery wedges in "refusing to seal" and ends in bounded loss" https://github.com/denoland/celld/issues/273
  "When our S3-compatible store stalls for longer than the node lease TTL, every node fails to renew in the same window
  and self-fences. ... Most of the dead node-log sessions then refuse to seal indefinitely, and every cell they owned is
  unreachable." "This has happened three times in 11 days. Raising `CELLD_TTL_MS` from 10 s to 30 s did not prevent the
  third." "Every wedged session in every incident ended in `declared bounded loss` once its old addresses went away."
  Setup: Railway S3-compatible storage, 2 fleets x 3 nodes, CELLD_NODE unset, ephemeral CELLD_WATCH.
- #245 (2026-10-01) "A declared bounded loss reuses the seqs of acknowledged writes; a 3-node fleet keeps a one-follower ensemble; no operator path out of 'refusing to seal'" https://github.com/denoland/celld/issues/245
  Uses MinIO. "With three nodes and stable ids, the owner's ensemble held one follower in all five runs" ;
  "owner alone: 1,501 lost"; "deleting the dead owner's record in the bucket: silent loss (1,440 lost, no loss record,
  no log line)". (v0.6.2 release notes list "#245: A fleet with one follower recruits a second one when a peer becomes
  available" as fixed; the issue remains open.)
- #244 "Docs: without CELLD_NODE, or with one node restarted alone, a restart after a fleet-wide fence loses acknowledged writes or wedges recovery" https://github.com/denoland/celld/issues/244
  Repro: v0.6.0, two nodes, MinIO, "iptables -I INPUT -p tcp --dport 9000 -j DROP on the MinIO host for 30 s".
- #274 (2026-10-14) "Durable Object SQL: bound the time of a single `ctx.storage.sql.exec()` statement" https://github.com/denoland/celld/issues/274
- #276 (2026-10-14) "Failed Durable Object startup leaks restored SQLite epochs and hot-loops overdue alarms" https://github.com/denoland/celld/issues/276
- #256 "Alarms get created when others are still running" https://github.com/denoland/celld/issues/256
- #258 "Durable Object: an outbound call from a continuation of an ended request, woken by another event, never settles" ("workerd runs every case.") https://github.com/denoland/celld/issues/258
- #238 "fetch() does not decompress gzip responses" https://github.com/denoland/celld/issues/238
- #230 "Let TLS sockets trust additional roots, as `fetch()` does": "`fetch()` verifies servers against: the Mozilla roots, the OS trust store, `SSL_CERT_FILE`. TCP sockets verify against the Mozilla roots only ... That blocks database drivers such as `pg`, which upgrade with `startTls()`." https://github.com/denoland/celld/issues/230
- #265 "celld dev: each list of the local store reads the whole objects.sqlite3, so a cold cell start takes about 20 s on a 4.7 GB store"
- #266 "What is the state of testing (functional and performance) for this project?" (no comments) https://github.com/denoland/celld/issues/266

Closed data-integrity bugs:
- #150 "Data loss when multiple large transactions are batched into one replication segment (-> permanent RestoreFailed)" closed 2026-08-19 https://github.com/denoland/celld/issues/150 ("Silent RPO=0 violation - discovered only at restore")
- #158 "database corruption after eviction" closed 2026-08-20 https://github.com/denoland/celld/issues/158
- #146 "An acknowledged alarm arm can lose its wake entry" (closed)
- #142 "Alarm-driven Durable Object writes aren't durability-gated / owner-node loss drops un-flushed alarm history" (closed)
- #162 "S3 first deploy fails creating missing deployment pointer on MinIO" (closed)
- #226 "Nested transactionSync() calls fail through the root storage handle" (closed)

Upgrade notes (docs/README.md): several upgrades are "stop all" (v0.1.0 to v0.2.0, v0.3.0 to v0.4.0, v0.5.1 to v0.6.0
with fleet durability): "A v0.6.0 node refuses to start against a v0.5.1 follower."

External write-ups:
- HN thread https://news.ycombinator.com/item?id=49185430 (286 points, ~70 days before 2026-10-16) [paraphrase via
  WebFetch summary]: concerns that segment writes are plain PUTs, that S3 becomes the control plane, correctness on
  MinIO; a request for benchmarks vs Cloudflare DO; kentonv said celld is ahead of workerd on distributed scheduling.
- The Register, 2026-08-12, Joab Jackson [via WebFetch]: Dahl's estimate "100 resident Durable Object cells cost $415 a
  month on Cloudflare, whereas the celld implementation would run only about $49 a month, built on a DigitalOcean
  S3-compatible bucket on an 8 GB droplet"; Cloudflare spokesperson: "$415 a month would be the cost if all the objects
  were continuously active", dormant "$20.65".
  Note: celld's own guarantees.md now says DigitalOcean Spaces does not implement the required conditional writes.
- reptile.haus [via WebFetch]: no independent measurements; treats cost claims "as directional rather than a benchmark".
- No independent latency/throughput benchmark of celld found.
