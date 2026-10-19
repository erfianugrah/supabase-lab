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
  equality domain works (CE03). The managed run below gave the same results.
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

Not run on this rig: the self-hosted compose stack (bare image plus PostgREST here), ZeroKMS (needs a
CipherStash account), the TypeScript `encryptedSupabase` wrapper, OPE ordering
and range filters, free-text match, encrypted JSON, any write through
PostgREST, writes by a role without grants, any timing, any pooler, and the managed gateway's handling of
ciphertext in query strings. EQL has no bytes type (the 11 installed domain
families above; CipherStash's TypeScript plaintext enum agrees, source-read,
see `docs/research/raw/2026-10-19-cipherstash/findings.md`), so large objects
stay with client-side encryption in Storage; nothing here tests otherwise.

## 2026-10-19 - managed, one Pro-org micro project, ap-southeast-1

`run-managed.sh`: one throwaway project created through the Management API
and deleted at the end of the same script (`delete project: 200`). SQL checks
over the direct connection (the `db.` host's AAAA record, connected by
address, so a new connection is a new backend, not a pooler slot); PostgREST
through the project's API gateway with the legacy `anon` key as `apikey` and
the access tokens of two Auth users created through the admin API. Schema
`app` added to the exposed schemas (`postgrest-config.json`:
`public,graphql_public,app`). The probe source is the same as the final local
run's (it sends `Accept-Profile: app`, which managed needs because PostgREST
serves the first exposed schema, `public`, by default; the first managed
attempt failed on `PGRST205` without it; an attempt before that never
reached the database because every lookup of the direct host through the
laptop's resolver failed, while later runs got the AAAA record from 1.1.1.1
within a second, so local negative caching is suspected, not separated; both
projects were deleted). Artifacts: `out/2026-10-19-managed/`.

Install (`install.txt`): `eql_version=3.0.6`, `install_role=postgres
superuser=false`, `pg=17.11`, `eql_domain_count=52`,
`eql_schema_acl=eql_v3:null eql_v3_internal:null`, `pgcrypto_schema=extensions`,
`psql_exit=0`, and `auth_uid_reads_claims=t` (managed's `auth.uid()` reads
`request.jwt.claims`). The installer printed the same two notices as on the
local rig (`install-notices.txt`).

Vendor test (`vendor-text_eq.txt`): `9 passed; 0 failed`, its ignored database
test included, as `postgres` over the direct connection.

Probe (`ce-managed.json`): every CE01-CE05 value is identical to the local
`ce-local.json` except the EXPLAIN plan text (costs) and the percent-encoded
path length (429 bytes against 427). In particular, on managed:

- CE02: before any grant, `authenticated` got `permission denied for schema
  eql_v3_internal` (context `SQL function "eq_term" during inlining`) on all
  three plaintext-only SQL shapes in a new connection, and PostgREST
  `select=id&order=id` answered 403 `42501`; with the index dropped, and in a
  connection where `postgres` planned first, the same reads counted 2, 1 and 2
  rows.
- CE03: equality over SQL A `[1]`, B `[3]`; PostgREST with the stored envelope
  A `[1]` (200), B `[3]` (200); the term-only envelope 400 `23514`;
  `eql_probe_reader` failed the three plaintext shapes as on the local rig.
- CE04: row 1 decrypted to the original 32-byte key and `S-001`.
- CE05: Bitmap Index Scan on `assets_subject_ref_idx`.

Not run on managed: any pooler (Supavisor session or transaction mode), the
new `sb_publishable_` key as `apikey`, the PostgREST version (not recorded),
the API gateway's logs, and everything listed as not run for the local rig
apart from managed itself.

## 2026-10-19 - ZeroKMS: managed project, @cipherstash/stack 1.2.1, encryptedSupabase

Real ZeroKMS keys this time. `run-zk-managed.sh` creates one Pro-org micro
project in ap-southeast-1, installs EQL 3.0.6 from the release SQL as
`postgres`, applies `zk/schema.sql` (tables in `public`, which the wrapper
introspects; RLS `owner = auth.uid()`; the EQL grants to `anon`,
`authenticated` and `service_role`), creates two Auth users and runs
`zk/probe.ts` with `@cipherstash/stack` 1.2.1, `@cipherstash/stack-supabase`
1.2.1 (protect-ffi 0.33.0) and supabase-js 2.118.0. CipherStash credentials:
the CLI device session (`stash auth login --region ap-southeast-2`, stash
1.1.1), no `CS_*` variables. The probe routes CipherStash traffic through an
in-process CONNECT proxy (`HTTPS_PROXY`, Supabase hosts in `NO_PROXY`; ZK05
shows the SDK's requests go through it, and the proxy logged no Supabase
host), which records the hosts it is asked for and can refuse or black-hole
them. A pre-run check with a dead proxy, not archived, saw `Encryption()`
fail in 5 ms with `Failed to load keyset: SendRequest`. Vantage: one laptop
in Singapore; ZeroKMS workspace in ap-southeast-2 (Sydney); project in
ap-southeast-1.

Runs, all on 2026-10-19, each on its own project, all deleted:

- run 1 (`zk-managed-run1.json`, `install-run1.txt`): ZK01-ZK07 with
  `KEEP=1`. Its ZK06 ciphertext check was a raw substring test against
  whichever `edge_logs` row carried the operand's `hm` slice, and it returned
  `rowHasCiphertextSlice: false` (see ZK06 below); the probe was then changed
  to decode the stored query string and compare it with the request sent.
- follow-up (`zk-followup-run1.json`): `run-zk-followup.sh` on run 1's
  project after the project's issuer was registered by hand as an OIDC
  provider in the CipherStash workspace dashboard: ZK06b and ZK07b, with two
  new Auth users.
- run 2 (`zk-managed.json`, `install.txt`): ZK01-ZK07 with the probe as
  committed.
- An attempt before run 1 failed before any test (node-postgres read the
  runner's `PGSSLMODE=require` as verify-full: `self signed certificate in
  certificate chain`); the runner now unsets it and uses
  `sslmode=no-verify`. Its project was deleted.

Install (`install.txt`, `install-notices.txt`): `eql_version=3.0.6`,
`pg=17.11`, `psql_exit=0`, the same two ORE notices as the local rig. The ZK
install recorded only these; pgcrypto, the domain count and the superuser
check were recorded for the CE targets only. The `stack_commit_for_eql_ref`
line in both `install*.txt` files came from an earlier version of the
runner, which no longer writes it.

| id | run 1 | run 2 |
|---|---|---|
| ZK01 insert 6 rows as A / 3 as B (one wrapper call each) | 714 / 413 ms | 615 / 390 ms |
| ZK01 stored rows | 9 (A 6, B 3), `plaintextHits: []` | same |
| ZK01 payload keys | `text_eq` c,hm,i,v; `text_ord` c,hm,i,op,v; `integer_ord` and `date_ord` c,i,op,v; `text` c,i,v | same |
| ZK01 three rows with subject `S-001` (A 2, B 1) | same `hm`, different `c` | same |
| ZK02 checks with an expected result (18 reads plus the update; 9 with an encrypted operand) | 19 of 19 pass, 0 fail | 19 of 19, 0 |
| ZK02 decrypted values for A's 6 rows | 0 mismatches; `score` number, `seen` Date | same |
| ZK02 update as A, delete as B, B updating A's rows | pass, `["b2"]`, 0 rows | same |
| ZK03 32-byte data key in `eql_v3_text` | round trip, stored keys c,i,v, no plaintext | same |
| ZK07 federation, issuer not registered | `401: Authorization failed: No OIDC provider found for issuer` | same |
| proxy, hosts asked for | `ap-southeast-2.aws.viturhosted.net` 13, `ap-southeast-2.aws.cts.cipherstashmanaged.net` 1; no Supabase host | same |

ZK02's 19 checks: select all as A and as B (RLS); equality on `text_eq` as
A and as B, `in`, `neq`; `gte`/`lt` on `integer_ord`; `gt` on `text_ord`;
`gte` on `date_ord`; equality on `integer_ord`; ordering ascending and
descending on `integer_ord`, ascending on `text_ord`, descending on
`date_ord`; `range(0,1)` paging; an encrypted and a plaintext filter
together; `is(subject, null)`; a plaintext-only select; the update as A.
Expected results were computed in the probe from the inserted values. Refused
by the wrapper in 2 ms or less, too fast for a network request (`.csv()`
threw and was not timed), with these messages: equality on `eql_v3_text` ("does not support
equality queries"), ordering on `eql_v3_text_eq` ("cannot order by encrypted
column ... carries no ordering term"), `gt` on `eql_v3_text_eq` ("does not
support orderAndRange queries"), `.csv()` ("unavailable on encrypted
queries because PostgREST serializes rows before the adapter can decrypt
them").

ZK04 latency, ms (SDK single operations n = 20 per run; wrapper and plain
supabase-js n = 10 per run; bulk and client init one call per run; p95 is
the largest of the n samples):

| measurement | run 1 p50 / p95 | run 2 p50 / p95 |
|---|---|---|
| SDK encrypt, one value | 257 / 321 | 269 / 335 |
| SDK decrypt, one value | 255 / 358 | 269 / 359 |
| wrapper insert, one row (one `text_eq` column) | 312 / 419 | 297 / 313 |
| supabase-js insert, plaintext table | 44 / 93 | 44 / 96 |
| wrapper select with an encrypted `eq` filter, one row | 562 / 580 | 554 / 620 |
| supabase-js select, plaintext `eq` filter | 43 / 82 | 47 / 83 |

| bulk, values | run 1 encrypt / decrypt | run 2 encrypt / decrypt |
|---|---|---|
| 10 | 261 / 359 | 273 / 272 |
| 100 | 766 / 2918 | 896 / 280 |
| 500 | 1066 / 813 | 581 / 312 |

Client init (`Encryption()`): 773 and 1056 ms; wrapper init
(`encryptedSupabase()`, introspection included): 1521 and 1286 ms. In ZK02 a
query with an encrypted filter operand that selected only the plaintext
`note` (so no decrypt) took 282-371 ms, and an ordering that selected only a
plaintext column 33-85 ms (both runs).

ZK05, ZeroKMS unreachable after init (wrapper and SDK already initialised;
the proxy drops its tunnels on each switch). Time to result, ms:

| operation | refused, run 1 / 2 | black-holed, run 1 / 2 | result |
|---|---|---|---|
| wrapper insert | 2 / 5 | 10005 / 10003 | `EncryptionError` ("ZeroKMS error 'Unexpected error (SendRequest: Failed to send request)'") |
| wrapper select of encrypted columns | 63 / 47 | 10047 / 10059 | `DecryptionError` ("Failed to retrieve key") |
| wrapper select, plaintext columns only | 39 / 47 | 60 / 55 | 7 rows, no error |
| wrapper encrypted `eq` filter | 2 / 4 | 10003 / 10004 | `EncryptionError` |
| SDK decrypt of a value encrypted before the outage | 2 / 3 | 10003 / 10004 | `DecryptionError` |
| supabase-js select of the same table | 37 / 40 | 46 / 58 | 7 rows, no error |

Recovery after the proxy passed traffic again: the first query succeeded in
903 and 838 ms, with no client re-initialisation.

ZK06 logs. The S-001 equality GET carried a 250-byte operand (keys c, hm, i,
v) in a 478 / 466-byte URL. `edge_logs` rows on the managed API gateway
carrying its `hm` slice: 2 / 3, each with the query string in
`request.search` (the row read: 421 / 410 characters). In run 2 the decoded
operand's `c` and `hm` equal the ones sent (`storedOperandMatchesSent:
true`). In run 1 the sampled GET itself had no row (ZK06b's earliest row is
the later `eq` on `score`), so the row read belonged to another S-001
request, whose `c` differs because each operand is encrypted afresh. That
alone explains `rowHasCiphertextSlice: false`; percent-encoding may also
have contributed (the earlier probe is not committed). ZK06b decoded every
logged `/rest/v1/records` request with an `eq.` parameter on run 1's
project: 8 rows (GET 5, PATCH 2, DELETE 1), 6 of them written out. 4 of
those 6 carried an encrypted operand with its full key set: `subject` with
keys c, hm, i, v (c 130 characters, hm 64) and, for the equality filter on
`score` (`integer_ord`), keys c, i, op, v (c 132); the other 2 had only a
plaintext `note=eq.`. ZK06b recorded keys and lengths and did not compare
them with what was sent. By the probe source, 10 requests with an `eq.`
parameter went to that path on run 1's project (7 GET, 2 PATCH, 1 DELETE),
so 2 had no row when read. Range, `in` and `neq` operands were not decoded.
`postgres_logs`: no row contained either operand slice in either run; 6
logged statements mentioned the table, and the 3 written out are DDL run over
psql.

ZK07b, federation (run 1's project, issuer registered, two new Auth users
A and B): as user A,
`OidcFederationStrategy` (CRN plus A's Supabase access token) encrypt and
decrypt worked; user B, federated the same way, decrypted A's unlocked value.
With the lock context `{ identityClaim: ["sub"] }` A encrypted and decrypted;
B's decrypt failed with `DecryptionError` "Failed to retrieve key: Failed to
send request: Forbidden: Request forbidden". CipherStash's Supabase Auth page
says lock context requires a Business or Enterprise workspace plan; it worked
on this newly created workspace, whose plan was not read.

What it shows:

- The wrapper runs equality, `in`, `neq`, range and ordering on encrypted
  `text_eq`, `text_ord`, `integer_ord` and `date_ord` columns through
  PostgREST under RLS on managed, with the results equal to the same filter
  on plaintext, in both runs. Unsupported combinations fail in the client.
- Every encrypt or decrypt is a round trip to ZeroKMS (inferred from
  latency; requests not counted): 255-269 ms p50 from this vantage to
  Sydney, so a wrapper select with an encrypted filter costs one encrypt (the
  operand) plus one decrypt (the rows) on top of the request: 554-562 ms
  against 43-47 ms. Per CipherStash's docs a bulk call makes one ZeroKMS
  call; measured, 500 values took 581-1066 ms to encrypt against 257-269 ms
  p50 for one value. The distances (Singapore to Sydney for ZeroKMS,
  Singapore to Singapore for the project) dominate (reasoned, not varied);
  another vantage or a ZeroKMS region next to the application was not run.
- With ZeroKMS unreachable, nothing encrypted can be read or written, a value
  encrypted just before the outage included (so no cached key served these
  calls; SDK source not read), while Postgres,
  PostgREST and plaintext columns are unaffected. A black-holed connection
  fails after 10.0 s per operation in every case, consistent with a 10 s
  request timeout in the client (not source-read). The client recovered on
  its own.
- The managed gateway's `edge_logs` keep the encrypted filter operand of
  each logged request, ciphertext and index terms included, for GET, PATCH
  and DELETE (8 of 10 `eq.` requests had a row when read).
  CipherStash's supabase-js guide asks for logs not to retain query strings;
  on managed Supabase the gateway's log does. Retention follows the plan's
  log retention (not measured here).
- Federation and the lock context did what CipherStash documents: the lock
  bound the value to A's `sub`, and B's valid federated session could not
  derive the key.
- Observed in the CipherStash dashboard during the follow-up (screenshot not
  archived): its readiness check for run 1's project showed "EQL
  installed" and "Encrypted columns detected" as not done, while
  `eql_v3.version()` returned 3.0.6 and the tables held six encrypted
  columns. The dashboard suggests `stash db install --supabase --migration`;
  this run installed from the release SQL. Cause not checked.

Not run: Supavisor (both modes), the Drizzle and Prisma integrations (free
text and encrypted JSON), the access-key and client-key credentials (device
session only), ZeroKMS from a second vantage or region, timing beyond the two
runs, concurrency, range, `in` and `neq` operands in `edge_logs`, edge_logs
retention, the TypeScript wrapper inside an Edge Function (WebAssembly
build).
