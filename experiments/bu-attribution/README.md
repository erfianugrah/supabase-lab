# bu-attribution

The platform facts behind deterministic per-business-unit cost attribution
inside one `platform`-plan organization. The operator builds the
attribution system on its own control plane; these modules measure what the
platform gives it to build on. Plan and requirements pattern:
`docs/plans/2026-10-02-bu-attribution.md`.

Self-provisioning: destructive modules create throwaway projects on the org
under test (`PVLAB_ORG_SLUGS`) and delete them in `finally`. No OpenTofu
state. Sibling context: `usage-metering` (M03-M07: estimator, rollup,
invoice reconciliation) and `sfp-platforms` (S06: platform-plan
entitlements).

## Modules

| id | claim |
|---|---|
| BA01 | read-only: plan label; project-scoped roles / member roles / audit retention entitlements; Management API rate budget |
| BA02 | create returns the ref synchronously; seconds until the sweep sees it; name survives; name is mutable; deleted refs leave the listings; no creator/tag/metadata field on the live project (BA02f) |
| BA03 | a branch has its own ref; whether the sweep lists it; parent ref readable from the branch |
| BA04 | transfer into the org keeps the ref and is visible to the sweep (needs `PVLAB_ORG_SOURCE`) |
| BA06 | read-only: does a PAT reach the dashboard's audit-log route (`/platform/organizations/{slug}/audit`, from the open-source Studio) |
| BA05 | with a restricted member's token (`PVLAB_PAT2`): can it create projects, which projects it lists and reads (`PVLAB_PEER_INSCOPE` / `PVLAB_PEER_OUTSCOPE`), whether it sees a project created after its role was set. Role assignment is dashboard-only; run once per role |

## Run

```bash
cd harness && bun run build && cd ..
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_SLUGS=<platform-org> \
  ./harness/dist/pvlab --where local --experiment bu-attribution --only BA01
# destructive
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_SLUGS=<platform-org> [PVLAB_ORG_SOURCE=<second-org>] \
  ./harness/dist/pvlab --where local --experiment bu-attribution \
  --only BA02,BA03,BA04 --destructive
```

`SUPABASE_MGMT_BASE_URL` and `SUPABASE_API_HOST_SUFFIX` override the
control plane when the org lives elsewhere.

## Measured (platform-plan org, 2026-10-02)

| finding | value | module |
|---|---|---|
| Project-scoped roles on the platform plan | enabled; roles Owner, Administrator, Developer, Read-only, None | BA01a |
| Org audit log retention | 366 days | BA01a |
| Member/role management on the API | not on this org (`api.members.roles` false); the v2 role and invitation endpoints are listed for Enterprise only (`x-allowed-plans`, v2 OpenAPI read 2026-10-07; not measured on an org with the entitlement enabled) | BA01a |
| Management API rate limit | 120 per window (`x-ratelimit-limit`) | BA01b |
| Create returns the ref | 201 in ~6 s, ref in the body | BA02a |
| Sweep source | `GET /organizations/{slug}/projects`: new ref visible in ~6 s; paginated, limit 100 | BA02b |
| Project name | mutable (`PATCH` 200) - not an attribution record | BA02d |
| Deleted ref | gone from listings in ~3 s - the map must keep rows | BA02e |
| Attribution field on the project | none (list and detail key sets recorded) | BA02f |
| Audit log with a PAT | `GET /platform/organizations/{slug}/audit` answers `401 JWT could not be decoded` while the same PAT gets `200` on `/v1` (production Team org) | BA06 |
| Branch refs | own ref; absent from both listings; parent link only on the parent's `/branches` list (`parent_project_ref`); `GET /projects/{branch_ref}` 404 | BA03 |

The audit log is not an attribution source (see the plan, step 7); it
records who created what for security review. Public sources for it (not
measured here): the Platform
Audit Logs guide (dashboard only, no export, no log drain; entries show
actor and token type) and the open-source Studio, which reads the log from
`/platform/organizations/{slug}/audit` and types each actor with
`token_type`, `token_hash`, `token_alias` ("access token alias, as shown in
the dashboard") and `oauth_app_id`/`oauth_app_name`
(https://github.com/supabase/supabase/blob/614344149399/packages/api-types/types/platform.d.ts,
`AuditLogsResponse_Output`).

Full record: RUNLOG.md. Raw artifacts carry project refs and stay off-repo.
