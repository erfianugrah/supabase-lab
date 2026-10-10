# terraform-edge-functions

What the OpenTofu `supabase` provider's `supabase_edge_function` and
`supabase_edge_function_secrets` resources do under load: whether an apply that
reports 24 functions created leaves 24 functions behind, how update-in-place
and destroy behave, and whether the loss measured through the Management API
in `edge-function-limits` (EF05a: 24 x 201, 10 present afterwards) shows up
through the provider.

Source for the resources: the public May 2026 developer update
(https://supabase.com/changelog/45702-developer-update-may-2026, fetched
2026-10-10: "Terraform Provider v1.9.0 adds Edge Functions resource, Edge
Function secrets resource, and a network bans data source"). The resource
names and attributes were read from the provider schema
(`tofu providers schema -json`) on 2026-10-10.

Self-provisioning: TF01 creates one throwaway project on the Pro org
(`PVLAB_ORG_PRO`), named `tf-*`, copies `tf/` to a scratch directory,
runs `tofu` there, and deletes the project in `finally`. No OpenTofu state of
its own lives in this directory; `tf/` is the module under test and carries the
committed provider lock file.

## Modules

One module file, `tests/tf01-edge-function-resources.ts`, id `TF01`; the rows
below are its phases, in execution order. Each row records what tofu reported
and what the Management API lists afterwards.

| id | what it does |
|---|---|
| TF01a | 24 functions + a secrets resource in one apply at `-parallelism=24`: reported created vs listed at +10 s and +70 s vs answering 200 |
| TF01b | re-plan after the first apply, then re-apply at 24 for up to 4 rounds until all are listed |
| TF01c | the secrets resource's names listed by the API after that |
| TF03a | destroy at `-parallelism=24`: reported vs still listed, state left, invocations afterwards |
| TF02a | baseline at `-parallelism=1`: 24 functions + secrets |
| TF02b | re-plan with nothing changed |
| TF02c, TF02d | change every source, apply at 1 then at 24: in place or replace, listed versions, new body served |
| TF02e | change one source: the other 23 untouched |
| TF02f, TF02g | secrets: change one value, add one, remove one; an undeclared secret and an out-of-band change (`info`) |
| TF03b | destroy at `-parallelism=1` from a converged state |
| TF04a-g | fresh state, apply then destroy at widths 1, 2, 4, 10, 24, 24, and 24 with the secrets resource |
| TF05a, TF05b | the same 24 functions straight through `POST /functions/deploy`, 24 in flight and 1 in flight |
| TF01z | cleanup: functions, secrets, project |

## Run

```bash
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make probe
```

`make probe` builds the registry and runs `TF01` with `--destructive`; the
module took 49 minutes in the last complete run (2026-10-10). `PVLAB_REF=<ref>` reuses an existing
project (kept; only `pvlab-tf-*` functions and `TFEF_*` secrets are removed).
`make lock` refreshes `tf/.terraform.lock.hcl`.

Results and caveats: `RUNLOG.md`; run artifacts in `out/2026-10-10/` (`make publish-evidence RUN=...` writes there).
