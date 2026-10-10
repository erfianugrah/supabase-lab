# RUNLOG - multigres

Modules MG01..MG09. Sources for the claims under test (public, read
2026-10-10): https://supabase.com/blog/multigres-v0-1-alpha (2026-06-04) and
https://github.com/multigres/multigres/releases/tag/v0.1.0. The blog quotes
below were returned by a page-summarising fetch tool, not read in a browser;
treat their wording as doc-cited-not-tested. The numbers in this file are the
measurements.

## 2026-10-10 - run5, 17 failovers on a 3-cell all-in-one container

Vantage: a Docker Desktop VM (Linux kernel 7.0.14-linuxkit, Docker server
29.8.2, 10 CPUs, about 8 GB) on an arm64 Mac. The tests, the load generators
and the `docker exec kill` fault injector run on the macOS host; clients reach
the gateway through published port 15432. No cloud resources, no Supabase
project. Artifact: `out/2026-10-10/run-2026-10-10T01-44-48-951Z.json`
(redacted copy of the raw run; the other runs cited below are published in the same directory, named `run-2026-10-10T<time>.json` as listed under "Run files"), 22 results, all `pass` or `info`. n = 3 runs per fault shape
unless stated; each run is one failover.

What was run, and how it differs from the deployment the blog describes:

- Upstream `main` at commit e3cbdbbb0b94453ca2ec43c9c40c05c98ed7bb73
  (2026-10-09), built with the repo's `Dockerfile.cluster`. The `v0.1.0` tag
  has no `Dockerfile.cluster` or `docker-compose.yml` (the GitHub contents API
  returned 404 for both at that ref), so the tagged source was NOT run. The
  server reports `Multigres 0.1.0-SNAPSHOT (unknown revision) built with
  go1.26.9`: the image used for these runs was built without the commit stamp
  (the Makefile here stamps it).
- The server is the Debian PostgreSQL build from the image's base layer (the
  exact version is the `server_version` measurement in MG01), on aarch64.
  3 cells (zone1..zone3), each with its own postgres, pgctld, multipooler,
  multiorch and multigateway, all child processes of one container started by
  the `local` provisioner. Not the Kubernetes operator, not kind, not a
  multi-host network. The entrypoint writes `allow-unsafe-initial-cohort:
  true` into every multiorch block (upstream comment: with 2-3 poolers in one
  shard the safe bootstrap rule can never hold), and the generated config sets
  multiorch `recovery-cycle-interval` and `pooler-health-check-interval` to
  500 ms. Those are the local provisioner's values; the operator's were not
  read or run.
- MG01: `synchronous_commit=on`, `synchronous_standby_names` of the form
  `ANY 1 (<3 ids>)`, 2 walsenders visible from the primary,
  `max_connections=110`. PostgreSQL acknowledges a commit under that setting
  after one standby has flushed it; the lost-commit counts below test that,
  they do not assume it.
- Client-side commit log: 8 workers, one connection each, autocommit
  `INSERT (w, n)` through the zone1 gateway, closed loop. Acknowledged writes
  per second before the fault (`tps_before`) were 5,398 to 6,046 in the fault
  runs. An INSERT that returns is "acknowledged". One that errors is in doubt
  and is checked against the final table. "Acknowledged-but-lost" means an
  acknowledged (w, n) missing from the table read back after recovery.
  `ack_stall_ms` is the longest interval with no acknowledgement from any
  worker that ends after the fault. The fault clock starts just before the
  `docker exec kill`, whose latency is inside every window and is printed in
  each run's evidence (largest: 154 ms).
  Orchestrator times are from multiorch's own log, corrected by a measured
  container-minus-host clock offset (largest: 26 ms).

### Measured: failover window and lost commits

| module / fault | n | acknowledged writes checked | acknowledged-but-lost | ack stall per run (ms) |
|---|---|---|---|---|
| MG02 SIGKILL the primary's postgres (its pgctld and multipooler left up) | 3 | 442,944 | 0 | 2,238 / 1,100 / 4,233 |
| MG03 SIGKILL postgres + multipooler + pgctld of the primary's cell | 3 | 263,121 | 0 | 14,702 / 15,136 / 14,735 |
| MG04 SIGSTOP the primary's cell for 45 s, then SIGCONT | 2 | 395,924 | 0 | 20,016 / 25,122 (earlier artifacts: 20,010 / 20,013 / 25,129 / 56,231, see below) |
| MG08 one standby SIGSTOPped 20 s (22.3 to 23.3 MB behind), then primary and the current standby SIGKILLed | 3 | 759,319 | 0 | 6,852 / 6,431 / 8,161 |
| MG09 as MG02 with one writer at 10 writes/s | 3 | 720 | 0 | 6,657 / 1,900 / 6,589 |
| MG05 pgbench (below) | 3 | 354,504 logged | 0 | n/a / n/a / 2,283 |

Counts are the sums of each row's `acked` measurement (MG05: `logged_transactions`).
Over the 17 runs, 2,216,532 acknowledged writes were checked and none was
missing from the final table. Every run ended with the same row count on every
surviving node and on a read through the gateway.

Reading the stall:

- Where it goes, from multiorch's log in the same runs. After a postgres
  SIGKILL the promote step (`promote_ms`) took 327 to 374 milliseconds in
  MG02, 343 to 364 in MG09 and 345 to 2,181 in MG08. The rest of the stall is
  the time before multiorch starts its leader appointment. The first
  "executing appoint leader action" line (a check, not the appointment: in
  MG02 and MG09 several of these ended in "primary already exists, skipping
  leader appointment") came, in milliseconds after the kill, 547 to 2,635 in
  MG02, 1,390 to 4,378 in MG09 and 5,724 to 6,245 in MG08. The first
  "starting leader appointment" line came 570 to 3,786 in MG02 (1,764 /
  570 / 3,786), 1,411 to 6,082 in MG09 and 5,765 to 6,288 in MG08.
- The spread in the stall is wide, from about 1 s to about 6.7 s, with most
  runs near 1 to 2 s or near 6 to 7 s. It was NOT explained. MG09's trickle load gave
  6.7 / 1.9 / 6.6 s and MG02's heavy load gave 2.2 / 1.1 / 4.2 s here, but an
  earlier full run (`final` (`out/2026-10-10/run-2026-10-10T01-19-34-842Z.json`), same fault code) stalled for MG02
  as (6.3 / 1.8 / 1.0 s) and `full1` (`out/2026-10-10/run-2026-10-10T01-06-52-479Z.json`) as (1.4 / 1.7 / 1.3 s). At n = 3
  per cell "traffic speeds up detection" is not supported and is not claimed.
- MG03 (the cell's multipooler and pgctld die with its postgres): multiorch's
  reason was `LeaderUnreachableByCohort`, its first "starting leader
  appointment" line came (14.2 to 14.6 s) after the kill in all three runs, and the promote step took
  360 to 364 milliseconds. Nothing restarted the killed cell: after a 45 s
  wait the cluster still had 2 nodes (`healed_to_1p2s` = no, all three), so
  each MG03 run starts from a freshly created container.
- MG04 (hung primary, sockets stay open): reason `LeaderQuorumWritesStalled`.
  In the run5 runs the first "executing appoint leader action" check was at
  +18.6 to +18.7 s after the SIGSTOP, "starting leader appointment" at +19.4 s
  (run a) and +20.1 s (run b), and the pooler-level promote of the new
  primary succeeded at +19.9 s (run a) and +20.6 s (run b). Multiorch itself
  logged the promotion as a success only at +39.7 s (run a) and +40.3 s
  (run b) (`promote_ms` 20,126 and 20,140): the recruit RPC to the frozen
  cell had to time out first (`recruit_ms` about 20,250), so the orchestrator
  side lags the pooler-level promote by about 20 s. In run a the 20,016 stall
  coincides with the client's own 20 s statement timeout (all 8 workers
  ended with "Query read timeout" at +20 s), so the client could not see
  recovery earlier than that. In run b the reconnects after the timeout hit
  the client's 5 s connect timeout once (8 x "timeout expired" at +25.15 s),
  which accounts for the 25,122 on top of a cluster-side recovery at about
  +20.6 s. That is client behaviour, not a cluster window.
  The stall was NOT always about 20 s. Across the six MG04 runs in three
  artifacts it was 20.0 / 25.1 (run5), 20.0 / 20.0 (`final` (`out/2026-10-10/run-2026-10-10T01-19-34-842Z.json`)) and
  25.1 / 56.2 s (`full1` (`out/2026-10-10/run-2026-10-10T01-06-52-479Z.json`)). In the 56.2 s run (`full1` MG04b) the
  first promotion attempt failed at +39.7 s (`recruit_ms` 20,254), a second
  attempt started at +48.3 s and succeeded at +57.8 s, and the client saw
  8 x "Query read timeout" plus 8 x "portal execution failed ... EOF". So
  recovery from a hung primary ranged from about 20 to 56 s here; the cause
  of the failed first attempt in that one run was not investigated.
  After SIGCONT (released at +45.2 s) the one demotion logged in
  `final` (`out/2026-10-10/run-2026-10-10T01-19-34-842Z.json`) MG04a was multiorch's "stale leader demoted successfully via SetPrimary" at +47.7 s;
  MG04b in that run logged none. All nodes ended with equal row counts.
- MG08 (durability probe): in all three run5 runs the primary's
  `pg_stat_replication` showed the stopped standby 22,265,848 to 23,256,456
  bytes behind (flush lag) just before the double kill. The lagging standby
  was not promoted in any run: the winner was the restarted original primary
  once and the up-to-date killed standby twice. A first version with a 5 s
  stop (5.4 to 5.8 MB behind, `final3` (`out/2026-10-10/run-2026-10-10T01-36-34-662Z.json`)) did promote the lagging
  standby in 1 of 3 runs, with 0 lost, and proves nothing: that much WAL may
  sit in the stopped standby's socket receive buffer and arrive after SIGCONT
  although the primary is dead (buffer size not measured). The 20 s stop makes
  the lag about 4 times larger; that is the version reported.

### Measured: what clients saw during the failover

- In-flight statements failed, they did not wait: one failed INSERT per worker
  in every MG03 and MG04 run (8 of 8), 8 to 11 in MG02. Error fragments,
  verbatim: `failed to read message: EOF`, `terminating connection due to
  unexpected postmaster exit`, `no writable primary is currently available`,
  and the client-side `Query read timeout` (MG04). Of the failed INSERTs, 0 to
  5 per run were in the table anyway (committed, unacknowledged); the rest
  were absent. The blog sentence "multigateway can hold requests until a new
  primary is promoted, thereby minimizing errors" matches only the connection
  side below, not statements already sent to the dead primary.
- New connections during a postgres kill (MG02, MG08, MG09): the gateway
  answered `database is temporarily unavailable; please retry` or
  `no writable primary is currently available`, and in every one of those runs
  2 to 5 connects were refused with `password authentication failed for user
  "postgres"` although the same password connected before and after. Failed
  connects per run: 45 to 237 (MG02), 349 to 561 (MG08), 13 to 59 (MG09).
  Separately, 3 connects per run in MG02 and in two MG08 runs were accepted
  but held before completing (longest per run: 1.2 to 4.6 s).
- During MG03 (cell loss) 1,096 to 1,136 connects per run failed, all with
  `no writable primary is currently available`; none was held for over 200
  milliseconds. MG04 run a had 0 failed connects: the clients sat on their
  open sockets until the 20 s timeout.
- Clients had to reconnect and retry themselves in every run. pgbench shows it
  plainly (MG05). One long pgbench (a: simple protocol, b: `-M prepared`): all
  8 clients aborted 45 to 51 milliseconds after the kill
  (`log_ends_after_fault_ms`), pgbench exited 2, no client completed a
  transaction after the fault, so pgbench alone gives no failover window
  (reported n/a; the last two log lines would give a meaningless 1
  millisecond). Relaunch loop (c: 41 back-to-back `pgbench -T 2`, 21 exited
  non-zero): 8 of 8 client slots completed transactions after the fault, ack
  stall (ms) 2,283, 240,174 transactions logged. pgbench's per-client log counts matched
  the per-client row counts: 0 acknowledged commits missing in all three, and
  rows exceeded logged transactions by 3 to 5 (committed, unacknowledged).

### Measured: pooler semantics through the gateway (MG06, MG07)

- MG06: the 9 probes of pooler-semantics S01 against the primary's own
  postgres (control, 9 of 9), the zone1 gateway and the zone2 gateway. Both
  gateways passed 9 of 9: `pid_stable`, `prepared_first`, `prepared_reuse`
  (bind/execute with no re-parse), `advisory_lock`, `listen_notify`,
  `session_guc`, `cursor_with_hold`, `temp_table`, `explicit_txn`. One client
  was connected, so the pool was uncontended. The gateway did not hand that
  client a dedicated backend: autocommit statements ran on backend pid 9171
  (both gateways), the explicit transaction on a different pid (9928, 9931),
  the control on 9927. Whether session state survives when other clients
  compete for the pool was NOT measured.
- MG07: roles `mg07_a` and `mg07_b` each connected through the gateway; the
  primary's `pg_stat_activity` showed a backend with `usename` equal to each
  role, on different pids. That is consistent with the blog's "separate
  connection pool per user with no shared pool and no `SET ROLE`
  impersonation" for two roles and one connection each. Pool sizing and
  fair-share allocation were not tested.

### Not measured / blocked

- The Kubernetes operator and kind path named in the project's documentation. The container used
  here is the repository's own all-in-one image; operator-managed pods,
  restart policies and real node loss were not exercised. What a killed cell
  does under an operator is unknown from this run; in this container nothing
  restarted it (MG03).
- The web-only `multigres-private-alpha` surface (invite only): no access, so
  the platform-downtime sampler was not reused.
- Network partitions between cells (only process kill and SIGSTOP were
  injected; a frozen process is not a partition). Loss of a gateway or of
  etcd. Loss of two cells other than MG08's two-postgres case.
- Durability policies other than the local provisioner's `ANY 1` of 3.
- Whether `allow-unsafe-initial-cohort` and the 500 ms orchestrator timers
  change the results against a default deployment.
- The cause of the wide spread in detection time after a postgres kill, and
  of the failed first promotion attempt in the 56 s MG04 run.
- Throughput and latency comparisons (`tps_before` is a closed-loop figure
  from a Docker Desktop VM, context only).
- Earlier artifacts (`full1` (`out/2026-10-10/run-2026-10-10T01-06-52-479Z.json`), `final`, `final2`, `final3`, `final4`)
  were produced before the connect-error counters and the final MG08 lag
  existed; they are cited above only for the detection-time spread, the MG04
  stall range and demotion, and the 5 s lag variant. None is published, so figures not in this file are not
  citable.

## Run files

All in `out/2026-10-10/` as `run-2026-10-10T<time>.json` with a `.facts.md` beside it: full1 `01-06-52-479Z`, final `01-19-34-842Z`, final2 `01-30-20-583Z`, final3 `01-36-34-662Z`, final4 `01-39-09-417Z`, run5 `01-44-48-951Z`.
