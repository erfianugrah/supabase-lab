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
| RR04a-c | same-region shape as RR03 (Small primary and Small replica in ap-southeast-1, `pitr_7`); `rr4_ryw`, `rr4_seen`, `rr4_where`, `rr4_spin` |
| RR04d | raw HTTP/1.1 HEAD, GET, POST, OPTIONS and an Auth GET on the replica, load balancer and primary hosts: status, every header, body bytes |
| RR04e-g | read-your-writes through the load balancer: POST a row, then at once GET it (raw fetch 200, supabase-js 50, raw 200 under 50 inserts/s) |
| RR04h0-h2 | the split under 1, 8 and 32 concurrent readers |
| RR04i1-i2 | the split while four busy loops hold the replica's, then the primary's CPU |
| RR04j | the split while the replica's replay is stopped (RR02h's conflict method, three cycles) |
| RR04k | `POST /restart` while reading: what `-all` serves while each node is down |
| RR04l | `edge_logs` on the three hosts: method, status, redirect identifier |
| RR06a-b | same-region shape (Small primary and Small replica in ap-southeast-1, `pitr_7`); RLS table `rr6_docs`, `rr6_touch()`; users A and B |
| RR06c | `custom_domain` add-on, hostname, DNS through Cloudflare, verify, activate, the custom host serves |
| RR06d | sign in through the custom host; that token on the custom, load balancer, replica and primary hosts: rows, `auth.uid()`, node |
| RR06e | 200 anon GETs through the custom host and 200 through the load balancer, interleaved; 50 user reads through the custom host |
| RR06f | two clients: Auth on the custom host, data on the load balancer with `accessToken` from the Auth client's session; writes; a refresh |
| RR06g | a Cloudflare Worker splitting GET/HEAD `/rest/v1/*` to the load balancer and the rest to the custom host; one supabase-js client through it |
| RR06p | teardown: Worker, custom hostname, DNS records, replica, project |
| RR07a-c | RR06's shape (Small pair in ap-southeast-1, `pitr_7`, custom domain) plus a mock OIDC issuer (Edge Function) in the Keycloak slot |
| RR07d | the RR06 Worker on a Workers Custom Domain in the same zone: seconds from the deploy to an answer on the zone's nameservers, on 1.1.1.1, and through the Worker |
| RR07e | Worker hop latency: 50 anon GETs through the Worker and 50 to the load balancer, interleaved, p50/p90 |
| RR07f | CORS: preflight and actual requests with an `Origin` for GET `/rest/v1`, POST `rpc`, POST `/auth/v1/token`, through the Worker, the custom host and the load balancer |
| RR07g | real cross-origin fetches in headless Chromium (`browser/cors-check.ts`): password sign-in, RLS read, POST `rpc`, through the Worker and the custom host |
| RR07h-k | OAuth PKCE round trip entered at the Worker, the custom host, the project host, and at the Worker with the callback hop through the Worker: `redirect_uri`, code exchange |
| RR07l | the OAuth session through the Worker: rows under RLS, `auth.uid()`, node, POST `rpc`, refresh |
| RR07m | SAML SSO (lab-signed Response) started through the Worker: SP metadata per host, ACS POST through the Worker and to the metadata ACS, code exchange, reads |
| RR07p | teardown: Worker, Workers Custom Domain, certificate, auth providers, custom hostname, DNS records, replica, project |
| RR08a-c | same-region shape (Small primary and Small replica in ap-southeast-1, `pitr_7`); `rr8_items` 1,500,000 rows, `rr8_list(p_ms)` (a STABLE scan of 1 to 7 s); one user; replica and load balancer hosts |
| RR08d | steady lag at 4 heartbeat inserts a second: heartbeat age on both hosts, `replay_lag` |
| RR08e, RR08h, RR08j, RR08l | 4 + 4 readers (replica host, `-all`) of `rr8_list` as `authenticated` while the primary updates 500 rows every 250 ms and runs `VACUUM (VERBOSE)` every 30 s: defaults (e), `max_standby_streaming_delay` 5s (h), 120s (j), `hot_standby_feedback` on (l); failures by SQLSTATE, read time, heartbeat age, `replay_lag`, `pg_stat_database_conflicts`, dead tuples VACUUM could not remove |
| RR08f, RR08n | the readers while the primary takes three brief ACCESS EXCLUSIVE locks, feedback off (f) and on (n) |
| RR08g, RR08i, RR08k | `PUT config/database/postgres` (merged over current overrides, as the CLI does); `pg_settings` and postmaster start on both nodes |
| RR08m | feedback on plus one 120 s repeatable-read transaction on the replica: VACUUM's not-removable count, `n_dead_tup`, heap growth |
| RR08o-p | API role settings on the replica; teardown |

The node that served a request is read from `public.rr_whoami()`
(`pg_is_in_recovery()`, postmaster start time) called as a GET, not inferred
from latency. RR02 reads `public.rr_node()` instead, which also returns
`stale_ms`, the age of the newest heartbeat row the node can see.

## Run

```bash
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make run
PVLAB_ORG_PRO=<pro-org-slug> make run-rr02   # RR02, about 25 to 35 minutes
PVLAB_ORG_PRO=<pro-org-slug> make run-rr03   # RR03, about 10 to 12 minutes
PVLAB_ORG_PRO=<pro-org-slug> make run-rr04   # RR04, about 14 to 16 minutes
PVLAB_ORG_PRO=<pro-org-slug> make run-rr06 DOMAIN=<host> [WORKER_DOMAIN=<host>]   # RR06, about 9 to 15 minutes; Makefile header lists the credentials
PVLAB_ORG_PRO=<pro-org-slug> make run-rr07 ZONE=<zone>   # RR07; run `bun install` in browser/ first; Makefile header lists the credentials
PVLAB_ORG_PRO=<pro-org-slug> make run-rr08   # RR08, 48 and 49 minutes on 2026-10-28 (before a 5-minute wait per PUT was removed)
make leftovers        # nothing named rr-* should print
make facts RUN=evidence/<ts>/run-<stamp>.json        # ONLY=RR02 for an RR02 run (RR03, RR04, RR08 likewise)
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

## Measured (2026-10-26, RR04, two projects, two runs, Singapore workstation, primary and replica both in ap-southeast-1)

Full record: `RUNLOG.md`; artifacts `out/2026-10-26/run-2026-10-26T06-19-17-837Z.json` and `run-2026-10-26T06-34-17-863Z.json`.

| finding | value | module |
|---|---|---|
| HEAD on the replica's own host | 400 `text/plain`, Content-Length 75 and the same header names as the POST 400 (`Read replica does not handle POST requests for the path /rest/v1/rr4_where.`, 75 bytes); no `x-envoy-*` or `content-profile`, so by inference refused by the gateway in front of the replica's REST service rather than by PostgREST | RR04d |
| HEAD through the load balancer | 200 from both nodes (replica 5 and 2 of 10), so the method rule did not apply to load balancer HEADs; `edge_logs` names the replica for those and logs them only under `-all`, as it does every load balancer request | RR04d, RR04l |
| Read-your-writes through `-all` (POST, then GET at once) | 0 misses (row not visible) of 108, 25 and 93 replica-served reads (run 1), 0 of 107, 28 and 95 (run 2); POST p50 about 21 to 24 ms against `replay_lag` p50 2.3 to 2.7 ms (max 33.5 and 34.7 ms in RR04e); 0 of 456 replica-served reads in all, from this vantage | RR04e-g |
| Split under 1, 8 and 32 concurrent readers | replica share 46.5, 49.9, 50.4 % (run 1); 48.2, 51.1, 49.8 % (run 2); 0 errors | RR04h |
| Split with four busy loops on one node | replica share 48.7 and 49.7 % with the replica loaded, 50.3 and 50.8 % with the primary loaded; the loops barely slowed REST reads | RR04i |
| Split while the replica's replay is stopped | `-all` sent 46 of 102 (run 1, one stop; 46 stale) and 180 of 343 (run 2, three stops; 160 stale) reads in the stale window to the replica; largest heartbeat age (`stale_ms`) served 29,613 and 30,669 ms | RR04j |
| Project restart | while only the primary was failing, `-all` served 14 and 13 reads from the replica and failed 12 and 9 (none moved wholesale); edge_logs show 521/522 to both nodes | RR04k |

## Measured (2026-10-28, RR06, two projects, two runs, Singapore workstation, primary and replica both in ap-southeast-1, custom domain active)

Full record: `RUNLOG.md`; artifacts `out/2026-10-28/`. supabase-js 2.118.0.

| finding | value | module |
|---|---|---|
| Reads through the custom host | 200 of 200 anon GETs served by the primary in each run, while the interleaved load balancer GETs split 105/95 (run 1) and 102/98 (run 2) replica/primary; 50 of 50 user-token reads by the primary in each run | RR06e |
| Token from `signInWithPassword` on the custom host | ES256, `iss` the project host; with an `accessToken` client 10 of 10 reads correct on each of the custom, load balancer, replica and primary hosts (user's 3 rows, `auth.uid()` the user's, 0 foreign), both runs; load balancer replica 6 (run 1) and 2 (run 2) of 10 | RR06d |
| Auth client on the custom host, data client on `<ref>-all` with `accessToken` reading the Auth client's session | 70 of 70 reads correct in each run (140 of 140 over two runs) across a `refreshSession` (replica 26 and 37 of 70); in each run 5 POST `rpc` writes on the primary, an insert 201, 6 rows written; `dataClient.auth.getSession()` throws | RR06f |
| Worker splitting GET/HEAD `/rest/v1/*` to `<ref>-all`, the rest to the custom host, on `*.workers.dev` (run 2 only) | sign-in and refresh through it ok; 120 of 120 table reads correct, replica 53 of 120; `get: true` rpc replica 10 of 20; POST rpc primary 5 of 5. Run 1 on a Workers Custom Domain in the lab zone never resolved on the workstation (DNS, no request reached it) | RR06g |

Not measured in RR06: an OAuth or SAML round trip through the Worker, browser
CORS through it (all measured in RR07, below); other regions; load beyond one
request at a time.

## Measured (2026-10-28, RR07, three projects, runs 0 to 2, Singapore workstation, RR06's shape, Worker on a Workers Custom Domain in the same zone)

Full record: `RUNLOG.md`; artifacts `out/2026-10-28/`. supabase-js 2.118.0,
wrangler 4.147.0, Playwright 1.63.0. Run 0 stopped at RR07d (the module's own
DNS wait, see RUNLOG); runs 1 and 2 passed 12 of 12.

| finding | value | module |
|---|---|---|
| Worker on a Workers Custom Domain, seconds after `wrangler deploy` exited | A record on the zone's nameservers and on 1.1.1.1 at 3 s (run 1) and 5 s (run 2); `rr_whoami` answered through it at 3 s and 6 s | RR07d |
| Worker hop latency, 50 anon GETs each way, interleaved | p50 34.9 ms through the Worker against 33.3 ms to `-all` (run 1), 55.8 against 35.5 ms (run 2): the hop added 1.6 and 20.3 ms at p50 | RR07e |
| CORS through the Worker, `Origin: https://app.example.test`, GET `/rest/v1`, POST `rpc`, POST `/auth/v1/token` | preflight 200 `Allow-Origin: *`, actual 200 with the origin reflected (`Allow-Credentials: true` on `/auth/v1/token` only); 9 of 9 header comparisons per run identical to the custom host and `-all`, both runs | RR07f |
| Cross-origin fetch in headless Chromium through the Worker and the custom host | sign-in, RLS read (5 rows), POST `rpc` all 200, 0 console errors, both runs | RR07g |
| OAuth PKCE entered at the Worker, custom and project hosts | `redirect_uri` `<custom-host>/auth/v1/callback` from every entry; code exchange ok at each entry host, through the Worker included, both runs | RR07h-k |
| OAuth session through the Worker | 30 of 30 reads correct per run (replica 15 and 12 of 30), POST `rpc` primary 3 of 3, refresh ok | RR07l |
| SAML through the Worker | available on the Pro org (enable 200, provider 201); SP entity ID and ACS on the custom host whichever host served the metadata; ACS POST through the Worker and to the custom host both gave a code, exchange through the Worker ok, 10 of 10 reads correct, both runs | RR07m |
## Measured (2026-10-28, RR08, two projects, two runs, Singapore workstation, primary and replica both in ap-southeast-1)

Full record: `RUNLOG.md`; artifacts `out/2026-10-28/run-2026-10-28T08-24-49-796Z.json` and `run-2026-10-28T08-26-05-821Z.json`. Readers: 4 on the replica host and 4 on `-all`, each read 1 to 7 s, role `authenticated` (8 s `statement_timeout`); the primary updated about 2,000 rows a second with `VACUUM` every 30 s. Cells read run 1; run 2.

| finding | value | module |
|---|---|---|
| `PUT config/database/postgres` for `max_standby_streaming_delay` and `hot_standby_feedback` | HTTP 200 in 6 of 6 changes; `pg_settings` on both nodes showed the value at the first read, 10 s after; no restart of either node | RR08g, RR08i, RR08k |
| Defaults (30 s, feedback off) | 0 reads failed at the client, but `confl_snapshot` 436; 288 on the replica; reads up to 11,547; 13,021 ms (planned at most 6,999); heartbeat age p95 25,557; 23,641 ms, max 29,025; 28,874 | RR08e |
| `max_standby_streaming_delay` 5s | heartbeat age max 5,528; 5,259 ms; `confl_snapshot` 1,404; 863; reads up to 19,358; 18,899 ms on the replica host; 3 reads in two runs past the client's 30 s timeout | RR08h |
| `max_standby_streaming_delay` 120s | `confl_snapshot` 316; 131, read overrun p95 113 to 186 ms; heartbeat age max 90,903; 63,246 ms, replay stops of up to 122.8; 120 s | RR08j |
| `hot_standby_feedback` on | `confl_snapshot` 0; 0, reads up to 7,019; 7,044 ms, data at most 250; 236 ms old; cost on the primary: VACUUM could not remove up to 26,500; 26,000 dead tuples a pass (13,000; 13,000 at defaults), cutoff up to 106; 106 XIDs old (52; 52) | RR08l |
| Feedback on plus one 120 s replica transaction | not removable 30,000, 90,000, 150,000, 210,000 over four passes, then 24,000; 30,000 after it committed; heap +10.6; +9.6 MB in 165 s | RR08m |
| Brief ACCESS EXCLUSIVE lock, feedback off and on | replay stopped behind it in both settings (largest age 5,270; 10,567 ms off, 6,292; 6,736 ms on); `confl_lock` 0 and 0 reads failed in both, as every read ended inside the 30 s delay | RR08f, RR08n |
| Steady lag at 4 inserts a second | `replay_lag` p95 3.7; 2.1 ms, max 4.7; 5.9 ms | RR08d |

Inference, not measured: the conflicts in RR08e, RR08h and RR08j did not reach the client because PostgREST retried each cancelled transaction (documented for PostgREST before v16, https://github.com/PostgREST/postgrest/issues/3673); the version on these projects was not recorded. Not measured: a lock with a 5 s delay, autovacuum on its own schedule, other sizes or regions.


Not measured (RR01 to RR04): other region pairs, write rates above 50 inserts/s,
behaviour with `hot_standby_feedback` on (RR08 measured it on 2026-10-28), the load balancer's rule, a
replica that is down while the primary is untouched (the Management API has
no per-replica restart as of 2026-10-23), recovery of the load balancer
endpoint after the last replica is removed beyond 1,200 s, read-your-writes
for a client much closer to the database than this vantage, a node slowed
at the REST layer, Auth-issued HS256 or third-party user tokens.
