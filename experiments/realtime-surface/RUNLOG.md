# realtime-surface RUNLOG

Chronological record of what was run. Projects were created on a Pro-plan
organisation, region ap-southeast-1, default compute (RT05: resized to Small),
no add-ons, and deleted by the module that created them. Org slugs and project refs are not recorded.
Vantage: a local macOS machine (not in the project's region); the current
`@supabase/supabase-js` is whatever the installed package.json said at run time
(RT01a records it), and the old client is the one pinned in this directory's
`package.json`. Every count is n=1 per row on one project unless a row says
otherwise (RT05: two reps per burst row, one for its two over-range pool
probes). Published artifacts: `out/2026-10-10/` and
`out/2026-10-22/` (redacted, with `.facts.md` beside each).

Sources for the claims each module is measured against:

- Postgres Changes filters and `select`:
  https://supabase.com/blog/postgres-changes-filters-and-column-selection
- Broadcast binary payloads:
  https://supabase.com/changelog/46834-realtime-broadcast-now-supports-binary-payloads
- Broadcast Replay: https://supabase.com/docs/guides/realtime/broadcast
- Changes during a disconnect and per-subscriber authorization cost:
  https://supabase.com/blog/realtime-or-pipelines-how-to-choose-the-right-tool
  (published 2026-05-05; fetched 2026-10-10 for the two quotes RT02 cites: "If a
  client disconnects for 30 seconds and reconnects, the changes that happened
  during those 30 seconds are gone." and "With 100 subscribers watching a
  table, one INSERT generates 100 authorization queries.").

## 2026-10-10 - RT01 (Postgres Changes: filters, select, DELETE, revoked column)

Artifact: `out/2026-10-10/run-2026-10-10T01-04-48-057Z.json` (24 pass, 0 fail).
Client: supabase-js as recorded in RT01a. Table `rt01_t` (id identity PK, n,
team, status, email, flag, note, secret), RLS off, in the `supabase_realtime`
publication, `anon` subscriber unless stated.

Docs claim, then measurement:

- **Operators and AND (RT01b).** Claim: comma = AND; `like`, `ilike`, `is`,
  `match`, `imatch`, `isdistinct` and a `not.` prefix. Measured: 19 filters, each
  on its own channel against one 8-row INSERT batch, each compared with
  `select id ... where <equivalent SQL predicate>` on the same rows. All 19
  delivered exactly the oracle's ids. Covered: `team=eq.a` (4 of 8);
  `team=eq.a,status=eq.open` (2); three columns `team=eq.a,status=eq.open,flag=eq.true`
  (1); two conditions on one column `n=gt.2,n=lt.6` (3); `in` (5); `like.a%` (1) vs
  `ilike.a%` (2); `is.null` (2), `is.true` (3), `is.false` (3); `match.^[a-d]` (4)
  vs `imatch.^[a-d]` (5); `isdistinct.active` (6, the two NULL-note rows included);
  `not.eq.open` (3, the NULL-status row excluded, as SQL does); `not.like.a%` (6);
  `not.in.(a,b)` (1); `not.is.null` (6); `team=eq.a,status=not.eq.open` (2);
  `email=ilike.a%,flag=is.true` (2). The unfiltered control received 8 of 8.
  Not measured: OR (the blog says AND only), the `postgresChangesFilter()`
  builder's output, filters on other column types (timestamps, uuids, arrays),
  a large batch.
- **`select` (RT01c).** Claim: only the listed columns, PK always included.
  Measured, one INSERT, a `note`-only UPDATE, a `status` UPDATE, one DELETE:
  `select: ['status']` delivered INSERT keys `id,status` (PK added);
  `['id','team']` and `['status','email']` likewise. The `note`-only UPDATE
  still produced an UPDATE event for subscribers whose `select` excluded
  `note` (2 UPDATE events each, `new` trimmed to the selected columns plus
  `id`, `old` carrying `id` only). DELETE events carried `old` = `{id}` and an
  empty `new` with and without `select`. The unselected control received all 8
  columns on INSERT and UPDATE. `select: ['nope']` (no such column): the
  subscribe callback reported `SUBSCRIBED`, the channel's `system` event
  carried `status: error` with `invalid column for select nope`, and 0 events
  arrived.
- **DELETE under a filter (RT01d).** Claim: DELETE carries only the PK, so
  column filters cannot be evaluated. With replica identity `default`, 4 rows
  seeded (2 with team a) and then deleted: `team=eq.a` (event `*`) received 0
  DELETE events; `team=eq.a,status=eq.open` (DELETE) 0; a PK filter
  `id=eq.<id>` 1; unfiltered DELETE 4. With replica identity `full`
  (`alter table ... replica identity full`), the same shape: `team=eq.a` 2 of 2,
  the AND filter 1 of 1, PK filter 1, unfiltered 4, and `old` carried all 8
  columns. The blog does not mention replica identity; the full-identity rows
  are the lab's finding, n=1, WAL volume under `full` not measured.
  An UPDATE that moved a row out of `team=eq.a` produced no event for the
  `team=eq.a` subscriber; the UPDATE that moved it back in produced 1 (`new.team`
  `a`).
- **`select` naming a column revoked from the subscribing role (RT01e).**
  Setup: `revoke select on table from authenticated` then column grants for
  every column except `secret`; `has_column_privilege('authenticated', ...,
  'secret', 'select')` false; PostgREST as that user: `42501 permission denied
  for table rt01_t` for `select=secret`. Measured, user signed in on the
  client: no `select` (all columns): INSERT, both UPDATEs and the DELETE
  arrived and `secret` was absent from every payload; `select: ['id','team']`
  arrived normally; `select: ['id','secret']`: subscribe callback `SUBSCRIBED`,
  `system` event `status: error ... invalid column for select secret`, 0
  events; `filter: 'secret=eq.s'`: `system` error `invalid column for filter
  secret`, 0 events. Control, `anon` (table-level select intact) with
  `select: ['id','secret']`: 4 events, `secret` present (`s1`, `s1`, `s2`).
  So the documented requirement holds; the failure is not surfaced by the
  subscribe status callback and shows only in the `system` event.
- **Delivered events with and without a filter (RT01f).** 20 INSERTs, 10 with
  team a: unfiltered subscriber 20 events, `team=eq.a` 10, `team=eq.a` plus
  `select: ['id']` 10. Billing messages were not read: the usage endpoint that
  carries them refuses a PAT (see `image-transformations` I10), and
  `usage.api-counts` `total_realtime_requests` read 7 before and 7 after the
  20 events, so it does not count them. "Filtered events cost fewer messages"
  rests on delivery counts only; that billing counts delivered events is the
  docs' statement, not measured.
- **Fresh-project warm-up (RT01a, RT02-setup).** On five fresh projects (RT01
  three times, RT02 twice) the first change event reached the subscriber about
  eleven seconds after it subscribed (artifact values in milliseconds: 10655,
  10635, 10870 in RT01; 10748, 10790 in RT02), with a canary INSERT sent when it
  joined and another every 10 s. On the three projects whose runs recorded which
  canary arrived, it was the second (sent about 10 s after the first) each time;
  the first canary's event was not delivered. The two earlier runs did not
  record the index. On these three projects, then, a subscribe that said
  `SUBSCRIBED` was not proof the change stream was wired (n=1 per row; five
  projects, one run each). Lost versus late is not separated: the harness waits
  1.5 s (`sleep(1500)` in `lib/rt.ts`, a code constant, not a measured
  timing) after the second canary's event, and the first canary's event had
  not arrived by then.

## 2026-10-10 - RT02 (loss during a disconnect, heartbeat canary)

Artifact: `out/2026-10-10/run-2026-10-10T00-55-32-188Z.json`. Table `rt02_t`
(phase, seq, `updated_at default now()`), RLS off, anon subscriber, rows
written with the service key over PostgREST at 1 per second. The socket was
closed by the client with code 4000, so the server saw a clean close; this is
not a network partition.

- **RT02a, client reconnects after 30 s** (`reconnectAfterMs` fixed at 30 s):
  3 rows before the drop, 25 during, 3 after the rejoin. Received 3/3, **0/25**,
  3/3. Status log: `SUBSCRIBED`, then `CHANNEL_ERROR` (4.7 s from the start),
  then `SUBSCRIBED` (34.7 s from the start), a rejoin delay after the drop of
  (30.1 s). None of the 25 gap rows was delivered at or after the rejoin.
- **RT02b, manual `disconnect()` then `connect()` after 30 s**, 25 rows in
  between: the original channel was in state `joined` after `connect()` with
  no re-subscribe call, received 0 of the 25 gap rows and the 1 row inserted
  afterwards; a fresh channel on the same client received 0 of the 25 as well.
- **RT02c, heartbeat-row canary.** A second table's single row is updated every
  2 s (heartbeat) and 40 data rows are written at 1 per second; at t=10 s the
  socket is dropped and never reconnects on its own. The watcher declares the
  subscription stale after 6 s without a heartbeat event, tears the client
  down, subscribes a new one, then backfills with `updated_at > last_seen`
  over REST and merges by id. Measured: staleness was declared (4.8 s after the
  drop; the last heartbeat had arrived before the drop), the new subscription
  joined in 0.1 s, the backfill query returned in under 0.1 s; 9 rows live on
  the first channel, 26 on the second, 5 backfilled, 0 backfilled rows also seen
  live, **0 of 40 missing** after the union. The `>` boundary was not stressed:
  rows here have distinct `now()` values, so two rows committed with the same
  `updated_at` as `last_seen` is reasoned, not measured, as the case `>` would
  drop.
- Not measured: the blog's "With 100 subscribers watching a table, one INSERT generates 100 authorization queries"; a
  gap longer than 30 s; a server-side drop or a real network cut; the incident
  that prompted the question.

## 2026-10-10 - RT03 (Broadcast Replay)

Artifact: `out/2026-10-10/run-2026-10-10T00-55-32-188Z.json`. 26 messages sent
with `select realtime.send(jsonb_build_object('i', n), 'evt', topic, true)` as
separate autocommit statements (26 distinct `inserted_at` values; the
spacing between them was not recorded), policies allowing `authenticated` to select and insert on
`realtime.messages`, an authenticated user signed in on the client.

- **Cap (RT03b).** Docs: at most 25, private channels only. Measured, a fresh
  subscriber per `limit`, `since` before the first message: omitted gave **25**
  messages, `i` 2 to 26, ascending (the newest 25, message 1 not delivered);
  `limit: 10` gave `i` 17 to 26; `limit: 25` gave 25; `limit: 26` and `limit:
  100` gave 25 with no join error. Every replayed message carried
  `meta.replayed`.
- **`since` window (RT03c).** `since` = floor of the epoch milliseconds of
  message 13's `inserted_at`, and that plus one millisecond, both with `limit:
  25`: 13 messages, `i` 14 to 26. An unpublished dev-output iteration on a reused project (not in `out/`)
  returned 14 messages including 13 for the first value; the boundary at
  sub-millisecond resolution is not settled.
- **Public channel (RT03d).** supabase-js refuses at construction (`tried to
  use replay on public channel`). A raw WebSocket join with `private: false`
  and a replay config got `{"status":"error","response":{"reason":
  "UnableToReplayMessages: Replay is not allowed for public channels"}}` and 0
  broadcast frames. `realtime.send(..., private => false)` still wrote 1 row to
  `realtime.messages`.
- **Client-sent messages (RT03e).** 3 messages by WebSocket `send` and 3 by
  `httpSend` on a private topic, all acknowledged (`ok`, `success: true`): 0
  rows in `realtime.messages` for the topic and a later replay subscriber got
  0. Replay covered the database-sent messages only, as the docs say.
- **First private use of a fresh project (RT03-warm, RT04-warm).** Before the
  first Realtime connection `realtime.messages` was absent with 0 partitions
  (RT03 project) or present with 0 partitions (RT04 project); the first join
  answered after 187 and 171 milliseconds, and a partition for the current UTC
  day existed 5261 and 178 milliseconds later. In an earlier run whose artifact
  is `out/2026-10-10/run-2026-10-10T00-29-34-398Z.json` (the same modules on two
  other fresh projects, no wait for the partition) `realtime.send` persisted 0
  of 26 rows (RT03a) and the first private join answered `CHANNEL_ERROR
  (MissingPartition: Realtime was unable to find the expected messages
  partition)` (RT03b, RT04-setup). The modules now wait for the partition.
- Not measured: the 72-hour partition boundary and the "last 3 days" in the
  announcement (the docs text read here says at least 72 hours and at most 4 days);
  `since` older than the retention; ordering when two messages share an
  `inserted_at`.

## 2026-10-10 - RT04 (binary Broadcast)

Artifact: `out/2026-10-10/run-2026-10-10T00-55-32-188Z.json`. Private topic with
select and insert policies; two receivers signed in as the same user, one on the
current supabase-js and one on the old pinned client (RT04-setup records both
versions); 16-byte payload `00 01 02 03 7f 80 c8 fe ff 00 ff 00 10 20 40 80`,
plus a 4096-byte payload over WebSocket `Uint8Array`.

Claim: binary over WebSocket (`ArrayBuffer` or `ArrayBufferView`), REST
(`application/octet-stream`) and `realtime.send_binary(bytea)`; the changelog
names minimum client versions for WebSocket and `httpSend`, a minimum Realtime
server version, and says older clients drop binary silently.

| send path | current receiver | old receiver |
|---|---|---|
| WebSocket `send` with an `ArrayBuffer` | 1 event, `ArrayBuffer`, bytes equal | 0 events |
| WebSocket `send` with a `Uint8Array` (16 B and 4096 B) | 1 event, a JSON object keyed `"0"`..`"15"` (the typed array JSON-encoded), not binary | same JSON object |
| `httpSend` with a `Uint8Array` | 1 event, `ArrayBuffer`, bytes equal | 0 events |
| raw `POST` `application/octet-stream` | 1 event, `ArrayBuffer`, bytes equal | 0 events |
| `realtime.send_binary(bytea, ...)` | 1 event, `ArrayBuffer`, bytes equal | 0 events |
| JSON controls (WebSocket, `httpSend`, raw REST, `realtime.send`) | 1 event each, equal | 1 event each, equal |

- The old receiver saw nothing at all for binary, including no other event
  names, which is the silent drop. It joined and received JSON normally.
- **Where the docs and the run differ (RT04a).** A `Uint8Array` passed to
  WebSocket `send` on the current client arrived as the JSON-encoded object on
  both receivers; only an `ArrayBuffer` went binary. `httpSend` converted a
  `Uint8Array` correctly. The old client sending a `Uint8Array` by WebSocket
  or `httpSend` (RT04b) also produced the JSON-encoded object at the current
  receiver. The 4096-byte row is the `Uint8Array` case only; a 4096-byte
  `ArrayBuffer` was not sent.
- **Stored form (RT04d).** The database send left rows with `extension`
  `broadcast`, `payload` null and a 16-byte `binary_payload`.
- **RLS (RT04c).** Topic with no select policy: the join answered
  `CHANNEL_ERROR (Unauthorized: You do not have permissions to read from this
  Channel topic: rt04:denied)`; the anon key joining the policy-allowed topic:
  the same error. Select-only topic: WebSocket binary and JSON sends by the
  authenticated user errored, raw REST binary and JSON with the user token
  answered 403, with the anon key 403, and a raw REST binary send with the
  secret API key answered 202 and the reader got the binary event. A leftover
  permissive `with check (true)` policy from an earlier module on a reused
  project made the select-only topic writable in an unpublished iteration;
  policies OR together, and the module now drops every policy on
  `realtime.messages` first.
- Not measured: client versions between the two used (so the changelog's
  minimum versions are not located), the Realtime server version, binary on
  `realtime.send_binary(..., private => false)`, an `ArrayBuffer` larger than
  16 bytes over WebSocket, any size limit.

## 2026-10-26 - RT05 on 2XL (subscription bursts at 2000 and 5000 joins)

Artifact: `out/2026-10-26/run-2026-10-26T01-21-52-456Z.json` (15 results,
all `info`). Lab commit 848b9f3 plus the uncommitted `RT05_COMPUTE`,
`RT05_BOUNDS` and `RT05_BC_LEVELS` knobs. Run started 01:21:52 UTC and
finished 01:33:06 UTC. The project was not created by RT05: it was the
data-api-capacity DC13/DC14 project (created Small through `POST
/v1/projects`, ap-southeast-1, resized Small -> XL -> 2XL by DC13, then
DC14's `db_pool` arms left it at `db_pool` 200), reused through
`PVLAB_PEER_RT`, and deleted after this run (DELETE 200 at 01:42:50 UTC by
`lib/cleanup.ts` in data-api-capacity, list mode then showed none). Before
RT05 it had served DC13's three 100-join bursts on a different table.
Settings: `RT05_COMPUTE=ci_2xlarge` (RT05-setup read `max_connections` 380,
no resize needed), `RT05_LEVELS=2000,5000`, `RT05_POOLS=20`,
`RT05_BOUNDS=` (no over-range probes), `RT05_BC_LEVELS=5000`, two reps.
Shape per burst as in the 2026-10-22 section below.

- **Config as read (RT05a-read):** `connection_pool` 5,
  `postgres_changes_pool` null, `max_concurrent_users` 10000,
  `max_joins_per_second` 2500, `max_channels_per_client` 100 (the
  2026-10-22 Small project read `connection_pool` 2).
- **No failure of any class at either level, either pool.** Every burst
  joined every channel: `pc` at the default pool 2000 of 2000 and 5000 of
  5000 (two reps each), `pc` at `postgres_changes_pool` 20 the same, `bc`
  5000 of 5000 (two reps). No `Too many database timeouts`, no join error,
  no rate-limit reply, 2000 or 5000 of the sockets opened every time,
  `realtime.subscription` held the ready count on every `pc` row (not read
  on `bc` rows), `pg_postmaster_start_time` unchanged. On Small (2026-10-22)
  the default pool gave the timeout to 1421 and 1611 of 5000; on 2XL it gave
  it to 0 and 0. H1 (RT05c-2000, RT05c-5000) was therefore not exercised on
  2XL: `info`, [0,0] at both.
- **Pool connections:** `realtime_subscription_manager_pub` peaked at 7 on
  every default-pool row (Small: 4) and 20 on every pool-20 row;
  `realtime_connect` at 5 on every row.

| row | ready | join to ready p50 / p95 ms | fan-out p50 / p95 / max ms |
| --- | --- | --- | --- |
| default `pc` 2000 r1 | 2000/2000 | 2051 / 2938 | 612 / 825 / 836 |
| default `pc` 2000 r2 | 2000/2000 | 633 / 1192 | 628 / 840 / 1262 |
| default `pc` 5000 r1 | 5000/5000 | 1607 / 3005 | 1041 / 1458 / 1465 |
| default `pc` 5000 r2 | 5000/5000 | 1571 / 2987 | 1074 / 1480 / 1490 |
| default `bc` 5000 r1 | 5000/5000 | 639 / 1184 | 46 / 623 / 674 |
| default `bc` 5000 r2 | 5000/5000 | 689 / 1318 | 46 / 465 / 872 |
| pool 20 `pc` 2000 r1 | 2000/2000 | 2044 / 2937 | 647 / 848 / 852 |
| pool 20 `pc` 2000 r2 | 2000/2000 | 273 / 502 | 174 / 375 / 381 |
| pool 20 `pc` 5000 r1 | 5000/5000 | 632 / 1192 | 623 / 1029 / 1250 |
| pool 20 `pc` 5000 r2 | 5000/5000 | 641 / 1210 | 1289 / 2764 / 2828 |

- Join to ready at 5000, `pc`: default pool 1607 and 1571 ms p50, pool 20
  632 and 641 ms; on Small (2026-10-22) default 2964 and 2864 ms for the
  ready channels, pool 20 2038 and 2028 ms. The first burst at each config
  on 2XL (2000 r1, default and pool 20) was the slowest of its pair (2051
  and 2044 ms against 633 and 273 ms); why was not separated.
- Fan-out of one insert at 5000: `bc` p50 46 ms both reps, `pc` p50 1041 and
  1074 ms (default pool) and 623 and 1289 ms (pool 20). One local process
  received every frame, so its own scheduling is inside these figures, as on
  Small.
- Not measured on 2XL: a level that makes the default pool time out (none
  above 5000 was run), `postgres_changes_pool` 1, the over-range values, a
  project created at 2XL rather than resized to it, several channels per
  socket, more than one client address.

## 2026-10-22 - RT05 (subscription bursts: Postgres Changes pool, private Broadcast)

Artifact: `out/2026-10-22/run-2026-10-22T22-53-26-669Z.json` (1 pass, 4 fail).
The four `fail` rows are RT05c at 100, 500, 1000 and 2000 joins. RT05c grades
H1 (below), not joins: it compares the default `postgres_changes_pool` with
`postgres_changes_pool` 20, and at those four levels neither of those two
settings produced a timeout, so H1 was not exercised there; under those two
settings every channel at those levels joined except 27 in the project's
first burst (below). After
this run the module grades such rows `info` (`tests/rt05-subscription-burst.ts`,
the RT05c status line); the data is unchanged. Run started 2026-10-22 22:53:26
UTC and finished 2026-10-23 00:00:42 UTC. One project on the Pro organisation,
ap-southeast-1, resized to Small before the first burst (RT05-setup read
`max_connections` 90, the Small figure in compute-disk D01), Postgres 17.11.
The module deleted it (HTTP 200 in the local run log, not in `out/`); a `GET
/v1/projects` afterwards listed no `rt-*` project.

Claims measured against: the Realtime settings page
(https://supabase.com/docs/guides/realtime/settings, "Postgres Changes
connection pool size", default 2, range 1 to 20, "Too low: subscription
creation times out during bursts. Clients receive a `postgres_changes` system
error with `Too many database timeouts` and retry after 5 to 10 seconds."), the
limits page (https://supabase.com/docs/guides/realtime/limits) and the Postgres
Changes page's single-thread, per-subscriber authorisation note. The two
hypotheses: H1, a burst at the default `postgres_changes_pool` gets `Too many
database timeouts` and the same burst at `postgres_changes_pool` 20 gets none;
H2, private Broadcast fed by a database trigger joins every channel at every
burst size.

Shape, the same for every burst row: 10 Auth users, all members of one tenant
in `rt05_members`; table `rt05_items` with a select policy for `authenticated`
that checks membership through `(select auth.uid())`; an AFTER INSERT trigger
on it calling `realtime.send(..., private => true)` on topic
`rt05:tenant:<tenant>`, and a `realtime.messages` select policy on the same
membership. N WebSockets from one local process (anon key in the URL), opened
at 100 per second, one channel each, joined with a user session token
(round-robin over the 10 users); then all N `phx_join` frames sent in one loop
with no pacing (how long the loop took was not recorded). The client is raw
protocol and never rejoins or retries, so each outcome below is the server's
first answer to one join. A Postgres Changes channel (`pc`) counts as ready on
`system {extension: postgres_changes, status: ok}`; a private Broadcast channel
(`bc`) on the `phx_reply` ok. After the channels settle, canary inserts every
2 s until one arrives, then one measured insert; fan-out latency is from that
insert's return on the orchestrator to each channel's receipt, on the same
clock. Two reps per burst row, except the two over-range probes
(RT05b-bound21 and RT05b-bound100, 500 joins, one rep each).

- **Config as created (RT05a-read).** `postgres_changes_pool` null,
  `connection_pool` 2, `max_concurrent_users` 10000, `max_joins_per_second`
  2500, `max_channels_per_client` 100. The limits page's Pro column says 500
  concurrent connections and 500 joins per second; this project read the
  values in the limits page's "Pro (no spend cap)" and Team columns (10000 and
  2500). Which of those applies to this organisation (its spend-cap state) was
  not read. Because 5000 fitted under 10000, the module did not PATCH
  `max_concurrent_users`.
- **Pool connections seen.** Realtime's connections were sampled from
  `pg_stat_activity` once a second while each burst settled. The ones named
  `realtime_subscription_manager_pub` peaked at 4 on every default-config row
  but the first (8), and at 1, 20, 21 and 81 with `postgres_changes_pool` set
  to 1, 20, 21 and 100. That name tracking the setting is the basis for reading
  it as the Postgres Changes pool. With the setting null it held 4 of those
  connections where the docs give a default of 2; explicit settings from 2 to
  19 were not tested. **Correction 2026-10-26:** "the docs" here is the
  settings page's default of 2. The concepts page's table of default pool
  sizes (https://supabase.com/docs/guides/realtime/concepts, "Subscription
  management") gives 4 for Small, which is what was measured; DC13 in
  data-api-capacity read 4 on Small and 7 on XL and 2XL, the table's figures.
- **H1 held at 5000 joins and at no lower level.** Default config: 1421 of 5000
  and 1611 of 5000 channels got `system` `{:error, "Too many database
  timeouts"}` (`pc_error`), and `realtime.subscription` held 3579 and 3389
  rows, the ready count. 500, 1000 and 2000 joins: every channel ready, both
  reps. 100 joins: rep 2 100 of 100; rep 1 73 of 100, the project's first burst
  (next bullet), with no timeouts. With `postgres_changes_pool` 20: every
  channel ready at every level, including 5000 of 5000 in both reps
  (RT05c-5000 pass). With `postgres_changes_pool` 1 the timeouts started at a
  lower level: 1234 and 1202 of 2000, 3858 and 3829 of 5000; 1000 joins and
  below all ready. Whether a channel that got the timeout would have recovered
  through the retry the settings page describes was not measured.
- **No other failure class appeared**, apart from the first burst on the new
  project: 100 joins, 26 `join_error` `UnableToConnectToProject` and 1
  `phx_error`; the second rep 100 of 100. No rate-limit reply
  (`ClientJoinRateLimitReached`, `ConnectionRateLimitReached`,
  `too_many_joins`), no socket failure (5000 of 5000 opened every time), no
  `no_reply`. `pg_postmaster_start_time` did not change across any burst.
- **Join to ready, p50 / p95.** At 5000: default `pc` 2964 / 5690 and 2864 /
  5688 ms (ready channels only), `postgres_changes_pool` 20 `pc` 2038 / 3863
  and 2028 / 3860 ms, `bc` (default config) 1730 / 3266 and 2067 / 3646 ms. At
  1000: default `pc` 825 / 1490 and 730 / 1380 ms, `postgres_changes_pool` 1
  `pc` 2600 / 4872 and 2595 / 4937 ms, `postgres_changes_pool` 20 `pc` 422 /
  798 and 426 / 779 ms, `bc` (default config) 374 / 668 and 376 / 679 ms.
- **H2 held: private Broadcast joined every channel at every level** (100 to
  5000, both reps, no error; `bc` ran at the default config only), and every
  ready channel of both kinds received the measured insert (delivered equals
  ready on all 42 burst rows).
- **Fan-out of one insert, p50 / p95 / max ms.** `bc` (default config): 6/7/7
  and 4/6/6 at 100; 9/14/15 and 9/11/11 at 500; 14/225/226 and 17/226/227 at
  1000; 30/442/652 and 18/234/237 at 2000; 234/877/1771 and 235/874/887 at
  5000. `pc`, default config: 375/376/376 (73 ready) and 463/465/465 at 100;
  572/575/581 and 613/616/864 at 500; 209/427/428 and 678/891/892 at 1000;
  483/693/700 and 873/1294/1299 at 2000; 909/1338/1760 (3579 ready) and
  936/1352/1358 (3389 ready) at 5000. `pc`, `postgres_changes_pool` 20:
  45/46/46 and 512/513/513 at 100; 1286/1701/1709 and 1270/1457/1688 at 5000
  (5000 of 5000). One process received every frame, so at 5000 sockets the
  client's own scheduling is inside both kinds' figures; that share was not
  separated.
- **The pool's upper bound is not enforced at the documented 20.** PATCH
  `postgres_changes_pool` 21 and 100 both answered 204 and read back (the
  OpenAPI schema gives 1 to 100). After a 500-join burst with
  `postgres_changes_pool` 21: 30 client backends of `max_connections` 90, and
  a Management API query answered 201. After a 500-join burst with
  `postgres_changes_pool` 100: `realtime_subscription_manager_pub` peaked at
  81 during the burst, client backends afterwards were 90 of 90, and a
  Management API query answered `503 Failed to run sql query: FATAL: 53300:
  sorry, too many clients already` (RT05a-bound100-conns).
- Not measured: whether a channel that got `Too many database timeouts`
  recovers through the documented retry or needs a rejoin (the client never
  retries, and the module stops watching once every channel has settled);
  several channels per socket; `filter=` subscriptions; compute above Small;
  joins from more than one client address; how the platform counts joins per
  second against the 2500 read here; explicit `postgres_changes_pool` values
  from 2 to 19; any `connection_pool` (the Realtime authorisation pool) other
  than 2.

Unpublished dev iterations the same day, all on one reused dev project, a
different project from the artifact's (nothing from them is in `out/`): the
orchestrator's pooler session was terminated with `57P01` (administrator
command) shortly after the Small resize and the unhandled error killed the
run, so the module reconnects now and records `postmaster_restarted`; the
measured insert picked its tenant with `limit 1` and hit an earlier run's
tenant, so neither kind received it (0 of N), and the insert now names the
tenant; re-issuing user tokens before every burst ended one iteration with a
failed password grant, so tokens are re-issued every 40 minutes; one iteration
began while another still had `postgres_changes_pool` 21 set and met `53300`
at setup, two runs on one project, so not counted. By the local shell clock
(not in `out/`), the dev project was healthy by 22:39 UTC and deleted at 22:53
UTC on 2026-10-22.

**Host sleep audit (2026-10-26, #234): no figure in this section is
affected.** Six sleeps of the orchestrator Mac, 1142 s in all (23:17:28 to
23:52:48 UTC), fell inside this run's wall span; walking the module across
them lands 11 s from `finishedAt`
(`../platform-downtime/out/2026-10-26/host-sleep/overlap.txt`). RT05 is one
module, so the tool cannot place single rows, but every row's timings are
wall-clock (`Date.now()` in `lib/burst.ts`) and none holds a sleep of 100 to
262 s: across the 42 burst rows the longest burst wall time was 7176 ms,
join to ready 6208 ms, canary wait 1595 ms, fan-out 1771 ms and teardown
18376 ms. Every channel not ready on any row has a server reply
(`Too many database timeouts`, or the first burst's 26 join errors and 1
`phx_error`), so no socket went quiet across a sleep. The sleeps fell
between bursts. One teardown (pool 20, 500 joins, r1) read -1, no zero
`realtime.subscription` count within its 90 s wall-clock wait, which a
sleep in teardown would also give; teardown is not quoted above.

## Harness lessons (2026-10-10, unpublished iterations)

- A client given only an `Authorization` header and `realtime.setAuth(token)`
  had its realtime token reset to the anon key at the client's next token
  refresh (the mechanism is inferred from the symptoms, not read from source).
  The first read of RT01e showed `secret` arriving in UPDATE payloads for an
  `authenticated` subscriber, and `httpSend` from the same client answered 401
  and 403 against a private topic that a raw request with the user token
  reached (202). With the user signed in on the client (`signInWithPassword`)
  neither happened, and the modules do that now.
- `removeAllChannels()` delivers `CLOSED` to the subscribe callback; a status
  read after teardown says `CLOSED`, not `SUBSCRIBED`. A readiness helper
  that read it afterwards reported failure on every healthy project for 120 s.
- Cleanup: every module deletes the project it creates in `finally`. The
  count of projects created across the unpublished iterations and the final
  runs was not logged, and no teardown listing is kept with the evidence, so
  this write-up does not state a count or a final `GET /projects` result.
