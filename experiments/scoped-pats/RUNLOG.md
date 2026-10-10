# scoped-pats RUNLOG

Chronological record of what was run. Org slugs and project refs are not
recorded here. Raw artifacts carry refs and stay off-repo.

Terms used below. "Lab token" is the `SUPABASE_ACCESS_TOKEN` the runs were
made with: a personal access token whose format class is `sbp_fc` (SP01d).
"Scoped token" is a token created in the dashboard with chosen resources and
permissions; no scoped token with a known, narrow scope was available in these
runs (see "Not measured"). "Docs" means the changelog
https://supabase.com/changelog/scoped-personal-access-tokens-ga (2026-10-06),
the guide https://supabase.com/docs/guides/platform/personal-access-tokens,
the Management API introduction (rate limits)
https://supabase.com/docs/reference/api/introduction, and the OpenAPI document
https://api.supabase.com/api/v1-json, all read on 2026-10-10 through a
summarising fetch, so quoted permission names and sentences are the fetch's
reading, not a verbatim copy. Neither the guide nor the changelog states a
rate-limit figure; the introduction page does (see SP10).

## 2026-10-10 - first runs (n = 1 per module; vantage: operator workstation, local; fixtures in ap-southeast-1)

Modules run: SP01, SP06, SP10 (read-only), SP02 and SP05 (one self-provisioned
fixture project each, deleted in `finally`), SP04 (two projects, deleted).
The project name prefix comes from `PVLAB_SP_NAME_PREFIX` (default `sp-`,
`lib/fixture.ts`). The code deletes what it creates in `finally`; a project
listing after the last run was not recorded, so "nothing left behind" is
unverified here.

### SP01 - creation surface (measured)

- SP01a: the OpenAPI document has 115 paths and 170 operations (sha256 prefix
  `fd277fd48c289e19`). No operation or path matches an access-token creation
  shape. The only token-named matches are the OAuth token and revoke routes
  and the project claim-token routes, a different mechanism. Control in the same
  run: `/v1/projects` and `/v1/organizations` are present. Scope of this
  result: the `/v1` document only; no other API version was read.
- SP01b: the route the dashboard uses, `GET /platform/profile/access-tokens`,
  answered the lab token `401 {"message":"Unsupported access token"}`.
  `GET /v1/profile/access-tokens` and `GET /v1/access-tokens` answered 404.
  Control in the same run: `GET /v1/organizations` 200. Only GET was sent, so
  the dashboard route's POST was not tried and no token was minted.
  Reading: creation is dashboard-only for a PAT caller. The route refusing the
  PAT on authentication does not show whether it would accept a dashboard
  session; that is inferred from the dashboard being the documented path.
- SP01c (document-derived, not enforcement): 164 of 170 operations declare
  `x-fga-permissions`; 73 distinct permission names; 19 distinct
  `x-oauth-scope` values. The six without: `GET /v1/projects/available-regions`,
  `GET /v1/oauth/authorize`, `POST /v1/oauth/token`, `POST /v1/oauth/revoke`,
  `GET /v1/profile`, `POST /v1/projects/{ref}/database/jit/invite/accept`.
  SP02 builds 59 probes from this list. The DNF reading used for prediction
  (outer list OR, inner list AND) is a hypothesis; the api-keys read declares
  both `[read]` and `[read, secret_read]`, which is consistent with it but does
  not test it.
- SP01d: the lab token has the `sbp_fc` format class. The docs say scoped
  tokens start with `sbp_fc`; this is the only format fact measured. Which
  scope the lab token was created with was not read.

### SP06 - profile and CLI with the lab token (measured)

- `GET /v1/profile`: 403 `{"message":"This endpoint requires a user-scoped
  access token"}`. This matches the earlier staging record in
  `experiments/s2z-wake/RUNLOG.md` for an org-scoped token, and the profile
  operation declares no permission in the OpenAPI document (SP01c).
- Supabase CLI 2.120.0 with the token in the child's environment and an empty
  temp HOME: `supabase whoami` exit 1 with `unexpected get profile status 403`
  and the same message; `supabase orgs list` exit 0 and `supabase projects
  list` exit 0, each printing 9 stdout lines (not stored). The changelog says "`supabase whoami` doesn't work with project- or
  organization-scoped tokens" (fetch's reading). The scope of the lab token was
  not read (SP01d), so this is consistent with the docs sentence but does not
  test it. The two list commands exit 0.
  Not separated: whether the refusal is "token is scoped" or "token lacks a
  user-level grant"; both read the same here.

### SP02-lab - permission sweep with the lab token (measured)

59 generated probes (GET on `{ref}`/`{slug}` routes, two `select 1` SQL calls,
api-keys with `reveal=true`) against one self-provisioned fixture project in
the Pro org: 53 returned 2xx, 0 returned 403 with `missing_permissions`, 0
returned 401, 6 returned another 4xx: `402` backup schedule, `400` custom
hostname, `406` JIT access, `410` logs-all, `400` restore point, `400`
available restore versions. These six look like the platform's answer for a
project without that feature (reasoned from the status codes, not read from
the bodies); none carries `missing_permissions`. So the probe list is usable
as a baseline, and no probe was refused for a missing permission, including the
secret-reveal read. That is weaker than "the token holds every permission
those probes need": for the six 4xx probes the permission check may not have
been reached, because a feature precondition could answer first. The SP04a
evidence for `GET /v1/organizations` lists 4 organizations, so the token
reaches more than one org (the 10 projects against 9 in the Pro org's own
listing agree).

### SP05-lab - SQL endpoints with the lab token (measured)

`select 1` through `POST /database/query` and `POST /database/query/read-only`:
201 and 201. `create table` through the read-only endpoint: 400 with
`ERROR: 25006: cannot execute CREATE TABLE in a read-only transaction`, table
absent when read back. `create table` through `/database/query`: 201, table
present. This is the control that makes a scoped read-only result readable.

### SP10 - what `x-ratelimit-remaining` counts (measured, one token)

Docs figure, from the Management API introduction page
(https://supabase.com/docs/reference/api/introduction, fetch's reading): "120
requests" per "1 minute", scope "Per user, per project or organization, per
endpoint", with "per-user, per-scope, per-endpoint isolation". The page also
lists `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`
headers. SP10 is consistent with the documented per-endpoint scope; it does not
discover it.

Measured: the limit header read 120 on the first response of SP10a, and 120/120
on the last SP04d pair (it was not recorded on every response). One route four
times: remaining 117,116,115,114, reset 41,39,38,37 (seconds). Two routes
alternated (`/organizations`, `/projects`): `/organizations` 113 then 112
(continuing the first sequence), `/projects` 118 then 117. So the header counts
per route (or per path bucket), not across all calls, as the docs' per-endpoint
wording says. A fixed 60 s window is suggested by `reset` falling by about one
per second; it was not probed past one window. Only the lab token was used, so
per-token vs per-user separation for the header is not measured; the docs say
per user, which these runs neither confirm nor contradict.

### SP04 - code-path check with the lab token standing in (measured, NOT the Q14 question)

`PVLAB_SCOPED_PAT_ORG` was set to the lab token to run the module end to end.
The numbers describe the lab token, not an Organization-Projects-only token.

- The token creates a project in the Pro org: 201, create_ms 3383 (create call
  to response). It lists it on the first poll (the 0.1 s recorded is the
  elapsed time of that one listing request, so the resolution is one request),
  reads it (200) and deletes it (200).
- A second project created afterwards (the module's owner arm, which also uses
  the lab token): 201, present in the listing on the first poll, direct read
  200. This arm separates nothing, because both sides are the same token.
- Account-level reads: `/organizations` 200, `/projects` 200 (10 entries),
  `/snippets` 200, `/profile` 403.
- Interleaved same-route reads, both calls with the lab token: remaining
  115,113,111,109 and 114,112,110,108, one counter falling by one per call.
  This matches SP10 and says nothing about two different tokens.

### Not measured, with the exact prerequisite

| item | status | missing |
|---|---|---|
| Org-scoped token on production (Q14: creates projects, sees later projects, request budget vs the owner token) | SP04 ready; run so far only with the lab token | `PVLAB_SCOPED_PAT_ORG`: dashboard-created, Pro org only, Organization Projects = Read-write |
| Per-resource x per-permission matrix; 403 `missing_permissions` body | SP02-ro/dbrw/narrow and SP03-* ready, skip without tokens | `PVLAB_SCOPED_PAT_RO`, `_DBRW`, `_NARROW` and a fixture project |
| SQL read-only without Database read-write | SP05-ro, SP05-dbrw ready | same tokens |
| Project boundary and later projects for a project-scoped token | SP09 ready | `PVLAB_SCOPED_PAT_RO` plus `PVLAB_PEER_FIXTURE`, `PVLAB_PEER_OTHER` |
| `supabase whoami` with a token of known narrow scope | measured only for the lab token (SP06) | `PVLAB_SCOPED_PAT_ORG`, `_RO`, `_NARROW` |
| Token follows the creator's current role | SP07 ready | a second human org member creating `PVLAB_SCOPED_PAT_MEMBER` and being demoted mid-run; role changes have no API on this plan (bu-attribution BA01a) |
| Seconds until a deleted token is refused | SP08 ready | `PVLAB_SCOPED_PAT_REVOKE`, deleted by the operator during the watch |
| Immutability after creation; expiry up to one year | not testable here | dashboard-only; no list or update route is reachable with a PAT (SP01b); doc-cited-not-tested |
| Contrast with a pre-GA classic token | SP02/SP06 ready | `PVLAB_LEGACY_PAT`, if the account still has one |

No token was created in a browser for these runs.

### Harness notes this run paid for

- The registry `harness/src/tests.generated.ts` is gitignored and, once it
  exists, is what `pvlab` runs from. A module added after the last
  `bun run gen` is silently absent: SP10 was missing from the first read-only
  run for that reason. `make registry` regenerates it.
- Bodies of account-level reads (org listing, SQL snippets) carry names; SP04
  now records statuses and counts only, after the first run stored a snippet
  title in a throwaway artifact.
