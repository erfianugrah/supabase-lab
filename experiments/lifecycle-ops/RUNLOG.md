# lifecycle-ops - run log

What a client can know before changing a project, and what it sees when it does.
Every project below was a throwaway `lo-*` project in one Pro
organization, region `ap-southeast-1`, created with `desired_instance_size:
micro` (the requested size; the compute size was not read back), and deleted in
the same session. Vantage for everything: one macOS orchestrator with working
IPv6, run from source under bun (version in each artifact's `toolVersions`).
Counts are small: n=1 for LO01, n=3 for LO03, n=1 for LO04 and n=5 for LO05.
These are observations, not distributions.

Creates on 2026-10-10: 6 (one failed first draft of the restart module, three
in LO03, one in LO04, one in LO05). All deleted; `GET /v1/projects` showed no
project with the `lo-` prefix at 01:06 UTC.

Published artifacts (redacted, a `.facts.md` beside each, `out/2026-10-10/`;
the raw copies were recovered from a session scratchpad on 2026-10-13 and sit
in the gitignored `evidence/recovered/`): LO01
`run-2026-10-10T00-43-34-355Z.json`; the failed first draft of the restart
module, run under the id LO02, `run-2026-10-10T00-35-35-776Z.json`; LO03
`run-2026-10-10T00-36-15-870Z.json`; LO04 with LO05
`run-2026-10-10T00-43-31-013Z.json`; LO05 `run-2026-10-10T00-46-09-369Z.json`.

Sources for the docs' claims, kept separate from the measurements below:

- Status page: https://status.supabase.com/ (JSON under `/api/v2/`).
- Restart endpoint and create body: the published OpenAPI document
  (`POST /v1/projects/{ref}/restart`, `POST /v1/projects`), read 2026-10-10.
- Prior restart numbers: `platform-downtime/RUNLOG.md`, D01, 2026-08-04, n=1.
- `edge-resilience/FAILURE-MATRIX.md` row 10.1 ("capacity blocks create,
  resize, restart") was `[doc]` only before this run.

## 2026-10-10 - LO01 status page shape and change-gate replay (n=1 fetch)

Read-only, no credential. Fetched `components.json`, `incidents.json` and
`summary.json` at 00:43 UTC (an earlier fetch at 00:33 UTC saw the same shapes).

Measured:

| what | value |
|---|---|
| components in `components.json` | 189 |
| region names present | 18, each occurring 10 or 11 times |
| non-region components | 5 (Auth, Billing & Payments, Dashboard, Logging & Observability, Realtime), each once |
| component keys | `created_at id name page_id position status updated_at`: no group, service or parent field |
| component status values | `operational` on all 189 |
| incidents in `incidents.json` | 25, oldest created 2026-08-24, 0 open |
| incident keys | `created_at id impact incident_updates name page_id resolved_at status updated_at`: no component or region field |
| `/api/v2/incidents/unresolved.json` | HTTP 404 |
| `/api/v2/scheduled-maintenances/active.json` and `upcoming.json` | HTTP 404 each |
| `summary.json` | 1 component (not 189); 1 scheduled maintenance, "Scheduled Platform Maintenance 07/02", status `scheduled`, created 2026-06-29, still `scheduled` on 2026-10-10 |
| fetch of both files in parallel | 0.3 s and 0.4 s in the two runs |

What that means for a gate (reasoned from the shapes, then built in
`lib/gate.ts` and unit tested with fixtures, 12 tests):

- A lookup of "the component named ap-southeast-1" returns one of 11 components
  with no field saying which service it is. The gate takes the worst status
  across every component with the region's name. Whether the 11 components map
  to services, and whether any of them flips during a regional incident, was
  not measured: all 189 read `operational` at fetch time, so component status
  as a signal has no positive case in this run.
- Incidents name their region only in text. The gate reads the title first
  (a region code, or a prose name such as "Ireland" or "N. Virginia" from an
  alias table) and treats a region found only in an update body as a warning
  unless the text also has lifecycle wording (create, provision, lifecycle,
  management api, project operation, restart, upgrade, resize and similar).
  The reason: in the feed, one incident title carried no region while its
  update bodies listed that region among a dozen others in a PostgREST rollout
  message about data API latency, not lifecycle operations. The first version
  of the gate counted that incident as 94.6 hours of refused restarts for
  `ap-southeast-1`; the title-first rule removed it.
- `impact` is not a reliable guide to lifecycle damage. Replayed for `upgrade`,
  the gate would have refused 11 of the 25 incidents, 3 of them published with
  impact `none`, including "Upgrade Issues", whose update text says the ability
  to upgrade projects was suspended. Replayed for `restart` it refuses 10, 2 of
  them with impact `none` (a creation incident naming "multiple regions", and a
  query-slowness incident naming two regions in its title). The gate ignores
  `impact`.
- The one scheduled maintenance in `summary.json` is 100 days old and still
  `scheduled`. A gate that blocked on any scheduled maintenance would block on
  that entry for as long as it stays, so the gate does not read maintenance
  windows. This is a choice; the semantics of the maintenance feed were not
  measured.

Gate decision at 00:43 UTC: all 18 regions proceed for each of create, restart,
resize and upgrade. One observation.

Replay of the 25-incident feed through the gate for `restart` (the feed spans
1113 hours; component status is not historical, so the replay uses incident
text only; the text classification is a heuristic, not ground truth):

| scope read from the incident | incidents |
|---|---|
| region in the title | 6 |
| region only in an update body | 2 |
| "all/multiple regions" in the title | 3 |
| no region anywhere | 14 |

Hours the gate would have refused a restart (union of incident intervals over
the 1113 hour window):

| region | refused hours |
|---|---|
| `ap-southeast-1` | 38.5 |
| `eu-west-1` | 41.8 |
| `us-east-1` | 205.1 |
| minimum over the 18 regions | 38.5 |

`ap-southeast-1` is refused only for unscoped lifecycle incidents and "all
regions" incidents. The `us-east-1` figure is one incident titled "Intermittent
latency in Eastern US" that stayed open for about 7 days; whether a restart in
that region was unsafe for those 7 days is not known, only that the gate's rule
would have said no. Two incidents have `resolved_at` earlier than `created_at`
and were excluded from the intervals.

Not measured: component status behaviour during an incident, a maintenance
window's effect, how late the feed is relative to an incident's real start,
and any behaviour of regions the feed did not name.

## 2026-10-10 - LO03 create through a region-fallback wrapper (n=3 creates)

`createWithFallback` walks a region list and stops at the first 2xx with a ref.
Create 1 used [`zz-nowhere-1`, `ap-southeast-1`], creates 2 and 3 used
[`ap-southeast-1`]. The gate said proceed before each. Each project was deleted
before the next create.

Requests that must fail (client-side invalid, so these are the bodies a wrapper
has to classify, not a capacity failure):

| request | HTTP | body | ms |
|---|---|---|---|
| unknown region code | 400 | `region_selection.code: Need to use one of available regions.` | 194 |
| unknown org slug | 404 | `Not Found` | 80 |
| missing `name` | 400 | `name: Invalid input: expected string, received undefined` | 93 |
| unknown instance size | 400 | `desired_instance_size: Need to use one of available instance sizes.` | 55 |

After the four, the org listing held no project with this run's name tag.

The three creates:

| create | attempts | landed | create call, ms | transitions (10 s poll from before the POST) | seconds to `ACTIVE_HEALTHY` |
|---|---|---|---|---|---|
| 1 | 400, then 201 | `ap-southeast-1` | 2358 | `COMING_UP` at 3 s, `ACTIVE_HEALTHY` at 145 s | 145 |
| 2 | 201 | `ap-southeast-1` | 1499 | first poll already `ACTIVE_HEALTHY` | 2 |
| 3 | 201 | `ap-southeast-1` | 1656 | first poll already `ACTIVE_HEALTHY` | 2 |

Read: the wrapper fell through a real 400 (under 0.1 s) and landed on the
second region. Seconds to `ACTIVE_HEALTHY` was 145 once and 2 twice. n=3 does
not say how often a create comes up instantly; it says both happen. The poll
resolution is 10 s, so 2 means the first read. A project that reads healthy at
the first poll was usable in the one case checked (LO05a: the REST, Auth,
Storage and pooler paths answered, and the direct path 5 s after the first
poll). DELETE returned 200 each time and the ref was absent from the org
listing at the first read each time.

Not measured: a provisioning or capacity failure on the platform's side (cannot
be induced from a client), whether a failed create is ever billed (the org
listing was checked, billing was not), any region other than `ap-southeast-1`.

## 2026-10-10 - LO04 identical POST re-sent (n=1)

The first `POST /v1/projects` was sent with the caller's wait capped at 1 s. It
timed out client-side (`TimeoutError`), so the response, and with it the ref,
was never received. The org listing afterwards held 1 project carrying the
name: the abandoned request had created it.

The identical request (same name, same body bytes) re-sent 1 s later returned
HTTP 400 (0.17 s): `Project with name "<name>" already exists in your
organization.` After a further 60 s there was still exactly 1 project with that
name, 1 distinct ref, `ACTIVE_HEALTHY`.

Read: within one organization, an exact re-send of a create did not make a
second project, because the second request was rejected with 400 on the name.
A client retrying after a lost response gets a 400 and has to read it as
"probably created, look it up by name", not as a failure to retry. A wrapper
that adds a random suffix per attempt would not meet that check; that
consequence is reasoned from the 400, not run. n=1, one name, one organization.
Not measured: whether the match is case-sensitive, whether a name freed by
DELETE is reusable at once, whether two concurrent identical requests both pass
the check, and an `Idempotency-Key` header (it would confound the re-send, and
no documented support was found in the OpenAPI document).

## 2026-10-10 - LO05 restart envelope (n=5, plus two side observations)

One Micro project, restarted 5 times, after the gate said proceed for
`restart` each time. REST, Auth, Storage, pooler (6543) and direct (5432) were
sampled every 0.5 s (plus the probe's own time) by `harness/src/sampler.ts`
(the Realtime path D01 had is not in this module). A window runs from the first
failed sample to the first sample of a 5 s sustained recovery.

Per path, five restarts (n=5):

| path | runs with a failure | window p50 | window max | first failure p50 / max | failure modes seen |
|---|---|---|---|---|---|
| rest | 0 of 5 | - | - | - | none |
| auth | 5 of 5 | 54 s | 60 s | 2 s / 3 s | `HTTP 521`, `The operation timed out.` |
| storage | 5 of 5 | 58 s | 59 s | 2 s / 3 s | `HTTP 500`, `The operation timed out.` |
| pooler | 5 of 5 | 54 s | 151 s | 2 s / 3 s | `Failed to connect to database: {:error, :timeout}`, `terminating connection due to administrator command`, `(EAUTHQUERY) auth_query secret check timed out`, and one more starting `(ECIR` (the artifact cuts the text at 160 characters) |
| direct | 5 of 5 | 50 s | 56 s | 3 s / 3 s | `Connection terminated unexpectedly`, `timeout expired`, `the database system is shutting down`, `connect ECONNREFUSED` (IPv6 address) |

Per run (window seconds, run 1 to 5): auth 32, 31, 54, 59, 60; storage 28, 29,
58, 59, 59; pooler 31, 151, 52, 54, 59; direct 28, 28, 50, 55, 56. Runs 1 and 2
were about 30 s on every path except the pooler's 151 s in run 2; runs 3 to 5
were 50 to 60 s. n=5 in one session cannot say whether that is drift across
back-to-back restarts, a change in platform load, or chance; the five runs were
sequential on one project, each after a readiness check.

Control plane, 10 s poll: the project read `RESTARTING` first at 0 s or 10 s
after the POST and `ACTIVE_HEALTHY` again at 40, 41, 61, 61 and 71 s. The data
paths had failed at 2 to 3 s, so the status field lagged the data plane by up
to the 10 s poll. `POST /restart` answered HTTP 200 every time, in about a
tenth of a second. In run 2 the status read `ACTIVE_HEALTHY` at 41 s while the
pooler window ran to 151 s.

Compared with `platform-downtime` D01 (2026-08-04, n=1, sampled every 0.5 s,
same region and size class): auth 75 s, storage 78 s, pooler 158 s, REST and
Realtime never failed. Here REST never failed in 5 of 5 (Realtime was not
sampled), auth and storage were 54 to 58 s at p50, and the pooler was 54 s at
p50 with one 151 s run. The earlier 158 s pooler figure is near this run's
single 151 s, not near its other four. Different day, different project; not a
controlled comparison.

> **Correction 2026-10-23 (#204):** "REST never failed in 5 of 5" measured the
> HTTP tier only. The REST probe was platform-downtime's anon `GET /rest/v1/`,
> which the API gateway answers with 401 before PostgREST or the database is
> reached, and any status below 500 counted as up. Re-run on 2026-10-23 with a
> row read beside it (section at the end of this file): the row read failed in
> 5 of 5 restarts, p50 150 s, max 181 s, while the old probe (now `rest_http`)
> failed in 0 of 5.

Readiness (LO05a): the project read `ACTIVE_HEALTHY` on the first poll, 2 s
after the POST (the create call itself took under 2 s), and all five paths
answered 5 s later.

LO05f, restart inside the post-create window. Two observations from two
projects:

- A restart sent about 70 s after the creating POST (to a project handed over
  from LO04; it already read `ACTIVE_HEALTHY` when LO04's 60 s settle ended and
  when LO05 first polled it) was
  refused with HTTP 400: `Project restarts are only allowed ten minutes after
  the creation process has completed. If you are running i` (the artifact kept
  120 characters; the rest of the sentence was not captured and the project was
  deleted before it could be re-read). The 70 s is read off the artifact
  timestamps of the two modules, not timed by the module.
- On the LO05 project, a restart sent 300 s after the first `ACTIVE_HEALTHY`
  read was accepted (HTTP 200, empty body) and restarted the project. The
  message says ten minutes. The acceptance at 300 s means either the stated
  window is not what is enforced, or the clock it measures from ("the creation
  process has completed") is not the first `ACTIVE_HEALTHY` read. The boundary
  between about 70 s and 300 s is not resolved, and the two observations are on
  two different projects. The runs that followed started 696 s after the first
  `ACTIVE_HEALTHY` read and were accepted with no refusals.

LO05c, a second restart while the first is in flight: with the status at
`RESTARTING`, the second `POST /restart` returned HTTP 200, as the first did,
with an empty body. It was not refused and the response did not distinguish
it. Whether it queued a second restart or was absorbed into the first was not
sampled.

Not measured: Realtime and Edge Functions paths, resize and upgrade under the
gate, any restart during a platform incident (none was open), a non-Micro size,
other times of day, and what a client sees when the status page and the
Management API disagree.

## Methods notes (vantage artifacts)

- Direct path, first draft (run as LO02, 2026-10-10): every path answered
  except `direct`, which never did within the 300 s readiness window, so no
  restart was run. Separately, for the AAAA-only `db.<ref>.supabase.co` host of
  another project in the same org (DNS and a TCP open only, no login): `dig`
  returned the AAAA record, `dns.resolve6` returned it, a TCP connect to the
  literal address on 5432 succeeded, and `dns.lookup` (getaddrinfo) failed with
  `ENOTFOUND`. The probe now resolves with `resolve6` and connects to the
  address with the hostname as the TLS server name. The draft's cause is
  inferred from that separate check; the draft did not record its own error
  text.
- The Management API budget was shared with other agents that afternoon; status
  polls were every 10 s and creates were never auto-retried.
- Nothing here reads billing. A failed or abandoned create was checked against
  the org listing only.

## What to do about it

| practice | lever | rests on |
|---|---|---|
| Read the status page per region and take the worst status over every component with that region's name | change pipeline | LO01 (11 components named `ap-southeast-1`) |
| Block on open incidents by title region, "all regions" wording and lifecycle wording; ignore `impact` | change pipeline | LO01 replay; design choice |
| Fail closed when the status page cannot be read | change pipeline | design choice, not measured |
| After a create whose response you may not have seen, list by name before retrying; a 400 "already exists" on an identical re-send means the first one worked | create wrapper | LO04 (n=1) |
| Keep the project name stable across retries of one logical create | create wrapper | LO04 (reasoned from the 400) |
| Treat a 400 from a create with a bad region as non-retryable and move down the region list; 5xx and timeouts are not in this data | create wrapper | LO03 (client-invalid requests only) |
| Budget a restart as an outage on every path, REST reads and Realtime included: about 1 minute on Auth, Storage, pooler and direct on 2026-10-10 with the pooler able to run 2.5 times that; corrected 2026-10-23 (#204), when REST reads (`rest_read`) failed in 5 of 5 restarts, p50 150 s, beside Auth p50 149 s, and the largest window on any path was 182 s. The 2026-10-10 "expect REST to keep answering" came from an HTTP-tier probe | maintenance planning | LO05b (n=5 each, one project per date) |
| Do not read the control-plane status as the end of an outage | health checks | LO05b (status `ACTIVE_HEALTHY` at 41 s, pooler down to 151 s) |
| Do not send a restart to a project minutes old; read the 400 as "wait" | automation | LO05f (two projects, boundary unresolved) |
| Detect a stuck project with a data read (one known row through the Data API), sustained for a set time; do not use socket checks or the project status as the signal | health checks | LO06 drill 3 (2026-10-23: with the lock alone, direct and pooler `select 1` failed 0 samples while `rest_read` failed 21) |
| Verify a self-restart on the data path; the status led reads by at least 24 and 14 s (10 s status poll) | automation | LO06c/d (n=2), LO05 2026-10-23 (n=5) |
| Keep a cooldown longer than the verify budget, and a per-hour cap that escalates instead of restarting | automation | LO06d/e; the API answers 200 to a duplicate restart (LO05c) |
| Let an open incident that advises a restart through the change gate as a warning | change pipeline | `lib/runbook.test.ts` with two incidents' wording; design choice |

## 2026-10-23 - LO05 re-run with data-path probes (#204)

Why: the 2026-10-10 LO05 "REST never failed" came from an HTTP-tier probe
(an anon `GET /rest/v1/` that the API gateway answers with 401 before
PostgREST or the database is reached, any status below 500 counted as up),
and Realtime was not sampled. LO05
now samples, beside the five paths it had, `realtime_ws` (WebSocket handshake),
and the data-path probes `rest_read` (anon row read, only HTTP 200 with the
seeded row counts) and `realtime_join` (Postgres Changes join confirmed and the
probe's own broadcast delivered), from `harness/src/real-probes.ts`. The REST
probe of the earlier run is the one now named `rest_http`.

Run: one Micro project, `ap-southeast-1`, Pro org, 5 sequential restarts at
500 ms sampling, artifact
`out/2026-10-23/run-2026-10-23T02-47-19-611Z.json` (the direct probe's
connect error carried the project's IPv6 address; published as `<addr>`).

| path | runs failed | window p50 | window max | first failure p50 |
| --- | --- | --- | --- | --- |
| rest_http | 0 of 5 | - | - | - |
| realtime_ws | 0 of 5 | - | - | - |
| rest_read | 5 of 5 | 150 s | 181 s | 2 s |
| realtime_join | 5 of 5 | 146 s | 179 s | 2 s |
| auth | 5 of 5 | 149 s | 182 s | 2 s |
| storage | 5 of 5 | 151 s | 178 s | 2 s |
| pooler | 5 of 5 | 147 s | 177 s | 2 s |
| direct | 5 of 5 | 145 s | 178 s | 2 s |

Per run (window seconds, run 1 to 5): rest_read 181, 154, 46, 46, 150;
realtime_join 179, 153, 54, 58, 146; auth 182, 152, 45, 46, 149; pooler 177,
151, 43, 44, 147. Across the six paths that failed, the windows were
within 6 s of each other in runs 1, 2 and 5 and within 15 s in runs 3 and 4.
`rest_read` failed with `HTTP 521`, `timeout`, `HTTP 503 PGRST002` and
`HTTP 525`; `realtime_join` with `pg_changes: {:error, "Too many database
timeouts"}` or a timeout waiting for the subscription. The control-plane status
read `ACTIVE_HEALTHY` again at 172, 142, 41, 41 and 141 s.

Reading: a restart takes REST reads and Realtime subscriptions down for about
as long as Auth, Storage and the database sockets: `rest_read` 46 to 181 s,
all paths 43 to 182 s. The 2026-10-10 LO05 windows (Auth 54 s p50) and these
(149 s p50) differ by more than a factor of two on the same module, region and
size; runs 3 and 4 here (43 to 58 s across all paths) look like the earlier
run's typical window, runs 1, 2 and 5 (145 to 182 s) do not. Not explained.

LO05f: a restart sent 489 s after the first `ACTIVE_HEALTHY` read was accepted
(HTTP 200), inside the ten minutes the earlier refusal message named; the
boundary stays unresolved. LO05c: a second restart sent while the first read
`RESTARTING` answered 200 again.

An earlier attempt the same morning (01:31 UTC project) stalled after its
third restart: no output for over 50 minutes with the project healthy. It was
killed, its project deleted by name, and it wrote no artifact; its console
lines are not cited. The sampler now caps each probe call at 30 s and LO05's
readiness loop uses the same cap. The stall happened before the cap existed,
a deadline may not fix that state, and the cause is not established; this run
did not stall.

## 2026-10-23 - LO06 cluster B drill: detect, self-restart, verify (#150)

Why: the cluster B runbook named in the original lifecycle-ops scope (a
project whose reads fail while the control plane reads it healthy, and for
which a restart is the remedy) was never built. Cluster B is two status-page
incidents whose advice to affected users was to restart the project:
"Unresponsive Projects" (2026-09-10 to 09-12, Nano projects unresponsive after
hours) and "401 errors due to JWT rejections" (2026-08-14 to 09-30). Neither
cause can be induced from a client.

Built: `lib/runbook.ts` (detector, guard rails, a `supervise` loop with every
side effect injected), `lib/runbook.test.ts` (23 tests, the loop under a fake
clock), `RUNBOOK-cluster-b.md` (the prose runbook), and the drill module LO06.
Defaults (design choices): sample every 2 s; detect when `rest_read` has
failed on every sample for 60 s and at least 10 samples; restart only if the
status is `ACTIVE_HEALTHY`, the last restart is 15 min old or more, fewer than
2 restarts in the last 60 min (else escalate), the project is past its first
ten minutes, and the status-page gate allows it; recovered when every probe
answers on every sample for 10 s; escalate if not recovered 600 s after the
POST.

Fault induced (a stand-in, said so in the module): one session over the direct
path took an ACCESS EXCLUSIVE lock on the probe table and ran `pg_sleep`
inside the transaction. Reads of that table wait behind it while the server,
its sockets and the control-plane status stay healthy; a restart ends the
session. For a known lock `pg_terminate_backend` is the cheaper fix.

Run: one Micro project (requested size), `ap-southeast-1`, Pro org, probes
`rest_read` (trigger), direct 5432 and pooler 6543 `select 1` (context),
artifact `out/2026-10-23/run-2026-10-23T08-45-26-339Z.json`. 6 of 6 results
passed. The anon role's `statement_timeout` read `3s`.

| step | drill 1 (LO06c) | drill 2 (LO06d) | drill 3 (LO06e) |
| --- | --- | --- | --- |
| first failed `rest_read` after the lock was held | 3 s | 3 s | 3 s |
| detected after the lock was held | 64 s | 64 s | 65 s |
| decisions | restart | hold (cooldown), then restart | escalate |
| POST after detection | 0 s, HTTP 200 | 760 s, HTTP 200 | no POST |
| status back to `ACTIVE_HEALTHY` after the POST | 34 s | 46 s | - |
| reads recovered after the POST (all three probes, 10 s sustained) | 58 s | 60 s | - |
| detection to recovered | 59 s | 820 s | - |
| lock-holding session ended after the POST | 3 s | 2 s | - |
| holder sessions left after the episode | 0 | 0 | 1, then terminated |

Failed samples during the lock alone (drill 3, no restart): `rest_read` 21,
direct 0, pooler 0, and `rest_read` failed only with `HTTP 500 57014` (the
anon role's 3 s statement timeout). During drills 1 and 2 direct failed 5 and
7 samples and pooler 6 and 6 over the whole episode; the module does not
time-stamp failures, and drill 3 (lock alone: 0 and 0) suggests they fell
around the restart. `rest_read`'s modes over drills 1 and 2 were
`HTTP 500 57014`, `HTTP 525`, `HTTP 521` and `timeout`. In drill 3, `pg_terminate_backend` ended 1 session and all three
probes answered again 4 s later.

Baseline (LO06b): the runbook watched the healthy project for 649 s (325
rounds at 2 s) before the first drill: 0 failed samples on any probe, no
detection. One window, n=1: it bounds nothing about blip rates on other days.

At the gate reads behind the two restart decisions (drills 1 and 2; the hold
and escalate decisions record no gate result) the status page had one open
incident, unscoped and without lifecycle wording ("API Gateway Request Issues", impact minor); the gate let
the restarts through with a warning.

Reading:

- A socket check would not have caught this fault: with the lock alone
  (drill 3) direct and pooler answered on every sample while `rest_read`
  failed 21. Detection has to read data.
- n=2 restarts: the status was read `ACTIVE_HEALTHY` at 34 and 46 s (status
  polled every 10 s), reads recovered at 58 and 60 s after the POST, so the
  status led by at least 24 and 14 s. LO05 (2026-10-23) showed the same order
  in each of its 5 runs: status back 41 to 172 s after the POST, reads back 48
  to 182 s (first failure p50 2 s plus windows of 46 to 181 s). Both LO06
  times sit at the low end; with n=2 this says nothing new about the range.
- Drill 2 shows the cooldown holding a restart for 760 s while reads failed
  and the status read `ACTIVE_HEALTHY`. That is the state a detector sees
  right after its own restart, until reads return; without the cooldown it
  would restart again.
- The plain LO01 gate refuses a restart during both cluster B incidents (their
  status-page wording in `lib/runbook.test.ts`): "Unresponsive Projects" names
  no region and its title matches the gate's restart wording; the JWT incident
  matches on "restart" in its update text. The runbook's `gateView` treats an
  open incident that advises a restart as a warning. That classification is a
  regex checked against two incidents' text and no others.

Runbook steps that did not match reality: none in this run. Detection came
61, 61 and 62 s after the first failed sample: the 60 s time condition set
the detection latency, and the 10-sample condition was met before it.

Not measured: a real cluster B cause (a Nano hang, a PostgREST time cache), a
user-JWT read probe, a restart that fails to clear the fault (the unit tests
cover the `unrecovered` path only), a status page that cannot be read, compute
sizes other than Micro, other regions.
