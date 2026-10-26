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

Findings, with counts and the claims they are measured against: `RUNLOG.md`.
