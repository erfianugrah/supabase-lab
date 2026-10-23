# pooler-checkout - RUNLOG

Written and run 2026-10-10 (lab revision in each artifact's `labCommit` field,
plus the uncommitted experiment directory). Self-provisioning: every run created
a Micro project through the Management API in a Pro org and deleted it before
exiting; `GET /projects` showed no project with the run prefix afterwards (PC09
passed in runs 1 to 7).

Vantage for every row: one macOS laptop in Singapore, IPv4 only (the OS resolver
returned no AAAA answer and a `curl -6` to a public IPv6 host failed). Module
code ran under bun and the driver probe under node; both runtime versions are in
each artifact's `toolVersions`, and the driver versions are the exact pins in
`drivers/package.json` (read back from `node_modules` after install). The
toxiproxy image tag is the `IMAGE` constant in `tests/pc03-driver-reset.ts`.
Project: compute `ci_micro`, `ap-southeast-1` unless a row says otherwise,
`max_connections` 60. Raw artifacts are in the ignored `evidence/<ts>/`; the
figures below were quoted by hand from them. Redacted copies, each with a
`.facts.md` beside it, are in the run table's last column.

Runs (all 2026-10-10, UTC stamps in the artifact names):

| Run | Evidence dir | Modules | Note | Published artifact |
|---|---|---|---|---|
| 1 | `20261010-095322` | PC01-PC04, PC09 | PC02 void: the laptop idle-slept mid-module (below). PC01, PC03, PC04 rows are valid | `out/2026-10-10/run-2026-10-10T01-53-22-718Z.json` |
| 2 | `20261010-104011` | PC01-PC04, PC09 | run under `caffeinate`; adds the host clock rows | `out/2026-10-10/run-2026-10-10T02-40-11-359Z.json` |
| 3 | `20261010-110914` | PC02, PC09 | adds PC02h | `out/2026-10-10/run-2026-10-10T03-09-14-920Z.json` |
| 4 | `20261010-112056` | PC03, PC09 | probe retry delay 300 ms (runs 1 and 2 retried at 0 ms) | `out/2026-10-10/run-2026-10-10T03-20-56-512Z.json` |
| 5 | `20261010-113309` | PC04, PC09 | adds PC04d | `out/2026-10-10/run-2026-10-10T03-33-09-220Z.json` |
| 6 | `20261010-113347` | PC03, PC09 | as run 4, plus the head of a crashed process's stderr | `out/2026-10-10/run-2026-10-10T03-33-47-691Z.json` |
| 7 | `20261010-114645` | PC04, PC09 | project in `us-east-1` (the facts header shows the harness region) | `out/2026-10-10/run-2026-10-10T03-46-45-971Z.json` |

## Run 1 voided PC02: the machine slept

PC02c in run 1 had a 100 s client deadline and reported 241,600 ms for the
query, while the module's monotonic duration (`durationMs`) for all of PC02 was
184,987 ms. On macOS `performance.now()` and timers use a clock that stops while
the machine sleeps; `Date.now()` does not. The power log shows an idle sleep
from 10:00:22 to 10:06:10 local time during that module. PC01 and PC03 in run 1
ran outside that window and their figures match runs 2 to 6. Every later run is
wrapped in `caffeinate -dims`, and PC01, PC02 and PC03 end with a `-clock` row
(wall clock minus monotonic clock over the module, pass under 2000 ms). Values
read: 2 ms (PC01, run 2), 3 ms (PC02, run 2), 2 ms (PC03, run 2), -4 ms (PC02,
run 3); runs 4 and 6 also passed it for PC03.

## PC01 - reproducing `ECHECKOUTTIMEOUT` (runs 1 and 2, 3 trials each)

Measured, `ap-southeast-1`, Supavisor transaction pooler on 6543, Micro:

| Observation | Value | Rows |
|---|---|---|
| Pool size the API reports | `default_pool_size null`, `max_client_conn null`, `pool_mode transaction` | PC01a |
| Effective pool size: active `pg_sleep` backends 6 s into 40 concurrent `pg_sleep(25)` clients, counted through the Management API | 16 (both runs) | PC01b |
| Drain of the other 24 clients | recorded: 40 of 40 clients ok, 0 errored, longest queue wait that still succeeded 50 s, wall 75 s. Inferred, not timed per client: with a pool of 16 and a 25 s sleep the clients finish in waves of 16, 16 and 8 at about 25, 50 and 75 s | PC01b |
| Client N+1 (N = 16, 16 backends held by `pg_sleep(75)`): `connect()` | 43 to 52 ms, succeeds | PC01c-1..3, both runs |
| Same client, first `select 1` | fails after 60,007 to 60,009 ms (6 of 6 trials) | PC01c-1..3, both runs |
| Verbatim error | `XX000 (ECHECKOUTTIMEOUT) unable to check out connection from the pool after 60000ms in Transaction mode` | PC01c-1..3 |
| `select 1` once the holders had ended | 7 to 8 ms | PC01c-1..3 |
| Holders sleep 8 s, client N+1 sends `select 1` 2 s in | served after 6,018 to 6,056 ms (4 of 4), no error | PC01d-1..2, both runs |

Reading. The client is accepted and the error arrives on the first statement,
so a connect probe or a pool "ping on connect" does not see exhaustion. Queueing
is the normal outcome: a statement that waits less than 60 s is served; one that
waits 60 s is refused. The error text embeds the timeout, so a client can read
it off the message.

Docs and public claims, separate from the above:

- A public status-page mirror (https://pulsetic.com/status/supabase/incidents/6635/,
  fetched 2026-10-10) titles an incident "Error spikes in one of the eu-east-1
  Supavisor clusters", dated 2026-08-24, and quotes the same error with `after
  15000ms in Transaction mode`. This project answered 60000 ms in 6 of 6 trials.
  Whether the figure is per cluster, per tenant or per Supavisor release was not
  separated; one project, one region, one day. Answered on 2026-10-23 (section
  "Where `after 15000ms` comes from" below): it is a different wait.
- The connection-management guide
  (https://supabase.com/docs/guides/database/connection-management) says each
  compute add-on has a pre-configured Supavisor pool size; the API returned
  `null` for it here, so the 16 is a measurement of effective concurrency, not a
  configured value read back.
- Role `postgres` cancelled a `pg_sleep(130)` with `canceling statement due to
  statement timeout` at 120 s (an exploratory run, not an artifact row): holders
  must sleep under 120 s.

Not measured: other compute sizes, a pool size changed through the API, a larger
crowd of waiting clients (the 40-client drain finished inside the 60 s window),
whether a waiting client that disconnects frees its queue slot.

## PC02 - fallback switch time (runs 2 and 3, 3 trials per row each)

The primary is the held transaction pool (16 of 16 backends active, PC02-hold).
The policy tested: the client gives up on the primary after a deadline (3,000 ms
client side, or the server's own 60 s error for PC02c), then opens a new
connection to the fallback and runs `select 1`. "Switch" is the time from the
primary's failure to the fallback's answer; "total" is from the primary attempt
start.

| Row | Fallback | Run 2 switch ms | Run 3 switch ms | Total ms (both runs) |
|---|---|---|---|---|
| PC02a | Supavisor session mode, 5432 | 49-61 | 59-70 | 3,092-3,131 |
| PC02b | direct 5432, no IPv4 add-on | 0 of 3 answered | 0 of 3 answered | n/a |
| PC02c | session mode after the server's `ECHECKOUTTIMEOUT` (no client deadline) | 56-69 | 62-117 | 60,115-60,359 |
| PC02e | dedicated pooler (PgBouncer) 6543, IPv4 add-on on | 131-145 | 126-167 | 3,180-3,222 |
| PC02f | direct 5432, IPv4 add-on on | 135-156 | 142-168 | 3,193-3,247 |

- PC02b error: `ENOTFOUND getaddrinfo ENOTFOUND` on the direct host, in 6 of 6
  trials. The artifacts mark the PC02b row `fail` in runs 1 to 3 because no
  fallback answered; that is the expected observation for a project without the
  IPv4 add-on, not a harness failure (the module and PC09 completed). The OS resolver returned 0 IPv4 and 0 IPv6 addresses
  (`direct_host_ipv4_addresses`, `direct_host_ipv6_addresses`); PC04d (below)
  shows a public resolver does return one AAAA record, so the OS resolver's 0 is
  this vantage's view, not the zone's.
- PC02d, IPv4 add-on switched on by `PATCH billing/addons` (HTTP 200 in both
  runs): this vantage's resolver returned an IPv4 address after 80 s in both
  runs; the dedicated pooler answered at 81 s and 80 s, direct 5432 at 81 s and
  81 s (5 s poll step plus up to 8 s probe time). Removal (`DELETE
  billing/addons/ipv4_default`) returned HTTP 200 and the add-on was gone on the
  next read (PC02g, both runs). In an earlier exploratory run on a different
  project the same DELETE answered HTTP 429 shortly after the PATCH, so the
  module retries it.
- PC02h (run 3): 16 transaction-mode backends held plus one session-mode client
  running `pg_sleep(15)`: 17 active `pg_sleep` backends 8 s in; the session
  client connected in 50 ms and completed. Measured only: at an effective
  transaction pool of 16, one extra session-mode client got a 17th backend. This
  is not compared with a documented combined limit (none was found on the
  connection-management page); one run, n=1, the pool setting was not changed.
- The session-mode fallback is a different pooling mode: session state
  (prepared statements, `SET`) behaves as on a direct connection, and each
  fallback client holds a backend for its whole connection. A herd of fallbacks
  was not tested; PC02h shows only that one extra session client fits while the
  transaction pool is full.

Not measured: fallback under load, a client already connected over IPv6 when the
add-on flips (this vantage has no IPv6), other resolvers' propagation, the cost
of reconnecting with TLS verification (`rejectUnauthorized: false` throughout).

## PC03 - TCP reset between client and Supavisor (runs 1 and 2 at retry delay 0 ms; runs 4 and 6 at 300 ms; 3 runs per cell per run)

Rig: toxiproxy in Docker, listening on 127.0.0.1:16543 in front of the project's
Supavisor transaction pooler. Drivers: node-postgres (`pg`), postgres.js
(`postgres`) and Prisma, each at the pin in `drivers/package.json`, Prisma with
`pgbouncer=true&connection_limit=5`. Each run: new node process, pool of 5, 5
workers issuing `select 1` every 200 ms for 22 s after warm-up; a fault from 4 s
after warm-up for 2,000 ms (`reset`, `cut`) or 150 ms (`flap`). A failed first
attempt is retried once, after 0 ms (runs 1, 2) or 300 ms (runs 4, 6).

Faults: `reset` = toxiproxy `reset_peer` on both streams, timeout 0 (RST on the
next bytes of any connection); `cut` = proxy disabled then re-enabled (open
connections closed, new connects refused for 2 s); `flap` = the same
disable/enable within 150 ms (open connections die, new connects succeed at once).

Controls, no fault, 10 s: 0 failed of 240 (pg), 240 (postgres.js) and 210
(Prisma) statements in each of runs 1, 2, 4, 6.

Counts are first attempts; each group below pools 6 runs (2 module runs of 3).
A run that did not crash has 455 to 530 first attempts for pg and postgres.js
and 415 to 470 for Prisma; a count of 5 is one failure per pooled connection. Attempt counts differ
between the two delay groups because a failed worker sleeps for the retry delay.

| Driver, fault | Failed first attempts, retry at 0 ms | Rescued by the retry | Failed first attempts, retry at 300 ms | Rescued by the retry |
|---|---|---|---|---|
| pg, reset | 40-45 per run | 2 of 254 | 20 per run | 0 of 120 |
| pg, cut | 45-50 per run | 0 of 290 | 20 per run | 0 of 120 |
| pg, flap | 5 per run | 0 of 30 | 0 in 1 run, 5 in 5 runs | 25 of 25 |
| postgres.js, reset | 5 per run | 30 of 30 | 5 per run | 30 of 30 |
| postgres.js, cut | 0 in 4 runs, 5 in 2 runs | 10 of 10 | 0 in 5 runs, 3 in 1 run | 3 of 3 |
| postgres.js, flap | 0, 4 or 5 per run | 19 of 19 | 0 in 2 runs, 5 in 4 runs | 20 of 20 |
| Prisma, reset | 43-45 per run | 2 of 263 | 20 per run | 30 of 120 |
| Prisma, cut | 45-50 per run | 0 of 295 | 20 per run | 10 of 120 |
| Prisma, flap | 5 per run | 0 of 30 | 5 per run | 30 of 30 |
| pg with no pool `error` listener, cut | 50 in 2 runs; the other 4 runs died first | 0 | 20 in 1 run; the other 5 runs died first | 0 |

Measured readings:

- After the fault cleared, no first attempt failed in the 111 runs that did not
  crash (`failed_after_clear` 0): all three pools evicted dead connections and
  recovered without a restart. The first successful first attempt after the
  clear came 2 to 98 ms after (pg, reset and cut, 0 ms group), 259 to 275 ms
  (postgres.js, reset and cut, same group), 9 to 187 ms (Prisma, same group);
  the 300 ms group includes the workers' retry sleep and reads higher.
- During a 2 s reset or cut, pg and Prisma first attempts failed at 40 to 50 per
  run in the window at 0 ms and 20 per run at 300 ms (`failed_in_window`; in
  runs 2 and 6 it equals `failed_total` for every cell except reset at 0 ms,
  where it is 40 against 45 or 42 for pg and 42 against 44 for Prisma). The
  number of first attempts started in the window is not an artifact key, so
  "every attempt in the window failed" is not claimed. pg's
  error is `Error: Connection terminated unexpectedly`; Prisma's is `P1001`
  (`Can't reach database server`) while the proxy refuses and `P1017`
  (`Server has closed the connection`) on a closed connection.
- A retry-once at 0 ms did not rescue a failure from a 150 ms flap on pg or
  Prisma (0 of 30 each); it lands inside the 150 ms the proxy is down, which is
  an inference from the timing, not a separate probe. At 300 ms it rescued 25 of
  25 (pg) and 30 of 30 (Prisma). A retry for a stale-connection failure has to
  wait longer than the outage it follows.
- postgres.js did not surface an error in 9 of 12 `cut` runs; in the 9 runs with
  no failed first attempt the slowest statement took 1,902 to 2,103 ms, about
  the length of the cut. When it did fail (3 to 5 failures in a run) the
  retry rescued every one. Its first success after a reset or cut was 259 to
  281 ms in both delay groups, which fits a fixed reconnect delay; the source
  was not read.
- node-postgres `Pool` without an `'error'` listener: 9 of 12 runs exited
  non-zero at the cut. The one stderr head captured (run 6) begins `node:events
  throw er; // Unhandled 'error' event ... Error: Connection terminated
  unexpectedly`. The 3 other runs survived; why was not separated (no pooled
  connection idle at the instant is a guess). With the listener (rows "pg"),
  0 of 36 runs crashed and the handler saw 0 to 5 `error` events per run.

Not measured: a real Supavisor node replacement (the proxy reproduces the TCP
symptom; it does not show how the platform moves tenants), prepared statements
(postgres.js ran with `prepare: false`), long-idle pools (the pools were busy
every 200 ms), TLS verification (Prisma used `sslaccept=accept_invalid_certs`),
other driver releases, Bun or Deno runtimes.

## PC04 - pooler host prefix and the lint (runs 1, 2 and 5 in `ap-southeast-1`, run 7 in `us-east-1`)

| Project | `db_host` prefix the API reports | Same tenant on `aws-0-<region>`, 5432 and 6543 | Same tenant on `aws-1-<region>`, 5432 and 6543 |
|---|---|---|---|
| runs 1, 2, 5 (`ap-southeast-1`) | `aws-0` | ok, 52 to 151 ms | `XX000 (ENOTFOUND) tenant/user postgres.<ref> not found`, 535 to 648 ms |
| run 7 (`us-east-1`) | `aws-0` | ok, 2,228 and 2,297 ms | the same error, 3,636 and 3,684 ms |

On 2026-10-10 a fresh project in each of two regions was on `aws-0`, and the
`aws-1` host refused the tenant with a tenant error rather than a connection
error. The hypothesis that `aws-0` hosts are the old ones is not supported by
these four projects; whether older projects or other regions sit on `aws-1` was
not measured, so the lint flags the literal host, not a prefix number.

- PC04c: `lib/lint-pooler-hosts.ts` on fixtures built at run time flags 2 of 2
  `aws-0` literals (3 of 3 with `--all-prefixes`) and ignores the dedicated and
  direct hosts. Over this repository's tree it flagged 8 `aws-0` literals in 6
  files in each of runs 1, 2, 5, 7 (existing RUNLOGs and docs quoting hosts): the
  lint is a tool for application repos, and this count is the lab's own prose.
  `bun test experiments/pooler-checkout` runs the lint's and the summary
  arithmetic's unit tests (9 tests).
- PC04d (runs 5 and 7): without the IPv4 add-on a public resolver (1.1.1.1)
  returned 0 A and 1 AAAA record for the direct host; this machine's resolver
  returned 0 IPv4 and 0 IPv6.

## Where `after 15000ms` comes from (PC01, PC05-PC07; runs 8 and 9, 2026-10-23)

The 2026-10-10 runs measured 60,000 ms and left a public `after 15000ms`
report unexplained. This section answers it from the Supavisor source and then
reproduces it.

| Run | Evidence dir | Project | Modules | Published artifact |
|---|---|---|---|---|
| 8 | `20261023-161142-micro` | `ci_micro`, `max_connections` 60 | PC01, PC05, PC06, PC07, PC09 | `out/2026-10-23/run-2026-10-23T08-11-43-542Z.json` |
| 9 | `20261023-161147-small` | `ci_small`, `max_connections` 90 | PC01, PC05, PC06, PC07, PC09 | `out/2026-10-23/run-2026-10-23T08-11-48-633Z.json` |

Both runs: 2026-10-23, `ap-southeast-1`, Pro org, pooler prefix
`aws-0`, same IPv4-only vantage as above, run concurrently under `caffeinate`
(every `-clock` row passed, 1 to 5 ms drift). The two projects were created
by `POST /v1/projects` outside the harness and handed to it with
`PVLAB_PC_ADOPT`, so PC01a's `create_to_healthy_s` of 0 is not a provisioning
time and PC09 reports them as adopted; both were deleted with `DELETE
/v1/projects/{ref}` after the runs and answered 404 on a later `GET`.

### Source reading (Supavisor at commit `d875a44f8316`, 2026-10-22; not a measurement)

Supavisor raises `ECHECKOUTTIMEOUT` with the text `unable to check out
connection from the pool after <N>ms in <mode> mode`
(https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/errors/checkout_timeout_error.ex#L19)
from two places, and the two use different N:

1. Waiting for a free pool slot: `pool_checkout` calls `:poolboy.checkout`
   with `data.timeout` (https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/client_handler.ex#L1105-L1109),
   which is the tenant user's `pool_checkout_timeout`
   (https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/client_handler.ex#L1145). The schema default is
   `60_000` (https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/tenants/user.ex#L18). The Management API does
   not expose the field: `UpdateSupavisorConfigBody` in
   https://api.supabase.com/api/v1-json (fetched 2026-10-23) has
   `default_pool_size` and `pool_mode` only. The wait is divided by the
   attempt number on a retry after a pooled connection exits mid-checkout
   (https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/client_handler.ex#L954, at most 2 retries per
   https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/client_handler.ex#L22), which gives 60,000, 30,000 and
   20,000 ms, never 15,000.
2. Handing the slot's backend connection to the client: `DbHandler.checkout`
   is a `:gen_statem.call` whose timeout defaults to a fixed `15_000`
   (https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/db_handler.ex#L105) and the caller passes none
   (https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/client_handler.ex#L958). The backend connection
   postpones that call until it is `idle` or `busy`
   (https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/db_handler.ex#L638-L652), that is, while it is still
   connecting, authenticating or waiting out its 2,500 ms reconnect cooldown
   (https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/db_handler.ex#L65). A Postgres login that takes longer
   than 15 s therefore produces `after 15000ms` while the pool has free
   slots. Authentication itself has a separate 15,000 ms limit
   (https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/db_handler.ex#L66) that fails with a different error.

The `after <N>ms` text arrived with PR #841 (merged 2026-03-10, first tagged in
v2.9.0, https://github.com/supabase/supavisor/pull/841). Before it, a
checkout timeout in transaction mode answered `Unable to check out connection
from the pool due to timeout` and one in session mode `MaxClientsInSessionMode:
max clients reached - in Session mode max clients are limited to pool_size`,
neither with a figure
(https://github.com/supabase/supavisor/blob/85acdde26b97f1c1b151c1e759f1b581e81e09a6/lib/supavisor/client_handler/error.ex#L251-L263).
The authentication limit arrived with PR #970 (merged 2026-05-07, first
tagged in v2.9.4, https://github.com/supabase/supavisor/pull/970). PC06 below
received that PR's error text, so the platform release serving these two
projects carried both changes; the exact release was not read.

The same source sizes a pool as `size: min_size, max_overflow: pool_size`,
with `min_size` 1 for an ordinary user
(https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/tenant_supervisor.ex#L25 and
https://github.com/supabase/supavisor/blob/d875a44f8316f89f95df698db0ad53e1c1563174/lib/supavisor/tenant_supervisor.ex#L78-L85). That is one more
backend than the pool size, which fits PC01b's 16 against the 15 that the
session-mode error below names, and PC07b's 6 against a pool size of 5. This
is a reading of the code next to the counts, not a separate probe.

Public reports, read as context: a closed issue in the Supabase repository
(https://github.com/supabase/supabase/issues/48163, opened 2026-07-21) quotes
pooler logs where `after 15000ms in Transaction mode` sits next to `DbHandler:
Connection failed {:error, :etimedout}` lines for the project's database
address, which is the second path. The status-page mirror cited in PC01 calls
its `after 15000ms` incident "Error spikes in one of the eu-east-1 Supavisor
clusters"; that it was the second path is an inference from the wording and
the code, not something the page states.

### PC01 re-run and PC05: the pool-slot wait does not move (runs 8 and 9)

Measured, 3 trials per row per run unless stated:

| Row | What was varied | Result | Rows |
|---|---|---|---|
| PC01b | effective transaction pool, 40 `pg_sleep(25)` clients | 16 active backends at +6 s on both `ci_micro` and `ci_small`; 40 of 40 clients served | PC01b |
| PC01c | client N+1 behind 16 `pg_sleep(75)` holders, transaction mode | `select 1` failed after 60,007 to 60,013 ms (6 of 6, both runs), `(ECHECKOUTTIMEOUT) unable to check out connection from the pool after 60000ms in Transaction mode` | PC01c-1..3 |
| PC05b | four extra transaction-mode clients at once: plain; node-postgres `statement_timeout: 5000`; `options: -c statement_timeout=5000`; `connectionTimeoutMillis: 5000` | every client connected in 48 to 58 ms and its `select 1` failed after 60,007 to 60,011 ms with the 60000ms text (24 of 24) | PC05b-1..3 |
| PC05a | 24 session-mode (5432) clients each `pg_sleep(75)` | 15 active backends at +6 s and 15 served; the other 9 per trial failed at connect after 560 to 597 ms with `(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15` (27 of 27 waiting clients per run). No session client queued and none saw `ECHECKOUTTIMEOUT` | PC05a-1..3 |
| PC07a | `PATCH .../config/database/pooler` `{"default_pool_size": 5}` | HTTP 200; read back `default_pool_size` 5 | PC07a |
| PC07b | pool size 5: 12 `pg_sleep(75)` clients plus one `select 1` | 6 active backends at +6 s; the extra client failed after 60,006 to 60,012 ms with the 60000ms text (6 of 6); 6 of 12 holders also failed, after 60,061 to 60,577 ms | PC07b-1..3 |

Reading. On these two compute sizes the pool-slot wait was 60 s whatever the
pool size the owner set and whatever the client sent. A Postgres
`statement_timeout` cannot shorten it: the statement never reaches Postgres
while it waits for a slot. Session mode on these projects does not wait at
all once its pool is full; it refuses at connect in under 600 ms.

### PC06: a slow backend login reproduces `after 15000ms` (runs 8 and 9)

Rig: a `login` event trigger (Postgres 17; PC06a records that role
`postgres` could create it through the Management API) that runs `pg_sleep(d)` only for
sessions whose startup `application_name` is `Supavisor` (the pooler's own
backend connections; the Management API session is `mgmt-api`), with d read
from a table. Each trial set d, terminated the pooler's backends through the
Management API (`pg_terminate_backend`), then started the clients. Transaction
rows: 4 concurrent `select 1` clients, then 1 more after they finished, 3
trials (15 clients per row per run). Session row: 2 concurrent clients, 3
trials (6 per run). No other client held the pool during these trials.

| Row | Login delay d | Run 8 (`ci_micro`) | Run 9 (`ci_small`) |
|---|---|---|---|
| PC06b | 0 s, transaction | 15 of 15 served, 57 to 96 ms from connect start to answer | 15 of 15 served, 52 to 97 ms |
| PC06c | 8 s, transaction | 15 of 15 served: the 12 concurrent clients after 8,006 to 8,097 ms, the 3 follow-up clients after 64 to 86 ms | 15 of 15 served: concurrent clients after 8,014 to 8,130 ms, follow-up clients after 50 to 73 ms |
| PC06d | 20 s, transaction | 12 of 15: `(ECHECKOUTTIMEOUT) unable to check out connection from the pool after 15000ms in Transaction mode` after 15,051 to 15,070 ms; 3 of 15: `08006 Failed to connect to database: authentication did not complete within 15000ms` after 14,997 to 15,002 ms | 12 of 15 the same `after 15000ms in Transaction mode`, 15,054 to 15,081 ms; 3 of 15 the `08006` text, 14,997 to 15,015 ms |
| PC06e | 20 s, session (5432) | 4 of 6: `... after 15000ms in Session mode`, 15,046 to 15,134 ms; 2 of 6 the `08006` text, 15,001 to 15,002 ms | 4 of 6 `after 15000ms in Session mode`, 15,046 to 15,180 ms; 2 of 6 the `08006` text, 14,990 to 14,999 ms |

Reading. Measured: with logins delayed past 15 s, clients on a project whose
pool-slot wait is 60 s got `ECHECKOUTTIMEOUT ... after 15000ms` in both
transaction and session mode, on both compute sizes, and the follow-up client
sent after the first failure got it too (6 of 6 transaction trials). With
logins delayed 8 s every client was served after about 8 s. In each
transaction trial exactly one of the 4 concurrent clients got the `08006`
authentication error instead; in session mode 1 of 2 clients did in trials 2
and 3, and none in trial 1, in both runs. Which client gets which matches the
source reading: a client handed a backend that had started authenticating
before the client's own 15 s timer started sees the authentication limit fire
first; one handed a backend still connecting or in its reconnect cooldown sees
its own 15 s checkout limit fire first. That per-client mapping is inferred
from the code, not logged.

Conclusion for the 60,000 ms vs 15,000 ms question: the figure in the error
text names which wait expired. `after 60000ms` is the pool-slot wait (the
tenant's `pool_checkout_timeout`, 60 s on every project measured here);
`after 15000ms` is the backend-connection handover, which is fixed in the
code and, per the source, fires when the backend connection a client is
handed is not ready within 15 s, whatever keeps it from being ready.
Measured here only with a deliberately slow login; that
public `after 15000ms` reports were the same path, and not a tenant configured
with a 15 s pool wait, is inference: no project with a 15,000 ms pool-slot
wait was found, and the field cannot be read through the Management API.

Not measured: a real network fault between the pooler and Postgres (the
public issue's case), compute sizes above Small, regions other than
`ap-southeast-1`, the dedicated pooler (PgBouncer), and whether any tenant
runs with a `pool_checkout_timeout` other than 60,000.

## What was not run

- Compute sizes other than Micro and Small (Small since 2026-10-23), other
  Supavisor releases, other clusters.
- No project with a 15,000 ms pool-slot wait was found. The `after 15000ms`
  text was reproduced on 2026-10-23 through the other path (PC06, above): a
  backend login slower than 15 s.
- Any production client. All clients are `select 1` or `pg_sleep` probes.
