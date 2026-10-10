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

## Not measured

- Any second primary region, a second replica, or a replica larger than
  Small.
- Load: every probe is one client at a few requests per second.
- Replication delay for a large write (the largest transaction here is a
  50,000-row update).
- Auth, Storage, Realtime and Edge Function traffic through the load
  balancer; custom domains; the replica's behaviour on restart.
- The load balancer's rule, and whether it re-routes when a replica is
  unhealthy or lagging.
- Cost: not metered. The final run kept a Small primary, a Small replica and
  `pitr_7` for about 27 minutes; the exploratory runs kept one project and
  one replica for roughly an hour and a half.
