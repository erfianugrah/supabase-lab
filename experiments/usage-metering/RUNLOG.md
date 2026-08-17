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
