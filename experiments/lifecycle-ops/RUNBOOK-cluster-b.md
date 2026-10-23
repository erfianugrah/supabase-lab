# Runbook: cluster B, detect then self-restart

For a project whose reads have stopped working while the Management API still
reports it `ACTIVE_HEALTHY`, and for which a restart is the known remedy. The
code is `lib/runbook.ts` (unit tests in `lib/runbook.test.ts`); the drill that
ran it end to end is LO06 (`tests/lo06-self-restart-drill.ts`, RUNLOG
2026-10-23). Every threshold below is a design choice unless a module id
follows it.

## What cluster B is

Two status-page incidents where the platform told affected users to restart
their project:

- "Unresponsive Projects", 2026-09-10 to 2026-09-12: Nano projects "becoming
  unresponsive after a period of time, typically hours"; after the fix,
  "Users still affected by project outages are encouraged to restart their
  projects which has shown to resolve lasting errors."
  https://status.supabase.com/incidents/4mkcsnlf6p5x
- "401 errors due to JWT rejections", 2026-08-14 to 2026-09-30: refreshed JWTs
  rejected with HTTP 401; "some customers have reported that restarting their
  project after the rollout resolved this issue."
  https://status.supabase.com/incidents/6q5902p2xd9f

In both, a client sees failing reads and nothing in the project status says
so. Neither cause can be induced from a client; the drill uses a held table
lock as a stand-in with the same client-side shape (reads fail, sockets and
status healthy, a restart clears it).

## 1. Detect

- Probe the data, not the tier: a read of one known row through the Data API
  with the key your clients use (`rest_read`: up only on HTTP 200 with the
  row). An anon `GET /rest/v1/` is answered by the API gateway with 401 before
  PostgREST or the database is reached, so it stays up through a restart
  (LO05, 2026-10-23: 0 of 5 failed while row reads failed 5 of 5). For the JWT
  case, read with a freshly issued user token as well as the anon key.
- Sample every 2 s with a 5 s timeout per read.
- Detected when a trigger probe has failed on every sample for 60 s and on at
  least 10 consecutive samples. One success resets the count.
- Run direct (5432) and pooler (6543) `select 1` beside it as context only;
  they do not trigger. In LO06 drill 3 they answered on every sample while
  reads failed (`rest_read` 21 failed samples, direct and pooler 0), so a
  socket check alone would not have fired.
- The control-plane status is an input to the decision, never the signal.

## 2. Decide (guard rails, first match wins)

| rule | action |
|---|---|
| 2 restarts already in the last 60 min | escalate to a human, no POST |
| project status is not `ACTIVE_HEALTHY` (RESTARTING, RESIZING, UPGRADING, COMING_UP, unreadable) | hold: an operation is in flight or the platform already reports it |
| last restart less than 15 min ago | hold (cooldown) |
| project less than 10 min past creation | hold: the API answered 400 'only allowed ten minutes after the creation process has completed' about 70 s after one create, but accepted restarts 300 s and 489 s after the first `ACTIVE_HEALTHY` read on others (LO05f, boundary unresolved); the 10 min hold follows the error text |
| status page unreadable | hold (fail closed; configurable) |
| status page gate (LO01, `lib/gate.ts`) blocks a restart | hold |
| otherwise | restart |

Why each one:

- The API does not refuse a duplicate: a second `POST /restart` sent while the
  first reads `RESTARTING` answered 200 (LO05c). The caller has to.
- The status reads `ACTIVE_HEALTHY` again before reads recover: ahead in each
  of 5 restarts in LO05 (2026-10-23), and in the 2 LO06 restarts the status
  was read `ACTIVE_HEALTHY` at 34 and 46 s (status polled every 10 s) while
  reads recovered at 58 and 60 s, so the status led by at least 24 and 14 s.
  A detector still running after a restart sees "healthy status, failing reads" again;
  the 15 min cooldown, longer than the 10 min verify budget, is what stops a
  restart loop.
- The plain LO01 gate refuses a restart during both cluster B incidents: the
  first is titled "Unresponsive Projects", which matches the gate's restart
  wording and names no region; the second matches on "restart" in its update
  text. The runbook's `gateView` moves an open incident whose text advises a
  restart from blockers to warnings (unit tests with the incidents' wording),
  and a text matching "do not restart" (one synthetic fixture) still blocks.

## 3. Act

`POST /v1/projects/{ref}/restart` once. A non-2xx answer ends the episode
with the body recorded; do not retry it in a loop.

## 4. Verify

- Recovered when every probe (trigger and context) answers on every sample for
  10 s. Report the first sample of that run.
- Do not stop at `ACTIVE_HEALTHY`; record when it came back, beside the data
  path.
- No recovery within 600 s of the POST (about three times the longest
  `rest_read` window in LO05, 181 s): escalate.

## 5. Record

Per episode: first failed sample, detection, every distinct decision with its
reason, POST time and status, status transitions after the POST, recovery
time, failure texts per probe. `supervise()` returns all of these as an
`Episode`.

## Drill result (LO06, 2026-10-23, one Micro project, `ap-southeast-1`)

Artifact `out/2026-10-23/run-2026-10-23T08-45-26-339Z.json`; full table in
RUNLOG, "2026-10-23 - LO06".

| | drill 1 | drill 2 | drill 3 |
| --- | --- | --- | --- |
| detected after the lock was held | 64 s | 64 s | 65 s |
| decision | restart | hold (cooldown) 760 s, then restart | escalate, no POST |
| status `ACTIVE_HEALTHY` after the POST | 34 s | 46 s | - |
| reads recovered after the POST | 58 s | 60 s | - |
| detection to recovered | 59 s | 820 s | - |

A 649 s watch of the healthy project before the drills had 0 failed samples
and no detection (n=1).
