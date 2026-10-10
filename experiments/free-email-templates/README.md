# free-email-templates

Whether a new free-plan project can edit its auth email templates through the
Management API (`PATCH /v1/projects/{ref}/config/auth`), with the default
email provider and with custom SMTP. Public source for the behaviour under
test: the 2026-06-03 changelog post
https://github.com/orgs/supabase/discussions/46599 (new free projects on the
default provider cannot modify auth email templates; free projects with their
own SMTP can; paid plans are unaffected).

Self-provisioning: each module creates one throwaway project (name prefix
`fe-`, ap-southeast-1) and deletes it in `finally`. No OpenTofu
state. Orgs come from `PVLAB_ORG_FREE` / `PVLAB_ORG_FREE2` / `PVLAB_ORG_PRO`.

## Modules

| id | what it does |
|---|---|
| FE01a-i | free-org project: baseline read; non-template control write; per-kind `mailer_templates_*_content` PATCH, `mailer_subjects_*` PATCH and notification-template PATCH on default SMTP; dummy custom SMTP written; the same template writes with SMTP set; SMTP cleared and writes retried; `smtp_host` alone; SMTP plus a template in one PATCH |
| FE02a-d | Pro-org control: same create, baseline, non-template write and default-SMTP template writes |

## Run

```
cd experiments/free-email-templates
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_FREE=... PVLAB_ORG_PRO=... make run
```

Results are in `RUNLOG.md`. Evidence lands in `evidence/<ts>/` (gitignored).
No auth flow is triggered, so the probes send no email. Whether the platform contacts the dummy SMTP host at write time is not observed.
