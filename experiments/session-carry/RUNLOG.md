# RUNLOG - session-carry

Two Supabase projects, no AWS. Answers: when an app moves from one Supabase
project to another, what does it take for sessions that already exist to
survive? The plan under test has three parts: import one self-supplied
signing key into both projects, copy each user's rows from the auth tables,
pin the client's `storageKey`. Each part carries a different piece of a
session. The modules vary the first two one at a time; `storageKey` was not
run (no browser).

`source` is the project the app moves off; `target` is where it lands. The
harness passes `ctx.ref` as the source and `ctx.peers.target` as the target.
An optional third project in a different organization (`ctx.peers.xorg`)
serves S01x only.

What was already measured elsewhere and is not repeated here:

- A refresh token only refreshes at a project whose `auth.refresh_tokens`
  holds it (cross-project-auth X03: `400 refresh_token_not_found` at the
  project that did not issue it).
- Copying users, identities, sessions and refresh_tokens in FK order, with the
  target assigning `refresh_tokens.id` and `auth.refresh_tokens_id_seq`
  resynced, lets the held refresh token mint a session at the target with no
  password grant (tenant-promotion P01); a TOTP secret still verifies there
  (P02). The copy mechanics are imported from `tenant-promotion/lib/promote.ts`.

## 2026-09-25 - runs (Micro x2, ap-southeast-1, team org)

Three runs against one project pair, all on 2026-09-25:

| Run (UTC start) | Modules | Published |
|---|---|---|
| 02:37 | first version of S00-S04 | no - S01 and S02 were rewritten after it |
| 02:55 | S00-S04, the committed session-carry code except that S01 lacked `makeRoom` | `out/2026-09-25/run-2026-09-25T02-55-19-040Z.json` |
| 02:56 | S01 only, with `makeRoom`, with the xorg peer | `out/2026-09-25/run-2026-09-25T02-56-35-467Z.json` |

The `labCommit` both artifacts record (61f2dc2) predates this experiment: the
session-carry code was uncommitted when they ran, and the commit that adds it
is the pin.

The xorg peer was a free-plan project in a second organization under the same
account, created through `POST /v1/projects` (a free-plan org rejects
`instance_size`, so tofu cannot provision it) and deleted the same session.

### S00 - control: different keys, token refused (02:55 run)

At the 02:55 run the two projects signed with different ES256 kids. The
source's was 3b51e255, no longer its original project-generated key 3da31688,
because the 02:37 run and ad-hoc probes had rotated it. A source access token
presented to the target:

- PostgREST: `401 PGRST301` "No suitable key was found to decode the JWT".
- Auth `/user`: `403 bad_jwt` "... unrecognized JWT kid ... for algorithm ES256".

### S01 - one imported key on both projects (02:56 run)

The plan's first step assumes a private key can be imported into both projects
under one kid. It cannot.

| Probe | Result |
|---|---|
| S01a imported key into the source, promoted to `in_use` | import 201, kid preserved, promote 200 |
| S01b the same JWK (same kid) into the target | `409` `Signing key with kid "..." already exists` |
| S01x different key material, same kid, into the project in the other org | `409`, same message |
| S01c the same private material under a fresh kid into the target, promoted | import 201, promote 200 |
| S01d source issues tokens with the imported kid | first seen 5190 ms after polling began (5 s step, 600 s budget); polling began after S01c, not at the S01a promotion |
| S01e target JWKS publishes its own kid for that material | 450882 ms after polling began (10 s step, 600 s budget); polling began after S01d, not at the S01c promotion |
| S01f target PostgREST, source token, after S01e | `401 PGRST301` |
| S01g target Auth `/user`, same token | `403 bad_jwt` "unrecognized JWT kid ... for algorithm ES256" |
| S01h target refresh, source refresh token, no rows copied | `400 refresh_token_not_found` |

Read:

- A kid is unique beyond one project, at least while one project holds it
  `in_use` (other key states not run). S01b refuses it on a second project in
  the same organization; S01x refuses it in a different organization, with
  different key material, so the check is on the kid alone. Both projects
  involved were under one account; whether the check spans accounts was not
  run.
- Identical key material under a different kid does not make the target accept
  the source's tokens. Auth's error names the cause (it looks the key up by
  kid). PostgREST refused after the target's JWKS was already publishing the
  target's kid for that material; that it also looks up by kid is inferred,
  since `PGRST301` is equally consistent with a verifier cache that had not
  picked the new key up yet.
- So on the hosted platform no signing-key arrangement lets the target accept
  an access token the source already issued: kids cannot be shared (S01b,
  S01x) and shared material under a new kid is refused (S01f, S01g).
  Third-party-auth trust is a different mechanism: cross-project-auth X02
  measured a spoke's PostgREST accepting a hub token once the hub was
  registered via `oidc_issuer_url`. It was not probed here, and Auth `/user`
  under it was not measured. Without it, the only piece of a live session that
  crosses is the refresh token, via the row copy.

Two constraints turned up on the way, neither of them the question:

- A project holds at most three `previously_used` keys. The 02:55 run's S01a
  was refused `422` "There already are 3 previously used signing keys. To
  proceed first revoke at least 1." Before importing, S01 now revokes the
  oldest non-HS256 `previously_used` key on any project that already holds 3
  (`makeRoom` in `lib/carry.ts`; in the 02:56 run, source=3da31688
  target=c0e41060). It never revokes the HS256 legacy secret, which signs the legacy anon and
  service_role API keys the harness uses.
- A signing-key create on the source answered `429` once, in an ad-hoc probe
  outside the harness; a create on the same project about a minute later was
  201. S01 retries 429 only. One occurrence; cause and window not measured.

### S02 - rows copied, keys differ (02:55 run)

This is the shape a hosted move actually gets. Session created at the source,
five tables copied, sequence resynced:

| Probe | Result |
|---|---|
| S02a target Auth `/user`, held source access token | `403 bad_jwt` "unrecognized JWT kid" |
| S02b target PostgREST, same token | `401 PGRST301` |
| S02c target refresh, held refresh token | 200 |
| S02d `iss` before / after that refresh | source / target |
| S02e target Auth `/user`, refreshed token | 200, same user id |

The access token a browser holds at cutover is useless at the target, at both
PostgREST and Auth, until the client refreshes. The session survives because
the held refresh token refreshes at the target (S02c).

### S03 - refresh at the source after the copy (02:55 run)

Login at the source gives R1; rows copied (target holds R1, unrevoked); a
refresh at the source turns R1 into R2.

| Probe | Result |
|---|---|
| S03a R2 at the target | `400 refresh_token_not_found` |
| S03b R1 at the target | 200 |
| S03c R2 at the source | 200 (gives R3) |
| S03d R1 at the source, 12 s after S03c | `400 refresh_token_already_used` |
| S03e R3 at the source, after S03d | 200 |
| S03f the target lineage from S03b, after S03d | 200 |

Read:

- A client that refreshed at the source after the copy holds a token the
  target never saw, and is signed out with `refresh_token_not_found`. Reuse
  detection does not come into it at the target.
- A client still holding the pre-copy token refreshes at the target even
  though the source already revoked it. From that point one session has two
  live lineages, one per project (S03c and S03b both 200).
- Presenting R1 again at the source 12 s later was refused, but R3 still
  refreshed afterwards (S03e), so this reuse did not revoke the session's
  other tokens. One trial; the conditions under which GoTrue's reuse
  detection revokes the whole session were not explored.

### S04 - does aal2 survive a target refresh? (02:55 run)

Two users, each stepped up to aal2 with a TOTP factor at the source (the source
held 2 `mfa_amr_claims` rows for each), then copied:

| Variant | aal before | aal after refresh | amr after |
|---|---|---|---|
| S04a five tables | aal2 | aal1 | none |
| S04b five tables + `auth.mfa_amr_claims` | aal2 | aal2 | password+totp |
| S04c control: S04a's refresh token refreshed at the source, not the target | - | aal2 | - |

The five-table copy moves the factor but not the record of how the session
authenticated, so the first refresh at the target silently downgrades the
session to aal1 with no `amr` claim (`amr_after` none). Inferred, not probed:
an app whose RLS or routes require aal2 would lock those users out of
MFA-gated paths until they re-verify. Copying
`auth.mfa_amr_claims` (after `auth.sessions`, since it references it) keeps
aal2.

## What this does NOT answer

- `storageKey` pinning. It is a client-side setting and this experiment has no
  browser. Not run.
- Whether first-party JWT verification checks `iss`. S02d shows `iss` switches
  on the first target refresh, and on hosted the pre-refresh token is refused
  on kid anyway (S02a/b), so the question does not arise here. Reading
  `@supabase/auth-js` 2.117.1 source (upstream, not the 2.112.3 in this
  repo's bun.lock), `getClaims` checks the signature by kid and
  `exp` and does not read `iss`; that is source-reading, not a measurement.
- OAuth / OIDC identities. Password users only, as in tenant-promotion.
- The other auth tables: `one_time_tokens`, `flow_state`, `mfa_challenges`,
  SSO and SAML tables, `audit_log_entries`. Not copied, not probed.
- Whether kid uniqueness spans accounts. Both orgs tested belong to one
  account.
- Lowering the target's JWT expiry before cutover to shrink the window in
  which held access tokens fail. It follows from S02a/b, but it is an
  inference, not a measurement.

## Cost / teardown

Two Micro projects from provisioning (start not recorded) to 03:04 UTC, runs
spanning 02:37-03:04 UTC, plus one free-plan project, all deleted the same
session (`make destroy`, and `DELETE /v1/projects/{ref}` for
the free-plan one).
