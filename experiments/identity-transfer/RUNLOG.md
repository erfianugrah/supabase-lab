# identity-transfer - RUNLOG

What the managed Auth server does when an OAuth identity comes back with a
NEW subject for an existing person. That is the shape an Apple Developer team
transfer produces: Apple's user identifier (`sub`) and private relay address
are both team-scoped, so after a transfer the same person arrives with a new
`sub` and, if they used a relay address, a new email. Apple cannot be minted in
a lab, so the module's cases drive the project's Keycloak provider slot: a
social provider whose issuer URL is a per-project setting
(`external_keycloak_url`; the Auth server appends
`/protocol/openid-connect/{auth,token,userinfo}` to it, performs no issuer
check and reads `sub`, `email`, `email_verified` from userinfo) fed by a
lab-controlled issuer worker (`worker/issuer.ts`). The account-resolution code
the cases exercise (`internal/models/linking.go`, `internal/api/external.go`
in the public supabase/auth repo) runs after every provider, Apple included.

## IT01 - new subject for an existing person: link, new user, or remap (2026-09-07, green, module)

Fresh micro project (ap-southeast-1, tofu-managed, provisioned and destroyed
the same day). Artifact:
`out/2026-09-07/run-2026-09-07T10-47-04-725Z.{json,facts.md}`, 7 pass, 0
fail (IT01z asserts the config restore and the sweep answered 2xx). Two
earlier runs the same day (10:36:19Z and 10:37:35Z, private evidence, not in
the repo) passed the same cases; they are superseded because the first one's
cleanup missed the IT01e shadow user described below, and in both the IT01d
sign-in after the rewrite reused the old email, which the email-link path of
IT01b would also have satisfied. The published run signs in with a different
email after the rewrite.

Setup: `PATCH /config/auth` with the Keycloak slot enabled and pointed at the
issuer worker, `site_url` set to a localhost callback so the final redirect
can be read; `/auth/v1/settings` reported `external.keycloak` false on the
first read and true on the second, 4 s after the PATCH began (poll interval
3 s, so the settle lies between the first read and 3 s; 3 s and 5 s in the
two earlier runs). The project had `mailer_autoconfirm=false` (email
confirmation required) and `security_manual_linking_enabled=false`, both as
provisioned by a fresh project with no auth config set. Each sign-in is the
browser flow followed by hand: `/auth/v1/authorize?provider=keycloak` (302),
the issuer's authorize endpoint with the case's persona appended (302 back
with a code), `/auth/v1/callback` (302 to `site_url` with tokens or an error
in the fragment). The user id is the `sub` of the returned access token.

| case | what arrives | result |
| --- | --- | --- |
| IT01a | subject a1, verified email a, first time | new user; one `auth.identities` row with `provider = keycloak`, `provider_id = a1`, and `identity_data.sub = a1` (`provider_id_equals_sub` true), `identity_data.email_verified` true |
| IT01b | subject a2, the SAME verified email a | the same user as a1; that user now has 2 identity rows |
| IT01c | subject b1 with email b1, then subject b2 with email b2 | two different users |
| IT01d | subject c1 with email c signs in; SQL rewrites its identity row to `provider_id = c2`, `identity_data.sub = c2` (1 row updated); subject c2 signs in with a DIFFERENT email c2 | the same user as c1, still 1 identity row (the email-link path of IT01b would have given 2 and needs a matching email, which c2 did not have). After that sign-in `identity_data.email` is the new address c2, `auth.users.email` and the `email` claim in the token are still the old address c. Control: c1 again with another email is a new user |
| IT01e | subject d1 with verified email d; then subject d2 with the same email but `email_verified = false` | no session: the callback redirected with `error=access_denied`, `error_code=provider_email_needs_verification`, "Unverified email with keycloak. Verify the email with keycloak in order to sign in". d1's user still has 1 identity. The refused sign-in left 1 identity row for d2 AND 1 user row whose `auth.users.email` is NULL and unconfirmed |
| IT01z | cleanup | 6 users deleted via the admin API, 1 more by a sweep keyed on identity subject or run-prefixed email (by count, the d2 shadow); auth config restored (HTTP 200) |

- **An identity is the pair (provider, subject).** `provider_id` and
  `identity_data.sub` are the same value (IT01a), and the lookup that decides
  "known user" is on that pair. A new subject is a stranger until something
  else says otherwise.
- **The something else is a verified email.** With a verified email that
  matches an existing user (linking.go: exactly one, non-SSO), the new subject
  is linked as a second identity on that user (IT01b): same user id in the
  token, two rows in `auth.identities`. This is what an Apple user who shared
  their real address gets after a team transfer, with no work on the Supabase
  side.
- **A different email is a different person.** IT01c is the relay-address
  case: Apple's private relay addresses are team-scoped ("different for the
  same user across apps written by different development teams", Apple's
  private email relay page), so a relay user arriving from the new team has a
  new `sub` AND a new email, matches nothing, and becomes a new user with none
  of the old rows.
- **Rewriting the identity row is enough, and it leaves the primary email
  alone.** After `update auth.identities set provider_id = <new>,
  identity_data = identity_data || {"sub": <new>}` the new subject arriving
  with a new email lands on the old user with one identity row (IT01d), and
  the old subject is a stranger again (the control). The sign-in refreshes
  `identity_data.email` to the new address; `auth.users.email` and the
  token's `email` claim keep the old one, so mail to that user still goes to
  the old relay address until `auth.users.email` is updated as well (admin
  update, not run here). No user row is touched by the rewrite, so
  `auth.users.id`, RLS ownership and foreign keys from `public` are unchanged.
  This is the Supabase half of Apple's transfer procedure: Apple's
  `/auth/usermigrationinfo` exchange returns the new `sub` (and, for relay
  users, the new relay email) for each `transfer_sub`; the rewrite above is
  what to do with the `sub`, and the email is the second column to carry over.
- **An unverified email did not link, and left a trace.** A provider that
  reports `email_verified = false` for an email an existing user owns gets
  `provider_email_needs_verification` (IT01e). The server still writes an
  identity row for the new subject and a user row with `email` NULL, so a
  cleanup or audit keyed on `auth.users.email` does not see it. Apple's ID
  token carries an `email_verified` claim; if it is true for the transferred
  user, this case marks the verification boundary and the transfer case is
  the verified one above (not measured here).

Not settled here: anything Apple-specific. The Apple parser in supabase/auth
(`internal/api/provider/oidc.go`) copies `transfer_sub` and `is_private_email`
into the provider claims' custom-claims map when the ID token carries them;
where they surface in `identity_data` was not run. Apple's
`/auth/usermigrationinfo` exchange is open for 60 days after the recipient
accepts the transfer; that, and the audience rule across a Services ID and a
bundle ID, need a real Apple team and app.

## ITL1-ITL3 - transfer_sub, the stored copies, and the hook (2026-09-11, green, local rig)

Self-hosted GoTrue, not the managed platform. `local/compose.yml` runs
`supabase/auth:v2.197.0` against a throwaway Postgres with the Keycloak slot
pointed at the same issuer worker IT01 uses, served over plain HTTP by Bun
(`local/issuer-server.ts` imports `worker/issuer.ts`, so there is one
implementation). The issuer shares the auth container's network namespace,
which is what lets GoTrue address both it and the Before User Created hook as
`127.0.0.1`: the hook config validator accepts `http` only for localhost,
127.0.0.1, ::1 and host.docker.internal
(`internal/conf/configuration.go`, `ValidateExtensibilityPoint`).

This vantage was chosen because all three questions are about the Auth
server's own code, and the four files they turn on -
`internal/models/linking.go`, `internal/api/hooks.go`,
`internal/api/provider/keycloak.go`, `internal/api/provider/oidc.go` - are
byte-identical between the `v2.197.0` tag and `master` as fetched on
2026-09-11. `GOTRUE_MAILER_AUTOCONFIRM` is false, matching the managed project
IT01 ran against, so `linking.go`'s first loop treats an unverified address the
same way in both. Artifact: `out/2026-09-11/run-2026-09-11T00-53-14-213Z.{json,facts.md}`,
14 pass, 0 fail. Two labels in that artifact are the harness's defaults rather
than facts about the rig: the region reads ap-southeast-1, and the rig has
none; and the lab-commit stamp reads a commit that a later history rewrite
replaced, so it resolves to nothing.

Apple is still not mintable. The Keycloak provider copies every userinfo claim
that is not sub/email/email_verified/name into the provider claims'
custom-claims map (`keycloak.go`), which is the field Apple's parser writes
`transfer_sub` to (`oidc.go`), and everything downstream is shared, so a lab
claim by that name travels the same path.

| case | what arrives | result |
| --- | --- | --- |
| ITL1a | subject c1, verified email c | new user |
| ITL1b | SQL sets `provider_id = c2` and leaves `identity_data.sub` at c1; c2 signs in with a different email | the same user, 1 identity row (`remap_rows` 1, `identity_data_sub_left_stale` true, `same_user` true) |
| ITL1c | the stored copies, either side of that sign-in | before: `raw_user_meta_data.sub`, `.provider_id`, `identity_data.sub` all old. After: `raw_user_meta_data` sub/provider_id/email and `identity_data` sub/email all NEW; `auth.users.email` and the token's email claim still old |
| ITL2a | subject e1 carrying `transfer_sub` | the claim is stored twice: `identity_data.custom_claims.transfer_sub` and `raw_user_meta_data.custom_claims.transfer_sub` |
| ITL2b | subject e2 whose `transfer_sub` is e1's exact subject, email matching nothing | a different user (`new_user` true) |
| ITL2c | e1 again with no `transfer_sub` | both stored copies absent; the `custom_claims` key itself survives on both rows (the issuer still sends `preferred_username`) |
| ITL3a | subject f1, no claim | created - the hook ran on CreateAccount and returned no error |
| ITL3b | subject f2 on f1's verified email, carrying a claim the hook refuses | a session on f1's user, 2 identity rows. Not refused |
| ITL3c | subject f1 again, carrying the same refusable claim | a session on f1's user. Not refused |
| ITL3d | a stranger carrying the refusable claim | no session: `error=access_denied`, no `error_code`, and the refusal message is the hook's own digest - `user_metadata` keys `custom_claims\|email\|email_verified\|full_name\|iss\|name\|phone_verified\|provider_id\|sub`, `custom_claims` keys `preferred_username\|transfer_sub`, `transfer_sub` matching what the issuer sent. 0 `auth.users` rows for that address afterwards |
| ITL3e | the same shape with a claim the hook accepts | created |

- **The lookup reads the `provider_id` column, not `identity_data.sub`.**
  ITL1b rewrote only the column and left the JSON copy pointing at the old
  subject; the new subject still landed on the old user with one identity row.
  IT01d rewrote both and so could not separate them. A remap runbook needs one
  column; writing `identity_data.sub` as well is tidiness, and the next
  sign-in overwrites it regardless.
- **Every claim copy repairs itself on the next sign-in except the primary
  email.** ITL1c: `raw_user_meta_data.sub`, `.provider_id` and `.email`, and
  `identity_data.sub` and `.email`, were all the new values after one sign-in,
  from the old ones immediately before it. `auth.users.email` stayed at the old
  address, and so did the `email` claim in the issued token. The
  AccountExists branch replaces `identity_data` wholesale and calls
  `UpdateUserMetaData`, which merges key-wise (`internal/api/external.go`,
  `internal/models/user.go`); nothing in it touches `user.Email`. So a
  migration that hand-patches `raw_user_meta_data` is doing work the server
  redoes, and one that skips `auth.users.email` leaves the project mailing a
  dead address.
- **`transfer_sub` is stored twice and read never.** ITL2a puts it on both
  rows; ITL2b hands the server a `transfer_sub` holding the old identity's
  exact subject, with an email that matches nothing, and gets a new user.
  `DetermineAccountLinking` takes `(emails, aud, providerName, sub)` and opens
  on `FindIdentityByIdAndProvider` (`linking.go`), so there is no branch for
  the claim to reach.
- **It is not a durable store either.** ITL2c: one sign-in without the claim
  and both copies are gone, because `identity_data` is replaced wholesale and
  the top-level `custom_claims` key in `raw_user_meta_data` is overwritten with
  the new map. Harvest transfer identifiers from Apple's endpoint during the
  60-day window; do not plan to read them back out of the database later.
- **The hook is armed by the CreateAccount decision alone.** ITL3b and ITL3c
  carried a claim that ITL3d proves the hook refuses, down the LinkAccount and
  AccountExists paths, and both got sessions - which is how "the hook did not
  run" is told from "it ran and was content". It fires for exactly the users
  who would otherwise become duplicates.
- **The payload carries the provider's custom claims.** ITL3d's digest is the
  hook's own report of what it was handed:
  `user.user_metadata.custom_claims.transfer_sub` was there, with the value the
  issuer sent, alongside `user.email`. A hook can therefore alarm on, or
  refuse, precisely the post-transfer users a remap missed.
- **Refusing leaves nothing behind.** 0 `auth.users` rows for the refused
  address (ITL3d), unlike the unverified-email refusal in IT01e, which left an
  identity row and a user row with `email` NULL.

Not settled here: the managed platform's side of the hook. The config fields
themselves (`hook_before_user_created_enabled`, `_uri`, `_secrets` on
`UpdateAuthConfigBody`) were later driven on a managed project by
security-lockdown S19d (2026-09-03): a Postgres-function hook refused a blocked
domain, active 5 s after the PATCH. Still unprobed on managed: an HTTP hook URI,
and whether the hook arms on CreateAccount only - IT02 and IT03 are the
managed-vantage modules for that and, as of 2026-09-11, had not been run (they
ran on 2026-10-23, last section). Nothing Apple-specific is settled either: the audience rule across a
Services ID and a bundle ID, and Apple's own `/auth/usermigrationinfo`
exchange, still need a real Apple team and app.

## Code changed on 2026-09-11, first run 2026-10-23

As written on 2026-09-11: three things in this experiment are written and
typecheck but have no run behind them. They are not "not re-run"; for IT02
and IT03 there was never a first run. All three ran on 2026-10-23 (next
section).

- **IT01 was edited after its 2026-09-07 run.** The sign-in flow and the
  config-settle poll moved verbatim into `lib/flow.ts` so IT02, IT03 and the
  local modules share one implementation, and IT01d gained four measurements
  that read `auth.users.raw_user_meta_data` either side of the post-remap
  sign-in. The 2026-09-07 artifact predates all of that, so it carries neither
  the new measurement keys nor any evidence the refactor is behaviour-neutral.
  The IT01 table above describes the run, not the current module. ITL1c
  measured the same question on the local rig.
- **IT02 and IT03 have never run.** They are the managed-vantage versions of
  the questions ITL2 and ITL3 answered locally: where a `transfer_sub`-shaped
  claim surfaces on a managed project, and whether the platform's
  `hook_before_user_created_*` config behaves as the local rig's environment
  variables do. IT03 additionally measures something the local rig cannot -
  how long a hook config change takes to reach the Auth server, which it polls
  for with fresh personas because `/auth/v1/settings` does not report hooks.
- Running all three needs a managed project and a PAT. `make up` then
  `make probe ONLY=IT01,IT02,IT03`.

## IT01 re-run, IT02, IT03 - managed micro, three runs (2026-10-23, green on runs 2 and 3)

Three fresh micro projects in ap-southeast-1 on the Pro org, one per run,
tofu-managed and destroyed after each run; they are numbered 1 to 3 in the
order they ran. Each run is one battery, `make probe ONLY=IT01,IT02,IT03`,
against the same issuer worker.

| run | artifact | result |
| --- | --- | --- |
| 1 | `out/2026-10-23/run-2026-10-23T08-17-21-218Z.{json,facts.md}` | 16 pass, 2 fail (IT03d, IT03z: module bugs, below) |
| 2 | `out/2026-10-23/run-2026-10-23T08-19-09-467Z.{json,facts.md}` | 18 pass, 0 fail |
| 3 | `out/2026-10-23/run-2026-10-23T08-19-57-569Z.{json,facts.md}` | 18 pass, 0 fail |

All three artifacts carry lab commit 661afdf, the checkout's HEAD. Runs 2 and
3 ran with an uncommitted fix to `tests/it03-before-user-created.ts` that
lands in the commit publishing these artifacts; IT01, IT02 and `lib/flow.ts`
were the same code in all three runs. Outside the artifacts (manual, driver
log only): `tofu apply` returned about 5 s after it started and the
per-service health endpoint reported auth, rest and db `ACTIVE_HEALTHY` on
its first poll, for all three projects.

The two IT03 fixes between run 1 and run 2:

- Turning the hook off sent `hook_before_user_created_enabled: false`
  together with `hook_before_user_created_uri: ""`. `PATCH /config/auth`
  answered 400 to that body both times run 1 sent it (IT03d and the IT03z
  cleanup); the response body was not recorded. The module now sends the
  enabled flag alone, which answered 200 in all 4 calls of runs 2 and 3, and
  IT03z reads `hook_before_user_created_enabled` back (false in runs 2 and 3).
  After run 3 the read-back check was tightened, not re-run: IT03z now passes
  only on a 200 GET that reports false, where runs 2 and 3 passed unless it
  reported true; both read false, so they pass either way.
  The two bodies differ only in the empty `uri` key, so the 400 is tied to
  that key; which validation rejected it is not known. Run 1's project was
  destroyed without the hook flag being read back after the 400.
- The fresh strangers were numbered from 1 in each poll, so run 1's IT03d
  poll opened by signing in IT03-setup's first stranger again: an existing
  user, the AccountExists path, a session after 1 s whatever the hook state.
  Run 1's IT03d therefore measured nothing about the hook being off. If the
  400 left the hook on (not checked), that session was one more AccountExists
  sign-in passing an armed hook, as in IT03c. Strangers are now numbered
  across the run. Run 1's IT03-setup and IT03a-c ran before the second poll
  and are unaffected.

IT01, refactored module, 3 of 3 runs. Every measurement the 2026-09-07 run
recorded has the same value in all three runs (`pvlab --diff` of the
2026-09-07 artifact against run 2: 34 measurements unchanged, 4 added, all
in IT01d), including the config settle: `external.keycloak` true on the
second `/auth/v1/settings` read, `settle_s` 4, at a 3 s poll interval. The
refactor into `lib/flow.ts` did not change what IT01 measures. The four new
IT01d keys, same in all three runs:

| key | value |
| --- | --- |
| user_metadata_sub_before_signin | c1 |
| user_metadata_sub_after_signin | c2 |
| user_metadata_provider_id_after_signin | c2 |
| user_metadata_email_after_signin | new |

So on the managed project, `raw_user_meta_data` keeps the old subject after
the SQL rewrite and takes the new subject, provider id and email at the next
sign-in, while `auth.users.email` and the token's email claim stay old
(`users_email_after` old, `token_email_after` old). That is what ITL1c
measured on self-hosted v2.197.0.

IT02, 3 of 3 runs, identical values in all three:

| case | what arrives | result |
| --- | --- | --- |
| IT02a | subject e1 carrying `transfer_sub` | a session; the claim is on both rows: `identity_data.custom_claims.transfer_sub` and `raw_user_meta_data.custom_claims.transfer_sub` present |
| IT02b | subject e2 whose `transfer_sub` is e1's exact subject, email matching nothing | a session on a different user (`new_user` true) |
| IT02c | e1 again with no `transfer_sub` | the same user as e1; both stored copies absent; `raw_user_meta_data` still has a `custom_claims` key |

The managed project agrees with ITL2a-c: the claim is stored twice, nothing
reads it to find an account, and one sign-in without it removes both copies.
IT02-setup reported `settle_s` 0 on 1 read in all three runs. That is not a
settle time: IT01z had restored `external_keycloak_enabled` to its original
false (HTTP 200) moments before, and a first read of true is either IT02's
PATCH reflected at once or IT01's restore not yet reflected. The run cannot
tell which.

IT03, HTTP hook at the issuer worker's `/hook/reject` and `/hook/allow`
routes over https. Setup and IT03a-c in 3 of 3 runs; IT03d and IT03z in runs
2 and 3.

| case | what happens | result |
| --- | --- | --- |
| IT03-setup | f1 signs in with the hook off; `PATCH /config/auth` enables the hook (HTTP 200, prior value false); fresh strangers sign in, one 3 s pause between attempts, until one is refused | f1 a session; the first refusal on attempt 2 in every run, 5 s after the PATCH in run 1 and 4 s in runs 2 and 3. Attempt 1, straight after the PATCH returned, was created |
| IT03a | that refused stranger, carrying `transfer_sub` | no session: `error=access_denied` and an empty `error_code`; the hook's digest of its payload: top-level keys `metadata\|user`, `user_metadata` keys `custom_claims\|email\|email_verified\|full_name\|iss\|name\|phone_verified\|provider_id\|sub`, `custom_claims` keys `preferred_username\|transfer_sub`, `transfer_sub` equal to what the issuer sent |
| IT03b | a new subject f2 on f1's verified email (LinkAccount), hook refusing | a session on f1's user |
| IT03c | f1 again (AccountExists), hook refusing | a session on f1's user |
| IT03d | `PATCH /config/auth` with the enabled flag alone set false (HTTP 200); fresh strangers until one is created | attempt 1 got no session, attempt 2 was created, 4 s after the PATCH (runs 2 and 3) |
| IT03z | cleanup | hook off HTTP 200, 3 users deleted via the admin API, 0 by the sweep, auth config restored HTTP 200, `hook_before_user_created_enabled` read back false (runs 2 and 3) |

- **The managed platform arms the hook on CreateAccount alone, as
  self-hosted v2.197.0 does (ITL3).** IT03b and IT03c signed in on the
  LinkAccount and AccountExists paths while the same hook refused every
  stranger, in 3 of 3 runs.
- **The payload carries the provider's custom claims.** The `user_metadata`
  and `custom_claims` key lists in IT03a are the same lists ITL3d recorded
  locally, and `transfer_sub` arrived with the value the issuer sent.
- **An https hook URI on an external host is accepted and called.** The
  config API took a workers.dev URI with a `v1,whsec_` secret (HTTP 200) and
  the Auth server called it. The worker does not verify the webhook
  signature, so whether the platform signs as standard-webhooks describes is
  not measured.
- **A hook change took effect within 4 to 5 s, in both directions.** On:
  the first sign-in after the PATCH was still created and the second, 4 or 5
  s after the PATCH, was refused (3 runs). Off: the first sign-in was still
  refused and the second, 4 s after, was created (runs 2 and 3). The
  resolution is one sign-in plus the 3 s pause; the pass band is 120 s.
  security-lockdown S19d saw a Postgres-function hook active 5 s after its
  PATCH on 2026-09-03.
- **To turn the hook off, send `hook_before_user_created_enabled: false`
  alone.** With `hook_before_user_created_uri: ""` beside it the config API
  answered 400 (run 1, 2 of 2 calls), and run 1 did not read the flag back.
  If a rejected PATCH leaves the hook on, which is the expected reading of a
  400 but was not checked, a cleanup that restores only the other auth keys
  leaves every new-account signup refused. Read the flag back after turning
  it off.

Not settled here: the Apple-specific half (the audience rule across a
Services ID and a bundle ID, Apple's `/auth/usermigrationinfo` exchange)
still needs a real Apple team and app. The hook's response body on refusal
is a digest the worker chose, so the full payload shape beyond those key
lists is not recorded. A Postgres-function hook was not run in this
experiment.
