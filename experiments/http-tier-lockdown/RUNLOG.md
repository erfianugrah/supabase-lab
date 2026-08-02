# RUNLOG - http-tier-lockdown

One Supabase project, no AWS. Answers the two questions the PrivateLink work
kept deferring: can the managed HTTP tier be locked down through the API, and
what does locking it down actually buy.

Scope note: PrivateLink settles the database socket. It does not touch the
HTTP tier - Data API, Auth, Storage, Realtime all live on `<ref>.supabase.co`
and resolve publicly (measured in the PrivateLink experiment, T13c). So the
only available moves on that tier are "disable" or "accept it", and both had
been asserted from docs rather than measured.

## 2026-08-02 - run 1 (Micro, ap-southeast-1)

Harness: `make probe` -> `pvlab --where runner --destructive --only T22,T23`.
The `runner` vantage is nominal here: there is no VPC, so T22's private-path
rows self-skip and only the HTTP-tier questions execute. Three consecutive
runs; numbers below are the spread across them.

### Data API (T22)

The Dashboard has an "Enable Data API" toggle and the guide says that with it
off, "none of the auto-generated REST endpoints respond, regardless of grants
or RLS". The published /v1 Management API has NO such flag - the only
PostgREST surface is `GET|PATCH /v1/projects/{ref}/postgrest` with
`db_schema` / `max_rows` / `db_extra_search_path` / `db_pool`. The hypothesis
under test was that an empty `db_schema` is what the toggle writes.

Measured:

- `PATCH { db_schema: "" }` is ACCEPTED (HTTP 200) and the value round-trips
  in the subsequent GET. So a lever exists.
- Effect lands in 6-8s: an anon table read goes from `404 PGRST205` (table
  absent - a normal PostgREST answer) to `503 PGRST002 "Could not query the
  database for the schema cache. Retrying."`.
- That state is STEADY, not a restart blip: held for 120s in a separate
  sampling loop, every 10s sample identical.
- `/graphql/v1` goes 503 with it - pg_graphql rides the same PostgREST
  process, so the blast radius is wider than "REST".
- `/rest/v1/` root keeps answering `401 "Only the service_role API key can be
  used for this endpoint"` throughout, in BOTH states. The API gateway in
  front of PostgREST is unaffected; the hostname stays internet-reachable and
  keeps answering.
- Restore (`db_schema` back to `public,graphql_public`) recovers in 1-2s.

Conclusion, and it is a correction rather than a confirmation: an empty
`db_schema` does not disable the Data API, it WEDGES PostgREST. A caller
cannot distinguish the result from an outage, monitoring will read it as one,
and the surface is still there answering. Do not present this as the
API-side equivalent of the Dashboard toggle. The toggle remains
Dashboard-only, which puts it in the same bucket as the PrivateLink
association: real, supported, and not expressible in IaC. (Consistent with
the earlier finding that undocumented `/platform` routes reject PATs
categorically.)

### Realtime (T23)

`private_only` IS a documented Management API field
(`PATCH /v1/projects/{ref}/config/realtime`, 204). The unmeasured part was
where enforcement lands.

Measured:

- Baseline (`private_only: false`): anon WebSocket handshake 89ms, `phx_join`
  on a non-private channel replies `{"status":"ok"}`.
- After the flip, 9s to effect, reproducible across runs.
- The handshake STILL SUCCEEDS. The refusal arrives in the join reply:
  `{"status":"error","response":{"reason":"PrivateOnly: This project only
  allows private channels"}}`.
- Restore is immediate.

Conclusion: `private_only` is an authorization control, not a network one. An
anonymous client on the public internet still opens a WebSocket to the
project; what it cannot do is join a public channel. Worth saying plainly to
anyone treating the Realtime toggle as attack-surface reduction - it narrows
what a connected client may do, it does not remove the endpoint.

## What this does NOT answer

- Whether the private data path survives the lockdown (T22d/e/f) - needs the
  `db` capability, i.e. a run from inside the VPC in the PrivateLink
  experiment. Every mechanism observed here is HTTP-tier only, so the
  expectation is "unaffected", but it is untested.
- Whether the Dashboard toggle produces a DIFFERENT state from the wedged one
  (e.g. a clean refusal at the gateway, or ingress removed). It is one click
  away for anyone with the Dashboard open, and it would settle whether
  "disable the Data API" means removed or merely off.
- Auth and Storage have no equivalent toggle at all.

## Cost / teardown

Micro project, ~25 minutes, destroyed same session. `make destroy`.
