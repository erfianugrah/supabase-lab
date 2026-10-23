# usage-metering RUNLOG

A platform billing its own tenants for per-tenant Supabase usage has no
org-scoped billing read on the Management API. The documented DIY
workarounds: (a) query the tenant project directly for ground truth
(pg_database_size, Storage object listing) and (b) read the per-project
usage analytics endpoints for request volumes. M01 puts both into practice
on a self-provisioned project and measures fidelity and lag.

No tofu state: M01 provisions and deletes its own project (the W21 pattern).
Run it with:

```
.pi/probe-usage-metering.sh M01
```

## 2026-08-17 - M01 green: DIY metering works, with minute-scale analytics lag

Run artifact: `evidence/run-2026-08-17T13-34-38-088Z.{json,md}` (local;
evidence/ is gitignored).

| Probe | Result | Read |
|---|---|---|
| M01-control | pass, 135s to healthy | same provisioning envelope as I01 |
| M01a: pg_database_size | baseline 9,940,115 -> 10,128,531 bytes | ground truth works, but the delta (188KB) is far under the ~8MB raw payload: `repeat(md5())` is TOAST-compressible. Use random payloads for capacity tests |
| M01b: REST-count reconstruction | 12 GETs sent; usage.api-counts showed 10 after ~67s | the analytics signal lags ~1-2 min and undercounts slightly across bucket boundaries - fine for billing rollups, not for real-time enforcement |
| M01c: metrics scrape | HTTP 200, 328 metric families, text exposition | the per-project Prometheus endpoint works with a plain PAT |
| M01d: storage ground truth | uploaded 262144, listed 262144 | exact |

Known issues (judge nits, fix before citing M01b numbers externally):
M01b's schema-cache retry can send a variable number of warm-up GETs while
recording a constant 12; it should count actual requests sent, send
`Prefer: count=exact`, and anchor `observation_lag_s` to the LAST sent
request. M01c's `content_type` is body-sniffed, not the response header
(mgmt() does not expose headers).

## 2026-08-18 - M02 green: scoped per-tenant metrics through a credential-proxy gateway

The god-mode-credential problem: scraping per-tenant metrics with a raw PAT
(or project secret) hands the scraper a full-privilege credential. M02
validates the PAT-proxy pattern end to end against the operator's own
gateway deployment (a Cloudflare Workers credential proxy with an IAM-style
policy engine and a D1 audit log): the PAT is registered server-side, a key
scoped to `supabase:metrics:read` on `project:<ref>` is minted, and only
that key leaves the control plane.

Run artifact: `evidence/` is gitignored; reproduce with
`.pi/probe-usage-metering.sh M02` (needs GATEKEEPER_URL + GATEKEEPER_ADMIN_KEY).

| Probe | Result | Read |
|---|---|---|
| M02-control | gateway + admin key 200 | - |
| M02a | project healthy in 134s; upstream register 200, 0 warnings | the gateway probes the PAT against the live Management API on registration |
| M02b | scoped key minted (200) | the key id IS the bearer (44 chars, `sbp_`-shaped because it is bound to a supabase upstream) |
| M02c | proxied scrape 200, 278 metric families; unclassified path 403; other project ref 403 | deny-by-default and per-resource scoping both enforced - a leaked key reaches exactly one project's metrics and nothing else |
| M02d | proxied calls visible in the proxy-events feed, ~1s flush | the feed never stores the bearer: key_id is the non-secret `first4...last4` preview - correlate on that, not the raw key |

Contract corrections discovered while testing (the live gateway API, not
the docs, is authoritative): POST /admin/keys requires `upstream_token_id`;
proxy usage events live at `/admin/supabase/analytics/events`
(`/admin/audit/events` is the admin-lifecycle log); event `key_id` is the
preview form, so server-side filtering by the full bearer silently matches
nothing.

## 2026-08-18 - M01 re-run with corrected request accounting: analytics count is EXACT

Run artifact: `evidence/run-2026-08-18T02-14-23-125Z.{json,md}` (local).

After fixing the M01b accounting (warm-up requests counted separately,
`Prefer: count=exact` on the counted dozen, lag anchored to the last sent
request): 12 counted + 1 warm-up = 13 REST requests sent, and
usage.api-counts reported **13** after **61s** - an exact match. The
earlier 10/12 was warm-up confounding, not platform undercounting. The
DIY metering verdict strengthens: the analytics signal is exact at
minute-scale lag, ground truth (pg_database_size, storage listing) is
exact to the byte, and the Prometheus endpoint (text/plain, 326 families)
answers a plain PAT. M01c now records the real Content-Type header.

## 2026-08-18 - M03 to M07, written up from the run artifacts (work-supabase-lab#43)

The modules landed in 2cf4b01 ("M03-M07 green") on 2026-08-18 with no RUNLOG
entry. Figures are pasted from `pvlab --facts` of the local artifacts. The lab
commit stamped in them (5bce8da) predates the history rewrites and does not
resolve. Vantage local; every project in ap-southeast-1 on the Pro org,
provisioned and deleted by its module; n = 1 run per module unless a row
gives two.

Published (redacted, a `.facts.md` beside each), `out/2026-08-18/`:
`run-2026-08-18T06-31-21-134Z.json` (M04), `run-2026-08-18T06-21-24-941Z.json`
and `run-2026-08-18T06-25-18-819Z.json` (M05),
`run-2026-08-18T06-36-29-484Z.json` and `run-2026-08-18T06-39-38-374Z.json`
(M06). Not published: M07's artifact (`evidence/run-2026-08-18T06-44-26-417Z.json`),
because its evidence lists the account's own project names. M03 left no
artifact.

| Probe | Result | Read |
|---|---|---|
| M03 | no artifact in `evidence/` | the M03 figures in AGENTS.md (3 projects, $29.43/mo compute) come from the 2cf4b01 commit message and cannot be checked against a run |
| M04-control | gateway 200 | - |
| M04a | throwaway project provisioned in 137 s; upstream and two scoped keys set up (pass) | - |
| M04b | key A: 7 sent, 7 answered 200; key B: 5 sent, 5 answered 200 | - |
| M04c | events feed, key A: 7 events of 7 expected, 7 with the right project ref, 7 with status 200; key B: 5 of 5, 5, 5 | the feed matched the sent count for both keys in this run |
| M05-control | store provisioned in 135 s, schema 201 (both runs) | - |
| M05a | 06:21 run: 4 org projects, 0 rows inserted, own row absent, 0 read back. 06:25 run: 4 projects, 4 rows inserted, own row present, 4 read back | the second run is the self-inclusion result; why the first inserted nothing is not recorded in its artifact |
| M05b | tenant t-a 100 rows, t-b 25 rows; payload bytes 100400 and 25100 (both runs) | module detail: exact for variable-width columns via `pg_column_size`, an estimate for fixed-width |
| M06-control | provisioned in 134 s (both runs) | - |
| M06a | 06:36 run: fail, 2 rollup windows (`t-0@00h=500 t-1@01h=500`), identical after re-flush. 06:39 run: pass, 4 windows of 250 (`t-0` and `t-1` in 00h and 01h), identical after re-flush | the first run's seed put each tenant in one window; the change between the runs is not recorded |
| M06b | late insert 201; closed window moved by 5 (expected 5); duplicate idempotency key rejected; other windows unchanged (both runs) | - |
| M07-control | invoice PDF parsed: 91 per-ref lines | the compute-line count and hour total are in the local facts render, not copied here: they describe the account's billing, not the method |
| M07a | 32 invoiced refs; 3 live projects, 3 matched; 29 deleted since the invoice | - |
| M07b | 4 reconciled rows; largest share of the billing window 98.7% | - |

## 2026-10-13 - M01 and M05 re-run after the explicit Data API grants (#128)

Task 20 of `docs/plans/2026-10-13-lab-backlog-waves.md` appended `grant
select, insert, update, delete ... to anon, authenticated, service_role` to
the SQL that creates `public.m01_payload` (M01) and `public.metering_hourly`
(M05). Until the 2026-10-30 default change these grants repeat what the
default already gives; the re-run checks that they execute and change no
result. One run each, local vantage, Pro org, ap-southeast-1, run from source
(`bun harness/src/run.ts`) at lab commit 8ec7f86, each project provisioned and
deleted by its module. Artifacts are private (this experiment has no
`publish-evidence` target): M05 `evidence/20261013-114237/run-2026-10-13T03-42-38-273Z.json`,
M01 `evidence/20261013-114309/run-2026-10-13T03-43-10-147Z.json`.

| Probe | 2026-10-13 | Last entry |
|---|---|---|
| M05-control | pass, provisioned in 13 s, schema 201 (the grant is one of the schema statements; the loop stops on the first non-2xx) | pass, 135 s, 201 (2026-08-18, both runs) |
| M05a | 4 org projects, 4 rows inserted through the store's PostgREST with its secret key, own row present, 4 read back | same as the 2026-08-18 06:25 run |
| M05b | t-a 100 rows, 100400 payload bytes; t-b 25 rows, 25100 | same (2026-08-18, both runs) |
| M01-control | pass, 12 s | pass, 135 s (2026-08-17) |
| M01a | pg_database_size 10843827 -> 11032243 bytes, delta 188416 | delta 188416 (9,940,115 -> 10,128,531, 2026-08-17) |
| M01b | anon REST read answered 200 on the first warm-up request (1 warm-up), then 12 counted requests, last status 206 (`Prefer: count=exact` with `limit=1`); usage.api-counts showed 9 at the first poll, 61 s after the last request | 13 of 13 at 61 s (2026-08-18); 10 of 12 at about 67 s (2026-08-17) |
| M01c | 200, text/plain, 336 metric families | 200, text/plain, 326 (2026-08-18) |
| M01d | 262144 bytes uploaded, 262144 listed | same |

No 401, 403 or 42501 on the Data API in either run: anon reads of
`m01_payload` and the secret key's inserts into `metering_hourly` (201 for 4 of
4) succeeded. M01b's 9 of 13 is below the 2026-08-18 exact count; the module
stops polling at the first non-zero reading, so it cannot tell a bucket still
filling from an undercount (one run). `provision_s` was 12-13 s on 2026-10-13
against 135 s in August. It spans create to the first `ACTIVE_HEALTHY` read
(polled every 10 s) plus the key fetch, and in M05 the schema install, so the
first poll already read healthy.
