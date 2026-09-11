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

Not settled here: the managed platform's side of the hook. That
`hook_before_user_created_enabled`, `_uri` and `_secrets` are fields on
`UpdateAuthConfigBody` is read from the published Management API document, not
probed - IT02 and IT03 are the managed-vantage modules for that and have not
been run. Nothing Apple-specific is settled either: the audience rule across a
Services ID and a bundle ID, and Apple's own `/auth/usermigrationinfo`
exchange, still need a real Apple team and app.

## Code changed on 2026-09-11 that has NOT been run

Three things in this experiment are written and typecheck but have no run
behind them. They are not "not re-run"; for IT02 and IT03 there was never a
first run.

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
