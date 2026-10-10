# auth-providers - RUNLOG

Vantage for every row: one workstation (macOS, local Docker) in the lab,
the Management API at api.supabase.com, throwaway projects in ap-southeast-1.
Harness run from source (`bun harness/src/run.ts --where local`), lab commit
70e4244 plus the uncommitted files of this experiment. The Auth server
version is not exposed by the platform and was not recorded. supabase-js
2.112.3 (root lockfile); the browser is the Chromium that ships in the
Playwright container image named in `tests/au02-passkeys.ts`; AU02a records
its build in the `chromium` measurement.

All runs 2026-10-10 (UTC 00:09 to 00:27 for the artifacts cited below). n is
1 run per row unless a row says otherwise; each module created its own
`au-*` project on the Pro org (AU01 also one on a Free org) and
deleted it in `finally`. Artifacts are in the gitignored `evidence/`; they
are not published to `out/` yet (`make publish-evidence`), so the numbers
below are pasted from the harness's facts renders and the publish step is
open. Latencies are in milliseconds where a row says "in ms".

Sources for the "docs say" column (read 2026-10-10 through the Supabase docs
search tool, not the blog post): https://supabase.com/docs/guides/auth/custom-oauth-providers,
https://supabase.com/docs/guides/auth/passkeys (also the source of the `webauthn_credential_not_found` error-code row, re-read 2026-10-10),
https://supabase.com/docs/guides/auth/enterprise-sso/auth-sso-saml (the SAML plan statement, "Pro and above"),
https://supabase.com/docs/guides/platform/sso/testing-best-practices. The blog
post behind the feature announcement was not fetched (a guessed URL answered
404), so its claims are taken from the announcement text, not from the post.

## AU01 - custom OIDC providers (run 2026-10-10 00:14 UTC, artifact au01-final2)

Rig: `worker/issuer.ts` on Cloudflare Workers (RS256, per-run key, discovery,
JWKS, authorize/token/userinfo), registered through the Auth admin API
`POST /auth/v1/admin/custom-providers` with the project's `sb_secret_` key.
That route is not in the Management API OpenAPI document (checked in
`api.supabase.com/api/v1-json`: no `custom-providers` path).

| row | docs say | measured |
|---|---|---|
| AU01a create | the discovery document is fetched from `{issuer}/.well-known/openid-configuration` and endpoints are resolved automatically (the page does not say what create does when the issuer cannot be reached; that part is measured only) | issuer `https://invalid.example.invalid`: 400 `validation_failed` "Unable to resolve hostname"; valid issuer: 201. Response keys: `acceptable_client_ids, attribute_mapping, authorization_params, client_id, created_at, custom_claims_allowlist, discovery_document, email_optional, enabled, id, identifier, issuer, name, pkce_enabled, provider_type, scopes, skip_nonce_check, updated_at`; the client secret is not echoed. Defaults: `pkce_enabled` true, `email_optional` false, `skip_nonce_check` false |
| AU01b quota, Pro | "Pro plan and above have unlimited custom providers" | Pro-org project: 1 provider existed, 2 more were created, the next create (the 4th provider) was refused: 400 `over_custom_provider_quota` "Maximum number of custom OAuth/OIDC providers reached". Total at refusal 3 |
| AU01b quota, Free | "Free plan projects can add up to 3" | Free-org project: 3 created, the 4th refused with the same code. Total at refusal 3 |
| AU01c update | "Update any provider fields except provider_type and identifier" | PUT (PATCH answers 405) with a changed `provider_type`: 200; with a changed `identifier`: 200; read back: `provider_type` still `oidc`, `identifier` still `custom:au-1`. The immutable fields are ignored, not refused. A `name` change: 200 and took |
| AU01d PKCE | "enabled by default (pkce_enabled: true)" | The Auth server's redirect to the issuer carried `code_challenge`, `code_challenge_method=S256` and `state`; the issuer verified the verifier at its token endpoint (the ID token carried `pvlab_pkce=S256-verified`, read back through `custom_claims_allowlist`). With `pkce_enabled=false` there was no `code_challenge` and the issuer saw `none`. The authorize redirect carried no `nonce` parameter in either case, and an ID token without a `nonce` claim was accepted. The Auth server presented the client secret by HTTP Basic (`pvlab_auth=basic`) although the lab discovery document advertised both Basic and post |
| AU01e email present | - | sign-in with `email` and `email_verified`: session; `app_metadata.provider` and the identity `provider` both `custom:au-1`; a second sign-in with the same `sub` gave the same user id |
| AU01f no email | "By default, providers must return an email address" | `email_optional=false`: the callback redirected with `error=server_error`, `error_code=unexpected_failure`, description "Error getting user email from external provider"; no session. `email_optional=true`: session, user `email` empty, `app_metadata.provider` `custom:au-1`, second sign-in same user id. The module retries the post-update sign-in up to 5 times 3 s apart; whether a retry was needed is not recorded |
| AU01g audience | `acceptable_client_ids` lists "additional client IDs that should be accepted for audience validation" | ID token `aud` = `stranger-client` (not the provider `client_id`): browser flow refused with "Error getting user profile from external provider" (no mention of audience); `signInWithIdToken` path: 400 "Unacceptable audience in id_token: [stranger-client]". Right `aud`: 200. After `PUT {acceptable_client_ids: [stranger-client]}`: browser flow signed in and `signInWithIdToken` 200. The browser-flow retry after the update (up to 4 times 3 s apart) is not instrumented either |

Two earlier AU01 runs (artifacts au01 and au01-final) gave the same quota,
update and audience results; they predate the `providers_before_loop` column.
Not measured: whether a Pro-plan limit above 3 can be granted (an
entitlement or a per-project setting). The competing reading is "default 3,
overridable", and the docs text says unlimited, so the 3 here is a measured
default on one Pro-org project, not a plan ceiling. `skip_nonce_check=true`,
`discovery_url`, `authorization_params`, `attribute_mapping`, the OAuth2
provider type, and what disabling a provider does to existing users were not
run.

Observation without a captured cause: an earlier AU03 attempt (artifact
au03-run2, 2026-10-10 00:08 UTC) got a 400 on the first provider create
against a Worker deployed seconds before, and the response text was not
recorded. The helper `createProviderWhenResolvable` now waits on a "resolve"
message; the later runs show `issuer_resolvable_after_s` 0 and 1 attempt, so
the delay did not recur and its cause (workers.dev name propagation or
something else) is not established.

## AU02 - passkeys (run 2026-10-10 00:13 UTC, artifact au02-final)

Rig: Playwright container, headless Chromium, CDP `WebAuthn` virtual
authenticator (ctap2, internal, resident key, user verification on), page
served by request interception at `http://localhost:3000`, supabase-js with
`auth.experimental.passkey`. Config through `PATCH /v1/projects/{ref}/config/auth`
(`passkey_enabled`, `webauthn_rp_id`, `webauthn_rp_origins`, `webauthn_rp_display_name`).

| row | docs say | measured |
|---|---|---|
| AU02a disabled | error `passkey_disabled` | `registerPasskey` after a password sign-in on the default config: `passkey_disabled`, HTTP 404, "Passkeys are disabled" |
| AU02b happy path | register, then sign in with no email prompt | `rp_id=localhost`, origin `http://localhost:3000` accepted (200; the options showed `rpId` localhost 3 s after the patch). `registerPasskey` ok, data keys `created_at, friendly_name, id`, `friendly_name` "Passkey". `signInWithPasskey` after sign-out: session for the same user id, `amr` `[{"method":"passkey"}]`. Admin list: 200, row keys `created_at, friendly_name, id, last_used_at`, `last_used_at` set after the sign-in. The exported credential's `rpId` was `localhost` |
| AU02c origin outside `webauthn_rp_origins` | each origin's hostname must match or be a subdomain of the RP ID | page at `http://localhost:3001` with the credential imported: `startAuthentication` options carried `rpId` localhost; `signInWithPasskey` and `registerPasskey` both failed at the server, 400 `webauthn_verification_failed` "Credential verification failed". The browser raised nothing (localhost on any port is valid for an RP ID of localhost) |
| AU02d RP ID not a suffix of the page host | RP ID is the bare domain | `webauthn_rp_id=example.com`, origin `https://example.com` (patch 200), page `http://localhost:3000`: the browser refused both calls with `SecurityError` ("The RP ID "example.com" is invalid for this domain"); the error carried no HTTP status, so no verify request reached the server |
| AU02e RP ID changed after enrolment | "Changing the RP ID makes every existing passkey unusable" | `webauthn_rp_origins` `http://app.localhost:3000` (a non-loopback http origin): patch 400 `WebAuthn RP origin "http://app.localhost:3000" must use HTTPS (HTTP is only allowed for localhost/127.0.0.1)`. Then `rp_id=example.com` with the page served at `https://example.com` (the value was already set by AU02d, so the `rp_visible_s` of 0 in this row says nothing about propagation): the credential bound to `localhost` could not be used (`NotAllowedError`, raised by the browser, no HTTP status); a fresh registration under the new RP ID worked and signed in |
| AU02f admin API | the admin endpoints need the secret key | `GET /auth/v1/admin/users/{id}/passkeys` with the publishable key: 401; with the secret key: 200. `DELETE .../passkeys/{id}`: 204 (count 2 to 1). Sign-in afterwards with the deleted passkey's credential still held by the authenticator: 400 `webauthn_verification_failed`, where the docs list `webauthn_credential_not_found` for a credential Auth does not know. One trial; the oldest enrolment (rpId localhost) was the one deleted |
| AU02g cap | error `too_many_passkeys` exists | 1 passkey existed, 9 more were registered (a fresh virtual authenticator each), the next was refused: 422 `too_many_passkeys` "Maximum number of passkeys reached". Total at refusal 10 |

An earlier run (artifact au02-run2) registered 10 in the loop because the
user then had no passkey left from the preceding row; the total of 10 is the
consistent figure. Not measured: unconfirmed, banned and anonymous users,
SSO users ("cannot register passkeys" per docs), `friendly_name` derived from
a real authenticator's AAGUID (the call passed a friendly name that the docs
page read here does not list as an option, and the returned name was
"Passkey"), rename and delete as the user, real platform or hardware
authenticators, Safari and Firefox, challenge expiry
(`webauthn_challenge_expired`), and replay of a used challenge.

## AU03 - canary (run 2026-10-10 00:09 to 00:20 UTC, artifact au03-run3)

Rig: lab issuer plus a custom provider `custom:canary`, one password user.
`signInWithIdToken` is `POST /auth/v1/token?grant_type=id_token` with
`provider=custom:canary` and an RS256 ID token minted by the test with the
same key the issuer publishes.

| row | measured |
|---|---|
| AU03a per method | password: 10 of 10 HTTP 200, latency in ms p50 / max: 104 / 223. `signInWithIdToken` with a custom provider: 10 of 10 HTTP 200, latency in ms p50 / max: 43 / 80. OAuth browser flow through the issuer (3 hops, redirects followed by hand): 4 of 4 sessions, latency in ms p50 / max: 111 / 126. `signInWithIdToken` accepts a `custom:` provider; the custom-provider docs page read here does not mention that path |
| AU03b error classes | wrong password and unknown user: both 400 `invalid_credentials`. ID token with a bad signature, expired, or wrong `iss`: all three 400 `invalid request` "Bad ID token" (not distinguishable). Wrong `aud`: 400 "Unacceptable audience in id_token: [someone-else]". Unknown provider: 400 `validation_failed` "Custom provider "custom:nope" not found". Provider disabled: 400 `provider_disabled` "Custom provider "custom:canary" is disabled" |
| AU03c session, client cut off from `/auth/v1` | `jwt_exp` 60 (patch 200; the OpenAPI document allows 0 to 604800). The block is a client-side `fetch` wrapper that throws for any `/auth/v1/` URL, so it simulates "Auth unreachable from this client", not a server-side fault. Before expiry: REST (`/rest/v1/canary`) 200 with the access token; `getSession` returned the session; `getClaims` succeeded (after one unblocked call that warmed it; whether it verified locally or by another route was not recorded); `getUser` failed (it calls `/user`). After expiry: REST still 200 at 8 s; the first non-200 sample was 38 s after expiry (401 PGRST303 "JWT expired"), polling about every 10 s, one trial, so the grace on this project lies between 8 and 38 s. `getSession` returned null with the fetch error (its auto-refresh was blocked), `getClaims` failed, and the storage still held the session (15 blocked calls, paths `/token` and `/user`). After unblocking, `refreshSession` with the stored refresh token succeeded and REST answered 200 again (the module retries up to 4 times 5 s apart; whether the first call needed a retry is not recorded) |
| AU03d global sign-out | `POST /logout?scope=global` 204. The access token issued before it: REST 200 before and 200 after; `GET /user` 403 `session_not_found`; refresh with its refresh token 400 `refresh_token_not_found`. PostgREST accepted the token on signature and expiry alone |
| AU03e IdP outage | the issuer Worker was deleted (delete ok). Password sign-in: 200, latency in ms 106. `signInWithIdToken` with a newly minted token and with one minted before the outage: 200 on all 17 polls spaced about 30 s apart, the last at 482 s (the earlier token is valid 600 s, so reuse beyond that was not tested). The OAuth browser flow got the Auth server's authorize redirect and then failed at the issuer: "issuer did not redirect: HTTP 404", latency in ms 89. The Auth server kept verifying against keys it already had for at least 482 s; which cache holds them (the Auth server or something in front of it) and its lifetime are not separated, and no refusal was seen to bound it |

The canary rows cannot say what the real incidents behaved like: the status page
lists five incidents for this cluster, one a
`signInWithIdToken` outage of 18.5 hours; nothing here induces a server-side
Auth fault (no lever), so AU03c and AU03e show what a client and a custom
issuer outage do, not a reproduction.

## AU04 - SAML SSO without a third-party IdP (run 2026-10-10 00:26 UTC, artifact au04-final)

Rig: provider created from metadata XML through
`POST /v1/projects/{ref}/config/auth/sso/providers` (`saml_enabled` patched
to true first; settled). The test is the IdP and the browser: it reads the
AuthnRequest ID from the `POST /auth/v1/sso` redirect (`skip_http_redirect`),
has `lib/saml-idp.mjs` (xml-crypto in a bun container) sign an assertion, and
POSTs the Response to the ACS. The IdP is never reachable from Supabase.
Pro-org project.

| row | measured |
|---|---|
| AU04a setup | enable patch 200 and `saml_enabled` true in the settings; provider create 201 (response keys `created_at, disabled, domains, id, saml, updated_at`); SP metadata 200; the SP entity ID and ACS equal `https://<project host>/auth/v1/sso/saml/metadata` and `.../sso/saml/acs` |
| AU04b valid sign-in | `POST /sso` 200; the ACS POST gave a session; 4 sign-ins, same user every time; ACS POST latency in ms, first and max of 4: 90 and 90; `app_metadata.provider` and the identity provider are `sso:<provider uuid>`; user email as asserted. Replaying the same Response: not signed in, `saml_relay_state_not_found` "SAML RelayState does not exist, try logging in again?" |
| AU04c negative controls | bad signature (signed with another key under the right certificate), unsigned assertion, wrong audience, expired conditions, wrong recipient: none signed in; all five redirect with `validation_failed` and a description that starts "SAML Assertion is not valid" and carries the whole SAML Response XML (2431 characters for the unsigned one, 4383 to 4409 for the others). The five cannot be told apart from the tail (it is the Response XML each time); the reason text, if any, sits in the middle of the description and was not captured, so each refusal is attributed to its variant by contrast with the accepted one, not read from a message. Two earlier runs (artifacts au04 and au04-run2) gave the same outcomes, with first-sign-in latency in ms 104 in au04-run2. An assertion for an email at a different domain than the provider's `domains` entry (`example.org` against `pvlab-idp.example.com`) signed in. An IdP-initiated Response (no `InResponseTo`, no RelayState) signed in |

Not measured: a real IdP (Okta or Entra needs an account), metadata URL
fetch and refresh, encrypted assertions, `attribute_mapping` beyond email and
a custom `sub`, SAML session lifetime and logout, provider quotas, an IdP
outage while a metadata URL is configured. SAML 2.0 support is on "plans Pro and above" per the
SAML docs page cited above; the module ran only on a Pro org, so the Free-org answer is not
measured.

## Cost and teardown

By my count of runs, 16 `au-*` projects were created over the day (13
on the Pro org, 3 on a Free org) with lifetimes from under 1 minute to about
11 minutes, each deleted by its module (cleanup rows `AU0Nz`) or by the
exploratory teardown script; micro compute, no add-ons. The spend was not
read from billing; by arithmetic it is a small fraction of 1 USD. Workers
named `au-iss-*` were deleted by their modules. A `GET /v1/projects`
after the last run listed no project with the prefix `au-`, and the
Cloudflare account listed no script named `au*`. The project count, the
lifetimes and these two listings are from the session, not from a saved
artifact; they are unverifiable from `evidence/` and should be read as the
author's account.
