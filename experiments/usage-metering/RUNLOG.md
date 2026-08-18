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
