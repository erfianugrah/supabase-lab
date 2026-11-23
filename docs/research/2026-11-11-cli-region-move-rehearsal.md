# CLI dump/restore region move, hand-run rehearsal (2026-11-11)

Question: what does the documented CLI backup-and-restore path carry when it is
used to move a project to another region, and what has to be put back by hand?

Shape: one throwaway pair on a Pro org, source in ap-southeast-1, target in
eu-west-3, both Micro (`desired_instance_size: "micro"` on
`POST /v1/projects`), PostgreSQL 17.11 on both. Supabase CLI 3.1.0, psql 17,
client in Singapore. The source was seeded with: SECURITY DEFINER functions
with `EXECUTE` revoked from `anon` and `authenticated`, RLS policies, a
`pg_cron` job, Vault secrets, a public bucket with policies on
`storage.objects`, 1,100 objects in one folder (1,130 in all), and password
users. The steps followed the Supabase docs page "Backup and Restore using the
CLI":

```bash
supabase db dump --remote="$SRC" -f roles.sql --role-only
supabase db dump --remote="$SRC" -f schema.sql
supabase db dump --remote="$SRC" -f data.sql --use-copy --data-only \
  -x "storage.buckets_vectors" -x "storage.vector_indexes"
psql --single-transaction --variable ON_ERROR_STOP=1 --file roles.sql \
  --file schema.sql --command 'SET session_replication_role = replica' \
  --file data.sql --dbname "$TGT"
```

The rehearsal was hand-run with shell scripts, not the pvlab harness, so no
run artifact is published; the scripts held connection passwords and stayed on
the machine that ran them. Every observation below was read off the two
projects during the run. One run. The single `psql` call exited 0 with an
empty stderr under `ON_ERROR_STOP=1`; `roles.sql` from this CLI version held
`ALTER ROLE` statements, so it raised no error against the target's existing
roles.

## What carried

| Surface | On the target after the restore |
|---|---|
| Tables, rows, RLS policies | present |
| Realtime publication | present |
| Sequences | carried at the source's values; the next insert did not collide |
| `auth.users` | present; a password login answered 200 |
| `storage.buckets`, `storage.objects` rows | present: the bucket and its file list |

## What did not carry

| Surface | Observed | Put back by |
|---|---|---|
| Object bytes | a GET of a restored object answered 400; the listing looked complete | copying the objects (below) |
| Policies on `storage.objects` | absent | re-running `create policy` lines generated from the source's `pg_policies` |
| `cron.job` rows | absent | `cron.schedule(...)` per saved job, with the old project's URL and key swapped |
| Vault secrets | absent: the CLI's data-only dump excludes the `vault` schema (its `--dry-run` script lists `vault` under `--exclude-schema`; re-read with CLI 3.2.0 on 2026-11-23), so the ciphertext never arrives and the root key question does not arise on this path | `vault.create_secret(...)` per secret, from the source's `vault.decrypted_secrets` saved before the window |
| `EXECUTE` revokes on functions | undone: functions revoked from `anon` and `authenticated` on the source were callable by both on the target. `schema.sql` carried only `REVOKE ... FROM PUBLIC`; the target's default privileges granted `EXECUTE` to `anon` and `authenticated` when the restore created each function | re-running the revokes on the target, then listing what `anon` can execute |
| Access tokens issued by the source | refused at the target: `401 PGRST301` | users sign in again (passwords carry) |

## Storage copy

The docs page's "Migrating storage objects" script lists each folder with
`limit: 1000` and does not page. In one folder of 1,100 objects it found 1,000.
A version that requests pages of 1,000 with an increasing `offset` until a page
comes back short found 1,130 of 1,130 and copied them in 94 s from Singapore,
small objects, every byte through the client machine. The bucket already
existed from the restore, so the script's merge option was the one used.

## Side observations

- Bucket visibility: after `update storage.buckets set public = false`, an
  object never fetched through its public URL answered 400 at once. An object
  fetched publicly before the switch still answered `200` with
  `cf-cache-status: HIT` on all 45 one-minute polls of a poll started after
  the switch (04:38 to 05:22 UTC). Signed URLs kept working.
- A new Micro project read `max_wal_size` 4096 MB and `min_wal_size` 1024 MB.
- Two `drop index concurrently` statements in one Management API
  `/database/query` call failed with SQLSTATE 25001, "cannot run inside a
  transaction block"; one per call succeeded.
- Edge Function invocations made by `pg_net` (from `pg_cron`) appear in the
  `function_edge_logs` source with `request.headers.user_agent` starting
  `pg_net`, not in `edge_logs`.

## Not run

Logical replication (that path is pgmig's, see its 2026-11-09 live runs), a
Postgres 15 source, OAuth identities, Edge Function
moves end to end, custom domains, and any timing of the write-stop window
itself.
