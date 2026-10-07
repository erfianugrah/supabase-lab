# Business-unit cost attribution in one platform org - plan

**Goal:** Measure the platform behaviour a customer needs in order to build
deterministic, self-service per-business-unit cost attribution inside a
single `platform`-plan organization, and write the requirements pattern they
implement on their own control plane.

**Status (2026-10-08):** Tasks 1, 2 and 6 done; Q1-Q8, Q10, Q11 and Q13
answered. Open: Q9 (Task 3, second org), Q12 (Task 5, invoice), Q14 (Task 5b,
scoped token on production), optional BA05 run (Task 4).

**Scope boundary:** the operator builds the attribution system. This lab
supplies the measured platform facts the pattern rests on, and the pattern
itself as requirements. No gateway, ledger service or poller is built here;
the usage-metering modules (M03-M07) already cover the estimator and
reconciliation mechanics.

**Why one org:** billing is per organization. Splitting units into
organizations makes attribution fall out of billing, at the cost of running
and administering many organizations. One organization keeps one bill and
moves attribution to the customer, keyed on project ref.

**Why "deterministic":** a map written only when someone remembers to write
it is discipline, not a mechanism. The pattern makes attribution a side
effect of the only path that creates projects, and a sweep that diffs the
org's project list against the map catches anything that took another path.

---

## The pattern (customer-side requirements)

1. **Write path.** Only the customer's provisioning service holds the
   Management API credential, ideally a scoped personal access token limited
   to the one organization with Organization Projects (Read-write), which
   the public Personal Access Tokens guide lists for `create_project`;
   classic tokens reach every org the user belongs to. Not yet measured
   (Q14). It creates projects with
   `POST /v1/projects` and records `{ref, unit, created_at}` from the create
   response in the same request. Run the sweep against the org listing: an
   org-scoped token gets `[]` from `GET /v1/projects` (s2z-wake, staging).
   - Write a pending row before the call and complete it on the response, so
     a crash between the 2xx and the write leaves a recoverable row.
   - Branches (`POST /v1/projects/{ref}/branches`) and transfers in
     (claim-token pair) are also write paths; each records the unit.
2. **Effective-dated map.** `(ref, unit, valid_from, valid_to)`, never
   deleted. A unit change closes one row and opens another, so past usage
   stays with the unit that incurred it.
3. **Sweep.** On a schedule, page through `GET /v1/organizations/{slug}/projects`
   and diff against the map. Unmapped refs go to `unattributed` and alert.
   Branches are not in that listing: walk each parent's
   `GET /v1/projects/{ref}/branches` and take the unit from
   `parent_project_ref`.
4. **Usage join.** Join per-project usage (the invoice's per-ref lines, or
   the estimator in usage-metering M03) to the map row valid for that
   period. Rows with no match go to `unattributed`, with a
   dollar total.
5. **Pooled lines.** Org-level lines with no project dimension (plan fee,
   and any of MAU, function invocations, realtime, discounts that the usage
   data does not carry per ref) are split by a rule in config, not by hand.
6. **Invariant.** Every month: sum(unit totals) + unattributed + allocated
   pooled lines = invoice total. A mismatch is a pipeline defect.
7. **Attribution comes from the map and the usage join only.** Cost and
   usage attribution never reads the audit log. The org audit
   log is for security review of who created what: dashboard only, no
   export, no drain, and a PAT is refused on the dashboard's route (BA06).
   An unattributed ref is resolved by fixing the write path or the sweep,
   then closing the gap in the map.
8. **Lock the bypass.** No human in a unit holds an org role that can create
   projects; the sweep catches whatever still gets through. Role assignment
   on the Management API is Enterprise-only by default per the spec: v2 has
   `PATCH /v2/organizations/{slug}/members/{user_id}/roles` and
   `POST /v2/organizations/{slug}/members/invitations`, both with
   `x-allowed-plans: ["Enterprise"]` (v2 OpenAPI, read 2026-10-07); v1 has
   only `GET /v1/organizations/{slug}/members`. On this `platform`-plan org
   `api.members.roles` reads false (BA01a), so the provisioning service
   cannot grant roles. An org admin assigns them in the dashboard: a
   project-scoped invite names one project, more projects are added after
   the user accepts (public Access Control guide). Org-level roles
   cover current and future projects; a project-scoped role covers the
   projects it was granted on, so each new project needs its project-scoped
   members added by hand (reasoned from the guide; BA05 would measure it).
9. **Rate budget.** One automation user's Management API budget is shared
   across all its classic tokens (rate-limits L01b; scoped tokens are Q14). On-demand creation across many
   units plus the sweep draw from it; one automation user per unit gives
   each its own budget.

---

## Tracking ledger

| id | question | how | status |
|---|---|---|---|
| Q1 | Does any project field carry creator/tag/label/metadata? | BA02f | DONE 2026-10-02 - none on list or detail |
| Q2 | Project-scoped roles, member roles, audit retention on the platform plan | BA01a | DONE 2026-10-02 - scoped roles enabled; Owner/Administrator/Developer/Read-only/None; audit 366 d |
| Q3 | Management API rate limit on the platform org | BA01b | DONE 2026-10-02 - 120 |
| Q4 | Create returns the ref synchronously (write path needs no polling) | BA02a | DONE 2026-10-02 - 201 with ref in ~6 s |
| Q5 | Seconds until a new ref is visible to the sweep | BA02b | DONE 2026-10-02 - ~6 s on the org listing (paginated, 100) |
| Q6 | Is the project name mutable (can a name prefix be the record)? | BA02d | DONE 2026-10-02 - mutable |
| Q7 | Deleted refs leave the listing (map must keep rows) | BA02e | DONE 2026-10-02 - gone in ~3 s |
| Q8 | Branch refs: own ref, sweep-visible, parent linkage readable | BA03 | DONE 2026-10-02 - own ref; not listed; parent only via the parent's `/branches` list |
| Q9 | Transfer into a platform-plan org: preview, ref kept, sweep-visible | BA04 (needs a second org on the same control plane) | open |
| Q10 | Which roles can create projects; does a project-scoped member see other units' projects; do org-wide roles cover future projects | Public docs (Access Control guide): Owner and Administrator create projects, Developer and Read-only cannot; a project-scoped member cannot view, access or see other projects in the dashboard; org-level roles cover current and future projects. BA05 would confirm the same on the Management API | answered by docs; BA05 optional |
| Q11 | Does the org audit log entry for a create name the token or only the user | Public: the Platform Audit Logs guide lists actor and token type; the open-source Studio types each actor with `token_type`, `token_hash`, `token_alias` (the token's dashboard name) and `oauth_app_id`/`name`. Dashboard only - no `/v1` path, no export, no drain; BA06 measured a PAT refused on the dashboard route (401) | answered - security review only, not an attribution input (step 7 revised 2026-10-07) |
| Q12 | Does the platform invoice itemise per ref; which lines stay org-level | M07 against a platform-plan invoice PDF | open |
| Q13 | Can the provisioning service assign member roles as it creates a project | BA01a (`api.members.roles` false); v1 OpenAPI: GET only; v2 OpenAPI (read 2026-10-07): role PATCH and invitations POST, both `x-allowed-plans: ["Enterprise"]` | answered - not on this org (entitlement false); Enterprise-only by default on v2 (per-org entitlement), unmeasured |
| Q14 | Does an org-scoped PAT create projects, reach projects created after it was issued, and share the user's rate budget | Scoped PATs are public (Personal Access Tokens guide); s2z-wake measured an org-scoped PAT on staging only (`GET /v1/projects` returns `[]`); L01b measured the cumulative budget with classic PATs | open |

---

## Tasks

### Task 1: scaffold (this commit)

- [x] `experiments/bu-attribution/` with README, RUNLOG, BA01-BA04.
- [x] Registry picks the modules up (`bun run build` in `harness/`).

### Task 2: first live run on a platform-plan org

- [x] Run BA01 (read-only), then BA02-BA03 with `--destructive`.
- [x] RUNLOG entry; README "Measured" table; ledger Q1-Q8 updated.

Consequences for the pattern: the sweep reads the org-scoped listing and
pages it; it walks each parent's `/branches` for branch refs and takes the
unit from `parent_project_ref`; names are hints, never the record.

### Task 3: transfer-in (Q9)

- [ ] Second org on the same control plane as `PVLAB_ORG_SOURCE`; run BA04.

### Task 4: member scope (Q10) and audit identity (Q11)

- [x] BA05 written: create / list / read / future-project visibility with
      the member's token.
- [ ] Optional: run BA05 at project-scoped Developer, org-wide Developer and
      project-scoped Administrator to confirm the documented behaviour on the
      Management API. Needs a second user who can join the org.
- [x] ~~After a BA02 run, read the org audit log entry for the create~~ -
      dropped 2026-10-07: the audit log is not an attribution input (step 7).

### Task 5: invoice (Q12)

- [ ] M07 against a platform-plan invoice PDF; list the org-level lines.

### Task 5b: scoped token (Q14)

- [ ] On production, create an org-scoped PAT with Organization Projects (Read-write);
      record whether it creates a project, reads a project created after the
      token was issued, and whether its `x-ratelimit-remaining` drops on a
      classic PAT's calls from the same user.

### Task 6: write-up

- [x] Requirements pattern above, updated with measured answers, as a
      lexicanum section: "One org, many business units" in the per-project
      cost attribution guide (steps 7/8 and Q13/Q14 carried there
      2026-10-07). Re-sync it when Q9, Q12 or Q14 closes.
