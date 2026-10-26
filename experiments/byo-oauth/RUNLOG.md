# byo-oauth RUNLOG

The "bring your own backend" integration pattern: a platform's users connect
THEIR OWN Supabase organization to the platform's app via Management API
OAuth2 (`/v1/oauth/authorize` -> code -> `/v1/oauth/token` -> act on the
user's orgs/projects -> `/v1/oauth/revoke`). The public guide describes the
flow; this experiment measures the runtime surface.

No tofu state: O01 needs only a PAT (ungated probes) plus the drill env
(gated lifecycle). Run it with:

```
.pi/probe-byo-oauth.sh O01
```

## The manual drill (supplies PVLAB_OAUTH_*)

OAuth app registration is dashboard-only and the consent click needs a
logged-in browser, so the token lifecycle is gated on three env vars:

1. Dashboard -> your org -> Settings -> OAuth Apps -> Add application.
   Name anything; callback URL `http://localhost:54321/callback`; scopes
   as needed for the drill.
2. Open
   `https://api.supabase.com/v1/oauth/authorize?client_id=<id>&redirect_uri=http://localhost:54321/callback&response_type=code`
   in the logged-in browser, approve, and copy the `code` from the
   address bar of the (dead) localhost redirect.
3. Within ~a minute, exchange it:
   `curl -u <id>:<secret> -d grant_type=authorization_code -d code=<code> -d redirect_uri=http://localhost:54321/callback https://api.supabase.com/v1/oauth/token`
4. Export `PVLAB_OAUTH_CLIENT_ID` / `PVLAB_OAUTH_CLIENT_SECRET` /
   `PVLAB_OAUTH_REFRESH_TOKEN` and re-run the probe. NOTE: a green O01e
   revokes the grant - re-consent to run the lifecycle again.

## 2026-08-17 - O01 green (ungated rows live; lifecycle gated)

Run artifact: `evidence/` is gitignored; the run is reproducible via the probe.

| Probe | Result | Evidence (verbatim) |
|---|---|---|
| O01-control: PAT reaches Management API | pass | `GET /projects` 200 |
| O01a: authorize with bogus client_id | HTTP 422, no redirect | `{"message":"Unrecognized client_id"}` |
| O01b: authorize well-formed (PKCE, state), no session | HTTP 422, no redirect | `{"message":"Unrecognized client_id"}` |

Read: client validation fires BEFORE session validation - an unknown
client_id gets a JSON 422, not a redirect to login, so the no-session
redirect behaviour is only observable once a real client_id exists (the
drill). The lifecycle rows (refresh grant shape, Management API access
with the OAuth token, revoke time-to-effect) are built and self-skip with
the reason until the drill supplies them.

## 2026-08-17 - O02 green: the contract-gated edge, measured

Run artifact: `evidence/run-2026-08-17T22-51-31-586Z.{json,md}` (local).

| Probe | Result | Evidence (verbatim) |
|---|---|---|
| O02a: POST /v1/oauth/authorize/project-claim with a Pro-org PAT | HTTP 404 | `{"message":"Cannot POST /v1/oauth/authorize/project-claim"}` |
| O02b: jwt-bearer grant, no client_id | HTTP 422 | `{"message":"Required parameter: client_id"}` |

Read: the claim route is not merely forbidden for a normal org, it does not
exist for the credential class (404, not 403). The jwt-bearer grant validates
parameters before any gating - reaching the actual plan gate needs a
client_id, which is what the manual drill supplies.

## 2026-08-18 - O03 green: the project's own OAuth IdP, and client_id in RLS, headless

A different OAuth surface from O01/O02: the PROJECT's own OAuth 2.1
authorization server (Supabase-as-IdP for third-party apps). The
shared-tenancy guide carried "tokens issued through it carry a `client_id`
claim, usable in RLS" as documented-not-tested. This run executes the whole
flow headless on a throwaway project (artifact: `evidence/run-2026-08-18T04-31-39-932Z.{json,md}`).

| Probe | Result | Read |
|---|---|---|
| O03-control | pass (175s to healthy, config PATCH 200) | `oauth_server_enabled` + `oauth_server_authorization_path` settable via `PATCH /v1/projects/{ref}/config/auth` |
| O03a | info | OAuth client registered via `POST /auth/v1/admin/oauth/clients` (needs BOTH `apikey` and `Authorization` headers) |
| O03b | pass: client_id claim present, aud=authenticated, scope=email | the consent flow is fully headless: GET authorize (302 -> authorization_id) -> GET `/oauth/authorizations/{id}` (binds the user) -> POST `.../consent {action:"approve"}` -> code -> token with `client_secret_basic` + PKCE (PKCE is REQUIRED even for confidential clients) |
| O03c | info: visible_with_matching_client=1, hidden_with_other_client=1 | an RLS policy on `auth.jwt() ->> 'client_id'` shows the row to the matching client's token and hides it from a second client's token for the same user |

Read: the second scoping dimension is real and works exactly as documented -
one shared project can distinguish third-party client applications in RLS,
not just users.

## 2026-08-18 - O01 lifecycle green: the full BYO OAuth token story, measured

After the manual drill (OAuth app registered with Organizations:Read +
Projects:Read, consent approved via the localhost listener):

| Probe | Result | Read |
|---|---|---|
| O01c: refresh_token grant | pass: 200, `expires_in: 86400`, `token_type: Bearer`, new refresh token returned | access tokens live 24h and refresh ROTATES the refresh token - a platform must persist the new one or lose the grant |
| O01d: Management API with the OAuth token | orgs 200 (1 org), projects 200 (3 projects) | the grant is org-scoped: the token sees exactly the one org approved at consent (3 standing projects), not the account's other orgs |
| O01e: revoke | 204, refresh grant immediately 404, time-to-effect 0s (first poll) | revocation is instant and the revoked refresh token answers 404, not 401/400 |

The full Path B loop is now measured end to end: register (dashboard-only)
-> authorize (422 client validation first) -> consent -> code -> token ->
refresh rotates -> org-scoped access -> revoke kills instantly.

## 2026-10-13 - O03 re-run for the explicit Data API grants (#128): fails before the grant runs

Task 20 of `docs/plans/2026-10-13-lab-backlog-waves.md` added `grant select,
insert, update, delete on table public.o03_docs to anon, authenticated,
service_role` to O03c's setup SQL. Two runs, local vantage, Pro org,
ap-southeast-1, run from source at lab commit 8ec7f86, each project
provisioned and deleted by the module. Artifacts are private (no
`publish-evidence` target here): `evidence/20261013-114454/run-2026-10-13T03-44-55-057Z.json`
and `evidence/20261013-114559/run-2026-10-13T03-45-59-555Z.json`.

| Probe | 2026-10-13 (both runs) | 2026-08-18 |
|---|---|---|
| O03-control | pass, `provision_s` 12, auth config PATCH 200 | pass, 175 s, PATCH 200 |
| O03a | admin user create 200 | info (client registered) |
| O03b | FAIL: `flow failed: consent=404 token=0`; no `client_id` claim | pass: `client_id` present, aud=authenticated, scope=email |
| O03c | skip: "no OAuth token" | visible_with_matching_client=1, hidden_with_other_client=1 |

The grant statement never executed: O03c skips before its setup SQL, so this
re-run says nothing about the #128 grants, and O03 no longer reproduces its
2026-08-18 result. The 404 is from either the authorize call or the consent
call: `runFlow` returns the authorize response's status in `consentStatus`
when no `authorization_id` is found, and the artifact does not separate them.
The routes still exist upstream (`GET /oauth/authorize`, `GET
/oauth/authorizations/{authorization_id}`, `POST .../consent` in
supabase/auth `internal/api/api.go` on the default branch, read 2026-10-13),
and the authorization id is still lowercase base32, which the module's
`[a-z0-9]+` match covers. One untested candidate: the flow starts within
seconds of the auth config PATCH, and the module does not wait for the
config to apply; with provisioning now reading healthy at the first 10 s
poll, the whole run took 13-14 s. Cause not established.

Correction (2026-10-26, entry below): `consentStatus` also carried the
client registration's status when registration failed, so the 404 could
have come from any of three calls (registration, authorize, consent). In the
2026-10-26 re-run's two no-wait runs the same failure was at registration
(`register_status` 404); that the 2026-10-13 404 was also the registration
is inferred from the matching timing, not separable from the 2026-10-13
artifacts.

## 2026-10-26 - O03b: the no-wait 404 is the client registration while discovery still answers 404; with a wait for discovery 200, O03b passes and O03c scopes (visible 1, hidden 1)

Question: which call answered the 2026-10-13 `consent=404`, and does it go
away once the auth config PATCH has applied.

Module changes, in this order: (1) `runFlow` records each step's status in
its own column (`register_status`, `authorize_status`,
`authorization_status`, `consent_status`, `token_status`; 0 = not reached)
and the first failing step's error code and message (`lib/flow-steps.ts`,
unit-tested), and O03-control reads the project's RFC 8414 discovery
document (`/.well-known/oauth-authorization-server/auth/v1`) once right
after the PATCH; (2) O03-control then polls that document every 2 s, budget
300 s, until it answers 200, and only then starts the flow. Runs 1-2 used
(1) only; runs 3-4 used (1) and (2). Nothing else changed between them.

Four runs, `make probe` equivalent (`--only O03 --experiment byo-oauth`),
local vantage, Pro org, ap-southeast-1, lab commit adc597c plus
uncommitted module changes: runs 1-2 ran change (1) alone, runs 3-4 ran (1)
and (2); `labCommit` reads adc597c in all four artifacts and does not
separate them. Other agents were running live work from the same Mac.
`oauth_ready_ms` is measured from the PATCH response to the arrival of the
first discovery 200, including each request's round trip; with requests 2 s
apart it bounds the apply delay from above (the second request, a little
over 2 s in, still answered 404). Each run's project was created and deleted by the module;
no `o03-idp` project remained in `GET /v1/projects` afterwards. Published
(redacted) under `out/2026-10-26/`:

- run 1 `run-2026-10-26T07-01-01-641Z.json` (no wait)
- run 2 `run-2026-10-26T07-01-31-048Z.json` (no wait)
- run 3 `run-2026-10-26T07-02-06-582Z.json` (wait)
- run 4 `run-2026-10-26T07-02-28-677Z.json` (wait)

| Row | Runs 1, 2 (no wait) | Runs 3, 4 (wait) |
|---|---|---|
| O03-control `provision_s` (create to end of O03-control; in runs 3-4 it includes the discovery wait) | 12, 12 | 16, 16 |
| `discovery_after_patch_status` | 404, 404 | 404, 404 |
| `oauth_ready_ms` (first discovery 200 after the PATCH returned) | not polled | 4322, 4313 (`oauth_ready_polls` 3, 3) |
| O03b `register_status` | 404, 404 | 201, 201 |
| O03b `authorize_status` / `authorization_status` / `consent_status` / `token_status` | 0 (not reached) | 302 / 200 / 200 / 200 in both |
| O03b | FAIL: `flow failed at register HTTP 404 (feature_disabled: OAuth server is disabled)` | pass: `client_id_claim` 1, `aud` authenticated, `scope` email |
| O03c | skip: "no OAuth token" | `policy_status` 201, `visible_with_matching_client` 1, `hidden_with_other_client` 1, `client_b_token` 1 |

In these four runs `provision_s` was computed after the discovery read (and,
with the wait, after the poll loop), so the 4 s more in runs 3-4 matches the
4322 and 4313 ms discovery wait. The module now takes it at the PATCH response again, the span
the 2026-08-18 and 2026-10-13 figures cover; the published runs used the
longer span.

- In runs 1-2 (no wait) the 404 came from `POST
  /auth/v1/admin/oauth/clients`, the first call of the flow. Its error code
  and message were the same `feature_disabled: OAuth server is disabled` that discovery answered right
  after the PATCH in all four runs (the PATCH itself answered 200 in all
  four). The authorize and consent
  routes were not reached.
- Waiting for discovery to answer 200 was the only change, and with it every
  step answered (register 201, authorize 302, authorization 200, consent 200,
  token 200) in both runs. The first 200 came on the third discovery
  request (the right-after read counts as the first; `oauth_ready_polls` 3),
  4322 and 4313 ms after the PATCH returned. cross-project-auth X09 measured 5149,
  5263 and 5119 ms on 5 s polls on 2026-10-23, and its unpublished run 1 (10:36:42 UTC,
  cross-project-auth RUNLOG 2026-10-23) stopped at the same `404
  feature_disabled` on registration.
- The 2026-10-13 artifacts recorded only `consent=404 token=0`, which the
  old code also produced for a failed registration. Their timing matches
  runs 1-2 (healthy at the first poll, 13-14 s per run; runs 1-2 took 13.9
  s each), so a registration 404 is the likely reading for them as well.
  Inferred, not separable from those artifacts.
- Why 2026-08-18 passed with no wait is not established: that run took
  175 s to healthy and its artifact does not record the time between the
  PATCH and the registration.
- #128's explicit grant (in O03c's setup SQL, `grant select, insert,
  update, delete on table public.o03_docs to anon, authenticated,
  service_role`) was part of a setup batch that answered 201 in runs 3-4
  (`policy_status`, the status of the whole batch), and both OAuth tokens' REST reads
  answered with a JSON array (1 row for client A, 0 for client B); a 401,
  403 or 42501 body on either read would have scored 0 on that read's
  cell. The run did not
  revoke the platform's default grants first, so it does not show whether
  this grant is load-bearing.

Not run: O01c/d/e (they need the manual consent drill's inputs). The OAuth
2.1 server docs were not re-read for a changed route: the registration 404
did not recur once discovery answered 200.
