# RUNLOG - residency-facts

One Micro project in eu-central-2 (Zurich), created via tofu on the Team org.
Zurich on purpose: the claims under test were made about a hard Swiss
residency requirement, and eu-central-2 being individually selectable is
itself one of the claims.

What this experiment is for: the data-residency doc's measured claims were
taken ad hoc on 2026-08-10 and lived only in a session transcript
("re-run any of them cheaply" with no checked-in way to do so). Each module
here is one of those claims, or one of the doc-reading claims that turned out
to be measurable after all, made re-runnable and diffable.

## Runs

### 2026-08-20 - full suite, 6 pass / 1 fail / 2 info

**R01 - the region catalogue endpoint EXISTS, and F04's negative is falsified.**
`GET /v1/projects/available-regions` answers 200, but only with
`?organization_slug=` - a bare call is a 400 ("organization_slug: Invalid
input"), which is how the first run of this module briefly "confirmed" F04.
The shape is `{ recommendations: {...}, all: { smartGroup[], specific[] } }`,
not the flat shape the doc implied. 17 specific regions + 3 smart groups
(americas, emea, apac); eu-central-2 (Zurich) present. The `recommendations`
block is the platform's capacity pick (americas/us-west-2 from a Singapore
vantage) - smart-group behavior made visible. platform-facts F04's RUNLOG
conclusion ("the set of creatable regions is documentation-only") is wrong
and needs correcting.

**R02 - smart group code rejected in the `region` field, exactly as claimed.**
`POST /v1/projects` with `"region": "emea"` -> 400
`{"message":"region: Need to use one of available regions."}`

**R03 - Cloudflare edge, caller-nearest PoP.** REST and Storage on the Zurich
project both answer `server: cloudflare` with PoP SIN from a Singapore
vantage.

**R04 - function execution is user-nearest by default, pinnable.**
`x-sb-edge-region: ap-southeast-1` unpinned, `eu-central-2` with the
`x-region` header - the doc's eu-central-1 measurement reproduces on Zurich.

**R05 - the storage cache matrix, and the doc-reading of fundamentals.md did
not survive contact.**

- Signed URLs: per-token keying CONFIRMED (repeat of one URL HITs, fresh
  token MISSes). One trap: the token embeds the expiry, so two sign calls in
  the same second with the same expiresIn return the SAME URL - vary
  expiresIn, not the wall clock.
- Private buckets: the documented per-user miss did NOT reproduce. user1
  MISS then HIT; user2's FIRST read was a HIT. The cache key is the object,
  not the user.
- **R05c, the fail that matters: a cached private object is served after the
  policy is tightened.** With a permissive policy, user1 and user2 read the
  object (populating the cache). Policy then restricted to user1 only. user3
  (never read it) gets 400/DYNAMIC - auth IS checked on a miss. user2
  (previously authorized) gets 200/HIT - on a hit, the CDN serves the bytes
  without re-evaluating the policy. Reproduced three consecutive runs. The
  object response carried `Cache-Control: no-cache` and was cached anyway.
  Exposure window is the cache TTL/eviction at each PoP, which this test did
  not bound - stated, not fudged.
- Doc consequence: "private buckets blunt the CDN leak" is wrong in both
  directions. Per-user isolation does not produce per-user misses, and policy
  revocation does not evict. For hard-residency objects the answer is not
  private buckets, it is keeping the objects off Storage (or accepting that
  any authorized reader's PoP holds a copy until eviction).

**R06 - realtime.messages IS daily-partitioned, but lazily.** On a fresh
project the table exists with ZERO partitions attached, and a SQL
`realtime.send()` warns `no partition of relation "messages" found for row`
and drops the message. Partitions are created by the Realtime service, not by
the SQL path: after one websocket client subscribes, five daily partitions
appear (2026_08_18 .. 2026_08_22 - pre-created +/-2 days around today), all
under `supabase_realtime_messages_publication`. The documented 3-day
retention is NOT observable on a minutes-old project - stated. Presence
fan-out ("sent to all connected Realtime nodes") is not observable from a
single vantage at all - stated, not probed.

**R07 - log drains have no published-API surface.** F05's enumeration method
across the whole published OpenAPI document: zero drain-configuration
operations (the only hits are analytics read endpoints). Drain configuration
is dashboard-only as far as the stable contract is concerned. The public
log-drains page states custom-endpoint requests are unsigned, so unsignedness
needed no test; whether delivery actually lands end-to-end is dashboard-gated
and untested here - stated, not probed.

## Not measured, and why

- The 3-day partition retention (needs a 4-day-old project).
- Presence fan-out geography (needs multi-vantage websocket clients).
- Log drain e2e delivery (dashboard-gated configuration; no API surface per R07).
- Cache eviction TTL for private objects (needs a wait longer than a run).

## Cost / teardown

One Micro project on the Team org, minutes. `make destroy`. The R04 function
and R05 buckets/users are torn down with the project; R05 also cleans up
in-run. Re-provisioning per run is deliberate (F02's reasoning: a long-lived
project stops answering "what does a NEW project look like").
