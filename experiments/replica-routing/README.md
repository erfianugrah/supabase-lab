# replica-routing

Where the API load balancer sends a GET when a project has a cross-region read
replica, how stale a replica read is after a write, and what the replica does
to a long query when the primary changes the rows under it. Self-provisioning:
the module creates a Small project on a Pro org, adds `pitr_7` and one
replica, measures, then removes the replica and deletes the project in
`finally`. No OpenTofu state. Sibling context: `sfp-platforms` (S07: replica
setup gate hunt) and `medium-serverless` (MS06: same-region replica).

## Modules

| id | claim |
|---|---|
| RR01a-b | create a Small primary in ap-northeast-1; `pitr_7` and the schema |
| RR01c-d | baseline GET on the primary; `read-replicas/setup` to ap-southeast-1, seconds until it serves |
| RR01e | the replica's REST host and the load balancer's host (neither is in the Management API) |
| RR01f-g | GETs through the load balancer from this vantage; which node served; non-GET goes where |
| RR01h0-h8 | the same GET from Edge Functions in eight regions (`x-region`) |
| RR01i-k | read-your-writes on the replica endpoint and through the load balancer; per-insert delay |
| RR01l-n | `max_standby_streaming_delay`, `hot_standby_feedback`; a long replica query against primary UPDATE+VACUUM and against an ACCESS EXCLUSIVE lock (3 each) |
| RR01o | what `edge_logs` records per load balancer GET (Cloudflare colo, chosen region, redirect identifier) |
| RR01p | teardown: replica removed, project deleted |
| RR02a-d | same shape as RR01; `max_standby_streaming_delay` raised through the Management API and read back on both nodes |
| RR02e | baseline: `rpc/rr_node` through the load balancer, the replica host and the primary host, with a 250 ms heartbeat writer |
| RR02f1-f6 | REST, GraphQL, Auth, Storage, Realtime and Edge Function requests on the primary, replica and load balancer hosts |
| RR02g | lag by write burst (bulk insert) while reading through the load balancer |
| RR02h | lag by stopped replay (replica query vs primary UPDATE+VACUUM) while reading through the load balancer |
| RR02i | `POST /restart` while reading: error windows per host, which nodes restarted |
| RR02j | `read-replicas/remove` while reading: errors, whether the load balancer moves to the primary |
| RR02k | `edge_logs` redirect identifier per path family on the load balancer host |
| RR03a-c | same-region shape: Small primary and Small replica both in ap-southeast-1, `pitr_7`; an RLS table, views and five functions; two users |
| RR03d | user JWTs through supabase-js (`accessToken`, global `Authorization` header, `setSession`, `signInWithPassword`) and raw fetch on each host: rows under RLS, `auth.uid()`, node |
| RR03e | legacy anon and service_role JWTs, `sb_publishable_`, `sb_secret_`, an ES256 user token and an HS256 user token on each host |
| RR03f | `rpc(fn, {}, { get: true })` and `rpc(fn)` through the load balancer for stable, definer, volatile read-only and writing functions |
| RR03g | `HEAD` and `GET` with `count=exact` through the load balancer and on the replica host |
| RR03h0-h3 | same-region split: GETs through the load balancer from this vantage and from Edge Functions in three regions, order of nodes |
| RR03i | lag under 50 single-row inserts a second for 300 s: `stale_ms` per host, `replay_lag` |
| RR03k | `edge_logs` per method and path on the load balancer host |

The node that served a request is read from `public.rr_whoami()`
(`pg_is_in_recovery()`, postmaster start time) called as a GET, not inferred
from latency. RR02 reads `public.rr_node()` instead, which also returns
`stale_ms`, the age of the newest heartbeat row the node can see.

## Run

```bash
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make run
PVLAB_ORG_PRO=<pro-org-slug> make run-rr02   # RR02, about 25 to 35 minutes
PVLAB_ORG_PRO=<pro-org-slug> make run-rr03   # RR03, about 10 to 12 minutes
make leftovers        # nothing named rr-* should print
make facts RUN=evidence/<ts>/run-<stamp>.json        # ONLY=RR02 for an RR02 run
make publish RUN=evidence/<ts>/run-<stamp>.json
```

About 30 minutes end to end, dominated by replica provisioning. The Makefile
header lists the environment knobs (keep the project, reuse one, run a subset
of phases). Billable while it runs: a Small primary, a Small replica and
`pitr_7`.

## Measured (2026-10-10, one project, one run, Singapore vantage)

Full record and caveats: `RUNLOG.md`; artifact `out/2026-10-10/`.

| finding | value | module |
|---|---|---|
| Load balancer host | `<ref>-all.supabase.co`; the PAT is refused on the route that lists it (401) | RR01e |
| GETs through the load balancer from Singapore, replica in Singapore, primary in Tokyo | 40 of 40 served by the replica; median latency matched the replica's | RR01f |
| Non-GET through the load balancer | `POST` RPC and `POST` insert served by the primary | RR01g |
| Edge Function vantages (10 GETs each; `x-region` is the function's region, the node served tracks the request's Cloudflare colo, see RR01o) | replica for ap-southeast-1, ap-southeast-2, ap-south-1, sa-east-1; primary for ap-northeast-1, eu-west-1, us-east-1, us-west-1 | RR01h1-h8 |
| What the load balancer logs | available regions, chosen region, Cloudflare colo and redirect identifier per request | RR01o |
| First read after a write, replica endpoint | 0 of 30 missed; bounded by the client's own round trip (writes went to Tokyo) | RR01i |
| `max_standby_streaming_delay` | 30 s on both nodes, source `default`; `hot_standby_feedback` off | RR01l |
| Long replica query vs primary UPDATE+VACUUM or ACCESS EXCLUSIVE lock | cancelled in 6 of 6, SQLSTATE 40001, about 30 to 32 s after the primary command | RR01m, RR01n |
| Row written on the primary after the conflicting command | visible on the replica about 30 to 32 s later (replay stopped) | RR01m, RR01n |

## Measured (2026-10-23, RR02, two projects, two runs, Singapore vantage)

Full record: `RUNLOG.md`; artifacts `out/2026-10-23/`.

| finding | value | module |
|---|---|---|
| Replica whose replay stopped (replica query vs primary UPDATE+VACUUM) | load balancer sent every read to it: 586 of 586 over 174.6 s (run 1), 98 of 98 over 28.8 s (run 2); largest age served 176,772 ms and 30,842 ms; 0 errors | RR02h |
| Write burst as a lag method | 1,500,000-row insert filled the Small disk after 19.7 s; replica age stayed under 2,000 ms | RR02g |
| `PUT config/database/postgres` `max_standby_streaming_delay: 600s` | HTTP 200 both runs; replica read `600000ms` in run 1, `30000ms (default)` in run 2 | RR02d |
| `POST /restart` | restarted both nodes, primary first; reads through the load balancer stayed on the replica while the primary was down, and failed (0 sent to the primary) while the replica was down, about 35 s per run | RR02i |
| `read-replicas/remove` of the only replica | load balancer errors from about 1 s after the call (16.1 s and 16.2 s, call at 15 s), 0 reads served by the primary; `HTTP 400 Load balancer does not seem to be configured properly.` until the 1,200 s watch ended (run 2) | RR02j |
| GraphQL through the load balancer | 400 for POST and GET (`Load balancer does not handle ... requests for the path /gr...`) | RR02f2 |
| Auth, Storage, Realtime, Edge Functions through the load balancer | 200 / joined; `edge_logs` names the primary for Auth, no identifier for Storage and Realtime | RR02f3-f6, RR02k |
| Replica's own host | serves REST GETs only; Auth, Storage, Functions, GraphQL 400, Realtime handshake fails | RR02f |

## Measured (2026-10-26, RR03, two projects, two runs, Singapore workstation plus Edge Functions in ap-southeast-1, us-east-1 and eu-west-1, primary and replica both in ap-southeast-1)

Full record: `RUNLOG.md`; artifacts `out/2026-10-26/`. supabase-js 2.118.0.

| finding | value | module |
|---|---|---|
| RLS and `auth.uid()` on the replica, ES256 user token | user A 3 rows, user B 5 rows, 0 rows of another tenant, `auth.uid()` the user's, on the replica host and through the load balancer whichever node served; anon 0 rows | RR03d |
| supabase-js patterns that carried the user token to the replica | `accessToken: async () => token` and `global.headers.Authorization`, both runs; `auth.setSession` fails on the replica host (`Failed to parse JSON`) and the next read goes out as anon (0 rows, no error) | RR03d |
| Keys on the replica host | legacy anon JWT, `sb_publishable_` (with or without Bearer) as anon; ES256 and HS256 user tokens as the user; legacy service_role JWT and `sb_secret_` as service_role; all 200 | RR03e |
| `rpc(..., { get: true })` through the load balancer | stable, definer and volatile read-only functions 200 on either node; a writing function 405 SQLSTATE `25006` on either node (replica 3 of 5, primary 2 of 5, both runs) | RR03f |
| `rpc(...)` (POST) through the load balancer | primary 5 of 5 for every function; the writing function wrote | RR03f |
| `HEAD` + `count=exact` | through the load balancer 200 on both nodes (replica 6 and 3 of 10); on the replica's own host 400 | RR03g |
| Same-region split, GETs through the load balancer | workstation 111/89 and 94/106 replica/primary of 200; Edge Function ap-southeast-1 100/100 and 115/85 of 200; 20/30 and 27/23 of 50 from us-east-1, 26/24 and 24/26 from eu-west-1 (chosen region `SIN` for the SIN, IAD and DUB colos, the only region available); order not alternating (run 2, workstation keep-alive: 92 switches in 199) | RR03h |
| Staleness and lag at 50 inserts/s, same region | replica host `stale_ms` (includes the 20 ms insert period and clock skew) p50 17 and 21 ms, p95 28 and 30, max 91 and 99 (primary host p50 12 both runs); `replay_lag` p50 2.2 and 2.1 ms | RR03i |

Not measured: other region pairs, read load or write rates above 50
inserts/s, behaviour with `hot_standby_feedback` on, the load balancer's
rule, a replica that is down while the primary is untouched (the Management
API has no per-replica restart as of 2026-10-23), recovery of the load
balancer endpoint after the last replica is removed beyond 1,200 s, the
same-region spreading rule, read-your-writes through the load balancer in
the same-region shape, Auth-issued HS256 or third-party user tokens.
