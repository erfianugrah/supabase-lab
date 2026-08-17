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
