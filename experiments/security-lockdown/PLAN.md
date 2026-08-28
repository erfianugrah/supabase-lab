# experiments/security-lockdown - PLAN

The broader security surface, beyond the IAP framing of iap-lockdown. Same
question ("how far can a Supabase project be locked down") but across the
dimensions IAP does not cover: the platform's own security lints, network
restrictions actually applied, auth hardening, and the honest answer for the
Data API - run your own PostgREST.

## Modules

### S01 - security advisors (the platform's own view)

Seed a deliberately-exposed fixture (an RLS-disabled table with data, a
SECURITY DEFINER function, a public view over a protected table), then call
the Management API security advisor and record what it flags. This is the
platform telling you where you are exposed - the first thing to run for any
"are we locked down?" question.

### S02 - network restrictions APPLIED (not just enumerated)

iap-lockdown L09 enumerated the network-restriction ops; here they are
applied. PATCH the restriction list to a CIDR that excludes everything (or the
restrict-all posture), confirm via the API it took, then measure the split:
the HTTP tier (REST) keeps answering (restrictions do not touch it), while the
DB/pooler socket is the surface they gate. Restore in finally.

### S03 - auth hardening

Which GoTrue hardening levers the Management API exposes and what each closes:
leaked-password protection (HIBP), MFA enforcement, password policy / minimum
length, and the auth rate limits. PATCH each, record what changes, restore.

### S04 - Supabase as database only: your own PostgREST

The honest answer for the Data API. Proxying the MANAGED endpoint gates
nothing - iap-lockdown L11 measured that <ref>.supabase.co keeps answering any
key-holder regardless of a proxy. The only way to truly control the REST layer
is to run your own PostgREST and turn the managed Data API off:

  S04a - managed Data API OFF (db_schema wedge): the managed REST endpoint is
         dark (503/PGRST002).
  S04b - self-hosted PostgREST (Docker, official image) against the SAME
         Supabase Postgres via the session pooler, schema public, anon role:
         it serves the data the managed endpoint no longer will.
  S04c - db-pre-request IP filter ON the self-hosted PostgREST: a function
         reading current_setting('request.headers')->>'x-forwarded-for' and
         RAISEing on a disallowed value. Confirm it REJECTS a spoofed IP.
         This is the exact db-pre-request x-forwarded-for filter that
         iap-lockdown L09 measured does NOT fire on hosted Supabase - it works
         here because we own the PostgREST config. The IP-restrict-the-Data-API
         ask is answerable, just not on the managed tier.

  Ops: `make postgrest-up` runs the container (pinned image, session pooler
  connection from the db_password); the module installs the anon role grants +
  the pre-request function, probes, then `make postgrest-down`.

### S05 - rate limiting in front of your PostgREST (design; light test)

Rate limiting can live anywhere the traffic funnels
through: a Cloudflare Worker (rate-limit binding / DO / KV), CF WAF rate rules,
nginx, Envoy, or Upstash (which Supabase's own docs recommend for edge
functions). The only rule: it must sit in front of a CLOSED origin, or callers
bypass it by hitting the origin directly (same bypass as S04a / L11). Tested
lightly here as a Worker in front of the self-hosted PostgREST; the full CF
integration reuses the iap-lockdown worker + wrangler pattern.

## The architecture this evidences

Supabase = managed Postgres. Data plane = your own PostgREST behind your edge
(IAP + IP allowlist + WAF + rate limit + db-pre-request). The managed HTTP tier
is not the exposed surface - yours is, and you control all of it. Auth,
Storage, Realtime either stay public or move to your stack too.

## Cost and teardown

One Micro per run; a local Docker container for S04. Ephemeral: provision ->
probe -> destroy (project) + postgrest-down (container) in one run. Nothing
left standing.
