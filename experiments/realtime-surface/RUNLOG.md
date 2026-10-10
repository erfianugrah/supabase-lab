# realtime-surface RUNLOG

Chronological record of what was run. Projects were created on a Pro-plan
organization, region ap-southeast-1, default compute, no add-ons, and deleted by
the module that created them. Org slugs and project refs are not recorded.
Vantage: a local macOS machine (not in the project's region); the current
`@supabase/supabase-js` is whatever the installed package.json said at run time
(RT01a records it), and the old client is the one pinned in this directory's
`package.json`. Every count is n=1 per row on one project unless a row says
otherwise. Published artifacts: `out/2026-10-10/` (redacted, with `.facts.md`
beside each).

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
