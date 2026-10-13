# rate-limits RUNLOG

The public API reference documents a 120 req/min budget (per user, per
project/organization scope), X-RateLimit-* response headers, and a 429 on
breach. L01 measures the surface on a normal Pro org. L01b (per-PAT vs
shared budget across two PATs from the same user) self-skips until a second
PAT is supplied via PVLAB_PAT2.

No OpenTofu state: read-only Management API calls plus a deliberate burst on
a cheap single-project read (the budget returns after the window; L01c waits
and confirms recovery). Run it with (since 2026-10-13; the
`.pi/probe-rate-limits.sh` named here before was gitignored local tooling):

```
sx SUPABASE_ACCESS_TOKEN -- make probe ONLY=L01 PVLAB_REF=<any project ref>
```

## 2026-08-17 - L01 green: headers on every response, JSON 429 at the boundary

Run artifact: `evidence/run-2026-08-17T23-47-28-571Z.{json,md}` (local;
evidence/ is gitignored).

| Probe | Result | Evidence (verbatim) |
|---|---|---|
| L01-control: GET /projects | pass | headers on every response: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` |
| L01a: 3 sequential scoped reads | limit 120, remaining 119 -> 118 -> 117 | decrement is 1:1 per call on the scoped read |
| L01c: burst the scoped read | 429 at request 118, `retry-after: 60`, recovered 200 after ~65s | `content-type: application/json` with body `{"message":"ThrottlerException: Too Many Requests"}` |

Read: on this endpoint (a cheap scoped read) the breach is the API's own
JSON throttler with a 60s retry-after - NOT a non-JSON interstitial. Other
endpoints and burst shapes may still hit the edge layer's HTML page (seen
in earlier experiments on aggressive polling), so clients still need to
treat "non-JSON body" and "JSON 429" as the same back-off signal - but the
measured breach here is machine-readable, and the remaining-budget headers
make pre-emptive shaping possible: read `x-ratelimit-remaining` rather
than inferring the budget.

## 2026-08-18 - L01b: the budget is cumulative across a user's PATs

Two PATs from the same user, alternating calls on the same scoped read:

- PAT1 remaining: 116 -> 114 -> 112 -> 110
- PAT2 remaining: 115 -> 113 -> 111 -> 109

Each token's remaining count drops when the OTHER token calls - one shared
counter per user per scope (matching the documented identity priority:
OAuth App ID, then User ID for a PAT, then IP). PAT sharding does not
multiply the budget.

## 2026-10-13 - L02: breach shape per endpoint and burst (work-supabase-lab#42)

Harness: `make probe ONLY=L02`, lab commit 1a7158f with the W3 plan's Task
O4 L02 change uncommitted at run time, one throwaway Pro project (Micro,
ap-southeast-1) for the project-scoped rows; 05:09 to 05:27 UTC; published
`out/2026-10-13/run-2026-10-13T05-09-36-511Z.facts.md`.

Each cell: first non-2xx by issue order (`n`), status, body class,
`retry-after`; then the 2xx count in the cell. In the parallel and spike
cells `n` is issue order, not arrival order, so a low `n` there does not
mean the budget ran out early.

| endpoint | serial | parallel-20 | spike-150 |
|---|---|---|---|
| projects_list | n=121, 429, json-throttler, 60; 120 x 2xx | n=120, 429, json-throttler, 60; 119 x 2xx | n=15, 429, json-throttler, 60; 119 x 2xx |
| orgs_list | n=121, 429, json-throttler, 60; 120 x 2xx | n=4, 429, json-throttler, 59; 119 x 2xx | n=3, 429, json-throttler, 60; 119 x 2xx |
| project_get | n=121, 429, json-throttler, 60; 120 x 2xx | n=14, 429, json-throttler, 60; 119 x 2xx | n=6, 429, json-throttler, 60; 119 x 2xx |
| functions_list | n=121, 429, json-throttler, 60; 120 x 2xx | n=10, 429, json-throttler, 59; 119 x 2xx | n=55, 429, json-throttler, 59; 119 x 2xx |
| health | n=121, 429, json-throttler, 60; 120 x 2xx | n=113, 429, json-throttler, 60; 119 x 2xx | n=36, 429, json-throttler, 59; 119 x 2xx |

Read: no cell got `html`; all 15 breaches were the API's JSON throttler
(`application/json; charset=utf-8`, `{"message":"ThrottlerException: Too
Many Requests"}`), with `retry-after` 59 or 60. Every 429 in the run was
that class (the spike cells: 31 x 429 each). Each cell's endpoint answered
2xx again at the first read after the 65 s cooldown (`recovered_s` 65 on all
15). A serial burst got 120 x 2xx before the 429; every parallel and spike
cell got 119. Not settled: one token, one vantage, one day; write endpoints
were not burst; the HTML page other experiments met on aggressive polling
was not reproduced by any of these shapes, so what produces it is still
open.
