# platform-downtime - run log

What a platform operation costs a client, per connection path. The number that
matters is not one duration but the SHAPE: the paths do not move together, and
the failure mode decides how a real client behaves.

Every window below was sampled at **500 ms**, and no number here is readable
without that. All of it is **n=1** - one run per operation, on one Micro project
in `ap-southeast-1`, from a single vantage. These are observations, not a
distribution.

## 2026-08-04 - D01 restart, D02 restriction flip

Project: Micro, `ap-southeast-1`, created and destroyed the same session.

### D01 - restart

| path | bit after | outage | mode |
| --- | --- | --- | --- |
| rest | - | **never failed** | - |
| realtime | - | **never failed** | - |
| auth | 2 s | 75 s | `HTTP 521` |
| storage | 2 s | 78 s | `HTTP 500` |
| pooler | 2 s | **158 s** | `Failed to connect to database: {:error, :timeout}` |

**REST and Realtime served continuously through a full project restart**, at
500 ms resolution. That is the result worth carrying: an application whose read
path is PostgREST may not notice a restart at all, while one that signs users in
during the same window fails for over a minute.

**The pooler is down roughly twice as long as the HTTP tier** - 158 s against
75-78 s. Its error is the interesting part: Supavisor answers and reports the
BACKEND unreachable rather than refusing the connection itself, so the pooler
process is alive the whole time and the wait is for Postgres behind it.

Auth and Storage fail differently from each other - 521 against 500. A client
retrying on 5xx treats them the same; a client matching on a specific status
does not.

This refines T14 (privatelink-aws), which measured a restart on ONE path at
5 s resolution and recorded `timeout expired`. Same operation, more paths,
better resolution: the single number was never representative, and the mode
differs by path.

### D02 - network restriction flip

| path | bit after | outage | mode |
| --- | --- | --- | --- |
| rest, auth, storage, realtime | - | **never failed** | - |
| pooler | 1 s | see caveat | `(EADDRNOTALLOWED) address not in tenant allow_list` |

**A network restriction is a database-socket control and the HTTP tier does not
notice it.** Four HTTP paths, zero failed samples, twice. Locking the database
to a CIDR that excludes you does NOT lock down REST, Auth, Storage or Realtime -
they keep serving, because they reach Postgres from inside.

It reaches the POOLER, which is the part worth knowing: Supavisor enforces the
database allow-list against the CLIENT address, so `6543` is covered by the
restriction and not only direct `5432`. The refusal names the rejected address,
so the failure is self-diagnosing - unlike a restart, where the pooler reports a
timeout and tells you nothing about why.

It bites **1 s** after the API returns 201.

**Caveat on the outage duration: it is an artifact, not a measurement.** The
module holds the restriction for a fixed 60 s dwell before restoring, so the
62 s window is the dwell plus about two seconds of recovery. The real platform
facts here are the 1 s to bite and the ~2 s to recover; the middle is a
parameter this test chose.

### D03 / D04 - compute resize, up then down

`PATCH /v1/projects/{ref}/billing/addons` with
`{addon_variant: "ci_small"|"ci_micro", addon_type: "compute_instance"}`. There
is no resize endpoint; compute size is an addon mutation. Worth stating because
a previous investigation on a related question concluded a size could not be
changed programmatically after searching only for resize-shaped and
branch-shaped paths. Returning to micro REMOVES the addon rather than setting
one - micro is the absence of a compute addon, and the GET afterwards reports
`null`.

| path | D03 up, bit after / outage | D04 down, bit after / outage |
| --- | --- | --- |
| rest | - / **never failed** | - / **never failed** |
| realtime | - / **never failed** | - / **never failed** |
| auth | 2 s / 131 s | 2 s / 99 s |
| storage | 2 s / 127 s | 2 s / 100 s |
| pooler | 3 s / 207 s | 3 s / 196 s |

**The asymmetry hypothesis is half right.** On the HTTP tier, growing costs
about a third more than shrinking (131 s against 99 s for Auth). On the pooler
the two are within 5 % of each other (207 s against 196 s), so whatever
dominates the pooler's window is something neither direction escapes.

**A resize is not a restart with extra steps - it is roughly twice one.** Auth
75 s on restart against 131 s resizing up; the pooler 158 s against 207 s.
Anyone planning a maintenance window off the restart number will under-budget.

## The full matrix

Four operations, five paths, 500 ms resolution, n=1 each.

| operation | rest | realtime | auth | storage | pooler |
| --- | --- | --- | --- | --- | --- |
| restart | - | - | 75 s | 78 s | 158 s |
| restriction flip | - | - | - | - | bites in 1 s |
| resize up | - | - | 131 s | 127 s | 207 s |
| resize down | - | - | 99 s | 100 s | 196 s |

**REST and Realtime never failed under any of the four.** One operation could
be luck; four is a pattern worth relying on, at this resolution and from this
vantage.

**The pooler reports a different error for every operation**, which makes the
mode diagnostic of what is happening rather than merely that something is:

| operation | pooler mode |
| --- | --- |
| restart | `Failed to connect to database: {:error, :timeout}` |
| restriction flip | `(EADDRNOTALLOWED) address not in tenant allow_list` |
| resize up | `Failed to connect to database: {:error, :econnrefused}` |
| resize down | `terminating connection due to administrator command` |

Only the last is a Postgres message; the rest are Supavisor's. So the pooler is
alive throughout all four, and what changes is how the backend is unavailable -
unreachable, refused, deliberately shut down, or the client not permitted.

Auth and Storage keep their own modes across every operation: `HTTP 521` and
`HTTP 500` respectively. A client retrying on any 5xx treats them alike; one
matching a specific status does not.

## Defects found by running it

**The first D02 restored in a `finally`, after sampling had stopped.** Recovery
could therefore never be observed: the run burned the full window and reported
"never recovered" every time. It proved a restriction bites and could not
measure anything else. The restore moved inside the sampled operation, with the
`finally` kept as an idempotent safety net.

**`first_fail_s` was missing from the report.** With the original D02 the only
column was the window, which was `n/a` - so a run that had genuinely measured
"the restriction bites almost immediately" reported nothing at all. Time to bite
and time to recover are different facts and the first survives a run that ends
early.

**The Realtime probe had an unreachable branch.** It treated a non-5xx upgrade
as healthy via ws's `unexpected-response` event, which **Bun does not
implement** - it prints a warning saying so. Verified against the live project:
an upgrade with no apikey returns 401 to curl, while ws reports
`failed: Expected 101 status code` with no status attached. So a Realtime 4xx
reads as DOWN here. Survivable rather than correct - the probe sends a valid
key, and a bad key would fail from sample zero and trip the healthy-at-start
guard rather than publishing a fake outage. The branch was removed and the
limitation written next to the probe.

## Cost / teardown

Two Micro projects, roughly twenty minutes each, both destroyed. D03/D04 ran on
the second one and put the compute size back themselves, so the only cleanup is
the project. Restrictions were confirmed restored to `0.0.0.0/0` before the
first teardown rather than assumed.

Not run here, and each needs its own justification: major upgrade, PITR
restore, and read-replica add/remove.
