# Business-unit cost attribution in one platform org - plan

**Goal:** Measure the platform behaviour a customer needs in order to build
deterministic, self-service per-business-unit cost attribution inside a
single `platform`-plan organization, and write the requirements pattern they
implement on their own control plane.

**Scope boundary:** the customer builds the attribution system. This lab
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
   Management API credential. It creates projects with `POST /v1/projects`
   and records `{ref, unit, created_at}` from the create response in the
   same request.
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
7. **Audit backstop.** Give each unit its own named token or OAuth app;
   the dashboard audit entry for a create carries the token's alias, hash
   and OAuth app, so a human can attribute a leftover `unattributed` ref.
   It is not an automation input: dashboard only, no export, no drain, and
   a PAT is refused on the dashboard's route (BA06).
8. **Lock the bypass.** No human in a unit holds an org role that can create
   projects; the sweep catches whatever still gets through.
9. **Rate budget.** One automation user's Management API budget is shared
   across all its tokens (rate-limits L01b). On-demand creation across many
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
| Q11 | Does the org audit log entry for a create name the token or only the user | Public: the Platform Audit Logs guide lists actor and token type; the open-source Studio types each actor with `token_type`, `token_hash`, `token_alias` (the token's dashboard name) and `oauth_app_id`/`name`. Dashboard only - no `/v1` path, no export, no drain; BA06 measured a PAT refused on the dashboard route (401) | answered - manual backstop only; name each unit's token |
| Q12 | Does the platform invoice itemise per ref; which lines stay org-level | M07 against a platform-plan invoice PDF | open |

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
- [ ] After a BA02 run, read the org audit log entry for the create; record
      whether the token is identified.

### Task 5: invoice (Q12)

- [ ] M07 against a platform-plan invoice PDF; list the org-level lines.

### Task 6: write-up

- [ ] Requirements pattern above, updated with measured answers, as a
      lexicanum section or guide alongside per-project cost attribution.
