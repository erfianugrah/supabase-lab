# RUNLOG - experiments/hyperdrive-direct

Cloudflare Hyperdrive against the Supabase direct connection
(`db.<ref>.supabase.co:5432`). One throwaway Pro project per module,
self-provisioning (no tofu); the probe Worker and the Hyperdrive config are
created with wrangler and deleted in the same run.

Run: `PVLAB_ORG_PRO=<slug> pvlab --where local --experiment hyperdrive-direct --only H01 --destructive`
(H02: `bun harness/src/run.ts` from the repo root with `--only H02`, same flags;
about 21 minutes, most of it the 900 s recovery watch, `PVLAB_H02_RECOVERY_S`;
H03: `--only H03`, about 36 minutes, most of it the 1800 s idle watch,
`PVLAB_H03_WATCH_S`; `PVLAB_H03_SKIP_Q1=1` runs the Q2 arms only, about 6
minutes)
with `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` in the
env (the Global API Key trio; a scoped token fails wrangler's account lookup
on this box). H01 self-skips without them.

## Findings, by module

- H01 (2026-10-05): Hyperdrive reaches the IPv6-only direct connection with
  no IPv4 add-on, and node-postgres named prepared statements work through it.
- H02 (2026-10-23): on Small (`max_connections` 90), non-superusers are
  refused at 87 client backends in total (superuser backends count toward
  the 87); a Hyperdrive config's default origin connection limit read back
  60 and capped its origin connections at 60; in one run Hyperdrive kept 60
  idle origin connections at every sample up to 891 s (watch cap 900 s),
  past Cloudflare's documented 10 minute idle timeout; when slots ran out,
  in both orderings tried (one run each), requests needing a new connection
  failed while the side already connected kept working.
- H03 (2026-10-23): idle origin connections were closed after 965-1182 s
  idle (default limit) and 965-1265 s (limit 15), past the 10 minute idle
  timeout Cloudflare lists for Hyperdrive-to-origin connections; until then
  nothing ran on them (one run). The Data API's PGRST002
  under Hyperdrive slot pressure is both readings at once: as many
  `dc_sleep_xl` calls answered 200 as PostgREST had pool connections plus
  free slots, and the first refused connection made PostgREST fail its
  schema-cache load, answer PGRST002 to the rest, and reinitialise its pool
  about 8 s later (three runs).

## 2026-10-05 - IPv6-only origin and named prepared statements (H01)

Cloudflare's Supabase page recommends the direct connection string and its
node-postgres page documents named prepared statements; neither says
Hyperdrive connects to an IPv6-only origin. Fresh Micro project in
`ap-southeast-1`, Pro org, no IPv4 add-on.

- Direct host DNS: 1 AAAA record, 0 A records (IPv6-only).
- `wrangler hyperdrive create --caching-disabled` against
  `postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres` saved on the
  first attempt. Hyperdrive runs a live connect check before it saves, so the
  save alone proves the origin is reachable from Cloudflare over IPv6.
- A Worker (`nodejs_compat`, `pg` 8.23.1, new `Client` per request) returned a
  row through the binding; `family(inet_server_addr())` read 6 (IPv6);
  `server_version` 17.11.
- A named query (`{ name, text, values }`) executed twice on one client
  returned the right values, and again on a second request.
- Reading: the direct string works behind Hyperdrive without the IPv4 add-on
  (this run; Cloudflare does not publish it as a guarantee). It matches the
  2026-07 observation in the lexicanum cloudflare-supabase-architecture
  reference.

Evidence: run artifact `run-2026-10-05T08-17-22-027Z` (gitignored). Project,
Worker and config deleted in the run's `finally`.

## 2026-10-23 - Hyperdrive and the Data API on one max_connections (H02)

Question: an app reaches a project through Hyperdrive on the direct
connection and through the Data API, and both draw on the same
`max_connections`. How many origin connections does Hyperdrive open, does
`--origin-connection-limit` cap them, which side fails first and with what
error, how many slots a non-superuser role really has, and what recovery
looks like.

Setup: one fresh Small project per run, Pro org, `ap-southeast-1`, Postgres
17.11, PostgREST 14.18 (from `application_name`). Two Hyperdrive configs on
`db.<ref>.supabase.co:5432`, caching disabled: config A logs in as role
`hd_a` with no limit flag, config B as `hd_b` with `--origin-connection-limit
5`. One Worker (`nodejs_compat`, `pg` 8.23.1, new `Client` per request)
runs `select pg_sleep(s)` through either binding; this Mac sends K
concurrent requests with fetch, which keeps each error body (oha reports
statuses only). Data API holds are `dc_sleep_xl(s)` RPCs with the legacy
service_role API key. All rows are one run each.

Two runs. Run 1 (`out/2026-10-23/run-2026-10-23T07-51-57-032Z.json`) ran an
earlier, uncommitted version of the module: Management API observer, no
warm-up, 150 s Data API holds, steps 10/20/30/45. Both artifacts stamp lab
commit 661afdf, which predates H02. Run 1's observer, the Management API
query endpoint, logs in as `postgres` (`rolsuper` false) and was itself
refused at the limit, so from its H02e on it saw nothing; its H02b rows
include 8 `404` HTML answers from workers.dev during deploy propagation
(and H02c step 10 one more). Run 2
(`out/2026-10-23/run-2026-10-23T08-12-55-905Z.json`) is the reference: it
reads `pg_stat_activity` through config B's already-open origin connections
(a SECURITY DEFINER function owned by `postgres`, granted to `hd_b` only;
the owner `postgres` can also run it), waits for 10 good answers in a row
per binding before measuring, and resets between the two orderings.
Figures are run 2 unless run 1 is named.

### Slots (H02a)

- `max_connections` 90, `superuser_reserved_connections` 3,
  `reserved_connections` 0. Superusers: `supabase_admin` only, which is also
  the only non-`pg_` role for which `pg_has_role(...,
  'pg_use_reserved_connections', 'member')` is true; that check is true for
  any superuser (Postgres `is_member_of_role` returns true for superusers,
  https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/acl.c),
  so no explicit grant was checked. No role has a `rolconnlimit`.
- At saturation the database held 87 client backends and refused the
  Management API with `53300: remaining connection slots are reserved for
  roles with the SUPERUSER attribute` (H02c step 45: `hd_a` 49,
  `authenticator` 31, `hd_b` 5, `pgbouncer` 1, `supabase_admin` 1). 87 =
  90 - 3. The `supabase_admin` backend is `postgres_exporter` and counts
  toward the 87, so with it connected non-superusers get 86.
- Supabase's own client backends at idle, run 1 before any Hyperdrive
  traffic: `authenticator` 2, `pgbouncer` 1, `supabase_admin` 1
  (`postgres_exporter`), plus `postgres` 1 for the Management API query
  that took the reading. Background workers (`pg_net` as `postgres`,
  `pg_cron` launcher and logical replication launcher as `supabase_admin`)
  appear in `pg_stat_activity` but are not client backends.
- Reading: with PostgREST's pool of 30 full (31 `authenticator` backends,
  H02c), `pgbouncer` 1 and `postgres_exporter` 1, 54 slots are left for
  everything else: Hyperdrive, the Management API and the dashboard's SQL.
  Derived from the counts above, not measured as one figure.

### Hyperdrive's origin connections and the limit flag (H02a, H02b)

- `--origin-connection-limit` is the flag (wrangler 4.147.0, run 1); its
  help text reads "The (soft) maximum number of connections that Hyperdrive
  may establish to the origin database", and Cloudflare's connection-pooling
  page says the setting "acts as a soft limit"
  (https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/).
  A create with `1` was refused: `Invalid connection limit specified: (1).
  Please indicate a limit in the valid range (5-1500). [code: 2021]`. 5-1500
  is the API's validation range; the same page says the maximum depends on
  the Workers plan.
- Config A, created without the flag, read back `origin_connection_limit`
  60 from `wrangler hyperdrive get`; config B read back 5. Cloudflare's
  limits page lists about 20 (Free) and about 100 (Paid) per config
  (https://developers.cloudflare.com/hyperdrive/platform/limits/); this
  account's Workers plan was not recorded.
- After the warm-up (8 bursts of 5 concurrent single-row requests through
  A, 2 through B) `hd_a` held 10 backends from 7 client addresses and
  `hd_b` 5 from 5: more than one burst needs (several pools is one reading,
  not measured). In run 1 one request per binding left `hd_a` 1 and `hd_b`
  2. `application_name` is `Cloudflare Hyperdrive`.
- Limit 5, 20 concurrent 10 s holds through B (config B already held 5
  connections from the warm-up): `hd_b` read 5 at the three samples (5, 15
  and 25 s; 5 sleeping at 5 and 15 s). 10 requests answered 200, min 10634,
  median 20642, max 20687 ms (consistent with two waves); 8 failed with
  `58000 Timed out while waiting for an open slot in the pool.` after
  15642-17557 ms and 2 with `Connection terminated unexpectedly` (no
  SQLSTATE) after 15920-15959 ms. Run 1 read `hd_b` 6 at 5 s and 15 s (6
  sleeping at 5 s) with limit 5: the documented soft limit, exceeded by one
  in one run of two.
- Config A, no flag, 80 concurrent 60 s holds after a reset (H02e): `hd_a`
  read 60, all sleeping, with 18 slots still free (69 client backends,
  Management API answering). 60 requests answered 200 (60220-61031 ms; 60 s
  is Cloudflare's documented maximum query duration, and these holds all
  completed); 18 failed with `58000 Timed out while waiting for an open slot
  in the pool.` after 15659-15964 ms and 2 with `Connection terminated
  unexpectedly` after 15753-15761 ms. The default limit, not Postgres,
  capped Hyperdrive there.
- Reading: when the config is at its origin connection limit, a request
  waits about 15 s and then fails (Cloudflare's limits page lists a 15 s
  initial connection timeout; whether that is this wait was not separated).
  The limits page documents the pool error as "Failed to acquire a
  connection from the pool."; this run saw the text above instead. When
  Postgres refuses, the failure comes back in under 1.2 s (H02c).

### Data API first, then Hyperdrive steps (H02c)

30 `dc_sleep_xl(100)` holds filled PostgREST's pool (`authenticator` 31,
48 client backends), then steps of concurrent 15 s Hyperdrive A holds:

| step | client backends mid-step | `hd_a` | Management API | Hyperdrive result |
|---|---|---|---|---|
| 10 | 53 | 15 | ok | 10 x 200 |
| 30 | 72 | 34 | ok | 30 x 200 |
| 45 | 87 | 49 | refused 53300 | 45 x 200 |
| 60 | 87 | 49 | refused 53300 | 45 x 200, 15 x 500 |

- The Management API was refused first (step 45). At step 60 Hyperdrive
  failed fast with Postgres's own refusal: 12 x `53300 remaining connection
  slots are reserved for roles with the SUPERUSER attribute` (741-1180 ms),
  2 x `53300 sorry, too many clients already` (808-810 ms) and 1 x
  `Connection terminated unexpectedly` (811 ms). These did not wait the
  15 s seen at the config's own limit.
- At the step 60 snapshot 4 of the 49 `hd_a` backends were idle while 15
  requests failed (14 with 53300, 1 with `Connection terminated
  unexpectedly`): Hyperdrive opened new origin connections
  rather than using them (7 client addresses; several pools is one reading,
  not measured).
- The Data API holders, already connected, all answered 200
  (100210-100555 ms). The Management API was also refused from step 45
  until PostgREST closed its idle pool connections.
- Recovery 1 (90 s after the holders returned): Data API pings answered 200
  throughout; `authenticator` stayed 31 and the Management API was refused
  until between 43 and 54 s, when `authenticator` dropped to 1 and client
  backends to 57; `hd_a` stayed 49 (idle) for all 90 s. In run 1 the 31
  idle `authenticator` connections stayed open for the whole remaining
  watch (at least 92 s idle, t+222 to t+314 s). Cause of the difference
  not separated.
- Run 1, same order with steps 10/20/30/45: peak 81 client backends and
  no Hyperdrive error other than one deploy-propagation `404`. Its 150 s
  Data API holds (function timeout 180 s) all ended `504 upstream request
  timeout` after 125146-125366 ms: something in front of PostgREST ends a
  Data API request at about 125 s (one burst of 30, run 1; the component
  was not identified; the Postgres backends kept sleeping until about
  150 s, so the 504 did not free the connection).

### Hyperdrive first, then the Data API (H02e)

Reset first: `hd_a` (49) and `authenticator` (2) backends terminated; the
next 3 Data API pings answered 200. Then 80 concurrent 60 s holds through A
(60 connected, above), and 10 s later 30 `dc_sleep_xl(5)` calls and one
`dc_ping` through the Data API.

- Data API: 19 x 200 (5130-5435 ms) and 11 x `503 PGRST002 Could not query
  the database for the schema cache. Retrying.` after 1369-2500 ms; the
  ping also answered `503 PGRST002` (1467 ms). No PGRST000, PGRST001 or
  PGRST003.
- Reading, not measured: before the burst `authenticator` read 2
  (`e_hd_held`); if one is PostgREST's listener, 19 = 1 pool connection +
  the 18 free slots, which matches data-api-capacity's PGRST002 with
  `db_pool` above `max_connections`. Against it: about 4 s after the 19
  calls returned, `authenticator` read 1 (`e_both`, t+329 s), where in H02d
  PostgREST held idle connections for 43 s or more. That fits PostgREST
  dropping its pool on the failure (a schema-cache reload). The run cannot
  separate the two.
- Run 1, same order without the reset (at the last read before H02e,
  t+314 s, PostgREST held 31 idle connections and `hd_a` 47): the Data API
  answered 30 x 200 and the ping 200, while Hyperdrive's 80 holds gave 53 x
  200, 18 x `53300 remaining connection slots are reserved for roles with
  the SUPERUSER attribute`, 1 x `53300 sorry, too many clients already` and
  8 x `58000 Timed out while waiting for an open slot in the pool.`

### Recovery (H02d, H02f)

- In one run, Hyperdrive kept 60 idle origin connections for at least
  891 s: after H02e's holds returned, `hd_a` read 60 at every 15 s sample
  up to 891 s (watch cap 900 s), past Cloudflare's documented 10 minute
  idle connection timeout. Config A received no traffic from this Mac in
  that window (the observer uses config B). The module recorded only
  `state`, so it cannot separate a pool floor, keepalive or health queries
  from Hyperdrive, or a timeout that does not apply here; it now also
  records `state_change` and the query text per `hd_a` backend for the
  next run.
- With 69 client backends the database was not full, so the Data API and
  the Management API answered throughout H02f (3 pings in a row by the
  32 s sample).
- Run 1 is the full-database case: after its H02e all 44 Management API
  reads over 656 s were refused with `53300` (last sample t+656 s), while
  Data API pings answered 200 (PostgREST's connections could not be read).
  What held the slots in that window could not be read.

Not settled: the account's Workers plan and whether 60 is a plan or an
account default; configs pointed at Supavisor; caching on; sizes other than
Small; whether and when Hyperdrive closes the idle connections (the watch
ended at 900 s; H03 answers it for one run); the PGRST002 reading above
(H03 separates it); requests from vantages other than this Mac. One run per
ordering with the reset.

Evidence: `out/2026-10-23/` (both runs, redacted, with facts.md). Project,
Worker and both configs deleted in each run's `finally`; the project list
no longer had the ref on the first read (0 s) and `wrangler hyperdrive list`
held 0 of the run's config ids (both runs).

## 2026-10-23 - Idle origin connections over 30 minutes; PGRST002 by arm (H03)

Two follow-ups from H02. Q1: does Hyperdrive ever close idle origin
connections to the direct connection (H02: 60 idle at 891 s)? Readings: a
pool floor, keepalive or health queries keeping them busy by Hyperdrive's
clock, or a timeout that does not apply to this path. Q2: why did the Data
API answer PGRST002 in H02e? Readings: (a) slot exhaustion, (b) PostgREST
dropping its pool and reloading its schema cache on the failure.

Setup: one fresh Small project per run, Pro org, `ap-southeast-1`, Postgres
17.11, wrangler 4.147.0, `pg` 8.23.1. Three Hyperdrive configs on
`db.<ref>.supabase.co:5432`, caching disabled: A (`hd_a`, no limit flag,
read back 60), B (`hd_b`, limit 5, the observer) and C (`hd_c`,
`--origin-connection-limit 15`, read back 15; 15 rather than 20 so A 60 + C
15 leaves the Management API observer room under 87). Observer:
`public.h03_snap(roles)`, SECURITY DEFINER owned by `postgres` (a member of
`pg_read_all_stats`, so it sees state and query text of every role), per
backend: pid, state, `state_change` and `backend_start` ages, the first 70
characters of the query and the client address, replaced by a per-run
label such as `v6#1` (no address is stored). Called through config B during Q2 and through the
Management API during Q1.

Three runs, all in `out/2026-10-23/`: run 1
(`run-2026-10-23T09-28-56-267Z.json`, Q2 then Q1), run 2
(`run-2026-10-23T10-06-17-500Z.json`, Q2 only) and run 3
(`run-2026-10-23T10-12-40-066Z.json`, Q2 only). The artifacts stamp lab
commit 235cac8, which predates H03. Only the postgrest_logs capture changed
between runs: run 1 kept every line in time order under a 6000-character cap,
which ended in the first arm's reset, so its log fields are not used; run 2
kept each arm's lines in order under a 4000-character cap, which ended about
1 s into each burst; run 3 (the committed module) groups lines by message
with a count and first and last offset. Q2d's C fill was 15 holds in run 1
and 20 in runs 2 and 3 (`PVLAB_H03_Q2D_FILL_C`).

### Q1: idle origin connections (run 1 only)

All `hd_*` and `authenticator` backends were terminated, then 70 concurrent
20 s holds through A and 30 through C. Mid-fill `hd_a` read 54 and `hd_c`
13 (72 client backends, summed from the per-role counts): both configs
stayed below their limits (60, 15) with Postgres slots free; A answered 54 x 200 and 16 x `58000 Timed out
while waiting for an open slot in the pool.` (15352-15807 ms), C 13 x 200,
16 x 58000 and 1 x `Connection terminated unexpectedly`. Then no Worker
traffic at all; 52 samples through the Management API over 1800 s (none
failed, none needed the B fallback).

| t after load end | `hd_a` | `hd_c` | `hd_b` |
|---|---|---|---|
| 0 s | 54 idle, state_change 0-1 s | 13 idle, 0-1 s | 0 |
| 604 s | 54 idle, 604 s | 13 idle, 604 s | 0 |
| 965 s | 54 idle, 965-966 s | 13 idle, 965-966 s | 0 |
| 1182 s | 0 | 6 idle, 1182 s | 0 |
| 1265 s to 1777 s (18 samples) | 0 | 0 | 0 |

- Every sample from 0 to 965 s (33 samples, about 30 s apart) showed a
  `state_change` age equal to the time since load end, a `backend_start` age
  20 s more (the hold), and one query text: the last `select pg_sleep(20)
  is null as ok, current_user as u`; every sample from 30 s to 965 s (32
  samples) had `kept` (pids also present at the previous sample) equal to
  the count. Nothing ran on these connections while idle, and none was
  replaced.
- There is no sample between 965 s and 1182 s (217 s), and the next came at
  1265 s (83 s). Each Management API call aborts at 30 s with no retry, and
  none failed, so the gaps are in the loop's 30 s sleep, which fits the Mac
  pausing the process (not checked; the per-sample wall clock was not
  recorded). All 54 `hd_a` backends closed in the first gap, after
  965-1182 s idle. `hd_c` closed 7 of 13 in it and the other 6 between
  1182 s and 1265 s. None reopened up to 1777 s.
- Client addresses (labels): `hd_a` came from 5 addresses (12, 11, 12, 12
  and 7 backends), `hd_c` from 5 others (3, 3, 3, 3 and 1); all IPv6. The 6
  `hd_c` backends left at 1182 s were every backend of 2 of its 5
  addresses (3 + 3).
- `hd_b` (terminated before the fill, no traffic afterwards) read 0 at every
  sample: Hyperdrive did not reopen connections to a floor.
- Postgres side: `idle_session_timeout` 0, `tcp_keepalives_idle` 1800, no
  role settings on `hd_*`.
- Reading: Hyperdrive, or something on its path, closed the idle origin
  connections after 16 to 21 minutes idle in this run. Cloudflare's limits
  page lists "Idle connection timeout | 10 minutes" in a table it introduces
  with "These limits apply to connections between Hyperdrive and your
  origin database."
  (https://developers.cloudflare.com/hyperdrive/platform/limits/, read
  2026-10-23); these connections outlived that by at least 365 s. The data
  rule out keepalive queries (no `state_change` reset), recycling (same
  pids) and, with no Worker traffic, a pool floor (all closed; B never
  reconnected). A (default limit) and C (limit 15) closed in the same
  window, except that 6 C backends were still open at 1182 s (one config
  each). The one partial close was by source address (the 6 survivors were
  every backend of 2 of C's 5 addresses), which fits a timer per source
  address; who sent the close was not measured (postgres_logs disconnect
  lines were not read). H02's 60 idle at 891 s fits the same window.

### Q2: PGRST002 under Hyperdrive slot pressure (runs 1-3)

Per arm: terminate `hd_a`/`hd_c` (and `authenticator` where named), 3 Data
API pings in a row, Hyperdrive holds of 40 s, 10 s later 30 concurrent
`dc_sleep_xl(5)` and one `dc_ping` (service_role key); `authenticator`
backends read per pid at 0.5, 1.5, 2.5, 3.5, 4.5, 6.5 and 10 s. PostgREST's
own setting: `db_pool` null, `db_pool_acquisition_timeout` 10 (Management
API). "Pool" below is `authenticator` backends other than the `LISTEN
"pgrst"` one.

| arm | run | free slots before | pool before | `authenticator` 0.5-4.5 s (kept/new) | `dc_sleep_xl` 200 / 503 PGRST002 | 503 latency ms | ping | `authenticator` at 10 s |
|---|---|---|---|---|---|---|---|---|
| a: reset, no load | 1 | 77 | 1 | 31 (2/29) | 30 / 0 | - | 200 | 31 |
| a | 2 | 78 | 1 | 31 (2/29) | 30 / 0 | - | 200 | 31 |
| a | 3 | 74 | 1 | 28 then 31 (2/29) | 30 / 0 | - | 200 | 31 |
| b: reset, A 80 holds | 1 | 19 | 1 | 21 (2/19) | 20 / 10 | 1126-2268 | 200 | 1 |
| b | 2 | 15 | 1 | 17 (2/15) | 16 / 14 | 852-2498 | 200 | 1 |
| b | 3 | 12 | 1 | 14 (2/12) | 13 / 17 | 1080-2690 | 503 PGRST002 | 1 |
| c: warm 12, no reset, A 80 | 1 | 6 | 12 | 19 (13/6) | 18 / 12 | 719-2519 | 200 | 1 |
| c | 2 | 3 | 12 | 16 (13/3) | 15 / 15 | 993-2424 | 200 | 1 |
| c | 3 | 1 | 12 | 14 (13/1) | 13 / 17 | 907-2170 | 200 | 1 |
| d: reset, A 80 + C | 1 | 6 | 1 | 8 (2/6) | 7 / 23 | 1097-2409 | 503 PGRST002 | 1 |
| d | 2 | 0 | 1 | 2 (2/0) | 1 / 29 | 1148-2718 | 200 | 1 |
| d | 3 | 0 | 1 | 2 (2/0) | 1 / 29 | 1358-2657 | 503 PGRST002 | 1 |

- In the 9 arm-runs with Hyperdrive load (b, c, d), `dc_sleep_xl` answered
  200 exactly as often as pool connections before the burst plus free slots
  (20 = 1 + 19, 18 = 12 + 6, 1 = 1 + 0, ...), and every other
  `dc_sleep_xl` call answered 503 PGRST002 in 719-2718 ms (the ping
  answered 200 in 6 of the 9); no PGRST000, PGRST001 or PGRST003 reached
  the client. The failed calls did not wait for a connection to come free
  at 5 s, inside the 10 s acquisition timeout.
- Arm c: `kept` 13 of 13 (the 12 pool connections sleeping and the LISTEN
  backend idle): the warm pool served, so PostgREST did not drop its pool
  at the failure.
- Run 2, arm b: three of the five B snapshots between 0.5 and 4.5 s (at
  0.5, 1.5 and 3.5 s) were refused with `53300 remaining connection slots
  are reserved for roles with the SUPERUSER attribute` (reading: those
  snapshots needed a new B origin connection).
- Config B, limit 5, read 6 `hd_b` backends after the warm-up in run 1 (and
  stayed there), up to 9 in run 2, and 9 after the warm-up (bursts of 5
  concurrent requests) and 11 from arm a on in run 3: the soft limit was
  exceeded by up to 6, already during the warm-up in runs 1 and 3.
  Cloudflare's limits page, footnote 2: "connection counts may occasionally
  exceed the listed limits".
- postgrest_logs, run 3, offsets from the burst (run 2 shows the same first
  second in all three pressure arms): the first 503 access line with the
  arm's User-Agent came first, at 0.3 s (b), 0.2 s (c) and 0.1 s (d), with a
  234-byte body (the one access line per arm the module kept; the 503
  PGRST002 ping lines in arm b's reset were 119 bytes), so another 503 code
  came first and the resend below hid it from the client; the code was not
  captured. Then `Failed to query the PostgreSQL version.` with `PGRST000`
  and `connection to server at "localhost" (::1), port 5432 failed: FATAL:
  remaining connection slots ...`, 3 times per arm, first at 0.2-0.5 s;
  `Failed to load the schema cache using db-schemas=public,graphql_public
  ...`, 3 times per arm, first at 0.5-0.9 s and last at 3.6-4.0 s;
  PGRST002 lines 55 (b), 57 (c) and 89 (d) between 0.5 and 2.7 s (fewer
  than the 503 access lines below; not reconciled); `Attempting to
  reconnect to the database in N seconds...` 3 times between 1.5 and 8.0 s;
  then `Successfully connected`, `Connection Pool initialized with a
  maximum size of 30 connections` and `Schema cache loaded` twice each at
  7.6-8.4 s. Arm d also logged one `FATAL: sorry, too many clients
  already` at 0.8 s. Arm a logged nothing in its burst window.
- Access lines carrying the arm's User-Agent were all 503, exactly 6 per
  503 the client saw: run 3 108 / 102 / 180 for 18 / 17 / 30 (b / c / d,
  ping included), run 2 84 / 90 / 174 for 14 / 15 / 29; 200s leave no line
  (arm a). That is the factor data-api-capacity DC01b/DC02b measured for
  504 PGRST003, so something in front of PostgREST sends a 503 request
  again up to 5 more times before the client sees the answer (reading; the
  component was not identified; the managed gateway does send an
  `x-envoy-attempt-count` response header, listed in replica-routing's
  `out/2026-10-10/run-2026-10-10T06-40-49-759Z.facts.md`, and H03 did not
  record response headers).
- Reading: both, in sequence. Slot exhaustion decides how many calls
  succeed (the ones that already hold a connection or get one of the free
  slots). The first refused connections (503 access lines from 0.1-0.3 s,
  234-byte bodies, code not captured; then the version query's PGRST000
  at 0.2-0.5 s) make PostgREST treat the database as lost: it fails its
  schema-cache load, answers PGRST002 to every request
  without a connection instead of waiting, retries with backoff, and about
  8 s later initialises a new pool and reloads the cache, which is why
  `authenticator` reads 1 at 10 s (H02e's `e_both` read). A reset is not
  needed for it (arm c), and the reset alone does not cause it with free
  slots (arm a).
- Side observation: terminating 31 idle `authenticator` backends (arm b's
  reset) made PostgREST log five failed schema-cache loads with `57P01
  terminating connection due to administrator command`; 9 of the 12 pings
  sent before 3 good ones in a row answered 503 PGRST002 (run 3; PostgREST
  logged 54 access lines for them, 6 per ping, between 43.0 and 16.6 s
  before the burst), and the pool and cache came back 16.0 s before the
  burst. Runs 1 and 2 needed 12 and 11 pings. Terminating 2 (arms a and d,
  run 3) reconnected within 1 s (a) and 4 s (d) with no PGRST002 line.
  H02's reset terminated 2.

Not settled: who closes the idle origin connections and with what message
(postgres_logs not read); Q1 has one run, one region, one Workers plan (not
recorded), and a 217 s gap in its samples exactly where the closes
happened; whether a request on one connection resets the others' idle
clocks; why A stopped at 54 in the Q1 fill; what resends the 503s in front
of PostgREST, and `x-envoy-attempt-count` on the 503s; the code of the
first 503s (234-byte bodies); Q2 on sizes other than Small and with other
PostgREST settings.

Evidence: `out/2026-10-23/run-2026-10-23T09-28-56-267Z.json`,
`run-2026-10-23T10-06-17-500Z.json`, `run-2026-10-23T10-12-40-066Z.json`
(redacted, with facts.md; client addresses are per-run labels). Project,
Worker and the three configs deleted in each run's `finally`; the project
list no longer had the ref on the first read (0 s) and `wrangler hyperdrive
list` held 0 of the run's config ids (all three runs).
