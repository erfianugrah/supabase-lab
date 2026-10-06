# medium-serverless - RUNLOG

One Medium project in ap-southeast-2 on the Team organisation, Postgres 17.6
(image `supabase-postgres-17.6.1.166`, read from `upgrade/eligibility`),
probed from an IPv4-only vantage in Singapore. The shape under test is a
shared multi-tenant production project reached from IPv4-only serverless
functions through a pooler; every module is one operation on that project.
Redacted artifacts under `out/2026-09-30/`; the harness commit is in each
artifact header. Numbers below are pasted from those facts files.

## 2026-09-30 - first spin

Order run: MS01, MS02, MS01 again, MS03, MS04, MS05, pooler-semantics S01,
MS10, MS04 again (rows e/f added), MS05 again, MS08, MS09, pooler-semantics
S02, MS05 (third build), MS12, MS11, MS14, MS15, MS13, MS06, MS07, then the
MS15 and MS13 reruns recorded under their sections. Project destroyed the
same day.

### MS01 - what the project presents (run-2026-09-30T04-23-23, run-2026-09-30T04-35-16)

- Postgres `17.6`, `max_connections` 120, `postgres_engine` 17, release
  channel `ga`. Both `postgres` and `service_role` carry `rolbypassrls =
  true`; `postgres` is not superuser. Role configs as shipped: `anon`
  `statement_timeout=3s`, `authenticated` `statement_timeout=8s`,
  `authenticator` `statement_timeout=8s | lock_timeout=8s`,
  `supabase_auth_admin` `idle_in_transaction_session_timeout=60000`.
- Logging GUCs: `log_statement = ddl` (the docs say the default is `none`),
  `log_min_duration_statement = -1`, `log_min_error_statement = error`,
  `log_parameter_max_length_on_error = 0`. Global `statement_timeout`
  setting `120000`; `idle_in_transaction_session_timeout` `0`.
- `GET /config/database/pooler` (Supavisor): `db_user postgres.<ref>`, host
  `aws-0-ap-southeast-2.pooler.supabase.com`, `pool_mode transaction`,
  `default_pool_size null`, `max_client_conn null`. `GET
  /config/database/pgbouncer`: `pool_mode transaction`, `query_wait_timeout
  80`, `server_lifetime 3600`, `server_idle_timeout 600`, `reserve_pool_size
  1`, `ignore_startup_parameters options,extra_float_digits`; no
  `default_pool_size` or `max_client_conn` in the body. Neither pooler's pool
  size or client cap is readable through the API on this project.
- Before the IPv4 add-on: `db.<ref>.supabase.co` publishes one AAAA and no A;
  direct 5432 and dedicated 6543 answer `connect ECONNREFUSED` against the
  v6 address from this vantage; shared 5432 and 6543 connect (2471 ms, 1949
  ms).
- After it (04:35): all four paths connect (direct 1952 ms, dedicated 1709
  ms, shared 5432 2393 ms, shared 6543 1692 ms - single samples, cold TLS
  from Singapore to Sydney). The dedicated pooler takes user `postgres` only;
  the Supavisor tenant shape `postgres.<ref>` gets `no such user`. Health
  reports all seven services `ACTIVE_HEALTHY`, including `pg_bouncer`.

### MS02 - switching the IPv4 add-on on (run-2026-09-30T04-23-55)

- `PATCH billing/addons {ipv4, ipv4_default}`: HTTP 200 in 146 ms.
- Sampled every 500 ms for 600 s (217 samples): the AAAA record was gone and
  no A record appeared within the window; direct 5432 and dedicated 6543 never
  connected (`getaddrinfo ENOTFOUND` to the end). Shared pooler 6543 and REST:
  0 failed samples of 217.
- At 04:35 (about 11 minutes after the PATCH) `dig` against the system
  resolver, 1.1.1.1 and 8.8.8.8 all returned the A record (TTL 30) and no
  AAAA, and MS01 connected on both `db.<ref>` ports.
- Reading: from a client's point of view the swap was not an atomic AAAA to A
  flip; there was a window longer than 10 minutes with no usable record from
  this vantage. Caveat: the vantage's resolver is systemd-resolved, and
  negative caching of the empty answer was not ruled out (the zone's SOA
  minimum was not read). The module recorded the A-record time only after
  the AAAA was gone in this run; fixed for the next run to track both
  independently. The docs' "less than a minute" refers to direct connections
  during DNS reconfiguration; this run measured time-to-first-usable-record
  for an IPv4-only client, which is a different quantity.

### MS03 - network restriction per path (run-2026-09-30T04-37-45)

An earlier attempt gave 8 s / 8 s / 4 s / 4 s and was lost when MS04
crashed the runner; the figures below are from the run whose artifact
survived (`run-2026-09-30T04-37-45-449Z`, the only published artifact
with an MS03 section).

- Baseline: all four Postgres paths connect at `0.0.0.0/0`.
- `POST network-restrictions/apply {192.0.2.0/24}`: HTTP 201, `apply_ms`
  1733. Time-to-bite from the apply call, and the first failure text:
  - shared 5432: 2.7 s, `(EADDRNOTALLOWED) address not in tenant allow_list:
    {118, 189, 189, 102}`
  - shared 6543: 3.3 s, same text
  - direct 5432: 6.7 s, `timeout expired`
  - dedicated 6543: 6.7 s, `timeout expired`
- REST probed during the restriction: ok.
- Restored to `0.0.0.0/0` (HTTP 201): direct 4.1 s, dedicated 3.8 s, shared
  5432 3.8 s, shared 6543 4.3 s back.
- Reading: Supavisor refuses an excluded address with a named error;
  `db.<ref>.supabase.co` on both ports drops it, so the client sees its own
  connect timeout (5 s here). security-lockdown S10 and the PrivateLink
  reference had only the Supavisor text and attributed the timeout mode to an
  AWS security group, "not measured here"; on the public direct and
  dedicated-pooler paths the restriction itself presents as a timeout.

### MS04 - role-level timeouts through the poolers (run-2026-09-30T05-11-13)

Roles `ms_app` (`idle_in_transaction_session_timeout = 5s`,
`statement_timeout = 3s`, `NOBYPASSRLS`) and `ms_app_nolimit` (no timeouts),
created through the query endpoint and dropped in `finally`.

- MS04a: `current_setting` on a pooled connection: `5s` / `3s` on dedicated
  6543 as `ms_app` and on shared 6543 as `ms_app.<ref>` (first run, 04:37). In
  the second run the shared row failed with `password authentication failed
  for user "ms_app"` seconds after the role was recreated, while MS04c
  connected through the same pooler as the same role about a minute later.
  Supavisor appears to cache credentials briefly after a role is created or
  altered. One occurrence, not re-probed.
- MS04b: `select pg_sleep(10)` through dedicated 6543 as `ms_app`: SQLSTATE
  `57014` `canceling statement due to statement timeout`, `wall_ms` 4786
  (connect included).
- MS04c: `BEGIN`, read `pg_backend_pid()`, destroy the TCP socket without
  `COMMIT`. Backend gone from `pg_stat_activity` after 1.5 s (dedicated) and
  1.6 s (shared).
- MS04d: the same on `ms_app_nolimit`: gone after 1.6 s. The pooler closes a
  server connection whose client died mid-transaction whatever the role says.
- MS04e: client alive, transaction open, no statement: backend gone after
  6.7 s (5 s timeout plus 1 s poll); the client's next statement failed with
  `Client has encountered a connection error and is not queryable` (no
  SQLSTATE surfaced through the pooler).
- MS04f: the same on `ms_app_nolimit`: backend still present after 30 s and
  the next statement succeeded with the transaction still open.
- Reading: a dead serverless function does not leak a backend through either
  pooler; a hung one does, and only the role-level idle timeout ends it. A
  session-level `SET` cannot do this job through transaction pooling.

### MS05 - what reaches the logs (run-2026-09-30T05-11-13 and run-2026-09-30T05-35-42, plus one manual query)

Marker planted on three surfaces, then searched through `GET
/analytics/endpoints/logs` (the unified ClickHouse table; `logs.all` answers
410 since 2026-09-23 - see the corpus guide
`supabase-management-api-logs-endpoint`, which also records that the
migration guide's `source_name` example is wrong and the column is
`source`). The first two runs found nothing: the first used `logs.all`, the
second searched `event_message` only, within 4 minutes of planting.

- Storage object at `tenant-<m>/record-<m>.txt`: `edge_logs` 2 lines and
  `storage_logs` 4 lines (3 in the second run) carry the full path - in `event_message` and in
  `log_attributes['request.path']` / `objectPath`, including the Storage
  worker's `ObjectRemoved:Delete` lifecycle event after cleanup.
- Realtime `phx_join` on `realtime:tenant:<m>`: `realtime_logs` 0 lines with
  the topic, in the run and in a manual 3-hour-window query afterwards.
- Failing `insert into ms_missing_<m> values ('<m>PII')` (SQLSTATE 42P01)
  through the shared pooler as `postgres`: 1 `postgres_logs` line. Its
  `event_message` is `relation "ms_missing_<m>" does not exist`; the literal
  sits in `log_attributes['parsed.query']` verbatim
  (`insert into ms_missing_<m> values ('<m>PII')`), with
  `parsed.application_name Supavisor`, `parsed.user_name postgres`,
  `parsed.sql_state_code 42P01`.
- Succeeding `select '<m>OK'`: 0 lines anywhere, consistent with
  `log_statement = ddl`. The second run, searching `log_attributes` as
  well, counted the failing literal on 1 line and the succeeding one on 0
  (MS05d `failing_literal_hits 1`, `success_literal_hits 0`).
- `supavisor_logs`, `pgbouncer_logs`: 0 lines with the marker.

### MS10 - Prisma 6.19.3 on each pooled path (run-2026-09-30T04-44-42)

Schema pushed with `prisma db push` over the shared pooler in session mode
(5432): `push_ms` 12888. Workload per row: 20 workers x 25 rounds of
`findMany` + `count` + parameterised `$queryRaw` + `create`,
`connection_limit=5&pool_timeout=10`, under Bun 1.3.14.

| Row | Path | Iterations ok | p50 / p95 ms per iteration | Wall s |
|---|---|---|---|---|
| MS10a | shared 6543, `pgbouncer=true` | 500 / 500 | 20553 / 21401 | 517.5 |
| MS10b | shared 6543, no flag | 7 / 500 | 4207 / 4760 | 35.3 |
| MS10c | dedicated 6543, `pgbouncer=true` | 500 / 500 | 20384 / 21345 | 514 |
| MS10d | dedicated 6543, no flag | 500 / 500 | 4090 / 4501 | 107 |
| MS10e | direct 5432 | 500 / 500 | 4212 / 4674 | 111 |

- MS10b errors: 445x `PrismaClientUnknownRequestError` on `findMany`, 36x on
  `count`, and 11x `P2010 sqlstate=26000: ERROR: prepared statement "s10" does
  not exist` (also `s11`, `s12`, `s13`). Supavisor transaction mode still
  breaks Prisma's named statements under concurrency; the single-statement
  `PREPARE`/`EXECUTE` probe (privatelink-aws T11, pooler-semantics S01) does
  not see this.
- The dedicated PgBouncer on this image handles Prisma's named statements at
  direct-connection latency (4090 vs 4212 p50). `pgbouncer=true` (Prisma
  disables prepared statements client-side) costs about 5x per iteration on
  either pooler (20384-20553 vs 4090-4207), so on the dedicated pooler the
  flag is pure cost.
- Absolute latencies include a Singapore-to-Sydney round trip per statement
  and are not a property of the poolers; the ratios are the result.

### pooler-semantics S01 - first run ever (pooler-semantics/out/2026-09-30/run-2026-09-30T04-41-49)

All 9 features `ok` on every mode, including both transaction-mode rows.
The matrix runs one client per mode: an idle single client is handed the
same server connection back on each statement, so session-scoped state
appears to survive transaction pooling. It measures the protocol surface,
not concurrency; MS10b is the same pooler breaking under 20 clients. The
dedicated row used user `postgres` via the new
`PVLAB_ENDPOINT_POOLER_TXN_USER`.

### MS08 - the dedicated pooler's CPU cost under equal load (run-2026-09-30T05-17-02)

pgbench `-S`, 16 clients, 60 s, through each pooler in turn; instance CPU
read from `/customer/v1/privileged/metrics` (Basic `service_role`) every 5 s.
The endpoint exposes 123 `pgbouncer_*` / `supavisor_*` metric lines.

| Row | Path | tps | avg latency ms | CPU busy % (idle 0) | MemAvailable delta MiB |
|---|---|---|---|---|---|
| MS08a | idle 30 s | - | - | 0 | - |
| MS08b | shared 6543 | 62.16422 | 257.383 | 3.5 | 6 |
| MS08c | dedicated 6543 | 62.866998 | 254.506 | 5.8 | 19 |

Reading: at the same ~62 tps the dedicated PgBouncer costs the instance
about 2.3 CPU points more than the off-box Supavisor. The load is
round-trip-bound from Singapore (16 clients x ~255 ms), so 62 tps is far
below what the instance can serve; the differential at real load is not
measured here.

### MS09 - client ramp to the ceiling on Medium (run-2026-09-30T05-17-02)

Steps of 50, each client holding one `select pg_sleep(2)` then idling.

- Dedicated 6543: 599 held; first refusal at client #551 (the count when the
  first of the 600-step's connects failed), text `no more connections allowed
  (max_client_conn)`; the whole 650 step refused. Connect p50 5761-5883 ms
  and p95 9714-9803 ms at every step from 50 up: the wait is on the server
  pool, not the client cap.
- Shared 6543: 600 held; first refusal at client #601, text `(EMAXCONN) max
  client connections reached, limit: 600`; the 650 step refused. Connect p50
  5701-6011 ms, p95 7771-8052 ms.
- No `client being queued` NOTICE was surfaced by the `pg` client on either
  path (0 notices), unlike the psql-based PrivateLink ramp; the queueing is
  visible as connect latency only.
- Reading: both poolers stop the client at the published Medium figure of
  600, with a named refusal each. What a client hits first is the pool
  queue, from the first step.

### pooler-semantics S02 - throughput per path (pooler-semantics/out/2026-09-30/run-2026-09-30T05-25-15)

`pg-analyser bench` (the renamed sbperf) select-only, 8 clients, 3 x 60 s
after a 10 s warm-up, extended protocol, on the `pgbench -i -s 10` tables
MS08 created.

| Row | Path | tps median | p50 / p95 / p99 ms | spread % |
|---|---|---|---|---|
| S02a | direct 5432 | 31.34425 | 254.45 / 262.2 / 263.6 | 2.8 |
| S02b | dedicated 6543 | 31.449556 | 253.27 / 262.74 / 265.43 | 0.8 |
| S02c | shared 6543 | 31.173369 | 254.81 / 263.41 / 265.77 | 1.1 |

Reading: one round trip per transaction from Singapore to Sydney (~254 ms)
bounds all three paths identically; the differences are within spread.
This is a measurement of the vantage, not of the poolers. The 1.5x
PgBouncer-over-Supavisor ratio in the PrivateLink reference came from an
in-region runner; reproducing it for Medium needs a Sydney vantage.

### MS11 - Postgres Changes per tenant with external-issuer tokens (run-2026-09-30T05-44-03)

Table `public.ms_msg` in the `supabase_realtime` publication, `SELECT` granted
to `anon` and `authenticated`. Tokens: ES256 from an in-process issuer whose
JWKS an Edge Function serves, registered as third-party auth, claims
`role: authenticated` and `o: {id, rol, slg}` (Clerk's organisation shape).
Two subscribers (`o.id` tenant-a and tenant-b), one INSERT per tenant, 8 s
collection. The `errors` counts in the stdout are the channel's `system`
"Subscribed to PostgreSQL" message, logged in that bucket by the module.

- MS11a, RLS off: subscriber a received 2 events (tenant-a and tenant-b),
  subscriber b received 2 (both). Every subscriber sees every tenant.
- MS11b, RLS on, `using (tenant_id = auth.jwt()->'o'->>'id')` for
  `authenticated`: a received 1 (tenant-a), b received 1 (tenant-b).
- MS11c, RLS on, anon key only: join `ok`, subscribed, 0 events.
- MS11d, RLS on, token signed by an issuer NOT registered: join
  `{"status":"error","response":{"reason":"JwtSignerError: Failed to
  generate JWT signer for key ID (kid) ..., check your JWT secret or JWKS
  configuration"}}`, 0 events.
- Reading: Realtime evaluates the table's RLS per subscriber using the
  external token's claims, so a Clerk-shaped `o.id` claim is enough to scope
  Postgres Changes per clinic - and without RLS the same subscribers receive
  everything. An unregistered issuer is refused at join, so `setAuth` with
  a Clerk JWT does nothing useful until the third-party integration exists.

### MS12 - effective server pool per pooler (run-2026-09-30T05-44-03)

40 clients each running `select pg_sleep(8)` tagged per path; active tagged
backends counted through the query endpoint at 3 / 6 / 12 / 20 s.

| Row | Path | active at 3/6/12/20 s | max | all 40 done in | expected at that pool |
|---|---|---|---|---|---|
| MS12a | dedicated 6543 | 16 / 16 / 16 / 11 | 16 | 26.1 s | 24 s |
| MS12b | shared 6543 | 17 / 17 / 17 / 9 | 17 | 26.2 s | 24 s |

Reading: the pool a Medium project's clients wait on is 16-17 server
connections per pooler, which neither config endpoint reports (MS01b). With
`connection_limit=5` per serverless instance, three or four warm instances
already fill it; MS09's flat 5.7-5.9 s connect p50 is this queue.

### MS14 - encrypt in an Edge Function before the row lands (run-2026-09-30T05-44-03)

AES-256-GCM under WebCrypto, key from function secret `MS14_KEY`, envelope
`version(1) | nonce(12) | ciphertext`, plaintext length-padded to 256-byte
blocks (the pastebin shape), written through the Data API with the service
key; reads decrypt through the same function.

- MS14a: secret `POST /secrets` 201; deploy 201 in 2395 ms; the function's
  first answer came 125 s after the deploy call (a GET with no id, 404 as
  written).
- MS14b: 20 writes through the function p50 371 / p95 843 ms; 20 plaintext
  writes through the Data API with the service key p50 216 / p95 610 ms.
  20/20 rows.
- MS14c: over the database path the row holds `version 1` and a 380-char
  base64 blob with the marker absent; the function's decrypt path returned
  the marker (HTTP 200).
- MS14d: 3 minutes later the marker appears in 0 log lines of any source.
- Reading: a function in the write path adds about 155 ms p50 from this
  vantage (one extra Singapore-to-Sydney hop plus the encrypt) and a leaked
  database credential reads ciphertext; the key lives in the function's
  secrets, so the platform can decrypt - this is a layer, not end-to-end
  encryption.

### MS06 - same-region read replica (run-2026-09-30T06-12-54)

- MS06a: `pitr_7` applied by the module (HTTP 200); add-ons then
  `ci_medium, ipv4_default, pitr_7`.
- MS06b: `POST read-replicas/setup {read_replica_region: ap-southeast-2}` -
  the primary's own region - accepted HTTP 204 on the first attempt, 0 s
  after the PITR add-on.
- MS06c: a `READ_REPLICA` entry (`identifier <ref>-rr-ap-southeast-2-<5
  chars>`, Supavisor user `postgres.<that identifier>`) appeared in
  `/config/database/pooler` after 216 s; a connection through its Supavisor
  string answered `pg_is_in_recovery() = true` after 219 s.
- MS06d: `POST read-replicas/remove {database_identifier}` HTTP 204; the
  entry was gone from the pooler config on the first poll (0 s); `DELETE
  billing/addons/pitr_7` HTTP 200.
- Reading: a replica in the primary's own region is accepted and serves in
  under four minutes on Medium, with PITR (physical backups) as the only
  prerequisite that had to be added. The docs describe replicas "across
  multiple regions" and do not say this; the platform does it.

### MS13 - custom hostname, first run (run-2026-09-30T05-57-32): verification never started

- MS13a: `cd_default` add-on HTTP 200; `custom-hostname/initialize` HTTP 201,
  status `2_initiated`. The response carried the ownership TXT
  (`_cf-custom-hostname.<host>`) and ZERO TLS validation records.
- MS13b: the module wrote the CNAME and the ownership TXT (both exit 0) and
  polled `reverify` for 15 minutes; status stayed `2_initiated`, ssl
  `pending_validation`. The `_acme-challenge.<host>` validation record showed
  up in later GETs, which the module never re-read. Written by hand at ~10
  minutes in with the general write key (`ok: added`); public resolvers
  carried it about 4 minutes later, after the module's window closed.
- MS13e: teardown DELETE HTTP 200, 2 DNS records removed, `cd_default`
  removed HTTP 200, 2 s.
- Fix: the reverify loop now writes any TXT each poll returns and the budget
  is 20 minutes. Rerun on a fresh name (avoids negative caches) below.

### MS07 - Medium -> Large -> Medium, outage per path (run-2026-09-30T06-16-37)

Eight paths sampled at 500 ms until 5 s of sustained recovery. The compute
PATCH is `billing/addons {compute_instance, ci_large}`; the first call
answered 429 because MS06's add-on changes were still settling, so the
module waited 185 s before the accepted PATCH - hence `first_fail_s` 187-189
on the way up (measured from sampling start) against 3 on the way down.

| Path | up: window s, mode | down: window s, mode |
|---|---|---|
| REST `/rest/v1/` | no failure | no failure |
| Realtime handshake | no failure | no failure |
| Auth `/auth/v1/health` | 35, `HTTP 521` | 42, `HTTP 520` then 521 |
| Storage `/storage/v1/bucket` | 34, `HTTP 500` | 44, `HTTP 500` |
| shared 6543 | 30, `Failed to connect to database: {:error, :timeout}` | 39, same, then `{:error, :econnrefused}` |
| shared 5432 | 36, `timeout expired`, then `terminating connection due to administrator command` | 39, `timeout expired` |
| dedicated 6543 | 34, `Connection terminated unexpectedly`, `ECONNREFUSED`, `timeout expired` | 55, same, then `server login has been failing, cached error: connect failed (server_login_retry)` |
| direct 5432 | 35, `Connection terminated unexpectedly`, `ECONNREFUSED`, `timeout expired` | 41, `Client network socket disconnected before secure TLS connection was established` |

Health (`db, rest, auth, pg_bouncer`) read `ACTIVE_HEALTHY` 2 s after the
up-resize's sampling ended and 1 s after the down-resize's. `compute_after`
`ci_large` then `ci_medium`.

Reading: a Medium <-> Large resize took every Postgres path and the Auth and
Storage HTTP paths down for 30-55 s and left REST and Realtime untouched, the
same shape platform-downtime measured for Micro <-> Small but at roughly a
quarter to a fifth of those windows (Auth 131 s and pooler 207 s there). The
dedicated PgBouncer was the last path back on the way down: after Postgres
returned it kept answering `server login has been failing ... server_login_retry`
for about 14 s, its cached login failure. n=1 per direction.

### MS13 - custom hostname, second run on a fresh name (run-2026-09-30T06-29-59)

- MS13a: `cd_default` HTTP 200; initialize HTTP 201, `2_initiated`, again 0
  TLS validation records and the ownership TXT only.
- MS13b: CNAME and ownership TXT written at once; the `_acme-challenge`
  record was first returned on the second `reverify` poll, 23 s in, and
  written then (all three `knotctl add` exit 0). Verified after 193 s:
  status `4_origin_setup_completed`, ssl `active`.
- MS13c: `activate` HTTP 201 and status `5_services_reconfigured` on the
  first GET (0 s). Then `https://<host>/auth/v1/health` did not answer from
  this vantage for the 5-minute wait (`Unable to connect`), `/rest/v1/`
  likewise; TLS issuer unread.
- MS13d: the origin-minted Storage signed URL fetched via the origin 200, via
  the custom host not reachable; Realtime handshake on the custom host
  errored; origin `/auth/v1/health` 200 throughout.
- MS13e: teardown DELETE 200, 3 DNS records removed, `cd_default` removed
  200.
- Reading: the platform side is measured - about 3 minutes from the records
  being in DNS to a verified challenge and an active certificate, and an
  activation that reports complete immediately. Whether the new name served
  is not: the wait did not record what the name resolved to or what the
  connect error was, so DNS negative caching at this vantage (the name was
  queried before its CNAME existed) cannot be separated from the edge not
  yet serving. Third run below records both each minute for 10 minutes.

### MS13 - custom hostname, third run (run-2026-09-30T06-41-33): the vantage's resolver

- MS13a/b: add-on 200, initialize 201; this time the `_acme-challenge`
  record was returned on the FIRST reverify poll (3 s) and all three records
  were written at once; verified after 45 s, `4_origin_setup_completed`,
  ssl `active`.
- MS13c: activate 201, `5_services_reconfigured` at 0 s. The new name still
  did not answer for 10 minutes - and the per-minute DNS trace says why: the
  LAN resolver at this vantage answered `10.0.10.1` for the name (a
  split-horizon override for the lab zone on the local knotea resolver),
  while 1.1.1.1 answered the CNAME to the project host and Cloudflare edge
  addresses (`104.18.38.10`, `172.64.149.246`). `fetch` used the local
  answer, so every on-host probe in runs two and three measured the
  vantage, not the platform.
- MS13e: teardown clean (DELETE 200, 3 records removed, add-on removed 200).
- Change for the fourth run: on-host probes go through `curl --resolve
  <host>:443:<1.1.1.1's A>`, TLS still validated against the hostname; the
  Realtime check is a pinned HTTP upgrade attempt.
- Platform timings across the three runs: verification 45-193 s from the
  records landing, activation reported complete on the first GET each time.

### MS15 - a preview branch as staging for a Prisma-pushed schema (run-2026-09-30T06-54-06)

Two earlier attempts: the first timed out on the create call at the harness's
30 s default while the platform created the branch anyway; the second
adopted that branch but set its poll budget from `created_at` and never
polled, then hit `422 Cannot delete persistent branch.` on cleanup. Both
artifacts are published; the figures below are the third attempt, on a
fresh branch.

- MS15a: `POST /projects/{ref}/branches {branch_name, persistent: true}`
  with no git integration: HTTP 201; `GET /branches/{id}` reported
  `ACTIVE_HEALTHY` with `db_host` 2 s later (the branch had already been
  created by the earlier attempt's timed-out call at 05:51, deleted, and this
  one provisioned during the create call itself). Postgres image
  `supabase-postgres-17.6.1.171` (newer than the parent's 17.6.1.166),
  compute `ci_micro`, `db_host db.<branch-ref>.supabase.co:5432` as
  `postgres` - IPv6-only from here, so the push went through the branch's
  Supavisor tenant (`postgres.<branch-ref>` on the regional pooler host,
  session mode; readable via `GET /projects/<branch-ref>/config/database/pooler`).
- MS15b: `prisma db push` (6.19.3) exit 0 in 14859 ms; one row inserted on
  the branch; the parent's `public.ms_record` resolves to null.
- MS15c: `GET /branches/{id}/diff` HTTP 200, 2016 chars of SQL: `create
  extension if not exists "pg_net"`, the `ms_record` sequence, table, primary
  key and tenant index - the platform diffs a db-push schema against the
  parent.
- MS15d: `POST /branches/{id}/merge` HTTP 201 `{"workflow_run_id": ...,
  "message": "ok"}`. The parent had no `ms_record` 20 s later, and about 10
  minutes later still had no `pg_net` extension (the discriminator the
  module's own cleanup could not have removed). The merge is accepted and
  applies nothing when there are no migration files.
- MS15e: `DELETE /branches/{id}` HTTP 422 `Cannot delete persistent branch.`;
  `PATCH {persistent: false}` HTTP 200; second DELETE HTTP 200; gone from
  the list after 1 s.
- Reading: a branch works as an isolated staging database for a
  Prisma-owned schema (push, insert, diff all fine); promoting it with
  `merge` does not carry the schema, so the promotion path for a
  `db push` workflow is `prisma db push` against production, or generating
  `supabase/migrations` from `prisma migrate diff`.

### MS13 - custom hostname, fourth run with pinned probes (run-2026-09-30T06-56-35)

- MS13a: `cd_default` HTTP 200; initialize HTTP 201 `2_initiated`, ownership
  TXT only.
- MS13b: ACME validation record returned at 22 s and written; verified after
  171 s, `4_origin_setup_completed`, ssl `active`.
- MS13c: activate HTTP 201, `5_services_reconfigured` after 1 s. Pinned to
  1.1.1.1's answer for the name (`172.64.149.246` then `104.18.38.10`, the
  CNAME target's Cloudflare edge): `/auth/v1/health` answered 400 at 0 s and
  61 s, then 200 at 71 s after activation; `/rest/v1/` 401 (the same as the
  origin's answer to an anon key). Certificate: `issuer=C=US, O=Google Trust
  Services, CN=WE1`, `subject=CN=<host>`.
- MS13d: a Storage signed URL minted against the origin host fetched 200 via
  the origin and 200 via the custom host; a pinned HTTP upgrade attempt on
  `/realtime/v1/websocket` answered HTTP 500 (the Realtime server reached,
  refusing a curl-shaped handshake); origin `/auth/v1/health` 200 throughout.
- MS13e: DELETE 200, 3 DNS records removed, `cd_default` removed 200, 2 s.
- Reading, across four runs: from CNAME plus TXT records in DNS to a verified
  challenge and active certificate took 45-193 s; the `_acme-challenge`
  record is never in the initialize response and arrives 3-23 s later;
  activation reports complete within a second and the name served about 70 s
  after that; signed URLs are host-independent; the origin keeps serving.

## 2026-09-30 - close-out

Project destroyed the same day. Runs: MS01 x2, MS02, MS03 x2, MS04 x2, MS05
x3, S01, MS10, MS08, MS09, S02, MS12, MS11, MS14, MS15 x3, MS13 x4, MS06,
MS07.

## Harness and platform notes from this spin

- `pg` `Client` emits `error` when its socket is destroyed; without a handler
  the event kills the pvlab process and every result of the run is lost
  (MS03's first artifact went this way). Attach `c.on("error", ...)` before
  `stream.destroy()`.
- `import.meta.dir` inside the compiled binary is `/$bunfs/...`; a module that
  needs a repo path reads `process.cwd()` (the Makefile runs from the
  experiment dir) or an env var.
- Measurement keys are not redacted by `publish-evidence`; a key built from
  `postgres.<ref>` carried the ref into `out/` and was scrubbed by hand.
  Correction 2026-10-06: the redactor already ran over keys (the whole JSON
  text). Its `\b[a-z]{20}\b` missed a ref touching `_`, which is the likelier
  shape of this key; fixed in `2cde058`, with unit cases.
  MS01d now names the tenant user generically.
- `logs.all` is gone (410); `harness/src/platform.ts` says so and points at
  the unified `logs` table.
- `make apply` recipes are silenced with `@` so the PAT passed as `-var` is
  not echoed into a log.
