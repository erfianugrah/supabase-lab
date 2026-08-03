# RUNLOG - cross-project-auth

Two Supabase projects, no AWS. Answers the question a tiered-tenancy design
rests on: can one project's identity be trusted by another, so a tenant moved
between projects keeps the token it already holds?

`hub` plays the identity provider - its GoTrue issues the tokens. `spoke`
plays the tenant's own project, configured to trust the hub. The names avoid
"shared"/"dedicated" because the trust question is independent of whichever
tenancy model sits on top of it.

Two things were being asserted rather than measured before this run:

1. The third-party-auth endpoint takes three config shapes
   (`oidc_issuer_url`, `jwks_url`, `custom_jwks`). A prior lab measured that
   `custom_jwks` is accepted and never works, and that `jwks_url` works. It
   never tested `oidc_issuer_url`, which was nonetheless written up as
   "likely the better choice" - a recommendation with no evidence under it.
2. Portability had a control - a token signed with a key the target does not
   trust was refused - but not the strongest available one. That control varies
   the TOKEN, so it leaves open whether the accepted token was accepted for the
   reason claimed. Varying the target's CONFIGURATION instead, with the token
   held byte-identical, closes that. (The guide's other control, "an anon key
   gets nothing", proves less than it looks: an anon bearer is signed by a key
   the target DOES trust and is stopped by grants and RLS, so it says nothing
   about signature validation at all.)

## 2026-08-03 - run 1 (Micro x2, ap-southeast-1)

Harness: `make probe` -> `pvlab --where local --destructive --only X01,X02`.
Both tests are `local` because the question is what the auth tier accepts over
the public API - no VPC, no runner; the PAT and two project refs are the whole
input. Run twice end to end, plus three X02-only repeats after tightening the
poll interval. Numbers below are the spread.

### X01 - which config shapes resolve

Resolution is the observable: `resolved_at` populated and `resolved_jwks`
non-null. A shape that never resolves is a shape whose tokens fail at request
time with `PGRST301`, long after the configuration looked correct.

| Shape | Create | Resolved | Time |
|---|---|---|---|
| `oidc_issuer_url` | 201 | yes | 59ms, 249ms |
| `jwks_url` | 201 | yes | 81ms, 79ms |
| `custom_jwks` | 201 | **no** | still null at 92.9s / 92.1s |

- `oidc_issuer_url` resolves, and it resolves ON the create response - the
  gap in the tenancy guide is closed, and the recommendation it carried
  without evidence turns out to be right. Both working shapes resolve to the
  same key material (identical `kid`, ES256), so the choice between them is
  about which URL you would rather hard-code, not about capability.
- `custom_jwks` reproduces the prior lab's finding on a fresh project pair:
  accepted with 201, key material echoed back intact on a later GET,
  `resolved_at` still null after 92s. It is not a slow path, it is a dead one.
- `type` comes back as `custom` for all three shapes, so the response field
  does NOT tell you which shape a given integration was created with. Read
  `oidc_issuer_url` / `jwks_url` / `custom_jwks` themselves.
- The hub's own OIDC discovery document is served and advertises `jwks_uri`,
  which is what makes the issuer form work at all. Its
  `grant_types_supported` is `authorization_code,refresh_token`.

### X02 - portability under three trust states

Design: ONE token, three trust states, in order, so acceptance is
attributable to the trust configuration and nothing else. The bytes of the
bearer are identical throughout.

| State | Expectation | Measured |
|---|---|---|
| No trust configured on the spoke | refused | `401 PGRST301` "No suitable key was found to decode the JWT" |
| Hub registered via `oidc_issuer_url` | accepted | accepted, `[]` (spoke empty) - 1038 / 1155 / 1169ms after the create |
| Slice copied to the spoke | reads it | 2 rows with the ORIGINAL token, no re-login |
| Trust deleted | refused again | `401 PGRST301` - 652 / 587 / 654ms after the delete |

Plus the isolation baseline on the issuing project: tenant A sees its 2 rows,
tenant B sees only its own 1 row, so RLS on `app_metadata->>tenant_id` is
doing the scoping rather than the token being all-powerful.

Reading the timings: the poll interval IS the error bar (`stepMs` in
`tests/x02-token-portability.ts`). The first probe fires immediately after the
API call and still sees the OLD state in both directions, so neither change is
synchronous with the write; a later poll sees the new one. Trust propagates in
well under two seconds each way, and that is as precise as this method gets.
Do not quote these as a latency figure - quote the shape: sub-second-ish, not
instant.

The revocation direction is the operationally interesting half and it had
never been measured: deleting a third-party-auth integration stops the tokens
it was verifying, promptly. De-provisioning a tenant's trust is a real
control, not an eventually-consistent hope.

## Why the negative control matters here

"The token worked on both projects" and "the API is not checking signatures"
produce identical observations. A foreign-key token distinguishes them, and the
earlier lab ran that one. The pre-trust state is the stronger version of the
same control: it holds the token constant and varies only the target's
configuration, so it also rules out the possibility that the accepted token
differed from the refused one in some way nobody was tracking. Two controls
that fail in the same direction for different reasons is the point.

## What this does NOT answer

- Whether enabling the OAuth 2.1 Server on the hub changes the token shape
  (`client_id` / audience handling) and therefore whether the spoke still
  accepts it. The discovery document already advertises
  `authorization_code`, so the surface exists; untested.
- Whether an `aud` mismatch is enforced. Both projects accepted the token
  with GoTrue's default `authenticated` audience; nothing here varies it.
- Refresh. The spoke trusts the hub's signing key, so it can VERIFY a token,
  but a refresh goes to the hub's `/token` endpoint. A promoted tenant still
  depends on the hub being alive at refresh time - which is the thing a
  "fully independent project" claim would need to address, and it is not
  tested here.
- Anything about Storage or Realtime accepting a foreign-issuer token. Only
  PostgREST was probed.

## Cost / teardown

Two Micro projects, ~20 minutes, destroyed same session. `make destroy`.
