# cipherstash-eql

What does CipherStash's Encrypt Query Language (EQL v3) need from a Supabase
database, and does its ciphertext work in a catalogue table read through the
Data API under RLS? Specifically: does the installer run as the non-superuser
`postgres` role, which grants do reading roles need, which PostgREST filter
operands work, and can a storage-only encrypted column hold a per-object data
key for a client-side-encrypted object store such as the one in
[client-keyed-objects](../client-keyed-objects/)?

Run on a local Docker rig, not on managed Supabase, and outside the pvlab
harness. The ciphertext comes from CipherStash's own Rust engine
(`stack-encrypt`) over the in-memory `FakeDataKeySource` from `stack-kms`, so
no CipherStash account and no ZeroKMS are involved. These are real EQL v3
payloads, but nothing here says anything about ZeroKMS: its key derivation,
authorisation, availability, regions or latency. The fake's own doc comment
says it "models none of ZeroKMS's authorization semantics".

## Rig

| part | what |
|---|---|
| Postgres | `supabase/postgres:17.11.0.004`; its `postgres` role is not a superuser (`install.txt`: `superuser=false`); EQL's permissions doc says the `postgres` role on cloud-hosted Supabase cannot create its ORE operator class; managed not tested here |
| EQL | `cipherstash-encrypt.sql` from the `eql-3.0.6` release of cipherstash/stack, installed with psql as `postgres`; SHA-256 and psql exit status in `out/<date>/install.txt` |
| PostgREST | `postgrest/postgrest:v14.17` (the self-hosted compose pin until it moved to v14.18), `db-schemas=app`, HS256 JWTs signed by `run-local.sh` |
| `auth.uid()` | replaced with GoTrue's definition (supabase/auth `migrations/20220224000811_update_auth_functions.up.sql`): the bare image's version reads only `request.jwt.claim.sub`, and of the two JWT settings PostgREST 14 sets `request.jwt.claims`, not `request.jwt.claim.sub` |
| ciphertext | cipherstash/stack at commit `66092fe450b555353a138d0d104f204cfcf255b1`, `packages/eql/tests/encryption`; `probe/supabase_probe.rs` is copied into that crate's `tests/` and run there |

Catalogue: `app.assets (id, owner uuid, subject_ref eql_v3_text_eq,
wrapped_dek eql_v3_text)`, a functional index on `eql_v3.eq_term(subject_ref)`,
RLS `owner = auth.uid()` for `authenticated`. Owner A holds rows 1 (`S-001`)
and 2 (`S-002`), owner B rows 3 (`S-001`) and 4 (`S-003`). Each `wrapped_dek`
is a 32-byte test key read from `/dev/urandom`, base64, encrypted as a
storage-only `eql_v3_text`.

Role-switched SQL checks (CE02, CE03) log in as `postgres`, open a new
connection per query, and run `SET LOCAL ROLE <role>` with `request.jwt.claims` set through `set_config`,
inside a transaction that is rolled back. PostgREST checks send the JWT of
owner A or B. CE01 inserts and CE05 explains over the probe's own `postgres`
connection.

## Checks

| id | asks |
|---|---|
| vendor | CipherStash's own `tests/text_eq.rs`, including its ignored database test (per its source: store, equality query, functional index, decrypt), run as `postgres` |
| CE01 | Rows written over SQL as `postgres` (counted), no plaintext subject reference or base64 data key in the stored column text |
| CE02 | On the installer's grants (none), as `authenticated`: equality over SQL and PostgREST; three plaintext-only SQL shapes (`count(*)`, `WHERE id = 1`, `ORDER BY id`) in a new connection, the same with the EQL index dropped, and the same in a connection where `postgres` planned against the table first; a plaintext-only PostgREST read |
| CE03 | After granting `authenticated` USAGE on `eql_v3` and `eql_v3_internal` and EXECUTE on all their functions: equality over SQL (term-only query envelope) and over PostgREST (a freshly encrypted full stored envelope of `S-001`) per owner, the term-only envelope as a PostgREST operand, an unfiltered read, the three plaintext SQL shapes, and the same shapes for `eql_probe_reader`, a role with table SELECT and no EQL grant |
| CE04 | The row PostgREST returned to owner A for the `S-001` filter decrypts to the original data key and subject reference |
| CE05 | EXPLAIN as `postgres` with `enable_seqscan = off`: can the equality predicate use the functional index |
| install | `install.txt` also records the EQL schema ACLs, the number of EQL domains and their families |

## Run

```sh
STACK_SRC=<cipherstash/stack checkout at the commit above> ./run-local.sh
./run-local.sh down
```

Writes `out/<date>/`: `install.txt`, `install-exit.txt`, `install-notices.txt`
(the installer's EQL notices), `vendor-text_eq.txt`, `ce-local.json`,
`ce-local.log` and `pgrst.log`. The cipherstash/stack checkout stays outside
this repo; `stack-encrypt` and `stack-kms` are under the PolyForm Internal Use
licence.

Results: [RUNLOG.md](RUNLOG.md).
