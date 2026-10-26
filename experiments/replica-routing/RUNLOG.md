# replica-routing RUNLOG

Chronological record of what was run. Project refs, org slugs and the
vantage's address are not recorded; the published artifact is the redacted
copy under `out/2026-10-10/` (one value removed by hand, see the note under
"Published artifact").

Vantage for every figure below unless stated: one workstation in Singapore
(the load balancer's own log names the Cloudflare colo as `SIN`). Docs claims
are quoted separately from what was measured and marked "docs".

Sources for the docs claims:

- https://supabase.com/docs/guides/platform/read-replicas (API load
  balancer, geo-routing, `get: true`, Redirect Identifier in logs)
- https://supabase.com/docs/guides/platform/read-replicas/getting-started
  (Small compute floor, physical backups, replica count)
- https://supabase.com/blog/read-replicas-vs-bigger-compute (dated
  2026-01-15: "routes GET requests to the nearest replica", "European latency
  drops from 150ms to 20ms", `max_standby_streaming_delay` "default: 30
  seconds")
- https://github.com/orgs/supabase/discussions/34494 (geo-routing replaced
  round-robin; the docs date the change to 4 April 2025)

## 2026-10-10 - RR01, final run (the published run)

Shape: one Pro-org project, primary ap-northeast-1 (Tokyo) on Small compute,
`pitr_7` add-on, one read replica in ap-southeast-1 (Singapore). The replica
is the near database for this vantage. n = 1 project, 1 run; per-row n in the
rows. Artifact: `out/2026-10-10/run-2026-10-10T06-40-49-759Z.json` (28 rows:
8 pass, 20 info, 0 fail). The module started 06:40 UTC and had torn down by
07:08 UTC (27 min). Module rows below are quoted from the artifact's facts file
(`run-2026-10-10T06-40-49-759Z.facts.md`) unless marked otherwise.

### Lifecycle

- RR01a: `POST /projects` with `desired_instance_size: small` and
  `region_selection: specific ap-northeast-1` answered 201; the project row
  and the `db`, `rest` and `pooler` health services read ACTIVE_HEALTHY 11 s
  after the create call.
- RR01b: `PATCH billing/addons` `pitr_7` answered 200 (add-ons before:
  `ci_small`); schema applied through `POST /database/query`, 201.
- RR01d: `POST read-replicas/setup {read_replica_region: ap-southeast-1}`
  answered 204 on the first attempt. A `READ_REPLICA` entry appeared in
  `GET config/database/pooler` and answered `pg_is_in_recovery() = true` on its
  first connection, both at 271 s. Two exploratory runs on the same shape read
  roughly 150 s; that came from a console log that was not kept, so no
  artifact backs it. Treat 271 s as the one published figure on this shape,
  not a distribution.
- RR01p: `POST read-replicas/remove {database_identifier}` answered 204 and
  the entry was gone from the pooler config on the first poll (0 s);
  `DELETE /projects/{ref}` answered 200. `GET /v1/projects` afterwards listed
  no `rr-` project.

### Which node served a GET (routing)

How "served by" is read: `public.rr_whoami()` returns `pg_is_in_recovery()`
and `pg_postmaster_start_time()`, called as `GET /rest/v1/rpc/rr_whoami` (what
`rpc(..., { get: true })` sends). `inet_server_addr()` was tried first and is
not usable: it returned the loopback address on the primary and on the replica
in an exploratory run (artifact local, not published).

- RR01e: the Management API returns neither the replica's REST host nor the
  load balancer's. The replica answered at `<identifier>.supabase.co` (the
  `identifier` field of the `READ_REPLICA` pooler entry), HTTP 200,
  `in_recovery = true`. `GET /platform/projects/{ref}/load-balancers` (the
  route the Dashboard calls) with the PAT answered 401
  `{"message":"Unsupported access token"}`, so a PAT cannot list the load
  balancer. The load balancer's host was found by trying
  `<ref>-<tag>.supabase.co` candidates: `<ref>-all.supabase.co` resolved and
  answered `rr_whoami`. In this run the loop stopped at the first hit, so the
  other candidates were not tried; an exploratory run tried `-lb` first and it
  did not resolve.
- RR01f (n = 40 GETs per target, interleaved, 250 ms apart): through
  `<ref>-all` the load balancer served 40 of 40 from the replica
  (`lb_replica_share` 1). Median latency from this vantage:

  | target | median ms |
  |---|---|
  | direct to the primary | 117.5 |
  | direct to the replica | 46.3 |
  | through the load balancer | 46.5 |

  Docs: GETs go to the nearest database; this vantage saw that, and the load
  balancer's latency matched the replica's. The blog's "150ms to 20ms" is a
  European example in other regions, not comparable; only the direction
  agrees. Response headers on the load balancer path carry no node identifier
  (header names are in the RR01f evidence).
- RR01g: `POST rpc/rr_whoami` through the load balancer (a stable function,
  no `get: true`) answered 200 from the primary. A `POST` insert through it
  answered 201 and the row was readable on the primary. Docs: non-GET goes to
  the primary; matches. Not run: Auth, Storage, Realtime and Functions paths
  through the load balancer (the docs say Auth is always the primary), a
  custom domain, and PostgREST `HEAD`/`OPTIONS`.
- RR01h1 to RR01h8: the same GET from an Edge Function invoked with
  `x-region`, 10 calls each. Which database served the load balancer GET:

  | x-region | load balancer served |
  |---|---|
  | ap-northeast-1 | primary (10 of 10) |
  | ap-southeast-1 | replica (10 of 10) |
  | ap-southeast-2 | replica (10 of 10) |
  | ap-south-1 | replica (10 of 10) |
  | sa-east-1 | replica (10 of 10) |
  | eu-west-1 | primary (10 of 10) |
  | us-east-1 | primary (10 of 10) |
  | us-west-1 | primary (10 of 10) |

  The latency columns in those rows come from 9 timed calls after a cold first
  call, through an Edge Function runtime, and are not interpreted here (they
  are in the facts file).
- RR01o: what the load balancer recorded. `GET /analytics/endpoints/logs`
  against the `edge_logs` source returned, for 152 load balancer rows, the
  attributes `load_balancer_geo_aware_info.available_supabase_regions`
  (`["NRT","SIN"]`), `load_balancer_geo_aware_info.chosen_supabase_region`,
  `request.cf.colo` and `load_balancer_redirect_identifier` (151 rows carry a
  chosen region, 152 a redirect identifier). Docs: the redirect identifier is
  `metadata.load_balancer_redirect_identifier`; here it is a log attribute
  named `load_balancer_redirect_identifier`, value `<ref>.supabase.co` for the
  primary and `<ref>-rr-<region>-<5 chars>.supabase.co` for the replica. The
  Cloudflare colo, the region chosen and the identifier agree with RR01f and
  RR01h:

  | request.cf.colo | chosen region | redirect identifier |
  |---|---|---|
  | SIN (this workstation, n = 71; Edge Function, n = 10) | SIN | replica |
  | SYD, BOM, GRU (n = 10 each) | SIN | replica |
  | NRT, DUB, IAD, SJC (n = 10 each) | NRT | primary |

  The one `POST` row (the RR01g RPC) has no geo fields and the primary's
  identifier. Inference, not separated by this run: the choice follows the
  request's Cloudflare colo among the regions that hold a database, so it
  depends on where the request enters Cloudflare, and the client's address or
  measured latency are not the inputs shown. A client on a different network
  path can enter at another colo. The run cannot tell a distance rule from a
  fixed colo table.

### Read-your-writes

Caveat first: every write here goes to Tokyo from Singapore, so the client
takes longer to come back than replication takes to arrive (the `POST` median
is in the RR01i table). These rows bound the gap a client of this shape sees;
they do not measure replication delay itself.

- RR01i (n = 30): insert on the primary's own endpoint, then `GET` the row
  from the replica's endpoint immediately. 0 of 30 first reads missed the row.
  Time from the `POST` response to the first read that saw it, in ms:

  | median | p95 | maximum | read round trip, median | `POST` round trip, median |
  |---|---|---|---|---|
  | 36.6 | 113.5 | 223 | 36.6 | 122.2 |

  The visible time is the read's own round trip: the row was already there.
- RR01j (n = 30): `POST` through the load balancer, then `GET rr_whoami`
  through it. The first GET was served by the replica 30 of 30 and had the
  row in 30 of 30.
- RR01k (n = 40): per-insert delay from the two database clocks (insert on the
  primary through a session pooler connection; the replica polled with
  `clock_timestamp()`). In ms, except the last column:

  | first poll that saw the row: median | p95 | maximum | median last-missing poll (inserts with a miss) | poll round trip, median | most polls for one insert |
  |---|---|---|---|---|---|
  | 41 | 44.3 | 655.5 | 648.5 | 7.3 | 83 |

  At most 2 of 40 inserts were above the p95 figure. The median in the table
  is mostly the primary insert's response travelling to the client before the
  first poll, so for 38 or more inserts it is a ceiling on the delay, not the
  delay. The maximum is a real delay of that order for at least one insert.
  The two clocks are on different hosts, so skew is inside every figure here.
  The cause of the outlier was not examined.

### max_standby_streaming_delay and conflict cancellation

- RR01l: `pg_settings` on both nodes: `max_standby_streaming_delay` 30 s
  (30000 in the setting's millisecond unit, source `default`),
  `max_standby_archive_delay` 30 s (default), `hot_standby_feedback` off
  (default), `statement_timeout` 120 s (configuration file), `hot_standby` on
  for the replica and off for the primary, `max_wal_senders` 10. The value
  found matches the docs figure (30 s, from the blog). On this fresh project
  the session-mode pooler accepted the password on the first attempt for both
  nodes (`session_pooler_auth_wait` 1 s).
- RR01m1 to RR01m3: on the replica, a repeatable-read transaction counted
  `rr_conflict` (50,000 rows) and then ran `select pg_sleep(100)`; 3 s later
  the primary ran `update rr_conflict set v = v + 1` and `vacuum rr_conflict`.
  All 3 replica statements were cancelled, SQLSTATE 40001, `canceling
  statement due to conflict with recovery`, DETAIL `User query might have
  needed to see row versions that must be removed.`
- RR01n1 to RR01n3: the same replica transaction against a primary
  `begin; lock table rr_conflict in access exclusive mode; commit`. All 3
  cancelled, same SQLSTATE and message, DETAIL `User was holding a relation
  lock for too long.`

  Seconds, per repetition (client clock when the error arrived; the "row
  visible" column is how long a row inserted on the primary right after the
  conflicting command took to appear on the replica's endpoint, polled at a
  0.7 s interval):

  | conflicting command | cancelled after, s | row visible after, s |
  |---|---|---|
  | update + vacuum | 31.1, 31.3, 31.6 | 30.8, 30.5, 31.3 |
  | access exclusive lock | 30.2, 30.2, 30.3 | 30.4, 30.2, 30.4 |

  The replay lag sampled during the stall stayed flat (822,920 bytes in the
  first vacuum run, 352 bytes in the first lock run; primary current LSN
  minus replica replay LSN), so replay on the replica was stopped, not slow.
  The stalled row is the largest read-your-writes gap measured: about the
  value of `max_standby_streaming_delay`, for a read served by a replica whose
  replay is blocked. The load balancer was not read during a stall (RR01j ran
  before the conflicts), so whether it keeps sending GETs to a stalled replica
  is not measured.
- Why the vacuum cancellations run about 1 s longer than the lock ones is not
  separated: the vacuum case first replays an `update` of 50,000 rows (about
  11 MB of replay lag 1 s after the command, then flat), which may start the
  30 s timer later, or the timer may count from a different WAL record. n = 3
  each. `pg_stat_database_conflicts` on the replica read `confl_snapshot` 3
  and `confl_lock` 2 at the end of RR01n3, after 3 vacuum and 3 lock
  cancellations; its reads lag, so the counters are recorded and not used.
- `hot_standby_feedback` was off, so these are the platform defaults. Not run:
  the same conflicts with `hot_standby_feedback` on, a different
  `max_standby_streaming_delay`, a query that is idle in transaction rather
  than in `pg_sleep`, or a query through the Data API (which has its own
  statement timeout).

### Published artifact

`publish-evidence.ts` redacted refs and hostnames and found no ref-shaped
token left. One value was removed by hand before publishing: the
`set-cookie` response header in the RR01c and RR01f evidence carried a
Cloudflare bot-management cookie value, replaced with `<removed>`. The module
now writes `<removed>` itself.

## 2026-10-10 - exploratory runs before the final run (artifacts local, not published)

Used to find what the module needed; each is superseded by the final run.

- A: `GET /projects/{ref}/api-keys?reveal=true` answered 403 about 20 s after
  the create call although the project row read ACTIVE_HEALTHY; the module now
  waits on the health endpoint and retries the key read.
- B: a reuse run reset the project's database password through
  `PATCH /projects/{ref}/database/password` (200). A pooler connection then
  ended with `Connection terminated unexpectedly`; the unhandled client
  `error` event killed the process before an artifact was written. The
  module's pooler clients now handle that event.
- C and D: two more reuse runs reset the password the same way and waited 60 s.
  Both saw `password authentication failed for user "postgres"` on the
  primary's session pooler (Tokyo); run D also on the replica's. Run C's
  later conflict rows connected, minutes afterwards. A fresh project showed no
  refusal (RR01l), so this is recorded as a hazard of resetting a password,
  from 2 runs, with no propagation time measured.
- C measured conflict cancellation with a 5 s polling loop, so its times
  (36.2 s vacuum, 30.8 s lock) carry up to 5 s of polling error. From D the
  module timestamps the error when it arrives (31.2 s vacuum, 30.2 s lock).
- D gave the first view of the `edge_logs` attributes in RR01o. A logs query
  that used `split(...)[1]` among other expressions was refused with
  `Backend error! Retry your query.`; the same query with the raw user agent
  worked. The cause was not isolated to `split`.

## 2026-10-23 - RR02, re-routing on a lagging or unhealthy replica, and non-REST traffic

Shape: the RR01 shape again, two throwaway Pro-org projects, one per run, the
same day. Each: primary in ap-northeast-1 (Tokyo) on Small compute, `pitr_7`,
one Small read replica in ap-southeast-1 (Singapore), vantage one Singapore
workstation, so the load balancer's choice for this vantage is the replica
(RR01f). Small is the smallest size a replica accepts (`"minimum size of
small"`, sfp-platforms S07). Run 1 ran every phase; run 2 repeated the
stopped-replay, restart and remove phases, with a 20-minute watch after the
remove instead of 6 minutes. Artifacts (module rows quoted from the facts
files beside them):

- run 1: `out/2026-10-23/run-2026-10-23T07-57-32-539Z.json`, 07:57 to 08:21
  UTC (24 min), 17 rows, 4 pass, 13 info, 0 fail
- run 2: `out/2026-10-23/run-2026-10-23T08-22-50-864Z.json`, from 08:22 UTC
  (33 min), 10 rows, 4 pass, 6 info, 0 fail

Replica setup (RR02c) answered 204 on the first attempt in both runs; the
first session-pooler connection to the replica came 182 s (run 1) and 197 s
(run 2) after the setup call. The load balancer host was `<ref>-all` again.

### How a read is classified

Every timed read is `GET /rest/v1/rpc/rr_node` with the anon key: a stable
function that reads the newest row of `rr_marker` and returns
`pg_is_in_recovery()` (which node ran it), the postmaster start time, and
`stale_ms`, the node's `clock_timestamp()` minus that row's `written_at`.
While a phase runs, a session-pooler connection to the primary inserts a
heartbeat row every 250 ms, so a node that is keeping up reads a few hundred
ms, and a node whose replay has stopped reads the length of the stop. The two
clocks are on different hosts; skew is inside every `stale_ms`. When the
primary itself is down no heartbeat is written, so `stale_ms` then grows on
every node and measures time since the last write, not replica lag.

Three sources are read in parallel, one request at a time each with a 5 s
client timeout and 250 ms between requests: the load balancer host, the
replica's own host and the primary's own host. The harness `rest_read` probe
(`harness/src/real-probes.ts`: `pvlab_probe` row 1 with the anon key, up only
on HTTP 200 with that row) runs on the load balancer host beside them; its
failure counts match the `rr_node` reads on the same host in RR02g and RR02h
(0 and 0), are within 5 failures in RR02i, and within 14 and 25 in RR02j
(1.3 % and 0.6 % of `rest_read` samples). A "lagging" read is a replica read with
`stale_ms` above 2,000 ms, a threshold chosen for this module (eight
heartbeat periods), not measured. Per-5-second counts are in each row's
evidence; spans read from those buckets carry 5 s of resolution and are
marked "about".

Baseline (RR02e, 30 rounds): the load balancer served 30 of 30 reads from the
replica in both runs; largest `stale_ms` through the load balancer 353 (run
1) and 379 (run 2).

### Lagging replica: the load balancer keeps sending reads to it

- RR02g (run 1), write burst: a 1,500,000-row insert (about 530 bytes a row)
  on the primary through a session-pooler connection. It started at 15.8 s
  and failed at 35.5 s (19.7 s later) with `could not extend file
  "base/5/17717": No space left on device`: the Small project's disk filled
  before the insert finished, so the burst's WAL volume and duration were not
  recorded. Up to then the replica did not fall behind measurably: the
  largest `stale_ms` was 1,563 on the replica host and 1,426 on the primary
  host in the +25 s to +35 s buckets (the heartbeat insert itself slowed on the
  primary), and the sampled replay lag was 16,627,032 bytes at 16 s and 224
  bytes at 21 s. Nothing crossed the 2,000 ms threshold, so this method did
  not produce a lagging replica. Later phases on the same project ran
  normally (RR02h heartbeat: 924 rows, 0 errors). Whether the disk grew
  afterwards was not checked.
- RR02h, stopped replay (the method that worked): on the replica, a
  repeatable-read transaction counted `rr_conflict` and then ran
  `select pg_sleep(180)` with `statement_timeout = 0`; 3 s later the primary
  ran `update rr_conflict set v = v + 1` and `vacuum rr_conflict`. With
  `hot_standby_feedback` off, replay on the replica stops until the replica
  query ends or `max_standby_streaming_delay` cancels it (RR01m).

  Before that, RR02d set `max_standby_streaming_delay` to `600s` with
  `PUT /config/database/postgres` (HTTP 200 in both runs, config read back
  `600s`) and read `pg_settings` on both nodes once the project was healthy
  again. Run 1: replica `600000ms (configuration file)`. Run 2: replica
  `30000ms (default)`, primary `600000ms (configuration file)`. The same call
  had reached the replica in one of two runs at the time of the read; how
  long it takes to arrive was not measured.

  | run | replica query | replica host lagging (> 2,000 ms) | largest `stale_ms`, replica host | load balancer reads in that span | served by the replica, all lagging | served by the primary | errors |
  |---|---|---|---|---|---|---|---|
  | 1 | ran its 180 s, not cancelled | 174.6 s | 176,680 ms | 586 | 586 | 0 | 0 |
  | 2 | cancelled at 50 s, 31.4 s after the conflict at 18.6 s, SQLSTATE 40001 | 28.8 s | 30,842 ms | 98 | 98 | 0 | 0 |

  The largest `stale_ms` served through the load balancer was 176,772 ms
  (run 1) and 30,842 ms (run 2). In both runs the load balancer sent every
  read to the replica for the whole stop, and `rest_read` through it failed 0
  times (1,010 and 1,039 samples): a stale replica answers 200 with old data,
  and the load balancer did not move a read to the primary at any staleness
  reached here. When the replica query ended, the next 5 s bucket was back
  under 400 ms through the load balancer.

### Unhealthy replica: project restart

`POST /projects/{ref}/restart` (RR02i, HTTP 200 both runs) restarted both
nodes: the postmaster start time changed on the primary and on the replica in
both runs. The nodes went down one after the other, primary first:

| run | primary host failing (first fail to recovery) | replica host failing | load balancer failing | load balancer reads served by the primary |
|---|---|---|---|---|
| 1 | 17.1 s to 78.1 s (27 failed reads) | 50.7 s to 114.9 s (21) | 50.8 s to 115 s (21) | 0 of 334 |
| 2 | 17.6 s to 97.1 s (86) | 70.3 s to 133.2 s (31) | 70.4 s to 133.1 s (29) | 0 of 415 |

Times are seconds after sampling started; the restart call went out at 15 s.
"Recovery" is the sampler's: the first success followed by 30 s without a
failure (`settleMs`), so a later blip moves it.

- While the primary was down and the replica up (run 1 about 17 to 50 s, run
  2 about 17 to 70 s), reads through the load balancer kept succeeding from
  the replica; their `stale_ms` grew to 33,517 ms (run 1) and 52,578 ms (run
  2) because no heartbeat could be written, not because the replica was
  behind.
- While the replica was down and the primary up (run 1 about 65 to 100 s,
  run 2 about 85 to 120 s), the load balancer failed every read and sent none
  to the primary. Most of those reads ended in the 5 s client timeout, so
  there is about one sample per 5 s bucket in that span; the other failure
  texts were `HTTP 521` (a Cloudflare HTML page), `HTTP 503 upstream connect
  error or disconnect/reset before headers` and `HTTP 503 PGRST002`.
- The load balancer recovered when the replica did, in the same 5 s bucket,
  in both runs.

### Unhealthy replica: replica removed

`POST read-replicas/remove` (RR02j, HTTP 204 both runs) at 15 s; the
`READ_REPLICA` entry was gone from the pooler config at 15.2 s in both runs.

- The load balancer's last good read was at 15.8 s (run 1) and 15.9 s (run
  2) and its first failure at 16.1 s and 16.2 s. It never served a read from
  the primary afterwards: 0 of 1,034 reads from its first failure on (run 1,
  watched to 360 s; 1,089 in all, the other 55 served by the replica before
  that) and 0 of 4,103 (run 2, watched to 1,200 s; 4,158 in all, 55 before),
  while the primary host answered every
  read in the same windows (958 and 3,236 samples, 0 failures).
- Failure texts in order: `HTTP 521` (Cloudflare page) and client timeouts
  first, then `HTTP 400 Load balancer does not seem to be configured
  properly.` Run 2 answered that 400 continuously from 70.7 s to its last
  error at 1,199.8 s; run 1 alternated it with `HTTP 530` (Cloudflare page)
  from 92.9 s to the end of its 360 s watch.
- The load balancer's name kept resolving: run 2 checked it once a minute
  from 75 s to 1,215 s and it resolved every time.
- So for at least 1,185 s after the remove call (run 2: call at 15 s, watch
  ended at 1,200 s), a client using the load balancer endpoint got errors
  while the primary's own endpoint worked. Whether it ever starts serving the
  primary was not watched past 1,200 s.

### Auth, Storage, Realtime, GraphQL and Edge Functions through the load balancer (run 1)

RR02f1 to f6 sent each request to the primary host, the replica host and the
load balancer host. HTTP status, and for REST and GraphQL the node named by
`rr_node`:

| request | primary host | replica host | load balancer host |
|---|---|---|---|
| `GET rpc/rr_node` | 200 primary | 200 replica | 200 replica |
| `POST rpc/rr_node` | 200 primary | 400 | 200 primary |
| GraphQL `POST { __typename }` | 200 | 400 `Read replica does not handle POST requests for the path /gra` | 400 `Load balancer does not handle POST requests for the path /gr` |
| GraphQL `POST { rr_node }` | 200 primary | 400 | 400 |
| GraphQL `GET ?query={ rr_node }` | 404 `PGRST202` | 400 | 400 `Load balancer does not handle GET reques` |
| Auth `GET /health`, `GET /settings` | 200, 200 | 400, 400 | 200, 200 |
| Auth admin create user, password grant, `GET /user` | 200, 200, 200 | 400, 400, not sent | 200, 200, 200 |
| Storage list buckets, create bucket, upload, authenticated download | 200 each, body matched | 400 each | 200 each, body matched |
| Realtime join with Postgres Changes and broadcast self-echo, 3 tries | ok x3 | `ws error at handshake` x3 | ok x3 |
| Edge Functions `POST /functions/v1/<probe>` | 200, `x-sb-edge-region` ap-southeast-1 | 400 | 200, `x-sb-edge-region` ap-southeast-1 |

The error texts are cut where the module's 70-character limit cut them.
pg_graphql was enabled by the module (`create extension pg_graphql`);
GraphQL through the primary host works, so the load balancer's 400 is its own
refusal of the `/graphql/v1` path for both methods. The replica host served
only REST GETs.

Which node the load balancer sent them to, from `edge_logs` on the load
balancer host (RR02k, run 1, `load_balancer_redirect_identifier` per path
family; "none" means the row carries no identifier):

| family | rows | redirect identifier |
|---|---|---|
| Auth (GET 3, POST 2) | 5 | primary |
| Storage (GET 2, POST 2) | 4 | none |
| Realtime (GET, status 101) | 3 | none |
| GraphQL (POST 2, GET 1, all 400) | 3 | none |
| `rpc/rr_node` POST | 1 | primary |
| Edge Functions | 0 | no row on the load balancer host matched |

Storage and Realtime answered through the load balancer with no redirect
identifier logged, so the log does not name the node that served them; the
replica's host refuses both. Inference, not separated by this run: they go to
the project's primary services. The Auth rows name the primary. The Edge
Function call answered 200 through the load balancer but left no `edge_logs`
row on that host; where it was logged was not found.

The REST rows in RR02k agree with the timed reads: in run 1 the load
balancer redirected 2,502 `rr_node` GETs to the replica and 952 got the 400
with no identifier (the RR02j tail); in run 2, 1,549 and 4,077.

### Not settled by RR02

- Lag from write volume: the one burst filled the disk at 19.7 s without
  lagging the replica past 2,000 ms. A burst that fits the disk, or a larger
  disk, was not run, so whether write volume alone can lag a Small replica
  enough to matter is open. The stopped replay is the method that produced
  lag.
- A replica that is down while the primary and the load balancer config are
  untouched: the Management API has no per-replica restart (its OpenAPI
  document lists `/restart` per project only, as of 2026-10-23); `restart` takes down both
  nodes, and `remove` changes the load balancer's config. The replica-down,
  primary-up span inside RR02i, about 35 s per run, is the closest these runs
  got.
- Recovery of the load balancer endpoint after the last replica is removed:
  not seen within 1,200 s.
- Two runs, one region pair, one vantage. The load balancer's rule is still
  not visible; these runs show what it did not do (move reads off a stale or
  unreachable replica), not how it chooses.

## 2026-10-26 - RR03, user JWTs, RLS, keys and RPC routing on a replica; same-region split; lag under steady writes

Shape: two throwaway Pro-org projects, one per run, the same day. Each: primary
in ap-southeast-1 (Singapore) on Small compute, `pitr_7`, one Small read
replica in the SAME region, ap-southeast-1. Vantage: the Singapore
workstation (Cloudflare colo `SIN`) and Edge Functions invoked with
`x-region`. Client library: `@supabase/supabase-js` 2.118.0 (the npm latest
on 2026-10-26; the repo's dependency moved from 2.112.3). Artifacts (module
rows quoted from the facts files beside them):

- run 1: `out/2026-10-26/run-2026-10-26T00-23-57-221Z.json`, 00:23:57 to
  00:34:14 UTC, 14 rows, 4 pass, 10 info, 0 fail
- run 2: `out/2026-10-26/run-2026-10-26T00-34-24-787Z.json`, 00:34:24 to
  00:45:43 UTC, 15 rows, 4 pass, 11 info, 0 fail

Run 2 differs from run 1 in three module changes made between the runs (both
artifacts record lab commit 848b9f3; the module was uncommitted, so the
commit does not identify either version): no `signOut` after sign-in (see
RR03d), the RR03h order of nodes recorded as a sequence plus a `Connection:
close` variant, and the RR03k log poll waiting until the row total stops
growing. Replica setup answered 204 on the first attempt; the first
session-pooler connection to the replica came 166 s (run 1) and 170 s (run
2) after the call. The load balancer host was `<ref>-all` again.

### Schema and how a read is classified

`rr3_docs` has RLS on, one policy `for select to authenticated using
(tenant_id = (select auth.uid()))`, seeded with 3 rows for user A, 5 for user
B and 2 for a third tenant. Both users were created through the Auth admin
API on the primary host and signed in with a password grant there; their
access tokens are ES256 with a `kid`, `iss https://<ref>.supabase.co/auth/v1`
(RR03b). The node that ran a request is read from `pg_is_in_recovery()` in
the response:

- `rr3_docs_v`: a `security_invoker` view over `rr3_docs` adding
  `pg_is_in_recovery()` and `auth.uid()` per row, so RLS applies.
- `rr3_node()` (stable): node, `auth.uid()`, `current_user`.
- `list_docs_invoker()` (stable), `list_docs_volatile()` (volatile, reads
  only): node, `auth.uid()`, `current_user`, rows visible (`n`) and rows of
  another tenant visible (`foreign`).
- `list_docs_definer()` (stable, `security definer`, `set search_path = ''`):
  rows with `tenant_id = auth.uid()` (`n`) and all rows (`all_rows`).
- `touch()` (volatile, plpgsql): inserts a row into `rr3_touch`; on error it
  re-raises with the same SQLSTATE and message and a detail
  `in_recovery=<t|f>`, so the node that refused the write is named.
- `rr3_where`: a one-row view `select pg_is_in_recovery() as in_recovery`.
  A `HEAD` carries no body, so `HEAD ... rr3_where?in_recovery=eq.true` with
  `Prefer: count=exact` reads count 1 on the replica and 0 on the primary.

`edge_logs` on the load balancer host (RR03k) is the second, independent
record of where each request went.

### RR03d: user JWTs and RLS on the replica

For each user, on each host (load balancer, replica host, primary host), four
client patterns read `rr3_docs_v` and `rpc/rr3_node` (`get: true`): a
supabase-js client created with the `accessToken` option returning the user's
token; a client with `global.headers.Authorization: Bearer <token>`; a client
on which `auth.setSession({ access_token, refresh_token })` was called; raw
`fetch` with `apikey: <legacy anon JWT>` and the user's token as Bearer. A
capturing `fetch` recorded what supabase-js sent: `apikey` the legacy anon
JWT, `Authorization` the user's ES256 token, for both the `accessToken` and
the header pattern.

| read | load balancer | replica host | primary host |
|---|---|---|---|
| user A, `accessToken`, header or raw | 3 rows, uid A, 0 foreign | 3 rows, replica, uid A, 0 foreign | 3 rows, primary, uid A, 0 foreign |
| user B, same | 5 rows, uid B, 0 foreign | 5 rows, replica, uid B, 0 foreign | 5 rows, primary, uid B, 0 foreign |
| anon key only | 0 rows; `rr3_node` uid null, role anon | same, on the replica | same, on the primary |

Both runs, the three patterns in the table (`setSession` below). Through the load balancer the node varied from
read to read (RR03h), and the rows and `auth.uid()` were the same whichever
node served. So RLS and `auth.uid()` behaved identically on the replica for
an ES256 user token.

- `auth.setSession`: run 2 `ok` on the load balancer host and the primary
  host, and the next read returned the user's rows. On the replica host it
  failed in both runs with `Failed to parse JSON` (the body was not JSON;
  RR02f recorded 400 for Auth paths on the replica host, and RR03 did not
  record the status), and the read after it went out with the anon key as
  Bearer and returned 0 rows with no error. Run 1 failed on the load
  balancer and primary hosts with `Auth session missing!` (status 400 on the
  supabase-js error object; `edge_logs` recorded HTTP 403 for the two load
  balancer attempts) and on the replica host with `Failed to parse JSON` as
  in run 2: the module had called `signOut({ scope: "local" })` after each
  sign-in, which sends `POST /auth/v1/logout` and ends the session on the
  server (`edge_logs` recorded `GET /auth/v1/user` 403 for the two load
  balancer attempts). That was a module bug, fixed for run 2; the run 1
  `setSession` rows are not a platform finding.
- `signInWithPassword` on a client created on the load balancer host: ok
  both runs, the token's `iss` is the primary host
  (`https://<ref>.supabase.co/auth/v1`), and that token read as user B on the
  replica host. On the replica host: `Failed to parse JSON` both runs.

### RR03e: keys and token types

`GET rpc/list_docs_invoker` with each header combination on each host. Every
combination answered 200 on all three hosts in both runs, with the same role
on each:

| apikey | Authorization | role, rows seen |
|---|---|---|
| legacy anon JWT (HS256) | same | anon, 0 |
| `sb_publishable_` | none | anon, 0 |
| `sb_publishable_` | `Bearer sb_publishable_...` | anon, 0 |
| `sb_publishable_` or legacy anon JWT | user A's ES256 token | authenticated, uid A, 3 |
| `sb_publishable_` or legacy anon JWT | user A's claims signed HS256 with the legacy JWT secret | authenticated, uid A, 3 |
| legacy service_role JWT | same | service_role, 10 |
| `sb_secret_` | none | service_role, 10 |

The HS256 token was minted by the module from user A's claims with the
legacy secret, which `GET /v1/projects/{ref}/postgrest` returned as
`jwt_secret` in both runs; an HS256 token issued by Auth itself was not
tested (new projects sign with ES256). supabase-js 2.118.0 created with the
publishable key sent `apikey` and `Authorization: Bearer` both set to the
publishable key with no session, and the user's token as Bearer with the
`accessToken` option; both answered as above on all three hosts.

### RR03f: RPC routing by volatility and method

supabase-js on the load balancer host, user A by `accessToken`, 5 calls each
with `rpc(fn, {}, { get: true })` (GET) and `rpc(fn)` (POST). Node counts are
replica / primary:

| function | GET run 1 | GET run 2 | POST (both runs) |
|---|---|---|---|
| `rr3_node` (stable) | 1 / 4 | 1 / 4 | 0 / 5 |
| `list_docs_invoker` (stable) | 3 / 2 | 2 / 3 | 0 / 5 |
| `list_docs_definer` (stable, definer) | 3 / 2 | 2 / 3 | 0 / 5 |
| `list_docs_volatile` (volatile, read only) | 1 / 4 | 2 / 3 | 0 / 5 |
| `touch` (volatile, writes) | 405 `25006` 3 / 2 | 405 `25006` 3 / 2 | 0 / 5, HTTP 200 |

- Every GET except `touch` answered 200 on whichever node served it. The
  volatile read-only function served by GET on the replica as well as the
  primary; volatility did not decide routing. `touch` by GET answered HTTP
  405, SQLSTATE `25006`, `cannot execute INSERT in a read-only transaction`,
  on the replica (`in_recovery=t`) and on the primary (`in_recovery=f`):
  PostgREST runs a GET read-only on either node, so the error does not tell
  which node a client reached.
- Every POST went to the primary and `touch` by POST wrote: `rr3_touch` went
  from 0 to 6 rows each run (5 through the load balancer, 1 on the primary
  host).
- `list_docs_definer` ran as `postgres` on both nodes: `n` 3 (filtered by
  `auth.uid()` inside the function) and `all_rows` 10 (the table owner is not
  subject to RLS), the same on the replica as on the primary.
- Raw fetch on the replica's own host: every GET answered as above, `touch`
  405 `25006` `in_recovery=t`, and every POST 400 `Read replica does not
  handle POST requests for the path /res...` (the module's 60-character cut
  of a non-JSON body).

### RR03g: HEAD and count=exact

Through the load balancer, 10 calls each (replica / primary):

| request | run 1 | run 2 |
|---|---|---|
| `HEAD rr3_where`, `count=exact`, `in_recovery=eq.true` | 6 / 4, all 200 | 3 / 7, all 200 |
| `GET rr3_where`, `count=exact` | 8 / 2, all 200, count 1 | 5 / 5, all 200, count 1 |
| `HEAD rr3_docs`, `count=exact`, user A | 200, count 3, x10 | 200, count 3, x10 |

supabase-js sent `HEAD` for `select('*', { count: 'exact', head: true })`
(captured). `edge_logs` agrees that the load balancer sent HEADs to both
nodes: HEAD to the replica 9 (run 1) and 6 (run 2), to the primary 11 and 14,
all 200. On the replica's OWN host a `HEAD` answered 400 with
`content-type text/plain` and no `content-range` (both runs; content type
recorded in run 2), while a `GET` with `Prefer: count=exact` there answered
200, `content-range 0-0/1` (run 2). So the replica host refuses HEAD and the
load balancer still delivers a HEAD to the replica; how it reaches the
replica was not looked at.

### RR03h: the split with primary and replica in the same region

`GET rpc/rr_whoami` with the anon key through the load balancer, sequential:

| vantage (Cloudflare colo) | run 1 replica / primary | run 2 replica / primary | run 2 switches / transitions | run 2 longest run |
|---|---|---|---|---|
| workstation, keep-alive, n = 200 (SIN) | 111 / 89 | 94 / 106 | 92 / 199 | 14 |
| workstation, `Connection: close`, n = 50 (SIN) | not run | 28 / 22 | 26 / 49 | 4 |
| Edge Function `x-region ap-southeast-1`, n = 200 (SIN) | 100 / 100 | 115 / 85 | 108 / 199 | 7 |
| Edge Function `x-region us-east-1`, n = 50 (IAD) | 20 / 30 | 27 / 23 | 25 / 49 | 7 |
| Edge Function `x-region eu-west-1`, n = 50 (DUB) | 26 / 24 | 24 / 26 | 21 / 49 | 6 |

0 errors in every row. `edge_logs` on the load balancer host: available
regions `["SIN"]` or empty (the artifact keeps the set, not the row); chosen
region `SIN` on every REST GET and HEAD row, empty on POST and Auth rows,
for the SIN, IAD and DUB colos; and over all of a run's load balancer rows
GET to the primary 845 and to the replica 813 (run 1), 841 and 860 (run 2).

- With both databases in one region the load balancer spread GETs over the
  primary and the replica, roughly half each, from every vantage. In the
  cross-region shape (RR01f, RR02e) the same vantage got 100 % replica; there
  the choice is between regions, here there is one region and two databases
  in it. Docs (read-replicas page, read 2026-10-26): the load balancer "balances
  requests between your Primary database and Read Replicas", and geo-routing
  sends a GET "to the closest available database (all read replicas +
  primary)"; its load balancer section says nothing about two databases
  equally close. The spread here is consistent with geo-routing picking the
  region and a second step choosing a database inside it.
- The order is not a strict alternation: a strict alternation would switch
  at all 199 (or 49) transitions; the run 2 sequences switched at roughly
  half, about what independent 50/50 draws give. Inference: a per-request
  choice between the two, not tied to the client's connection (the
  keep-alive row switched at 92 of 199 and the `Connection: close` row
  spread the same way; connection reuse was not recorded). The run cannot
  tell a random choice from another rule, and whether the weights move with
  load or health was not tested.
- Latency from the workstation, keep-alive, run 2 medians: 20.9 ms when the
  primary served, 19.2 ms when the replica served.

### RR03i: lag under steady writes (same region)

A session-pooler connection on the primary inserted one heartbeat row into
`rr_marker` every 20 ms for 300 s: 15,096 rows, 50 a second, 0 errors, both
runs. Meanwhile `GET rpc/rr_node` (anon), with a 250 ms pause after each
response on each host, returned `stale_ms`, the serving node's clock minus
the newest row's `written_at`; a node keeping up therefore reads up to the
20 ms insert period plus delay, and the two hosts' clock skew is inside
every replica figure. `pg_stat_replication.replay_lag` was read on the
primary every 5 s.

| source | run | n | stale_ms p50 | p95 | max |
|---|---|---|---|---|---|
| replica host | 1 | 1,091 | 17 | 28 | 91 |
| replica host | 2 | 1,092 | 21 | 30 | 99 |
| primary host | 1 | 1,093 | 12 | 20 | 79 |
| primary host | 2 | 1,083 | 12 | 21 | 28 |
| load balancer (523 of 1,090 by the replica) | 1 | 1,090 | 15 | 27 | 122 |
| load balancer (541 of 1,086 by the replica) | 2 | 1,086 | 17 | 29 | 144 |

`replay_lag`: p50 2.2 ms, p95 2.4 ms, max 2.5 ms (n 61, run 1); 2.1, 2.5 and
3.4 ms (n 59, run 2). 0 read errors on any host. At this write rate the
replica's median was 5 ms (run 1) and 9 ms (run 2) above the primary's own
median, with clock skew inside that difference.

### edge_logs and supabase-js retries

Run 1's `edge_logs` hold two load balancer GETs routed to the replica
(redirect identifier) that answered 503 (`rr3_docs_v` and `rpc/rr3_node`)
that none of the module's results show; run 2 has none. postgrest-js 2.118.0
retries a GET or HEAD answered 503 or 520 by default
(`src/fetchWithRetry.ts`, with an `X-Retry-Count` header), so those two were
most likely retried by supabase-js and answered on the retry. The 503 bodies
were not recorded, so their cause is unknown.

### Not settled by RR03

- A cross-region arm was not run: RR01 and RR02 cover a Tokyo primary with a
  Singapore replica from this vantage.
- The load balancer's rule inside a region: spread observed, mechanism not
  visible; behaviour under load, with two replicas, or when one same-region
  node is stale or down was not run.
- Read-your-writes through the load balancer in the same-region shape (a GET
  right after a POST can land on either node) was not measured as such; the
  lag figures above indicate its size at this write rate only.
- Auth-issued HS256 user tokens, third-party-auth tokens, Realtime and
  Storage with a user token through the load balancer.
- Why the replica host refuses HEAD while the load balancer delivers HEAD to
  the replica.
- Cost: not metered. Each run kept a Small primary, a Small replica and
  `pitr_7` for about 10 and 11 minutes.

## Not measured

- Any primary region other than ap-northeast-1 (RR01, RR02) and
  ap-southeast-1 (RR03), a second replica, or a replica larger than Small.
- Load: probes are one client each; the heaviest are RR03h0 (200 sequential
  GETs, p50 19.8 ms in run 1, 20.9 and 19.2 ms by node in run 2) and RR03i
  (50 single-row inserts a second for 300 s plus three readers every 250
  ms).
- Replication delay for a large write (the largest transaction here is a
  50,000-row update; the RR02g bulk insert filled the disk before it
  committed).
- Custom domains. Auth, Storage, Realtime, GraphQL and Edge Function traffic
  through the load balancer is RR02f/RR02k; the replica's behaviour on a
  project restart is RR02i.
- The load balancer's rule. Whether it re-routes off a lagging or unhealthy
  replica is RR02h-RR02j (it did not, in two runs); with the primary and the
  replica in one region it spread GETs over both (RR03h), by a rule not
  visible from outside.
- Cost: not metered. The RR01 final run (2026-10-10) kept a Small primary, a
  Small replica and `pitr_7` for about 27 minutes; the exploratory runs kept
  one project and one replica for roughly an hour and a half.
