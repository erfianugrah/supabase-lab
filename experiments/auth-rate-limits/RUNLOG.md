# auth-rate-limits - RUNLOG

One project, no AWS. GoTrue's rate limits and sign-up throughput, measured
against the managed Auth endpoints rather than read off the config. The docs
give per-endpoint per-IP quotas (token-bucket, capacity 30) and a 2/hour email
cap on the built-in provider; this experiment fires real bursts and records
where the 429 lands, proves Sb-Forwarded-For rebuckets the limit, and measures
that sign-up latency is bcrypt-bound (rises with concurrency) rather than
rate-limit-bound.

Distinct from the `rate-limits` experiment, which measures the Management API's
120/min budget. This one is the Auth data-plane: `/auth/v1/*`.

## Modules

| id   | mode        | question |
| ---- | ----------- | -------- |
| AR01 | destructive | Where the 429 lands: anonymous sign-in burst (docs 30/hour per IP, burst 30), the email-send cap on built-in SMTP (docs 2/hour), and the documented knobs from config/auth pinned beside the measured boundary. |
| AR02 | destructive | Sb-Forwarded-For: with forwarding OFF, distinct forwarded IPs share one bucket and a burst trips; with forwarding ON and a secret key, distinct forwarded IPs get distinct buckets and the burst does not trip. The differential is the claim. |
| AR03 | destructive | Sign-up throughput is bcrypt-bound: admin-create (hashes, sends no email) at concurrency 1 vs concurrency 8, per-request latency rises under concurrency on a small instance. |
| AR04 | read-only   | Auth's DB connection-share surface (which knob config/auth exposes) and the project's max_connections. Recorded, not asserted - the field name and per-tier settability are not guessed. |
| AR05 | destructive | Password grants per second by compute size (closed loop, c=1 to 128, limiter raised out of the way), Auth process CPU and Auth DB-pool waits from the metrics endpoint, and Auth latency while 2 x vCPU sessions burn Postgres CPU. Self-provisioned (Pro org). |
| AR06 | destructive | The `/auth/v1/token` bucket: password and refresh grants on one bucket or two; whether `GET /auth/v1/user` is limited; `PUT /user` vs sign-up buckets and which key moves `PUT /user`; steady-rate and 300-request burst shape at `rate_limit_token_refresh` 10000. Self-provisioned (Pro org). |
| AR99 | destructive | Deletes the AR05/AR06 project this process created. |

## Run it

```
make apply                       # provision the throwaway project
make probe                       # AR04 (read-only)
make probe-destructive           # AR01,AR02,AR03 (bursts, admin-create, config PATCH)
make probe-destructive ONLY=AR01 # narrow it
make destroy                     # tear the project down

# AR05/AR06: self-provisioned, no tofu state (env: SUPABASE_ACCESS_TOKEN, PVLAB_ORG_PRO)
make run-self SELF=AR06,AR99                                  # bucket tests on a new Small project
PVLAB_AR_REF=<ref> make run-self SELF=AR06                    # reuse a project across invocations
PVLAB_AR_REF=<ref> PVLAB_AR05_LABEL=large PVLAB_AR05_RESIZE_TO=ci_large make run-self SELF=AR05
make clean DELETE=1                                           # delete leftovers by name prefix (pvlab-ar-)
```

Needs `make secrets-decrypt` at the repo root first. The probe targets fetch the
anon, service_role and secret keys at run time. AR02 self-skips without an
sb_secret_ key. Every module restores the auth config it changed and deletes the
users it created in finally; a second run clears any users a paging gap left.

## Validated 2026-09-08 (Free + Pro + Team orgs, ap-southeast-1)

Ran AR01-AR04 on one throwaway project in each of a Free, Pro and Team org, then
destroyed all three. 8 pass / 0 fail per tier after the AR01a propagation fix
(below). Evidence held locally (refs redacted by not committing it).

| Row | Result |
|---|---|
| AR01a | anonymous sign-in burst trips 429. First cut bursted immediately after enabling anon sign-ins and got 60x `422` (the enable had not propagated) - fixed to poll `/auth/v1/settings` for `external.anonymous_users` first; then 429 as expected. |
| AR01b | the 3rd email signup within the hour was refused `429 over_email_send_rate_limit "email rate limit exceeded"` - the built-in-SMTP 2/hour cap, identical on all three tiers. |
| AR01c | config defaults, same on all tiers: anonymous 30, email 2, otp 30, verify 30, token_refresh 150, sms 30. Note token_refresh reads **150**, not the 1800/hour the public rate-limits page quotes - worth chasing whether the page figure is a different unit or stale. |
| AR02a | per-IP burst tripped 429 at request 31 on a fresh bucket (capacity 30); at request 1 when AR01 had already drained the bucket earlier in the same battery - ordering artifact, not a tier difference. |
| AR02b | with `security_sb_forwarded_for_enabled` on and a secret key, 60 requests spread over distinct `Sb-Forwarded-For` values drew no 429 - forwarding rebuckets onto the end-user IP. |
| AR03 | admin-create latency p50 measured 102/105/110ms sequential vs 411/368/366ms at concurrency 8 (Pro/Team/Free) - sign-up is bcrypt-CPU-bound, so latency rises with concurrency well before any rate limit. |
| AR04 | `db_max_pool_size=10`, `max_connections=60` on all three tiers - Auth's pool is 10, the second ceiling on concurrent sign-ups beside core count. |

Takeaway: the email/anon caps and the per-IP bucket behave as documented;
Sb-Forwarded-For works; sign-up throughput is CPU- and pool-bound, not
rate-limit-bound. The one doc discrepancy is token_refresh 150 vs 1800.

Correction 2026-10-26: the "doc discrepancy" above is a unit difference: on
2026-10-26 the rate-limits page read "150 requests per 5 minutes, with
bursts up to 30" for the token endpoint, which is the same rate as
1800/hour, and AR06a measured the config value as per 5 minutes: at
`rate_limit_token_refresh` 60 a drained bucket refilled 6 tokens in 30 s (60
/ 300 s = 0.2/s), against the about 15 that 150 per 5 minutes would refill
(predicted, not run).

## Validated 2026-10-26 (AR05, AR06; Pro org, ap-southeast-1, one project)

One self-provisioned project (Small, resized to Large, then 2XL, then
deleted by AR99), created through POST /v1/projects in the Pro org;
PostgreSQL 17.11. Client: one Mac in Singapore, one egress IPv4, `GET
/auth/v1/health` p50 18 to 20 ms from it (AR05 `rtt` rows), so every latency
includes that round trip. Evidence in `out/2026-10-26/`:

| run | modules | what |
|---|---|---|
| `run-2026-10-26T00-24-19-000Z` | AR06d, AR06c (5 s arm) | fresh-project config read; first pass of AR06c |
| `run-2026-10-26T00-26-19-212Z` | AR06a-c | the reference AR06 run (90 s arms) |
| `run-2026-10-26T00-46-13-771Z` | AR05 small | sweep; its placement row is superseded (burner filter bug, 0 seen) |
| `run-2026-10-26T00-53-13-344Z` | AR05 small-placement | placement probe on Small |
| `run-2026-10-26T00-56-08-056Z` | AR05 large | resize Small to Large, sweep |
| `run-2026-10-26T01-01-50-039Z` | AR05 2xl | resize Large to 2XL, sweep, placement probe |
| `run-2026-10-26T01-09-20-327Z` | AR99 | delete, 200, gone from the listing |

Project lifetime about 45 min: Small about 32 min, Large about 6 min, 2XL
about 8 min (from the run stamps).

### AR06 - the token bucket

| Row | Result |
|---|---|
| AR06d | Fresh project (run 00-24-19): `rate_limit_token_refresh` 150, `rate_limit_otp` 30, `rate_limit_verify` 30, `rate_limit_web3` 30, `rate_limit_anonymous_users` 30, `rate_limit_email_sent` 2, `rate_limit_sms_sent` 30, `security_sb_forwarded_for_enabled` false. Same as AR01c on 2026-09-08, plus `rate_limit_web3` and `security_sb_forwarded_for_enabled`. |
| AR06a | **One bucket for password and refresh grants.** At `rate_limit_token_refresh` 60 (PATCH read back in 0.6 s, no health gap), 4 trials, 2 per order: draining with password grants gave the first 429 at request 31 (200 x 30), and a refresh grant sent right after with an unused refresh token got `429 over_request_rate_limit`; draining with refresh grants (a rotating chain) gave the first 429 at 31 and the password grant right after got 429. All 4 trials identical. 30 s after each drain, 6 requests passed: the running limiter refilled at 60 per 5 minutes, so the PATCH reached it (n=4). ID-token and PKCE grants were not sent. |
| AR06b.1 | `GET /auth/v1/user` was not limited: 60 sequential (p50 23 ms) and 100 concurrent (p50 463 ms) GETs with one user token, 160 x 200, no 429. Password grants sent after them passed 31 before the first 429 (bucket reset by the PATCH to 150, one grant spent on the token: 29, plus refill at 0.5/s during the GETs and the drain), so the GETs did not draw on the token bucket. n=1. |
| AR06b.2 | **`PUT /auth/v1/user` and email sign-up have separate buckets.** PUT drained to its first 429 at request 31; email sign-ups (autoconfirm on, no email sent) sent right after passed 30 and 429'd at 31. PUT uses `rate_limit_otp`'s rate (AR06b.3); sign-up's refill rate was not measured. 10 s after the PUT drain, 1 PUT passed at the default 30 per 5 minutes. n=1. |
| AR06b.3 | `rate_limit_otp` moves `PUT /user`: at 3000 (10/s) a fresh PUT bucket gave its first 429 at 40 (30 plus refill during about 1 s of sequential requests), and 10 s after a drain 41 passed, against 1 at the default. `rate_limit_token_refresh` was at 150 throughout. n=1. |
| AR06c.0 | At 10000, 100 grants paced at 20/s: 100 x 400, no 429 (the 150 default 429s the 31st). In the first pass (run 00-24-19) unpaced sequential grants went out at about 50/s (20 ms each) and the first 429 came at request 90, which is the 10000 limiter at work: 30 / (50 - 33.3) s = 1.8 s = request 90. |
| AR06c steady | Open loop, 90 s per arm, grants for an email with no account (400 `invalid_credentials`; the limiter runs before the grant handler). 25/s: 2250 sent, 0 x 429. 33/s: 2970 sent, 0 x 429. 45/s: 4050 sent, first 429 at request 113 (2.49 s), 1021 x 429, 3029 passed. 60/s: 5400 sent, first 429 at request 67 (1.10 s), 2371 x 429, 3029 passed. 3029 = 30 + 33.33/s (10000 / 300 s) x 89.98 s (first to last send on the schedule, 4049 / 45 and 5399 / 60; the artifact rounds it to 90 s): above the refill rate a client gets exactly the burst plus the refill. The first-429 times match a fixed 30-token bucket: 30 / (45 - 33.3) = 2.56 s, 30 / (60 - 33.3) = 1.12 s. n=1 per arm at 90 s; the 45/s arm also ran 5 s in the first pass: first 429 at request 113 (2.49 s) again. |
| AR06c burst | 300 concurrent grants at a full bucket (client send span 1 to 6 ms). `rate_limit_token_refresh` 150: 30 passed, twice (both runs). 10000: 47 and 37 passed (reference run; 46 of the 300 in the first burst ended client-side with status 0, error text not recorded), 68 and 42 in the first pass. 100000: 130 passed (reference), 160 (first pass). **The burst stays 30 at a raised limit**; what grows is the refill while the burst is served (33.3/s at 10000, 333/s at 100000; response spans 163 to 1100 ms; the 100000 bursts passed more than 30 + 333/s x span). A capacity proportional to the limit would have let all 300 through at 10000. |

### AR05 - grants per second by compute

Closed loop, 128 pre-created users (one per worker),
`rate_limit_token_refresh` 1,000,000, 40 s per step, valid password grants
(bcrypt cost 10 per the `gotrue_compare_hash_and_password_submitted_total`
label, read by hand from the metrics payload, not in the artifact). CPU
figures come from the project's metrics endpoint: node CPU
(`node_cpu_seconds_total`, labelled `service_type="db"`) and the Auth
process (`process_cpu_seconds_total{service_type="gotrue"}`), normalised by
node CPU seconds. The payload refreshes rarely (data-api-capacity DC05), so
a step's CPU reading spans its first and last distinct snapshots and can
include part of the step before; only the c=64 and c=128 rows (preceded by a
step at the same rate) are quoted in the table; the pool bullet also uses
2XL c=16. `-1` in the artifact = fewer than 2 distinct snapshots.

| size | c=1 | c=4 | c=16 | c=64 | c=128 | node CPU / Auth cores at c=64 |
|---|---|---|---|---|---|---|
| Small (2 shared vCPU) | 8.7/s, p50 113 ms | 18.4/s, 210 ms | 18.8/s, 843 ms | 18.9/s, 3198 ms | 14.2/s, 6746 ms (3 x status 0, client-side, error text not recorded) | 90.8 % / 1.7 |
| Large (2 vCPU) | 11.2/s, 85 ms | 26.7/s, 143 ms | 28.1/s, 552 ms | 28/s, 2140 ms | 27.9/s, 4122 ms | 91 % / 1.72 |
| 2XL (8 vCPU) | 11.6/s, 84 ms | 46.2/s, 85 ms | 111.1/s, 138 ms | 113.7/s, 533 ms | 113.8/s, 1041 ms | 89.4 % / 6.89 |

- **Grant throughput rises with the CPU available to Auth**: 2XL saturated
  at 113.7/s against Large's 28/s, 4.1 x for 4 x the vCPUs; Small and Large
  both report 2 vCPUs and ran at 18.9/s and 28/s, so the count alone does
  not set the rate. No 5xx and no 429 in any step. At saturation the Auth
  process alone used 1.7 of 2 (Small), 1.72 of 2 (Large) and 6.89 of 8 (2XL)
  cores while node CPU read 89 to 91 %. Reading (inference): the Auth
  process runs on the database instance and its CPU is the ceiling. That is
  about 61 ms of Auth CPU per grant on Large and 2XL (1.72 / 28, 6.89 /
  113.7) and about 90 ms on Small.
- Auth's DB pool is 10 connections on every size (`db_max_pool_size` 10,
  `db_sql_connection_max_open` 10, the latter read by hand from the metrics
  payload, not in the artifact). Its wait counter rose by thousands per
  saturated step (2XL c=64: 9295 waits, 828 s of summed wait), but at 2XL
  c=16 (a window that can include part of c=4), 111/s with 21 waits. The c=1
  rows show 313, 304 and 104 waits at 39.3, 39.2 and 16.2 % node CPU, likely
  the warm-up and limiter check in the same window (not separated). Reading
  (inference, one snapshot pair per step): the pool queues once CPU is
  saturated and was not the limit below it.
- Above saturation p50 rises about in proportion to concurrency (843 -> 3198
  -> 6746 ms Small, 552 -> 2140 -> 4122 ms Large, 138 -> 533 -> 1041 ms 2XL
  for c=16 -> 64 -> 128) at near-constant throughput on Large and 2XL; Small
  fell 18.9 -> 14.2/s at c=128.
- The limiter check before each sweep (300 concurrent cheap grants) gave 0,
  8 and 42 x 429 on Small, Large and 2XL at 1,000,000: the burst is 30 at
  every limit tried (AR06c), so a 300-request spike from one IP can see 429s
  even there. The harness marks these rows `fail`; the sweep itself saw no
  429.

### AR05 placement - Auth while Postgres burns CPU

2 x vCPU sessions loop `select count(*) from generate_series(1, n)` through
a service_role RPC (function-level `statement_timeout` 120 s) while the same
probes run again. Sequential p50 over 20 requests each, plus a 20 s closed
loop at c=16 (grants/s):

| size | `/auth/v1/health` | grant, no account (lookup) | valid grant (bcrypt) | c=16 grants/s |
|---|---|---|---|---|
| Small, 4 burners (4 seen active) | 20 -> 22 ms | 21 -> 22 ms | 112 -> 275 ms | 18.9 -> 6.6 |
| 2XL, 16 burners (13 seen active) | 23 -> 24 ms | 19 -> 20 ms | 83 -> 174 ms | 112 -> 54 |

- **Auth slows with the database's CPU, on the bcrypt path**: the valid
  grant's p50 rose 2.5 x (Small) and 2.1 x (2XL) and c=16 throughput fell to
  35 % and 48 %, while the lookup-only grant's and health's p50 moved by at
  most 2 ms (2XL lookup p95 24 -> 40 ms).
  Reading (inference): CPU contention on the shared instance fits; a slower
  database alone does not, since the lookup path runs the same user query
  and did not slow. One run per size.
- Node CPU during the 2XL burn read 68.3 % (Small unreadable: stale
  snapshots). The burner RPCs mostly answered 503: Small 4 of 4 calls at n =
  300M (run 00-53-13), 2XL 31 of 40 at n = 60M (run 01-01-50); n is not in
  the artifacts (source comment, tests/ar05-grant-throughput.ts). A lone
  60M-row call on idle Small answered 200 in 17.3 s (by hand, not in an
  artifact). Which layer returned the 503 and whether the statement kept
  running after it was not checked; the sessions were seen active 10 s into
  the window.

### Not measured

- ID-token and PKCE grants on the shared bucket (source-read only: one
  `Token` limiter for password, refresh_token, id_token and pkce; `web3` has
  its own; auth master `internal/api/token.go`).
- The bucket key on the hosted platform (per client IP; what the edge passes
  as the IP was not varied here; AR02 covers Sb-Forwarded-For).
- Whether a PATCH to an unrelated auth field resets the token bucket (each
  bucket here was reset by changing its own value or waited out).
- `/recover`, `/resend`, `/magiclink`, `/otp` buckets (source: one limiter
  each at `rate_limit_otp`).
- Grants/s with a client in the region of a far project, Medium/XL/4XL, a
  repeat of any sweep, and Postgres CPU separate from the node's.
