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

Costs: four short-lived Pro projects at the default compute size, a few
minutes each; no paid add-ons.

Findings, with counts and the claims they are measured against: `RUNLOG.md`.
