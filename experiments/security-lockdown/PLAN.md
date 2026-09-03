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

### S13-S15 - review gap-plugging (column grants, the Auth switch-on levers, Storage/Realtime reach)

Three gaps a review of the data-surface-lockdown reference raised, each the
missing half of a claim the page already makes.

  S13 - column-level grants. Move 1 says "an UPDATE policy gates which rows
        change but not which columns" and stops. The fix is a column privilege,
        not a policy: with a permissive UPDATE policy and a table-level UPDATE
        grant, anon writes a sensitive column (the trap); after `REVOKE UPDATE`
        + `GRANT UPDATE (<safe columns>)` the same write returns 42501 through
        the Data API while the row policy is unchanged, and the granted column
        still writes. RLS decides the rows, the grant decides the columns.

  S14 - the Auth levers a customer switches ON. S03/S11 probed Auth for what
        leaks; the lever table never covers what a customer can turn on to
        harden the Auth service: a before-user-created hook, CAPTCHA
        (hCaptcha/Turnstile), and the configurable auth rate limits. Inventory
        which switch-on fields the Management API exposes, prove one settable
        end to end (a rate limit lowered and read back), restore. Enforcement of
        the hook/CAPTCHA needs a live endpoint + provider secret, so those are
        inventoried, not driven.

  S15 - Storage and Realtime do not route through PostgREST. The db-pre-request
        IP filter and any owner-list read from request headers are PostgREST
        controls; Storage (storage-api) and Realtime run their own services
        against Postgres and never traverse PostgREST. Evidenced structurally:
        with the managed Data API OFF (REST 503), Storage (/storage/v1) and
        Realtime (/realtime/v1) keep answering. Plus: the storage schema is
        owned by supabase_storage_admin, so the Move 1 public-schema REVOKE does
        not govern it. Conclusion: an IP/owner gate for Storage/Realtime belongs
        in each service's own authz or an edge you own, never a db-pre-request.

## The architecture this evidences

Supabase = managed Postgres. Data plane = your own PostgREST behind your edge
(IAP + IP allowlist + WAF + rate limit + db-pre-request). The managed HTTP tier
is not the exposed surface - yours is, and you control all of it. Auth,
Storage, Realtime either stay public or move to your stack too.

## Cost and teardown

One Micro per run; a local Docker container for S04. Ephemeral: provision ->
probe -> destroy (project) + postgrest-down (container) in one run. Nothing
left standing.

### S16-S21 - pen-test-customer gaps (2026-09-03)

A customer with a failed pen test, no RLS (authorisation in app code, service_role
from the backend), asked four things: disable or IP-restrict the Data API and put
WAF rules in front; FORCE ROW LEVEL SECURITY for the roles the backend uses; a
full access-audit trail (Log Drains to Honeycomb) and a way to block a bad
actor; managed protection for signup abuse beyond CAPTCHA and the
before-user-created hook. The existing modules answer the first thoroughly and
the other three thinly or not at all. Six modules close that, on one micro.

  S16 - pre-request on hosted, with a RESTART. L09's "does not fire" rests on
        one 120s window after NOTIFY. Set the role GUC, NOTIFY, poll; then
        `POST /projects/{ref}/restart`, wait for health, poll again. Plus an
        RPC that returns `request.headers` so the x-forwarded-for shape the
        hosted edge hands PostgREST (client value passed, appended, or
        replaced) is measured, not "not lab-answerable".
  S17 - FORCE ROW LEVEL SECURITY. Role attributes (rolsuper, rolbypassrls) for
        the platform roles; FORCE binds the table owner (owner read 2 -> 0);
        service_role still reads everything (BYPASSRLS); whether the project
        owner can strip BYPASSRLS from service_role; and the shape that works -
        a NOBYPASSRLS backend role reached through the Data API with a minted
        HS256 JWT, RLS applied.
  S18 - audit trail + blocking. Log Drains in the /v1 spec (none: Dashboard
        only); a marked REST and Storage request found in `edge_logs` with a
        client IP field, and the ingestion lag; a failed login in `auth_logs`
        and a successful login in `/auth/v1/admin/audit`; network bans -
        retrieve, provoke with repeated failed psql auth through the pooler,
        retrieve, remove - and that every ban endpoint is DB-scoped.
  S19 - Auth enforcement, not settability. HIBP at SIGNUP (autoconfirm on, so
        no email send); an anonymous-sign-in rate limit driven to its 429; the
        CAPTCHA gate with Turnstile's documented always-fail and always-pass
        test secrets (no provider account needed); a before-user-created hook
        as a Postgres function rejecting a disposable-email domain.
  S20 - the x-forwarded-for trust boundary on your own PostgREST. S04 proved the
        filter fires on a client-supplied header. Here an nginx edge overwrites
        X-Forwarded-For with $remote_addr: the spoof is visible direct to
        PostgREST and invisible through the edge. The filter is an allowlist
        only when PostgREST is reachable solely from the edge.
  S21 - the no-RLS, service_role-from-the-backend shape. Anon reads a plain
        table (the exposure); REVOKE on schema/tables/functions + ALTER DEFAULT
        PRIVILEGES closes anon and authenticated while service_role keeps
        reading, including a table created afterwards; and the exposed-schema
        move is project-wide - service_role loses `public` too until it sends
        `Accept-Profile`.

  Ops: S20 needs `make postgrest-up` + `make edge-up`. S16 restarts the project
  and runs LAST in its own invocation; S18 bans this machine's IP from the DB
  socket mid-module and removes it, so it runs alone after S17/S19/S21.
