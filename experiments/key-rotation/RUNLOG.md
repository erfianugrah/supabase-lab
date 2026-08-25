# RUNLOG - key-rotation

> **RAN LIVE 2026-08-25** - full windows, two throwaway projects, destroyed
> after. See "First live run (2026-08-25)" below. The headline: the consumer
> cache SHAPE held (R02 reproduced end-to-end), but the platform changed
> around it - signing keys moved to the Management API, the standby-create
> rate limit is gone (one-standby-at-a-time `422` instead), and a fresh
> integration serves a stale kid set even when the issuer's JWKS is current.
> R03's exact revoked-key-honoured scenario still needs a dedicated run
> (module ordering confounded it this time).


Two Supabase projects, no AWS. Answers a question about platform
eventual-consistency: when a hub project's GoTrue is registered as a spoke
project's third-party auth issuer and the hub rotates its signing key, does
the spoke notice?

The answer, measured three times in throwaway bash: it does not. The spoke's
cached kid set holds exactly the kid it resolved at trust-creation time, and
a token signed by a key the spoke does not know about is rejected with
PGRST301 even though the hub is now publishing that kid. This experiment
makes that finding reproducible by porting the bash into typed test modules.

`hub` plays the identity provider - its GoTrue issues the tokens and rotates
its signing key. `spoke` trusts the hub via a third-party auth integration
(`oidc_issuer_url`).

## Tests (R01-R03)

All three are `where: "local"` because every question is about what the auth
tier and Management API accept over the public internet. No VPC, no runner,
no endpoint; the PAT and two project refs are the whole input. All
`destructive` because they write signing keys, auth config, and users.

### R01 - standby key create is rate limited

On a fresh project, creating a signing key returns a rate-limit message with
a hard ISO8601 deadline. This test captures the refusal, parses the deadline,
waits it out, and records how long the wait was. The wait is a measurement,
not an obstacle to retry past - once the deadline passes, the standby key is
created and left in place for R02.

### R02 - the consumer does not re-resolve

After R01's standby key is promoted to active, the hub's JWKS publishes the
new kid (with a measurable propagation delay). The spoke, however, never
re-resolves: its cached kid set, read from the third-party-auth integration's
`resolved_jwks`, stays exactly as it was at trust-creation time.

Every probe records four fields that make the anomaly explicable:
- `pgrst_code` - the PostgREST error code (PGRST301 = no suitable key found)
- `cached_kids` - the spoke's third-party-auth resolved JWKS kid set
- `hub_jwks_kids` - the hub's published JWKS kid set from `.well-known`
- `key_status` - the token's own signing key status re-read at that moment

Capturing only HTTP status codes is exactly what left the original anomaly
unexplained.

### R03 - a revoked key is still honoured

After R02's rotation, the old key is moved from `previously_used` to
`revoked`. The key status is re-read from the hub's signing-keys endpoint
immediately before each probe, so "revoked but accepted" is measured on both
sides rather than inferred from a PATCH that returned earlier.

To obtain a token signed by the old key (which is `previously_used` and no
longer signs new logins), the test temporarily promotes it back to `active`,
obtains a token, then revokes it.

## Provisioning

Two Micro projects in ap-southeast-1. Placeholders for the shared AWS
variables block (aws_account_id, aws_access_key_id, aws_secret_access_key,
breakglass_cidr) so tofu accepts the root secrets.tfvars.

## Configuration

Polling windows and intervals are configurable via environment variables so
the full-duration run and a fast smoke test share the same code:

- `KEYROT_R02_WINDOW_MS` (default 1,200,000 = 20 min)
- `KEYROT_R02_POLL_INTERVAL_MS` (default 10,000 = 10 s)
- `KEYROT_R03_WINDOW_MS` (default 900,000 = 15 min)
- `KEYROT_R03_POLL_INTERVAL_MS` (default 10,000 = 10 s)

## Conventions

- Management API client: `import { mgmt } from "../../../harness/src/mgmt"`.
  No hand-rolled second copy.
- Peer refs come from `ctx.peers.spoke`, not `process.env`. Each module
  self-skips with a reason naming `PVLAB_PEER_SPOKE` when the peer is absent.
- `measurements` values are `number | string` only. Booleans coerced with
  `String()`.
- A measured `fail` is data, never retried to green.
- Ids sort within the destructive tier: R01 creates the standby key, R02
  promotes it and probes, R03 revokes and probes.
- No account-specific identifiers anywhere in tracked files.
- Secrets never enter a measurement, detail, or evidence string.
- Kids and JWKS bodies are public; access tokens are not.

## First live run (2026-08-25)

The offline-gated port finally ran live (committed artifacts: `out/2026-08-25/`; raw evidence dirs stay local). Two port bugs
surfaced first, then the run itself changed three findings:

- **Port bug 1 - the surface moved.** The project GoTrue admin
  `/auth/v1/admin/signing-keys` is a hard `404 page not found` on live
  projects; signing keys are managed on the Management API at
  `GET|POST|PATCH /v1/projects/{ref}/config/auth/signing-keys`. The lib now
  routes there (PAT, not service key). Status vocabulary: `standby | in_use |
  previously_used | revoked`; `kid == id`; create body needs `{algorithm}`.
- **Port bug 2 - doubled path.** `adminCreate` passed `/admin/users` to a
  helper that already prefixes `/auth/v1/admin`, so every user create hit
  `/admin/admin/users`, silently 404'd (result unchecked), and the login
  probes failed 400 on a nonexistent user.
- **R01 premise refuted.** Standby creation is NOT time-rate-limited on the
  new surface: first create `201` immediately. The constraint changed shape -
  a second create answers `422 "already has a signing key in standby"` (one
  standby at a time), not an ISO-deadline throttle.
- **R02 reproduced end-to-end.** Hub published the new kid in its JWKS after
  241 s (~4 min, vs ~7 min measured 2026-08-04). The spoke's cached kid set
  never changed across 116 probes / 20 min and new-key tokens were refused
  (HTTP 401, not a PGRST301 body) the entire window. The consumer cache is
  still the maintenance window.
- **R03 partially confounded, and a stronger cache finding fell out.** The
  revoked key's tokens were refused throughout (87 probes, 401) - but
  `cached_kids` shows the spoke never cached that key at all: R03's FRESH
  third-party-auth integration, created while the new key was `in_use` and
  while the hub JWKS demonstrably advertised it, still served the ORIGINAL
  kid set. Integration re-creation does not repopulate the JWKS cache even
  when the issuer's published JWKS is current - stronger than the 2026-08-04
  G33 reading (which blamed the issuer's own JWKS lag). The original R03
  scenario (spoke honours a revoked key it HAS cached) was therefore not
  reproduced this run; it needs a run where the spoke's integration is
  created before the rotation and the revocation happens inside the cache
  window with no intervening promotion.

This answers the second bullet below ("whether the spoke re-resolves if the
integration is deleted and re-created"): it does not, at least within the
observed window, even with a current issuer JWKS.

## What this does NOT answer

- Whether the spoke would eventually re-resolve given enough time (the
  original bash ran for 37 minutes with no change; this experiment defaults
  to 20 but that is a floor, not a ceiling).
- Whether the spoke re-resolves if the integration is deleted and re-created.
- Whether a key whose status is changed to `active` after a prior promotion
  is treated differently from one that was never `previously_used`.
- The exact mechanism the spoke uses to cache JWKS (in-process, database, or
  config-based; timeout vs event-driven invalidation).
- Anything about Storage or Realtime accepting a foreign-issuer token.
