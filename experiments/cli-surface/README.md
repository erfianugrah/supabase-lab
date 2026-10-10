# cli-surface

What the current Supabase CLI does with two features announced in the Select
2026 notes (https://supabase.com/blog/select-2026-build-anything):

1. pg-delta declarative schemas (`db diff --use-pg-delta`, `db schema
   declarative generate|sync`, `config pull`, `pull`), against the migra
   engine, by the catalog fingerprint of the database each path produces.
   Changelog: https://supabase.com/changelog/44938-public-alpha-declarative-schema-management-with-pg-delta
2. The experimental stack backend (`[experimental] stack = true`,
   `SUPABASE_EXPERIMENTAL_STACK=1`) in a Linux container that has no
   container engine, with one and several git worktrees.

Self-provisioning, no OpenTofu state. CLI under test: 2.120.0 (the container
image pins it and checks the release checksum; CL01-CL03 use whatever
`supabase` is on PATH and record its version, CL04 used the same host install
but recorded no version).

## Modules

| id | claim |
|---|---|
| CL01 | `db diff`: migra vs pg-delta on one fixture; which features each diff names, which engine runs by default on a fresh `init`, round-trip catalog fingerprint, warm wall time |
| CL02 | `declarative generate`, then `sync`, `db reset`, fingerprint; second sync, `db diff` and second export are empty or identical |
| CL03 | sync after edits (new column, dropped policy, new table in a new file, deleted table file), apply and migration history, hand-written tree with file names against dependency order, 22 object kinds (migra / pg-delta / export), strict coverage, engine mixing |
| CL04 | one Free-org project: `config pull` (dry run, write, after changes through the APIs), linked `db diff` with both engines, `supabase pull`, local rebuild fingerprinted against the remote. Destructive |
| CL20 | stack in a box with no Docker: legacy control, cold start, ports, lazy services, first-request latency, memory, restart, app flow through the gateway |
| CL21 | main plus two linked worktrees: ports, start times, isolation, memory, stop one, branch switch, fixed-port config collision |
| CL22 | switches and precedence, command surface (db diff, declarative, reset, migration, dump, lint, gen types, test db, functions serve), services vs the legacy list, config drift |

## Run

```bash
make -C experiments/cli-surface local        # CL01-CL03, needs Docker
make -C experiments/cli-surface nodocker     # CL20-CL22, builds pvlab-cli-nodocker:2.120.0
sx SUPABASE_ACCESS_TOKEN -- env PVLAB_ORG_FREE=<free-org-slug> \
  make -C experiments/cli-surface remote     # CL04, creates and deletes one project
```

Raw output lands in `evidence/<ts>/` (gitignored). `make publish-evidence
RUN=evidence/<ts>/run-<stamp>.json` writes the redacted copy to `out/<date>/`.

## Measured results

See RUNLOG.md.
