# RUNLOG - compute-surface

## CS00 - Compute enrollment gate (2026-10-23)

One run, n = 1 per row. Vantage: one macOS machine in Singapore (Bun 1.3.14),
lab commit 661afdf. Project: one Micro project (`ci_micro` read back from
billing add-ons) in ap-southeast-1 on a Pro-plan organization, created by
CS00 and deleted in its `finally` (DELETE HTTP 200; absent from
`GET /v1/projects` at 08:34:29 UTC). Key: the lab PAT for every row except
CS00g. Compute name in the paths: `cs00-probe`, never deployed.

Published artifact: `out/2026-10-23/run-2026-10-23T08-34-04-355Z.json`
(redacted) and its `.facts.md`.

Docs say (read 2026-10-23, not measurements): Compute is a private alpha
behind a waitlist (https://supabase.com/compute,
https://supabase.com/blog/select-2026-build-anything); the v2 document marks
every compute operation Alpha and lists responses 200/201/202/204, 401, 403
and 429, with no 404 (https://api.supabase.com/api/v2-json); the CLI's
compute commands are opt-in with `SUPABASE_EXPERIMENTAL_COMPUTE=1`
(https://github.com/supabase/cli/blob/ce77899cb45383dfca7f4ee5f44a285f342536c0/apps/cli/docs/compute-commands.md).

Measured:

| row | call | HTTP | `error.code` | body |
|---|---|---|---|---|
| CS00b | `GET /v2/projects/{ref}/compute` | 404 | `compute_not_enabled` | `{"error":{"code":"compute_not_enabled","message":"Compute is not available for this project"}}` |
| CS00c | `GET /v2/projects/{ref}/compute/cs00-probe` | 404 | `compute_not_enabled` | same |
| CS00d | `POST /v2/projects/{ref}/compute/cs00-probe/uploads` | 404 | `compute_not_enabled` | same |
| CS00e | `POST /v2/projects/{ref}/compute/cs00-probe/deploy`, schema-valid body (runtime deno, size 2gb, exposure private, instances 1, no upload) | 404 | `compute_not_enabled` | same |
| CS00f | `DELETE /v2/projects/{ref}/compute/cs00-probe` | 404 | `compute_not_enabled` | same |
| CS00g | list, no Authorization header | 401 | `unauthorized` | `{"error":{"code":"unauthorized","description":"No access token provided","message":"Unauthorized"}}` |

- Gate: `closed`. All five compute operations answered the same 404 with
  `compute_not_enabled`; none answered 403, so the PAT passed whatever
  permission check runs first. Without a token the list route answered 401
  before any gate.
- CS00a, org entitlements (`GET /v1/organizations/{slug}/entitlements`):
  HTTP 200, 64 entitlements, 1 key containing compute, worker, service,
  container or app: `instances.compute_update_available_sizes=true`, the
  database instance-size set. Nothing in the list names Compute services, so
  enrollment, if it is an entitlement, is not one this token sees on this
  organization.
- CS00h, CLI 2.121.0 (Homebrew; npm dist-tags at run time `latest=2.121.0
  beta=2.122.0-beta.15`): `supabase compute --help` printed the root help
  (exit 0) without the switch and with the global `--experimental` flag;
  with `SUPABASE_EXPERIMENTAL_COMPUTE=1` it printed "Manage Supabase Compute
  (experimental): deploy and run any code." (exit 0). The subcommand list
  (`new`, `push` with alias `deploy`, `list`, `status`, `logs`, `delete`)
  is from a hand run of the same binary that day, not in the artifact. So
  the stable channel carries the command, behind the environment variable
  only.
  `SUPABASE_EXPERIMENTAL_COMPUTE=1 supabase compute list --project-ref <ref>`
  exited 1 with "Compute is not available for project `<ref>`. Compute is
  in private alpha. Stay tuned for the public alpha coming soon."
- Project setup (CS00p): ACTIVE_HEALTHY at the first 10 s poll (`healthy_s`
  12).

Not settled: whether any other organization or plan is enrolled; whether
the gate is per project or per organization once enrollment exists (the
error says "this project"); anything about Compute itself (CS01-CS07, see
README). Re-running CS00 after an enrollment and diffing with
`pvlab --diff out/2026-10-23/run-2026-10-23T08-34-04-355Z.json,<new run>`
shows the change as the `gate` measurement.
