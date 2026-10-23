# RUNLOG - experiments/hyperdrive-direct

Cloudflare Hyperdrive against the Supabase direct connection
(`db.<ref>.supabase.co:5432`). One throwaway Pro project per module,
self-provisioning (no tofu); the probe Worker and the Hyperdrive config are
created with wrangler and deleted in the same run.

Run: `PVLAB_ORG_PRO=<slug> pvlab --where local --experiment hyperdrive-direct --only H01 --destructive`
(H02: `bun harness/src/run.ts` from the repo root with `--only H02`, same flags;
about 21 minutes, most of it the 900 s recovery watch, `PVLAB_H02_RECOVERY_S`)
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
  requests failed with 53300: Hyperdrive opened new origin connections
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
ended at 900 s); the PGRST002 reading above; requests from vantages other
than this Mac. One run per ordering with the reset.

Evidence: `out/2026-10-23/` (both runs, redacted, with facts.md). Project,
Worker and both configs deleted in each run's `finally`; the project list
no longer had the ref on the first read (0 s) and `wrangler hyperdrive list`
held 0 of the run's config ids (both runs).
