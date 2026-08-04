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

One Micro project for about twenty minutes; `make destroy`. Both operations are
self-restoring, so nothing needs cleaning up beyond the project itself.

Not run here, and each needs its own justification: resize up/down (billable,
and the compute change persists between the two), major upgrade, PITR restore,
and read-replica add/remove.
