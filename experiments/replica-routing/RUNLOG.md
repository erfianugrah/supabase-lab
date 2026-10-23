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

## Not measured

- Any second primary region, a second replica, or a replica larger than
  Small.
- Load: every probe is one client at a few requests per second.
- Replication delay for a large write (the largest transaction here is a
  50,000-row update; the RR02g bulk insert filled the disk before it
  committed).
- Custom domains. Auth, Storage, Realtime, GraphQL and Edge Function traffic
  through the load balancer is RR02f/RR02k; the replica's behaviour on a
  project restart is RR02i.
- The load balancer's rule. Whether it re-routes off a lagging or unhealthy
  replica is RR02h-RR02j (it did not, in two runs).
- Cost: not metered. The final run kept a Small primary, a Small replica and
  `pitr_7` for about 27 minutes; the exploratory runs kept one project and
  one replica for roughly an hour and a half.
