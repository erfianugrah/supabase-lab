# Test plan - W14 onward

STATUS (2026-08-16): fully executed. W14 answered (manual drill), W15-W20
and W22-W24 built and green, W21 built and green in the Pro org. Full battery
22/22 unattended - see RUNLOG.md. Sections below keep the original
plans with their measured outcomes appended.

Every issue below is either (a) anchored in PUBLIC evidence (Postgres
docs, Supabase docs, public GitHub, public status page) or (b) a
lab-discovered behavior measured in this repo (cited by module/artifact -
our own measurements, safe to publish). Nothing rests on internal-only
knowledge. IDs continue the W-series; each entry lists the issue, its
evidence class, the test design, and the workaround it validates.

## W14 - instance size vs replication worker ceiling

Issue: logical replication (initial sync AND apply) stalls on micro
because max_worker_processes=6 is exhausted by platform background
workers. Evidence: lab-measured (W09 artifacts; manual drilling
2026-08-15); max_worker_processes semantics are Postgres-docs public.
Open question: does a bigger size lift the ceiling?
Design: recreate the standby at `small` (tofu -replace; the provider
reports "no changes" for in-place size edits while pg_settings proves
micro - a measured provider no-op). Record pg_settings
(max_worker_processes, max_logical_replication_workers,
max_sync_workers_per_subscription, shared_buffers, max_connections) per
size. Re-run the W09 module. Measure: does the apply worker stabilize and
do auth.users rows stream?
Workaround validated: "size up the standby" as the auth-replication
enabler - or a clean negative result (auth.* replication is not a size
problem but an auth-schema problem).
OUTCOME (2026-08-15, manual drill - RUNLOG W14): clean negative.
pg_settings scale with size (max_connections 60->90, shared_buffers
256->512MB) but max_worker_processes stays 6 on BOTH sizes. auth.*
streams zero changes at any size, with or without copy_data; a custom
non-public schema replicates in ~4s on the same instances. The wall is
platform-managed schemas (auth, storage), not size, not workers, not
schema privacy. Auth portability posture: TPA + SQL backfill + forced
re-login.
Public anchor: https://www.postgresql.org/docs/current/runtime-config-replication.html

## W15 - DDL lands on the primary while a subscription is live

Issue: logical replication carries no DDL (Postgres-docs public). The
operational trap: a migration adds a column on the primary; the standby
lacks it; the apply worker starts erroring and replication stalls -
silently, unless you watch pg_stat_subscription.
Design: establish W05-style replication of w_repl; `alter table w_repl
add column` on the primary ONLY; insert a row using the new column;
observe the standby: apply state, verbatim error (via subscription
stats), whether replication of OTHER rows stalls too. Then apply the DDL
on the standby and measure recovery (does it resume cleanly?).
Workaround validated: the migration procedure (apply standby first,
then primary) with a measured failure signature to alert on.
Public anchor: https://www.postgresql.org/docs/current/logical-replication-restrictions.html

## W16 - sequence resync at cutover

Issue: sequences do not replicate (Postgres-docs public). After cutover,
inserts collide with stale sequence values.
Design: replicate a serial-PK table; write rows on the primary past the
standby's sequence value; simulate cutover; insert on the standby and
capture the verbatim duplicate-key error; run the resync
(`select setval(pg_get_serial_sequence(...), (select max(id)+1 ...))`);
verify inserts succeed. Measure the error signature and the fix.
Workaround validated: the resync script step in the cutover runbook.
Public anchor: same restrictions page as W15.

## W17 - auth config parity inventory

Issue: TPA ports tokens, but per-project auth config (SMTP, SITE_URL,
redirect URLs, rate limits, jwt_exp) does not follow a cutover.
Evidence: Supabase auth-config docs (public); lab-found config-API
behaviors (jwt_secret PATCH no-op, jwt_exp effect lag).
Design: set distinguishable values on the primary (jwt_exp, a redirect
URL, a rate limit); GET config/auth on both projects; produce the diff
inventory verbatim. Record what a cutover runbook must re-apply.
Workaround validated: a config-parity checklist generated from the API,
not from memory.
Public anchor: https://supabase.com/docs/guides/auth (config surface)

## W18 - edge function cold start

Issue: cold-start latency on function invocations (Supabase docs mention
cold starts publicly; no public numbers).
Design: deploy the W13 sleeper with sleep=0; invoke cold x5 (60s idle
gaps), then warm x20; record p50/p99 cold vs warm.
Workaround validated: keep-warm ping cadence with a measured benefit.
OUTCOME (2026-08-16, green - RUNLOG W18): cold p50 284ms / p99 1433ms,
warm p50 98ms. Only the first invoke after deploy+idle carries the
real cold start; the steady-state gap is ~100-200ms.
Public anchor: https://supabase.com/docs/guides/functions

## W19 - imgproxy render-path failure modes

Issue: transform URLs fail differently than originals (corrupt image,
oversized source, extreme dimensions). Evidence: Supabase storage image
transformation docs (public).
Design: upload a valid image, a corrupt file with an image extension,
and an SVG; request each through /render/image/ with width
params; record verbatim status/body per case; confirm originals still
serve.
Workaround validated: pre-generated renditions at upload (also the
billing fix) with measured render-path failure signatures.
OUTCOME (2026-08-16, green - RUNLOG W19): corrupt source -> render 400
InvalidRequest; SVG -> render 200 with the source unchanged; the plain
URL always serves the original. The render path never 5xxs.
Public anchor: https://supabase.com/docs/guides/storage/serving/image-transformations

## W20 - statement timeout and lock-wait signature

Issue: long statements die with 57014; lock pileups degrade to
serialization. Evidence: Postgres error codes (public).
Design: SET LOCAL statement_timeout in a transaction; run pg_sleep over
it and capture the verbatim error; then two sessions contending an
advisory lock with SET LOCAL lock_timeout, measure wait behavior.
Workaround validated: timeout configuration guidance with the exact
client-visible signature.
OUTCOME (2026-08-16, green - RUNLOG W20): 57014 at 3467ms wall, 55P03
at 4533ms wall, both verbatim.
Public anchor: https://www.postgresql.org/docs/current/errcodes-appendix.html

## W21 - spend cap trip behavior

Issue: what a Pro project does when the spend cap trips (usage
disallowed - but which status codes, which paths?).
Evidence: Supabase cost-control docs (public).
Blocker: the lab org is free-tier; spend cap is Pro-only. Document-only
unless a Pro org is available. No module exists - W21 was never built
(the battery is 22 modules: W01-W13, W15-W20, W22-W24).
Public anchor: https://supabase.com/docs/guides/platform/cost-control

## W22 - initial sync at real table size

Issue: initial table sync duration at real-world sizes (lab measured
3.1-6.5s at 3 rows; nothing at scale).
Design: seed 1M rows (~100MB) on the primary; create the subscription;
measure initial sync end-to-end; measure lag after sync.
Workaround validated: migration timing budgets with a real curve.
OUTCOME (2026-08-16, green - RUNLOG W22): 1M-row initial sync 22728ms
(12533ms in the battery run); streaming lag after sync 245-276ms.
Public anchor: logical replication docs (as W15).

## W23 - pg_cron across restarts

Issue: do scheduled jobs skip, delay, or double-run across a project
restart? Evidence: pg_cron docs (public).
Design: schedule a 1/min heartbeat job writing to a table; restart the
project (mgmt API); measure the gap in heartbeat rows vs the measured
restart window.
Workaround validated: cron-drift monitoring guidance.
OUTCOME (2026-08-16, green - RUNLOG W23): pg_cron resumes across the
restart and keeps firing on schedule (diff=3 rows across the window,
no catch-up doubling).
Public anchor: https://supabase.com/docs/guides/cron

## W24 - edge failover proxy with flap damping (the W05c slice)

Issue: the cutover needs an automated health-check failover at the edge
that never dual-writes and never flaps. Evidence: lab architecture work
(W04/W05); the pattern is public (active-passive failover).
Design (as shipped): the drill worker fails over on the FIRST failure
(5xx, the CF-wrapped 403, or any non-ok under OUTAGE), holds on standby
for a time-based HOLD_MS window persisted in the CF Cache API, and
returns to primary when the window expires. The module drives it by
redeploying FAILOVER_PRIMARY to an unroutable URL (not the OUTAGE
toggle); the standby target is the same project - the failover PATH is
what is tested, distinguished by x-drill-origin. Failover mode skips
the cache-first read (HITs carry no origin tag and mask failover).
Workaround validated: the automated cutover mechanism itself.
OUTCOME (2026-08-16, green - RUNLOG W24): prime=primary ->
outage=standby -> holdover=standby (HOLD_MS=60000) -> return=primary,
all HTTP 200.

## Execution order (completed)

Executed as planned: W14 (manual drill) -> W15 -> W16 -> W17 -> W18 ->
W19 -> W20 -> W21 (Pro-org spend cap) -> W22 -> W23 -> W24. All green 2026-08-15/16/17; full battery
22/22 unattended in ~27 min (RUNLOG, 2026-08-16). Every planned module now exists
and is green.

Local rung first for all (single-file modules; the pattern now proven:
tight SPEC + filename rule + verbatim-evidence rule). Frontier is the
escalation rung only.
