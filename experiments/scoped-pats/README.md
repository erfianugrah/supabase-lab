# scoped-pats

What a scoped personal access token (the dashboard default since the GA
announced at https://supabase.com/changelog/scoped-personal-access-tokens-ga)
can and cannot do against the Management API, measured against what the
Personal Access Tokens guide
(https://supabase.com/docs/guides/platform/personal-access-tokens) and the
public OpenAPI document (https://api.supabase.com/api/v1-json) say.

Self-provisioning, no OpenTofu state. The destructive modules create their own
throwaway projects (named `${PVLAB_SP_NAME_PREFIX}<tag>-<ms>`) and delete them
in `finally`. Test-id prefix `SP`.

## Creation has no API

Scoped tokens are created in the dashboard only (SP01: no creation operation
in the OpenAPI document; the dashboard's own route refuses a PAT). The modules
that need a token with a specific scope therefore skip, with the exact
dashboard hand-off in the skip reason, until `PVLAB_SCOPED_PAT_<ROLE>` is
supplied. Nothing here creates a token in a browser.

## Modules

| id | needs | claim |
|---|---|---|
| SP01 | lab token | no access-token creation operation in the OpenAPI document; the dashboard route's answer to a PAT; the `x-fga-permissions` inventory; token format classes |
| SP02 | lab token + fixture; scoped tokens optional | per-token x per-endpoint matrix generated from `x-fga-permissions`: outcome counts, predicted vs observed refusal; SP03-<role> reads the 403 body (`missing_permissions`) |
| SP04 | `PVLAB_SCOPED_PAT_ORG`, `PVLAB_ORG_PRO` | Q14: an org-scoped token creates projects, sees later ones, reads account-level routes; request-budget header sequences |
| SP05 | lab token + fixture; `_RO`, `_DBRW` optional | SQL through `/database/query` and `/database/query/read-only`: select and `create table`, with the table's existence read back |
| SP06 | lab token; scoped tokens optional | `GET /profile`, `supabase whoami`, `orgs list`, `projects list` per token |
| SP07 | `PVLAB_SCOPED_PAT_MEMBER` (a second human), `PVLAB_PEER_FIXTURE` | operator demotes the token's creator mid-run; seconds until probes change |
| SP08 | `PVLAB_SCOPED_PAT_REVOKE`, `PVLAB_PEER_FIXTURE` | operator deletes the token mid-run; seconds until the API refuses it |
| SP09 | `PVLAB_SCOPED_PAT_RO`, `PVLAB_PEER_FIXTURE`, `PVLAB_PEER_OTHER` | project-scoped token: in-scope vs out-of-scope reads, listings, later projects |
| SP10 | lab token | what `x-ratelimit-remaining` counts (control for SP04) |

## Hand-off: the tokens to create

All in the dashboard (Account > Access Tokens), expiry short (a day is
enough). Tokens are immutable after creation per the changelog, so each is a
separate token. Fixture projects are two small projects in the Pro org, created
by the operator first because a project-scoped token can only select a project
that exists.

| env var | resources | permissions |
|---|---|---|
| `PVLAB_SCOPED_PAT_ORG` | the Pro org, all projects | Organization Projects = Read-write, nothing else |
| `PVLAB_SCOPED_PAT_RO` | fixture project only | Read on every project-level permission except API Key Secrets; no Write |
| `PVLAB_SCOPED_PAT_DBRW` | fixture project only | Database = Read-write; Project Settings, API Keys, API Key Secrets = Read |
| `PVLAB_SCOPED_PAT_NARROW` | fixture project only | Project Settings = Read, nothing else |
| `PVLAB_SCOPED_PAT_MEMBER` | fixture project only | created by a second human org member with Administrator or Developer role; Database = Read-write, Project Settings = Read |
| `PVLAB_SCOPED_PAT_REVOKE` | fixture project only | Project Settings = Read; the operator deletes it during the SP08 window |
| `PVLAB_LEGACY_PAT` (optional) | n/a | a pre-GA classic token (Legacy badge) if one exists, as a contrast for SP02 and SP06 |

Plus `PVLAB_PEER_FIXTURE` and `PVLAB_PEER_OTHER` (refs of the two projects) and
`PVLAB_ORG_PRO`. `PVLAB_SCOPED_PAT_<ROLE>_GRANTS=name,name` overrides the
permission names a role is assumed to hold (used only to predict refusals).

## Run

```bash
make registry                       # regenerate the gitignored registry
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<slug> make probe        # read-only
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<slug> make matrix       # SP02, SP05
```

Inject the token per command (`sx SUPABASE_ACCESS_TOKEN -- make probe`); never
echo it. The docs state 120 requests per minute per user, per project or
organization, per endpoint; `lib/http.ts` spaces calls 1.5 s apart
(`PVLAB_SP_MIN_GAP_MS`) to stay well under it. Whether unrelated traffic under
the same user draws on the same counter is not measured.

## Measured

See RUNLOG.md. Raw artifacts carry project refs and stay off-repo.
