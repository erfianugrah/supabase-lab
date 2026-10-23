# compute-surface

Supabase Compute: long-running services deployed next to a project's
database, announced as a private alpha with a waitlist
(https://supabase.com/blog/select-2026-build-anything,
https://supabase.com/compute). The Management API v2 document publishes the
routes, every one marked Alpha (https://api.supabase.com/api/v2-json, read
2026-10-23):

| operation | route |
|---|---|
| list | `GET /v2/projects/{ref}/compute` |
| get | `GET /v2/projects/{ref}/compute/{name}` |
| delete | `DELETE /v2/projects/{ref}/compute/{name}` |
| upload slot | `POST /v2/projects/{ref}/compute/{name}/uploads` |
| deploy | `POST /v2/projects/{ref}/compute/{name}/deploy` (202) |

The CLI carries a `supabase compute` command family behind
`SUPABASE_EXPERIMENTAL_COMPUTE=1`
(https://github.com/supabase/cli/blob/ce77899cb45383dfca7f4ee5f44a285f342536c0/apps/cli/docs/compute-commands.md).

Self-provisioning: CS00 creates one `compute-surface-` Micro project on a Pro
organization (`PVLAB_ORG_PRO`), in ap-southeast-1, and deletes it in
`finally`. No OpenTofu state. Results are in `RUNLOG.md`.

## Modules

| id | question | runtime |
|---|---|---|
| CS00 | is Compute enabled for a new project on this organization: each v2 compute route's status and body, the org entitlement keys, and whether the installed CLI shows `supabase compute` (with and without the experimental switch); nothing is deployed | ~1 min, one Micro project |

CS00 is the enrollment gate. Every row is `info`; the summary row's `gate`
measurement is `closed` (list answered `404 compute_not_enabled`), `open`
(list answered 2xx) or `unclear`. Re-run it after an enrollment and compare
with `pvlab --diff` against the published artifact. With the gate open CS00
does not send the deploy call.

Not written yet, and blocked on enrollment: the deploy path for `deno`,
`node` and `dockerfile` runtimes (CS01), serving on
`/compute/v1/<name>/` (CS02), idle and cold start (CS03), memory, port-bind
and egress limits (CS04), the database path from inside a service (CS05),
custom domains (CS06), logs and usage (CS07). Read the private-alpha terms
before publishing results from those.

## Run

```bash
# secrets injected per command, never exported: SUPABASE_ACCESS_TOKEN, PVLAB_ORG_PRO
make -C experiments/compute-surface probe        # CS00
make -C experiments/compute-surface cleanup      # deletes any project named compute-surface-*
make -C experiments/compute-surface publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

`PVLAB_SUPABASE_CLI` points CS00h at a different CLI binary (default
`supabase` on PATH). Raw run artifacts go to `evidence/<stamp>/` (gitignored:
they carry project refs); redacted copies are under `out/<date>/`.

## Layout

- `tests/cs00-gate.ts` - the gate module; its header names each row's
  route, key and project.
- `lib/cs.ts` - Micro project create and delete, a v2 call that keeps status,
  `error.code` and body verbatim, and the gate reading. The CLI spawn helper
  is cli-surface's `lib/cli.ts`.
