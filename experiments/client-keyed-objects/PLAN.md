# client-keyed-objects - plan

Status: built and run 2026-10-12 (onprem, onprem-file, region-a, region-b); results and the parity table in RUNLOG.md, run instructions in README.md.

## The platform question

Can one application, unchanged, run against managed Supabase and against the
self-hosted stack when:

- large binary records (hundreds of MB to a few GB each) are encrypted on the
  client in chunks before upload, so the platform stores ciphertext only;
- the key-encryption key never leaves an operator-run key service outside
  Supabase;
- uploads must survive interruption and reads must fetch byte ranges of a
  record without downloading all of it;
- tenants are pinned to a region, one Supabase project per region;
- access control is Supabase Auth plus RLS over a record catalogue in Postgres?

The experiment builds that application as a reference implementation and runs
the same acceptance suite against every target. A behaviour difference between
targets is a finding, not a test failure to work around.

Inputs from other experiments: storage-surface SS03-SS06 (S3 contract, TUS,
encrypted round trip, managed vs self-hosted storage diff; PLAN.md there),
self-hosted-defaults (the local stack rig), self-hosted-auth (GoTrue trust
across managed and self-hosted), residency-facts (region catalogue, Storage
CDN behaviour).

## Targets

| role | what |
|---|---|
| region-a | managed Pro-org project, ap-southeast-1 |
| region-b | managed Pro-org project, eu-central-1 |
| onprem | self-hosted stack (self-hosted-defaults rig), S3 backend (MinIO), storage image at the managed version where published |
| onprem-file | the same stack on the default file backend (control) |

Every target gets the same migrations (`supabase/migrations/`, applied with
the CLI against managed and with psql against self-hosted) and the same
client build. Target differences live in one config file per target (URLs,
keys, S3 credentials, region); a code branch on target identity is not
allowed and the suite greps for one.

## The application

### Catalogue (Postgres, schema `app`)

- `tenants` (id, name, home_region)
- `memberships` (tenant_id, user_id, role: owner | editor | viewer)
- `records` (id, tenant_id, title, created_by, created_at, status)
- `assets` (id, record_id, object_key, plaintext_size, chunk_size,
  chunk_count, ciphertext_size, cipher (`aes-256-gcm`), key_id,
  wrapped_dek, nonce_prefix, plaintext_sha256, upload_state, created_at)
- `asset_chunks` (asset_id, idx, ciphertext_sha256): per-chunk integrity,
  because the S3 endpoint does not validate or store object checksums
  (storage-surface SS03g)
- `access_log` (actor, action, asset_id, byte_range, at): written by the
  client and by triggers on catalogue changes

RLS: members read their tenant's rows; editors write; viewers read only.
Storage RLS on `storage.objects` keyed on the tenant id as the first path
segment (`<tenant_id>/<asset_id>/data`), so a leaked object key does not
grant access without membership. A custom access token hook adds
`tenant_ids` to the JWT; it must behave the same on every target.

### Key service (outside Supabase)

A small HTTP service run by the operator (Docker, local), holding one KEK per
tenant. Two calls: `wrap(dek, tenant_id) -> wrapped` and
`unwrap(wrapped, tenant_id) -> dek`, authenticated by the user's Supabase
access token (verified against the target's JWKS) plus a membership check
through the Data API. The service is the only place a DEK is ever unwrapped.
Supabase holds `wrapped_dek` and ciphertext only.

### Client library (TypeScript, Bun and browser builds)

- Envelope encryption: random 256-bit DEK per asset, AES-256-GCM per chunk,
  nonce = `nonce_prefix || chunk_index`, AAD = `asset_id || chunk_index ||
  chunk_count`, so chunks cannot be reordered, swapped between assets or
  truncated undetected.
- Chunk size 8 MiB of plaintext (ciphertext chunk = 8 MiB + 16-byte tag).
- Upload paths, both implemented and both measured:
  - S3 multipart, one ciphertext chunk group per part (parts of 64 MiB);
    resume by `ListParts` on the upload id stored in `assets`
  - TUS resumable (6 MiB transport chunks; the ciphertext stream is
    independent of the transport chunking)
- Ranged read: plaintext range -> chunk indices -> one ciphertext `Range`
  GET -> verify chunk hashes against `asset_chunks` -> decrypt -> slice.
- Read paths: S3 GetObject, S3 presigned GET, Storage signed URL, and
  `/object/authenticated`, each with `Range`.
- Integrity: plaintext SHA-256 recorded at upload and checked after a full
  read; per-chunk ciphertext hashes checked on every read.

### Region routing

A static directory (config, not a database) maps tenant -> home region ->
target. The client resolves the target from the tenant before every call.
No cross-region reads; a user exists per region (separate Auth per project).

## Acceptance suite (`CK` modules)

| id | asserts | targets |
|---|---|---|
| CK01 | Migrations apply cleanly; schema, policies and the auth hook are identical (catalogue diff of `pg_policies`, functions, triggers) | all |
| CK02 | Auth: sign-up, sign-in, refresh, custom hook claims present; error bodies for wrong password, expired token, disabled user, compared field by field | all |
| CK03 | RLS: owner/editor/viewer/non-member matrix on catalogue tables and on storage objects (REST and S3 with a user session token) | all |
| CK04 | Upload 2 GiB plaintext via S3 multipart; interrupt at ~40%, resume from a new process; full read verifies plaintext SHA-256 | all |
| CK05 | Same through TUS, interrupt and resume | all |
| CK06 | Ranged reads: 100 random plaintext ranges (1 KiB to 64 MiB) across the four read paths; bytes equal the plaintext slice; bytes transferred per read vs the minimum needed | all |
| CK07 | Tamper: flip a byte in a stored chunk (via an S3 overwrite of a copy), swap two chunks, truncate the object; each read fails closed with a typed error | all |
| CK08 | Ciphertext-only: no plaintext in the object store (scan stored bytes for known plaintext markers), no DEK or KEK in Postgres, `storage.objects.metadata` contents recorded | all |
| CK09 | Key service down: uploads and reads fail closed; the catalogue and ciphertext stay intact; recovery after restart | all |
| CK10 | Region isolation: a region-a user's token is rejected by region-b's Auth, Data API and Storage; a tenant's object key is absent in the other region | region-a, region-b |
| CK11 | Browser: headless Chromium runs the client build against each target: CORS preflight, S3 multipart from the page (needs `ETag` readable), ranged read via signed URL | all |
| CK12 | Error-shape diff: one fixed set of failing requests per service (Auth, Data API, Storage REST, Storage S3) -> status, content type, body keys, per target | all |
| CK13 | Upgrade drift: the self-hosted stack at its pinned image tags vs the managed versions read live (Auth, PostgREST, Storage, Postgres); report the version gap next to every CK12 difference | onprem vs managed |

Output: one parity table (row = assertion, column = target), plus the
transfer and timing columns from CK04-CK06 marked as single-vantage info.

## What this does not settle

- Regulatory or contractual fitness for any industry or jurisdiction.
- Regions not exercised here; vantage is one laptop, so transfer times are
  not a statement about any other network path.
- Self-hosted on Linux amd64 or Kubernetes, HA for the self-hosted stack, or
  self-hosted backup and restore (candidate follow-up).
- The key service is a stand-in for an operator's KMS or HSM, not a
  recommendation of one.

## Order

1. Wait for storage-surface SS03-SS06 results: they decide which read and
   upload paths are viable on each target and whether CK11 needs a
   workaround for missing `Access-Control-Expose-Headers`.
2. Build schema, key service and client against `onprem` (free), then
   `onprem-file`.
3. Provision region-a and region-b, run the suite, delete both projects in
   `finally`, `make sweep`.
4. RUNLOG, key facts in AGENTS.md, README entry, publish-evidence.

## Cost and cleanup

Two Pro-org micro projects for a few hours and a few tens of GB of egress
within the plan's quota. Self-hosted runs are local.
