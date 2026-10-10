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

The node that served a request is read from `public.rr_whoami()`
(`pg_is_in_recovery()`, postmaster start time) called as a GET, not inferred
from latency.

## Run

```bash
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make run
make leftovers        # nothing named rr-* should print
make facts RUN=evidence/<ts>/run-<stamp>.json
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

Not measured: other region pairs, load, Auth/Storage/Realtime through the load
balancer, behaviour with `hot_standby_feedback` on, the load balancer's rule.
