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

## Run it

```
make apply                       # provision the throwaway project
make probe                       # AR04 (read-only)
make probe-destructive           # AR01,AR02,AR03 (bursts, admin-create, config PATCH)
make probe-destructive ONLY=AR01 # narrow it
make destroy                     # tear the project down
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
