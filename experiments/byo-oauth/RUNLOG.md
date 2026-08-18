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
