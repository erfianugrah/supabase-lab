# free-email-templates RUNLOG

Chronological record of what was actually run. Org slugs and project refs are
not recorded here. Evidence stays in gitignored
`evidence/`; it has not been published to `out/` yet, so the figures below are
transcribed from the run artifacts' measurement tables and each cites its
module id and run.

## What the docs claim (not measured by this run)

The 2026-06-03 GitHub discussion announcement (https://github.com/orgs/supabase/discussions/46599)
says: new free-plan projects on the default email provider can no longer
modify their auth email templates; existing free projects keep theirs; paid
plans are unaffected; free projects that configure their own SMTP provider can
customise templates. Everything below is a measurement against that wording.

## 2026-10-10 - three runs, new free-org projects, ap-southeast-1

Vantage: local Mac, Management API (`api.supabase.com/v1`), one PAT. Every run
created a fresh project, ran the sequence, and deleted the project in
`finally`.

Provenance caveat: the saved run artifacts (JSON and MD measurement tables)
record no org identifier, no project ref, no delete status and no post-run
project listing. The org class per run below, the delete result and the
absence of leftover lab-prefix projects were observed at run time but were
not captured in the evidence set. Treat them as operator notes, not as
recorded measurements.

| run | modules | org class (operator note) | projects |
|---|---|---|---|
| 1 | FE01 (phases a-g plus the combined PATCH, earlier probe revision) | first free org | 1 |
| 2 | FE01 (a-i), FE02 (a-d) | first free org (FE01), Pro org (FE02) | 2 |
| 3 | FE01 (a-i) | second free org | 1 |

So the free-org result has n=3 projects across what the operator noted as two
free orgs; the Pro control has n=1. Run 1 predates the notification-template and `smtp_host`-only probes,
so those rows have n=2 (runs 2 and 3). In run 1 the combined SMTP-plus-template
PATCH was labelled FE01h; it is FE01i in runs 2 and 3.

### FE01 measured: free org, new project

- FE01a: `POST /v1/projects` 201; the artifacts record `ACTIVE_HEALTHY` with
  healthy_s 1, 0, 1 across the 3 runs (the sub-10 s elapsed time suggests the
  first poll already saw it healthy; the poll count itself was not recorded),
  and `GET config/auth` was
  200 after 1, 1 and 3 s. Baseline FE01b: `smtp_host` null; 6 of 6
  `mailer_templates_*_content` and 6 of 6 `mailer_subjects_*` keys present,
  plus seven notification-template and seven notification-subject keys and
  `mailer_templates_custom_contents` / `mailer_subjects_custom_contents` maps
  with every flag false.
- FE01c: control `PATCH {site_url}` returned 200 and read back, 3 of 3 runs.
  PATCH as such is not blocked.
- FE01d, default SMTP: each of the six `mailer_templates_*_content` fields
  PATCHed alone (confirmation, invite, magic_link, recovery, email_change,
  reauthentication): 0 of 6 accepted in each of 3 runs, every one HTTP 400
  with the body
  `{"message":"Email template modification is not available for free tier projects using the default email provider. Please upgrade your plan or configure a custom SMTP provider."}`.
  Read-back: 0 of 6 persisted. All six `mailer_subjects_*` in one PATCH: the
  same 400, 0 of 6 persisted, 3 of 3 runs. All seven notification-template
  content fields in one PATCH: the same 400, runs 2 and 3. Enabling a
  notification (`mailer_notifications_password_changed_enabled: true`) is not
  a template edit: 200, runs 2 and 3.
- FE01e: writing dummy custom SMTP (`smtp_host` smtp.example.com, port 587,
  user, password, admin email, sender name) in one PATCH: 200, and the read
  back shows the host and `smtp_pass` set (the password is recorded as present
  only). The write did not reject a host that is not an SMTP server.
- FE01f, custom SMTP set: the same six content PATCHes: 6 of 6 accepted (200)
  and 6 of 6 persisted, 3 of 3 runs. Subjects (one PATCH) 200 in 3 of 3;
  notification templates (one PATCH) 200 and enable flag 200, runs 2 and 3.
  Read in runs 2 and 3: 13 of 13 `mailer_templates_custom_contents` flags
  true, 6 of 13 `mailer_subjects_custom_contents` flags true (the six
  subjects written).
- FE01g, SMTP cleared (the six SMTP fields set to null): 200 and `smtp_host`
  null afterwards, 3 of 3 runs. The templates written under custom SMTP did
  not remain: 0 of 6 still stored in 3 of 3 runs; in runs 2 and 3 also 6 of 6
  equal to the baseline default text, 6 of 6 subjects equal to baseline, and
  all custom-content flags false. Retrying the six content PATCHes on the
  cleared project: 0 of 6 accepted (400, same body), 3 of 3 runs.
- FE01h (runs 2 and 3): `smtp_host` alone set (200), then a confirmation
  template PATCH: 400, same body. The host alone did not lift the restriction.
  Which other SMTP field or fields lift it was not isolated.
- Combined PATCH (FE01i in runs 2 and 3, FE01h in run 1): one request carrying
  the six SMTP fields and `mailer_templates_recovery_content`, sent from the
  default (cleared) state: 200, and the SMTP host and the template both read
  back, 3 of 3 runs.

### FE02 measured: Pro org control (run 2, n=1)

Same sequence a-d on a Pro-org project, default SMTP (`smtp_host` null):
6 of 6 content PATCHes 200 and persisted; subjects PATCH 200 with 6 of 6
persisted; notification-template PATCH 200; enable flag 200. After the writes
13 template and 6 subject custom-content flags were true.

### Reading

On a new free project the Management API refuses template content, subject and
notification-template writes with a 400 whose text names both remedies
(upgrade, or a custom SMTP provider); the Pro-org control accepts the same
writes on default SMTP. That is consistent with a plan-dependent check (Pro
control n=1), not proof of one: the free and Pro orgs may differ in more than
plan. The check sees the SMTP fields of the same request (the
combined PATCH succeeded) and the stored SMTP state afterwards (after the
clear, writes were refused again).

One observation the run does not explain: after the SMTP fields were cleared,
the custom templates were gone and the defaults were back. The clear request
itself and a platform job reacting to the SMTP change are both consistent with
that; there was one read immediately after the clear and no timing series.

## Not measured

- Pre-2026-06-03 free projects (the "existing projects keep their templates"
  claim): none available; every free project here was new.
- Delivery: no auth email was triggered, so whether a stored custom template
  is rendered, and what a real send to the dummy host does, were not observed.
  FE01e shows the write accepts a dummy host, not that sends work.
- Which SMTP fields lift the lock (the host alone does not).
- The dashboard path; only the Management API was exercised.
- Plans other than Free and Pro.
- Timing of the template reset after the SMTP clear.
- Whether the shared Management API budget throttled any call: the retry
  helper backs off on 429 but does not count retries.
