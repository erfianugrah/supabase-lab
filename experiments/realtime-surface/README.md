# realtime-surface

Realtime behaviour that changelog and blog posts describe and the lab had not
run: Postgres Changes filter composition and column select, what a subscriber
misses while disconnected, Broadcast Replay limits, and binary Broadcast
payloads. Measured from the local vantage with the current `supabase-js` (the
version is recorded in each run) on throwaway Pro-plan projects.

Self-provisioning, like `bu-attribution` and `sfp-platforms`: each module
creates a project (`rt-*`, ap-southeast-1), runs, and deletes it in
`finally`. No OpenTofu state.

## Modules

| id | claim |
|---|---|
| RT01 | `postgres_changes` AND filters over two and three columns; `like`, `ilike`, `is`, `match`, `imatch`, `isdistinct` and `not.` each checked against Postgres's own evaluation of the equivalent predicate; `select` (PK injection, UPDATE touching only an unselected column, nonexistent column); DELETE under a filter with replica identity default and full; `select` naming a column revoked from the subscribing role; delivered events per subscriber with and without a filter |
| RT02 | rows inserted during a 30 s disconnect (client-driven reconnect and manual `disconnect()`/`connect()`); a heartbeat-row canary that detects the stall, resubscribes and backfills over REST with `updated_at > last_seen` |
| RT03 | Broadcast Replay: 26 database-sent messages against the documented 25 cap, which 25 come back, `since` windows, a public channel, client-sent messages |
| RT04 | binary Broadcast over WebSocket (`ArrayBuffer` and `Uint8Array`), REST (`httpSend` and raw `application/octet-stream`) and `realtime.send_binary`; receive on the current client and on an old one; private-channel RLS on read and write |
| RT05 | subscription bursts of 100 to 5000 joins (one channel per WebSocket, all joins sent at once) on Small: Postgres Changes at the default, 1 and 20 `postgres_changes_pool`, against the documented "Too many database timeouts"; private Broadcast from a database trigger at the same sizes; one insert's fan-out latency to every ready channel; whether the Management API accepts pool values above the documented 20, and how many of the 90 `max_connections` on Small are in use after a 500-join burst at `postgres_changes_pool` 100. `RT05_COMPUTE` runs it at another size (`ci_2xlarge` on 2026-10-26, levels 2000 and 5000), `RT05_BOUNDS` and `RT05_BC_LEVELS` trim the over-range probes and the Broadcast levels |
| RT06 | join and delivery cost of 5000 Postgres Changes subscribers in two shapes on an RLS-protected notifications table: one shared public topic with an unfiltered INSERT binding (shape A) against one topic per user with a `user_id=eq.<uid>` filter (shape B), on a project created Small with the Postgres Changes pool as created; 20 rows inserted across users and every client's deliveries counted; private per-user Broadcast (`user:<uid>` topics, a `realtime.messages` policy on `auth.uid()`, `realtime.send` at 50 and 200 messages/s for 60 s): delivery, latency, statement time per message, `realtime.messages` growth, and whether the policy runs per join or per message. Users are inserted into `auth.users` with one SQL statement and their tokens minted locally under the project's JWT secret (checked against a session token first). `RT06_COMPUTE`, `RT06_N`, `RT06_BC_N`, `RT06_BC_RATES` and `RT06_REPS` resize it |

## Measured (RT06, 2026-10-28)

Three projects (S1 and S2 created Small, L created Large), 5000 clients,
Postgres Changes pool as created; full tables and the inference in `RUNLOG.md`.
Artifacts: `out/2026-10-28/`.

| question | S1 (Small, 2 reps) | S2 (Small, 1 rep) | L (Large, 2 reps) |
| --- | --- | --- | --- |
| shape A ready of 5000 (`Too many database timeouts`) | 5000, 5000 (0, 0) | 3380 (1620) | 5000, 5000 (0, 0) |
| shape B ready of 5000 (`Too many database timeouts`) | 4916, 4782 (84, 218) | 3279 (1721) | 5000, 5000 (0, 0) |
| join to ready p50 ms, A / B | 2939, 2877 / 3028, 3027 | 2964 / 3085 | 2802, 2685 / 2955, 2931 |
| subscription statement ms, A / B | 5180, 4841 / 5750, 5828 | 3856 / 4345 | 1537 + 1526, 3131 / 3764, 3572 |
| 20 rows: delivered to owner, misdelivered | 20 of 20, 0 every row | 20 of 20, 0 every row | 20 of 20, 0 every row |
| 20 rows: delivery p50 ms, A / B | 9486, 9851 / 7966, 7839 | 7256 / 6666 | 5841, 5380 / 4796, 4583 |
| 20 rows: WAL poll statement ms, A / B | 9332, 9482 / 7862, 7599 | 7273 / 6418 | 5514, 5414 / 4409, 4380 |
| Broadcast: policy evaluations, 5000 joins / during sends | 5000 / 0 | 5000 / 0 | 5000 / 0 |
| Broadcast: send statement ms per message, 50/s / 200/s | 0.193, 0.2 / 0.134, 0.142 | 0.24 / 0.161 | 0.148, 0.147 / 0.09, 0.091 |
| Broadcast: latency p50 ms, 50/s / 200/s | 14, 14 / 16, 16 | 14 / 17 | 13, 12 / 14, 14 |

## Run

```bash
cd experiments/realtime-surface
make install        # the old supabase-js RT04 receives on (supabase-js-2-90)
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make run
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make run ONLY=RT03
make facts RUN=evidence/<ts>/run-<stamp>.json
```

`PVLAB_PEER_RT=<ref>` reuses an existing project (never deleted) while
iterating; add `PVLAB_RT_DBPASS` for the modules that open a pooler session.

Costs: RT01-RT04, four short-lived Pro projects at the default compute size, a
few minutes each; no paid add-ons. RT05, one project resized to Small for about
70 minutes (67 in the 2026-10-22 run; `make run ONLY=RT05`; `RT05_LEVELS`, `RT05_REPS`, `RT05_POOLS`,
`RT05_KINDS` shorten it), opening up to 5000 WebSockets from the local machine.
RT06, one project created at `RT06_COMPUTE` (Small by default) for about 10 to 16
minutes per run (three runs on 2026-10-28: 14, 16 and 9 minutes), up to 5000
WebSockets.

Findings, with counts and the claims they are measured against: `RUNLOG.md`.
