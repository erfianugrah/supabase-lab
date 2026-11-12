# Access control: platform roles on top of the kit

A 2-3 minute dashboard walkthrough of what a Team or Enterprise organization
adds over a set of separate Pro organizations, and how it lines up with the
controls the kit already puts inside the database.

The point to land: there are two planes. The platform plane decides who may
change a project (dashboard and Management API: org roles, project-scoped
roles, SSO, MFA, audit logs). The data plane decides what an app user may
read or write (JWT `app_metadata` -> profile -> RLS and column grants). A
dashboard role is not an app role and never passes through RLS.

## Plan tiers

Checked against the live docs and pricing page on 2026-10-07.

| Feature | Plan | Source |
|---|---|---|
| Owner, Administrator, Developer org roles | All plans (Free and Pro list "Owner, Admin, Developer") | https://supabase.com/pricing ("Access Roles" row) |
| Read-only and No-access org roles | Team and Enterprise | https://supabase.com/docs/guides/platform/access-control ("Read-Only and No-access roles are only available on the Team and Enterprise plans") |
| Project-scoped roles | Team (predefined) and Enterprise (custom) | https://supabase.com/docs/guides/platform/access-control ("Project scoped roles are only available on the Team and Enterprise plans"); pricing: Team "Predefined project scoped roles", Enterprise "Custom project scoped roles" |
| Dashboard SSO (SAML 2.0) | Team and Enterprise per the docs; see the note below | https://supabase.com/docs/guides/platform/sso ("Supabase currently provides SAML SSO for Team and Enterprise Plan customers") |
| Org MFA enforcement | Pro, Team and Enterprise | https://supabase.com/docs/guides/platform/mfa/org-mfa-enforcement ("MFA enforcement is only available on the Pro, Team and Enterprise plans") |
| Platform audit logs | Team and Enterprise | https://supabase.com/docs/guides/security/platform-audit-logs ("only available on the Team and Enterprise plans"); pricing "Platform Audit Logs" row |
| Audit log drains | NOT CONFIRMED - the audit-logs page links to them without naming a plan; project log drains are Pro, Team and Enterprise | https://supabase.com/docs/guides/security/platform-audit-logs, https://supabase.com/docs/guides/telemetry/log-drains |
| Member role management by API | Team and Enterprise per the spec read 2026-11-12 (Enterprise only when read on 2026-10-07): v2 role and invitation writes carry `x-allowed-plans`; platform-facts F08b (2026-11-12) measured a Team org past the invitation-delete plan check and Pro and Free orgs refused with 402; the role PATCH is not measured on any org; v1 has no member write | https://api.supabase.com/api/v2-json, https://api.supabase.com/api/v1-json (see below) |

SSO note: the pricing page is inconsistent. The Team plan card lists "SSO
for Supabase Dashboard", while the comparison table's "SSO" row (under
Platform Security and Compliance) says "Contact Us" for both Team and
Enterprise. The docs page says SAML SSO is for Team and Enterprise Plan
customers (https://supabase.com/docs/guides/platform/sso). Neither says
whether it is self-serve on Team.

Retention of platform audit logs is not on the pricing page ("Retention
periods depend on your plan"). The lab's own reading of the entitlements
endpoint on a Team org returned `audit_logs_days` 62 (platform-facts F01,
2026-11-12,
`experiments/platform-facts/out/2026-11-12/run-2026-11-12T03-44-01-588Z.facts.md`);
that is a measurement of one org, not a published limit.

## Walkthrough

Step timings are targets, not rehearsed numbers.

1. **Team page** (Organization settings > Team, 30 s). Show the members
   list. One member is a project-scoped Developer on `kit-live` only; one
   is Read-only. Point out that the project-scoped member does not see
   `kit-ready` at all - the docs say they "will not be able to view, access,
   or even see other projects". Separate Pro organizations can only approximate
   this with one organization per project, and Pro has no Read-only role.
2. **Switch to the scoped member's browser** (20 s, optional). The project
   list shows only `kit-live`. This is the coding-agent scenario: a builder
   gets full rights on the sandbox project and nothing on the reference one.
3. **Security settings** (Organization settings > Security, 30 s). Show the
   "Require MFA to access organization" toggle. Only owners can change it,
   the owner must have MFA themselves, and members without MFA lose access
   immediately (they keep their membership and regain it once they enrol).
   Personal access tokens are not affected, so automation keeps working.
   Do NOT switch it on in a shared lab org unless every member has MFA.
4. **SSO** (Organization settings > SSO, 20 s). Show the SAML form: IdP
   metadata, optional email domains for SP-initiated sign-in, auto-join with
   a default role (the docs recommend Developer). Mention the safety rule -
   at least one non-SSO owner must exist - and that SSO and password
   accounts with the same email are separate accounts. Leave it unconfigured
   unless a test IdP is ready. The dashboard's auto-join role picker offers
   Owner, Administrator, Developer and Read-only, defaulting to Developer,
   and no No-access option (dashboard source; backend not checked; see "SSO
   auto-join roles" below).
5. **Audit logs** (Organization > Audit logs, 30 s). Find the entries for
   the member invites from step 1 and for the `webhook-sink` deploy and
   secret update that `make integrations` made through the Management API.
   Each entry shows actor, IP, token type, action and target. There is no
   dashboard export; streaming goes through audit log drains.
6. **Back to the database** (30 s). Open the SQL editor on `kit-ready` as
   the Read-only member and run `select department_id, count(*) from
   purchase_requests group by 1`. Both departments come back. That is
   expected: the next section explains why.

## How the two planes combine

| Who | Plane | What decides access | Sees other departments? |
|---|---|---|---|
| App user (alice, bob, ...) | Data | `app_metadata` department and role -> profile -> RLS policies, column grants, `decide_purchase_request` (SECURITY INVOKER) | No - K01, K02, K04 |
| In-app agent | Data | The caller's JWT; same policies | No - K02 |
| Webhook payload | Data | Trigger reads only the decided row | No - K04.03 |
| Dashboard Developer / Admin / Owner | Platform | Org or project-scoped role | Yes - unrestricted SQL editor and Data Manage rights; the editor's default role, `postgres`, has BYPASSRLS (role attribute checked 2026-10-07; which role the editor uses for a Developer was not observed) |
| Dashboard Read-only | Platform | Org role, SELECT only | Yes - SQL runs as `supabase_read_only_user`, member of `pg_read_all_data` with BYPASSRLS (checked on the ready project, 2026-10-07) |

Consequences worth saying out loud:

- Department managers get an app role (`app_metadata.role = manager`), not
  a dashboard role. A dashboard role on a production project is a
  cross-department grant by construction.
- Developer can read the project's secret (service) key, per the
  access-control permission table, and that key is what writes
  `app_metadata`. A Developer on a project can therefore move any app user
  between departments or promote them. Keep production projects to Owner and
  Administrator plus Read-only, and give builders project-scoped Developer
  on sandbox projects such as `kit-live`.
- Developer and Read-only can both view Edge Function secrets (the table
  marks Read-only "able to access secrets"), which includes
  `WEBHOOK_SINK_SECRET`. Whether the dashboard shows the value or only a
  digest was not checked here.
- Audit logs cover the platform plane only. App-level actions are recorded
  by the kit itself: `agent_audit` for the in-app agent, and the
  `webhook-sink` receipts for decisions.

## SSO auto-join roles

Read from the dashboard source, not run against an org with SSO configured
(the lab has no test IdP). In supabase/supabase, the auto-join form's "Default
role on join" select lists four values: Owner, Administrator, Developer,
Read-only
(https://github.com/supabase/supabase/blob/fcfb0f022282a7967ab1b129ea365b4ae0438978/apps/studio/components/interfaces/Organization/SSO/JoinOrganizationOnSignup.tsx#L59-L62).
The form starts with auto-join off and the role at Developer
(https://github.com/supabase/supabase/blob/6d08d66b7d784220ec149fd77e0ba940c6067464/apps/studio/components/interfaces/Organization/SSO/SSOConfig.tsx#L94-L95)
and falls back to Developer on submit, casting the role to one of those four
(same file, L156-L161). The form schema itself takes any string (L47), and
the saved role is read back from the backend, so these are the dashboard's
choices; whether the backend accepts No access through another path was not
checked. Both files read 2026-11-06.

What it means for a rollout: through the dashboard, a member who joins by
SSO auto-join gets one of those org-wide roles, and the lowest, Read-only,
reads every project's data through `supabase_read_only_user` (BYPASSRLS,
`pg_read_all_data`; "How the two planes combine" above). Invited members are
not affected. An org that wants members to start with access to nothing
keeps auto-join off and invites each member with the No-access org role plus
a project-scoped grant.

## Roles on branches (K09)

Not yet measured: K09 needs a second account, and the lab org's member
listing showed only the Owner when read by hand on 2026-11-06. The question
is whether a project-scoped role on a production project carries to that
project's branches, and whether a branch can hold a role of its own. It
decides whether "builders get Developer on branches and Read-only on
production" is possible.

What is known:
- A branch has its own project ref, absent from the org's project listing
  (bu-attribution BA03), and a project-scoped invite names one project.
- The access-control permission table (read 2026-11-06,
  https://supabase.com/docs/guides/platform/access-control) gives Owner,
  Administrator and Developer Read and Write on the production branch and
  List, Create, Update and Delete on development branches; Read-only gets
  Read on the production branch and List on development branches only. Its
  footnote 8: with dashboard branching and no GitHub integration, the first
  branch creation registers the production branch and needs Owner or
  Administrator; Developers create branches normally after that. The table
  says what a role may do, not whether a grant on the production project
  reaches its branches. In K09 the owner registers the production branch
  (setup), so K09f measures the case after registration.

1. `sx SUPABASE_ACCESS_TOKEN -- make roles-setup` creates and keeps a
   `kit-cm-roles-*` project with one table and a persistent branch
   (`k09-staging`); the run log prints the project ref.
2. In the dashboard, invite the second account with org role No access and a
   project-scoped Read-only on that project only. Note whether the project
   picker lists `k09-staging` as a separate entry.
3. From the second account, create a classic (user-level) personal access
   token, not a scoped one: a scoped token adds its own permission set, so a
   refusal could come from the token rather than the role (scoped-pats SP06).
   Store it in the vault; then
   `sx SUPABASE_ACCESS_TOKEN PVLAB_PAT2=<vault item> -- make roles-probe PEER_ROLES=<ref> K09_ROLE=Read-only`.
   The owner deletes leftover run branches, re-applies the table on
   production and adds a preview branch. The member's token lists projects
   and branches, runs SELECT (read-only and query endpoints) and DDL on
   production and both branches (after an owner control read and an owner
   drop of any leftover probe table on each), tries to create a branch and
   reads key metadata. The owner deletes the preview branch and any branch
   the member created. Recorded: status codes, and for a refusal the SQLSTATE
   and a short reason with refs removed.
4. Change the grant to project-scoped Developer and run step 3 with
   `K09_ROLE=Developer`.
5. `sx SUPABASE_ACCESS_TOKEN -- make roles-teardown PEER_ROLES=<ref>`, and
   remove the member from the org in the dashboard.

Done so far (2026-11-06): step 1, and step 3 with the lab's own owner token
standing in for the member, as a baseline and a check of the module
(`out/2026-11-06/run-2026-11-06T08-40-48-500Z.json`, `K09_ROLE=Owner`). That
token got 201 on all three SQL probes on production, the persistent branch
and the preview branch; 201 creating a branch; 200 on key metadata for
production and the preview branch; and 200 listing `/projects`, where
neither branch ref appeared. The owner control read found the table's one
row on production and 0 rows on each branch: the branches had the table but
no data. The token is a scoped one: `GET /v1/profile` answered 403 "This
endpoint requires a user-scoped access token" (as in scoped-pats SP06), so
the org role read as "(unread)" and the run is labelled by `K09_ROLE`. An
earlier attempt that day stopped at that 403; the module no longer does. The
project and `k09-staging` are still up for steps 2 to 5.

## One-time setup for the lab org (manual)

The public Management API cannot do this on Pro or Team. Re-checked
2026-10-07 against the published OpenAPI documents. In v1
(https://api.supabase.com/api/v1-json, 169 operations) the only membership
operation is `GET /v1/organizations/{slug}/members`; org-level writes are
organization creation and project claim only; the `database/jit/invite`
endpoints are database access, not org membership. v2
(https://api.supabase.com/api/v2-json) adds
`PATCH /v2/organizations/{slug}/members/{user_id}/roles` and
`POST /v2/organizations/{slug}/members/invitations`, both with
`x-allowed-plans: ["Enterprise"]` when read on 2026-10-07 and
`["Team","Enterprise"]` on 2026-11-12. Not measured on an Enterprise org; on
2026-11-12 platform-facts F08b measured a Team org past the invitation-delete
plan check. The README's "no Management API for member roles on Pro or Team"
now holds for Pro only; for Team the spec and F08b disagree with it, and the
role PATCH itself is not measured.

- [ ] Owner account has MFA enrolled (two authenticator apps, per the docs)
      before anything else in this list.
- [ ] Invite the builder: Organization settings > Team > Invite, role
      Developer, scoped to project `kit-live`. Invites expire after 24
      hours, and a project-scoped invite names one project; add more
      projects after acceptance if needed.
- [ ] Invite the reviewer: role Read-only, organization-wide.
- [ ] Optional: give the builder org role No access with the project
      grant, so new projects in the org stay invisible to them by default.
- [ ] Both accept from their own browsers; confirm the builder sees only
      `kit-live`.
- [ ] Before the demo, confirm the invites appear in Organization > Audit
      logs.
- [ ] After `make destroy` and `make up` the projects are new, so expect
      the project-scoped grant to need re-assigning (not yet tested).
      Members themselves are not removed by `make destroy`.
- [ ] Do not enable MFA enforcement or SSO on the lab org without
      checking every member first; both lock people out immediately.

Programmatic check after setup (read-only; the PAT comes from the vault):

```bash
sx SUPABASE_ACCESS_TOKEN -- sh -c 'curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/organizations/<org-slug>/members" | jq "[.[] | {role_name, mfa_enabled}]"'
```

`GET /v1/organizations/{slug}/entitlements` shows which of the features
above the org's plan carries (the lab saw `project_scoped_roles` true on a
Team org).
