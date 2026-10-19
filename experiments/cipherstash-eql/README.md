# cipherstash-eql

What does CipherStash's Encrypt Query Language (EQL v3) need from a Supabase
database, and does its ciphertext work in a catalogue table read through the
Data API under RLS? Specifically: does the installer run as the non-superuser
`postgres` role, which grants do reading roles need, which PostgREST filter
operands work, and can a storage-only encrypted column hold a per-object data
key for a client-side-encrypted object store such as the one in
[client-keyed-objects](../client-keyed-objects/)?

Two parts, both outside the pvlab harness:

- CE01-CE05 run on a local Docker rig and on one managed Pro-org project
  (`run-managed.sh`). The ciphertext comes from CipherStash's own Rust engine
  (`stack-encrypt`) over the in-memory `FakeDataKeySource` from `stack-kms`:
  real EQL v3 payloads, no CipherStash account, nothing about ZeroKMS. The
  fake's own doc comment says it "models none of ZeroKMS's authorization
  semantics".
- ZK01-ZK07 (and the follow-up ZK06b, ZK07b) run against managed projects
  with real ZeroKMS keys, through CipherStash's TypeScript SDK and its
  supabase-js wrapper (`zk/`, `run-zk-managed.sh`, `run-zk-followup.sh`).
  See [ZeroKMS checks](#zerokms-checks-zk).

## Rig

| part | what |
|---|---|
| Postgres | `supabase/postgres:17.11.0.004`; its `postgres` role is not a superuser (`install.txt`: `superuser=false`); the managed project's is not either (`out/2026-10-19-managed/install.txt`) |
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

# managed: one Pro-org micro project in ap-southeast-1, deleted on exit;
# needs IPv6 to the direct database host
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<org slug> STACK_SRC=... ./run-managed.sh
```

The managed run writes `out/<date>-managed/` (`install.txt`,
`install-notices.txt`, `install-exit.txt`, `postgrest-config.json`,
`vendor-text_eq.txt`, `ce-managed.json`, `ce-managed.log`), with no project
ref in any of them.

Writes `out/<date>/`: `install.txt`, `install-exit.txt`, `install-notices.txt`
(the installer's EQL notices), `vendor-text_eq.txt`, `ce-local.json`,
`ce-local.log` and `pgrst.log`. The cipherstash/stack checkout stays outside
this repo; `stack-encrypt` and `stack-kms` are under the PolyForm Internal Use
licence.

## ZeroKMS checks (ZK)

| part | what |
|---|---|
| SDK | `@cipherstash/stack` 1.2.1, `@cipherstash/stack-supabase` 1.2.1 (protect-ffi 0.33.0), supabase-js 2.118.0, pg 8.23.1 (`zk/package.json`, `zk/bun.lock`), run with bun |
| credentials | the CipherStash CLI device session from `bunx stash@1.1.1 auth login --region ap-southeast-2`, stored in `~/.cipherstash/`; no `CS_*` credential variables (`CS_FED_CRN` only names the workspace for ZK07 and ZK07b) |
| project | one Pro-org micro project in ap-southeast-1 per run, EQL 3.0.6 from the release SQL, `zk/schema.sql` (tables in `public`, which `encryptedSupabase` introspects; RLS `owner = auth.uid()`; the EQL grants to `anon`, `authenticated`, `service_role`), two Auth users created through the admin API |
| network | (ZK01-ZK07 only; the follow-up runs without the proxy) CipherStash traffic goes through a CONNECT proxy inside `zk/probe.ts` (`HTTPS_PROXY`), Supabase hosts direct (`NO_PROXY`); the proxy logs the hosts asked for and can refuse or black-hole them |

| id | asks |
|---|---|
| ZK01 | Wrapper inserts as two users; what Postgres stores per domain (`text_eq`, `text_ord`, `integer_ord`, `date_ord`, `text`): plaintext absent, payload keys, identifier, equality term and ciphertext for equal values |
| ZK02 | Wrapper reads under RLS: 19 checks (18 filter, range, ordering and paging reads, 9 of them with an encrypted operand, plus the update) compared with the expected result computed in the probe from the inserted plaintext; delete, delete, a cross-owner update; misuse cases (equality on storage-only, ordering or range on equality-only, `.csv()`) |
| ZK03 | A 32-byte data key in a storage-only `eql_v3_text` column, round trip and stored shape |
| ZK04 | Latency: SDK encrypt and decrypt (n = 20), bulk 10 / 100 / 500, wrapper against plain supabase-js for one-row insert and `eq` select (n = 10) |
| ZK05 | ZeroKMS refused, then black-holed, after init: wrapper insert, encrypted read, plaintext-only read, encrypted filter, SDK decrypt of earlier ciphertext, plain supabase-js read; time to result; recovery |
| ZK06 | Whether the encrypted filter operand reaches the project's `edge_logs` and `postgres_logs` (Management API logs endpoint) |
| ZK07 | Federation (`OidcFederationStrategy`) before the project's issuer is registered in the CipherStash workspace |
| ZK06b | (follow-up) every logged `/rest/v1/records` request with an `eq.` filter decoded (first 6 written out): method, query string length, encrypted operand keys and lengths |
| ZK07b | (follow-up, issuer registered) federated encrypt and decrypt per user; lock context `{ identityClaim: ["sub"] }` encrypt as A, decrypt as A and as B |

```sh
bunx stash@1.1.1 auth login --region ap-southeast-2   # once, device approval in the browser
(cd zk && bun install)
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<org slug> CS_FED_CRN=crn:<region>.aws:<workspace> \
  [KEEP=1] ./run-zk-managed.sh
# after registering https://<ref>.supabase.co/auth/v1 as an OIDC provider in the workspace:
SUPABASE_ACCESS_TOKEN=... ZK_REF=<ref> CS_FED_CRN=... ./run-zk-followup.sh   # deletes the project
```

Writes `out/<date>-zk/`: `install.txt`, `install-notices.txt`,
`install-exit.txt`, `schema.txt`, `zk-managed.json`, `zk-managed.log`,
`zk-followup.json`, `zk-followup.log`, with the project ref replaced by
`<ref>`. In `out/2026-10-19-zk/` the first run's files and the follow-up
(which ran on that first run's project) carry a `-run1` suffix. `zk/smoke.ts` is a local credential check
(encrypt and decrypt per type, one bulk call) that needs no project.

Results: [RUNLOG.md](RUNLOG.md).
