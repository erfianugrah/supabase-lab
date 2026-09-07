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
