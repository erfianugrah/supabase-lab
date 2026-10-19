# cipherstash-eql - RUNLOG

## 2026-10-19 - local Docker rig, EQL 3.0.6, Postgres 17.11, PostgREST 14.17

Artifacts: `out/2026-10-19/`. `ce-local.json` is the result object quoted
below; `ce-local.log` holds the same JSON with the test harness output. One
run of each check. The rig was re-run several times on 2026-10-19 while it was
being fixed; the figures below are from the final run unless a sentence says
"earlier, unarchived run".

Install (`install.txt`, `install-notices.txt`):

- `eql_version=3.0.6`, installed as `postgres superuser=false` on
  `pg_image=supabase/postgres:17.11.0.004`, `psql_exit=0`,
  `pgcrypto_schema=extensions` (pgcrypto came with the image).
- `eql_schema_acl=eql_v3:null eql_v3_internal:null`: no privilege on either
  EQL schema for any role other than the owner after the install.
- `eql_domain_count=52` EQL domains in `public`, in 11 families:
  `bigint,boolean,date,double,integer,json,numeric,real,smallint,text,timestamp`.
  None is a bytes or binary type.
- The installer skipped `eql_v3_internal.ore_block_256_operator_class`
  ("requires superuser") and reported "20 ORE-backed domains disabled and will
  raise on use", pointing to the `_ord_ope` and `_eq` domains instead, with
  "OPE ordering domains unaffected". Neither the disabled ORE domains nor the
  OPE domains were exercised.

Vendor test (`vendor-text_eq.txt`): `9 passed; 0 failed`, its ignored database
test included, run as `postgres`.

Probe (`ce-local.json`):

| id | result |
|---|---|
| CE01 | `rows: 4` (counted); `plaintext_refs_in_rows: []`, `plaintext_deks_in_rows: 0` |
| CE02, before grants, equality as `authenticated` | SQL: `permission denied for schema eql_v3`; PostgREST: 403 `42501` `permission denied for schema eql_v3` |
| CE02, before grants, plaintext-only SQL as `authenticated`, each shape in its own new connection | all three shapes: `permission denied for schema eql_v3_internal`, context `SQL function "eq_term" during inlining` |
| CE02, the same with the EQL index dropped (rolled back) | `count(*)` 2, `WHERE id = 1` 1, `ORDER BY id` 2 rows counted |
| CE02, the same in a connection where `postgres` first planned `SELECT ... WHERE id = 1` on the table | 2, 1 and 2 rows counted, no error |
| CE02, before grants, PostgREST `select=id&order=id` as A | 403 `42501` `permission denied for schema eql_v3_internal` |
| CE03, after grants, equality over SQL with the term-only query envelope | A `[1]`, B `[3]` |
| CE03, after grants, PostgREST with a freshly encrypted full stored envelope of `S-001` as the `eq.` operand | A `[1]` (200), B `[3]` (200) |
| CE03, after grants, PostgREST unfiltered read as A | `[1, 2]` (200) |
| CE03, the term-only query envelope as the PostgREST operand | 400 `23514` `value for domain eql_v3_text_eq violates check constraint "eql_v3_text_eq_check"` |
| CE03, after grants, plaintext-only SQL as `authenticated` | 2, 1 and 2 rows counted |
| CE03, `eql_probe_reader` (table SELECT, no EQL grant), plaintext-only SQL | all three shapes: `permission denied for schema eql_v3_internal`, context `SQL function "eq_term" during inlining` |
| CE04 | row 1, as returned by PostgREST to A for the `S-001` filter: `dek_matches: true`, `dek_bytes: 32`, `subject_ref: "S-001"` |
| CE05 | `uses_index: true`: Bitmap Index Scan on `assets_subject_ref_idx` (EXPLAIN as `postgres`, term-only query envelope, `enable_seqscan = off`) |

Operand sizes (`operand_bytes`): term-only query envelope 116 bytes, full
stored envelope 275 bytes, percent-encoded PostgREST path and query string
carrying it 427 bytes. The path length changes by a few bytes between runs
(earlier, unarchived runs on 2026-10-19: 419 to 435), because percent-encoding
expands some base64 characters of the fresh ciphertext and not others.

What it shows:

- The EQL installer runs as this image's non-superuser `postgres` role. The
  equality domain works (CE03). Managed was not tested (no project was created
  in this run).
- The installer grants nothing: its permissions doc says so, `eql_schema_acl`
  is null on both schemas after the install, and CE02 ran on that state (no
  REVOKE before it). With an EQL functional index on the table, a role with none of
  the EQL grants fails even plaintext-only SELECTs on that table in a fresh
  connection: the planner inlines the index expression `eql_v3.eq_term`, whose
  body calls `eql_v3_internal.hmac_256`, and the schema permission check fails
  during inlining. Dropping the index (CE02) or granting USAGE on `eql_v3` and
  `eql_v3_internal` and EXECUTE on all their functions (CE03; USAGE on
  `extensions` not granted) made the same queries work; no subset was tested. Measured for
  `authenticated` and `eql_probe_reader`; by the same mechanism `anon`,
  `service_role` or a reporting role would fail the same way without the
  grants, not run for those roles. Writes were not tested.
- Whether a query fails depends on the connection. In a connection where
  `postgres` had already planned against the table, the same plaintext reads
  as `authenticated` succeeded before any grant (CE02, warm row). The likely
  mechanism, recalled and not measured beyond that row: Postgres caches a
  table's index expressions per backend (relcache), so the inlining, and its
  permission check, happens once per backend, as whichever role plans first.
  Through a connection pool, whether a request fails can then depend on
  which backend serves it; reasoned from these rows, not measured through a
  pooler.
- Through PostgREST, equality works with a full stored envelope as the `eq.`
  operand, and RLS still scopes the result to the caller (A `[1]`, B `[3]`).
  The term-only query envelope fails the column's domain check, which matches
  CipherStash's supabase-js guide ("PostgREST cannot cast a term-only query
  envelope"). The operand, with its ciphertext and every index term for the
  value, travels in the GET query string.
- The 4 rows were inserted over SQL as `postgres`; nothing was written
  through PostgREST, and the RLS policy covers SELECT only.
- PostgREST logging: in the final run, `pgrst.log` has one request line, the
  rig's start-up check (`GET /`, 503, schema cache not loaded); none of the
  200, 400 or 403 responses produced a request line. In an earlier, unarchived
  run the same day, requests carrying the `eq.` operand that were answered 503
  were logged with the full query string. Whether the managed API gateway
  keeps query strings in its logs was not tested.
- A storage-only `eql_v3_text` column held a 32-byte data key as ciphertext
  and PostgREST returned it intact (CE04, one row). `stack-encrypt` at this
  commit derives no `EncryptFrom` for the storage-only `Text` domain; the
  probe seals natively, wraps the payload, and decrypts the native leaf, as
  CipherStash's own `text_eq.rs` does for `TextEq`. Whether this amounts to
  key wrapping depends on ZeroKMS (per CipherStash's key-management docs, each
  value gets its own derived data key and the client key stays with the
  application owner; doc-read, not tested), which this rig replaces with an
  in-memory fake.

Earlier, unarchived run (2026-10-19), rig defect: with the bare image's
`auth.uid()` (it read only `request.jwt.claim.sub` when printed with
`pg_get_functiondef` in that run), PostgREST requests after
the grants returned `[]` for both owners, because PostgREST 14 sets
`request.jwt.claims` and not `request.jwt.claim.sub`; installing GoTrue's
definition fixed it. Not reproduced in the final run, which installs it first.

Not run: managed Supabase (needs a Management API token and a Pro org), the
self-hosted compose stack (bare image plus PostgREST here), ZeroKMS (needs a
CipherStash account), the TypeScript `encryptedSupabase` wrapper, OPE ordering
and range filters, free-text match, encrypted JSON, any write through
PostgREST, writes by a role without grants, any timing, any pooler, and the managed gateway's handling of
ciphertext in query strings. EQL has no bytes type (the 11 installed domain
families above; CipherStash's TypeScript plaintext enum agrees, source-read,
see `docs/research/raw/2026-10-19-cipherstash/findings.md`), so large objects
stay with client-side encryption in Storage; nothing here tests otherwise.
