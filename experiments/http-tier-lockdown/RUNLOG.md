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

## 2026-08-07 - run 2 (Micro, eu-central-2) - the Dashboard toggle, settled

Run 1 left two questions open: whether the Dashboard "Enable Data API" toggle
produces a different state from the `db_schema: ""` wedge, and (from the
PrivateLink experiment) whether eu-central-2 really is excluded from
PrivateLink. Both are project-level questions with no network topology, so one
bare micro project in eu-central-2 answered both.

**eu-central-2 has no PrivateLink UI.** Project Settings > Integrations on a
Team-plan project in eu-central-2 lists GitHub and Vercel only - no AWS
PrivateLink entry. The control is tight: same org (Team, PrivateLink granted
and used that morning), same day, and the section renders for an
ap-southeast-1 project in that org. Region is the only variable. This does not
prove the backend would refuse, but there is no self-serve path, which is the
operationally relevant fact. Moves the published row from "asserted, untested
(Studio source)" to measured.

**The Dashboard toggle IS `db_schema`.** With the toggle off, `GET
/v1/projects/{ref}/postgrest` returns `db_schema: ""`, and the observable state
is identical to the Management API path: anon table read `503 PGRST002 "Could
not query the database for the schema cache. Retrying."`, `/rest/v1/` still
`401`, `/graphql/v1` `503`. So the toggle and the PATCH are the same lever, and
three claims in the published reference are wrong: that the Management API path
"is not equivalent", that disabling the Data API "remains a Dashboard action",
and that the lever is not expressible in IaC. There is no `enabled` field, but
that was the wrong field to look for.

**The toggle round-trip is LOSSY, and this is the finding worth carrying.**
Set `db_schema = "public,graphql_public,pvlab_api"` (the third a schema created
for this test, with a table anon could read). Toggle off, toggle on. It came
back as `public` - alone. Not the prior value, and not the platform default
either, which would have included `graphql_public`. It writes a constant.

Consequences: any project with extra exposed schemas loses them silently on a
toggle round-trip, `/graphql/v1` stops working because `graphql_public` is
gone, and a client asking for a dropped schema gets `406 PGRST106 "Invalid
schema: pvlab_api"` with hint `"Only the following schemas are exposed:
public"`. The error is honest; the config change is silent. Recovery is
re-entering the list by hand.

So the operational advice inverts. The Dashboard click is the DESTRUCTIVE path.
`PATCH /v1/projects/{ref}/postgrest` round-trips whatever you give it and is
the safe one.

**Timing, measured from the click this time.** Disable had already propagated
by the first sample ~2s after the click; enable repopulated within ~8s. An
earlier attempt in this session reported ~110s and then "never restored" - both
were artifacts of sampling from when the watcher started rather than from the
click, and neither is a real measurement. Do not repeat that: timestamp the
human action, not the observer.

Side observation: `GET /v1/projects/{ref}/postgrest` returns the project's
`jwt_secret` in the config body. Worth knowing before piping that response
anywhere it gets logged.

Method note: the probe table was created through
`POST /v1/projects/{ref}/database/query`, which is write-capable. That avoids
needing DB connectivity at all - useful here because the direct host is
IPv6-only and the dev box has no IPv6.

Teardown: `tofu destroy`, 1 resource, project gone, 0 in the lab org.

## What this does NOT answer

- Whether the private data path survives the lockdown (T22d/e/f) - needs the
  `db` capability, i.e. a run from inside the VPC in the PrivateLink
  experiment. Every mechanism observed here is HTTP-tier only, so the
  expectation is "unaffected", but it is untested.
- [answered in run 2] The Dashboard toggle produces the SAME state as the
  wedge, because it is the same lever - and its round-trip drops every schema
  but `public`.
- Auth and Storage have no equivalent toggle at all.

## Cost / teardown

Micro project, ~25 minutes, destroyed same session. `make destroy`.
