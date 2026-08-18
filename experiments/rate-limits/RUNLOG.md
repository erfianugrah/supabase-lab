# rate-limits RUNLOG

The public API reference documents a 120 req/min budget (per user, per
project/organization scope), X-RateLimit-* response headers, and a 429 on
breach. L01 measures the surface on a normal Pro org. L01b (per-PAT vs
shared budget across two PATs from the same user) self-skips until a second
PAT is supplied via PVLAB_PAT2.

No OpenTofu state: read-only Management API calls plus a deliberate burst on
a cheap single-project read (the budget returns after the window; L01c waits
and confirms recovery). Run it with:

```
.pi/probe-rate-limits.sh L01
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
