# bu-attribution RUNLOG

Chronological record of what was actually run. The org under test is
supplied via `PVLAB_ORG_SLUGS`; org slugs and project refs are not recorded
here (the org class is).

## 2026-10-02 - first runs (platform-plan org, ap-southeast-1)

Run 1 (BA01-BA03): 4 pass, 3 fail, 1 skip. The fails were probe design,
not platform behaviour, and were fixed before run 2:

- BA02b/c gated on `GET /projects`; the gate moved to the org-scoped
  listing, which is the sweep's source.
- BA03c read the parent from `GET /branches/{id}`, which returns the
  branch's connection config (ref, db_host, db_port, db_user, db_pass,
  jwt_secret, ...) and no parent field. Moved to the parent's
  `GET /projects/{ref}/branches` entry. Only key names are recorded.
- BA01c (project key set) skipped on an empty org; moved to BA02f, which
  reads the live throwaway project.

Run 2 (BA01-BA03): 8 pass, 0 fail.

- BA01a: `project_scoped_roles` true; member roles Owner, Administrator,
  Developer, Read-only, None; `security.audit_logs_days` 366;
  `api.members.roles` false.
- BA01b: `x-ratelimit-limit` 120.
- BA02a: `POST /projects` 201 in 5.5-6.0 s with the ref in the body; the
  create response already reads `ACTIVE_HEALTHY`.
- BA02b: visible in `GET /organizations/{slug}/projects` after 5.8 s
  (run 1) and 6.6 s (run 2). The listing is an envelope
  `{projects, pagination: {count, limit: 100, offset}}`.
- BA02c: name verbatim in the org listing.
- BA02d: `PATCH /projects/{ref}` `{name}` 200; the rename took.
- BA02e: delete 200; gone from both listings in 3.4 s / 2.4 s.
- BA02f: org-listing keys `ref,name,cloud_provider,region,is_branch,
  status,inserted_at,databases`; detail keys `id,ref,organization_id,
  organization_slug,name,region,created_at,status,database`. No creator,
  tag, label or metadata field.
- BA03a: branch create 201; the branch has its own ref.
- BA03b: the branch ref is in neither listing (polled 120 s).
- BA03c: the parent's `GET /projects/{ref}/branches` entry carries
  `project_ref` and `parent_project_ref` (matched the parent);
  `GET /projects/{branch_ref}` answers 404.

Not run: BA04 (one org on this control plane; a second would be
undeletable via the API). BA05 written, waiting on a second user.
