# client-keyed-objects

Can one application, unchanged, run against managed Supabase and against the
self-hosted Docker stack when large binary records are encrypted on the client
before upload, the key-encryption key stays in an operator-run key service
outside Supabase, uploads must survive interruption, reads fetch byte ranges,
tenants are pinned to a region, and access control is Supabase Auth plus RLS?

This directory is that application (a reference implementation, not a
product) plus the CK01-CK13 acceptance suite, run against every target with
one parity table as output. The plan and its open questions are in
[PLAN.md](PLAN.md); results, the parity table and the rows that are partial
in [RUNLOG.md](RUNLOG.md) (generated table: `out/2026-10-12/parity.md`).

## Targets

| role | what |
|---|---|
| region-a | managed Pro-org micro project, ap-southeast-1, `ck-region-a-<epoch>`, created and deleted by `make managed` |
| region-b | managed Pro-org micro project, eu-central-1, `ck-region-b-<epoch>`, same |
| onprem | self-hosted stack (supabase/supabase `docker/` at the commit self-hosted-defaults pins), MinIO backend, Storage image at the managed version where published |
| onprem-file | the same stack on the default file backend (control) |

Every target gets the same migrations (`supabase/migrations/`, `supabase db
push` on managed, psql as `postgres` on self-hosted) and the same client
build. Target differences live in one config per target (URLs, keys, S3
access key id and region); CK01 greps the client and the migrations for a
branch on target identity.

## The application

| part | where | what |
|---|---|---|
| catalogue | `supabase/migrations/` | schema `app`: tenants, memberships, records, assets (wrapped DEK, nonce prefix, sizes, upload state), asset_chunks (per-chunk ciphertext SHA-256), access_log; RLS for owner / editor / viewer; storage RLS on the first path segment; a custom access token hook adding `tenant_ids` |
| key service | `keysvc/` | Bun HTTP service in Docker, one KEK per tenant, `wrap` / `unwrap` only; verifies the caller's access token against the target's JWKS (issuer pinned per tenant) and checks membership through the Data API with the caller's token |
| client | `client/src/` | WebCrypto AES-256-GCM per 8 MiB chunk, nonce = prefix and chunk index, AAD = asset id, index and count; S3 multipart (64 MiB parts, resume by ListParts) and TUS (6 MiB transport chunks, resume by HEAD); ranged reads over S3 GetObject, S3 presigned GET, signed URL and `/object/authenticated`; one static tenant -> region directory |
| Bun entry | `client/cli.ts` | the suite's child process (JSON in, JSON out, `PROGRESS` lines on stderr) |
| browser entry | `client/browser/` | the same library bundled for the browser, driven by headless Chromium in the Playwright container |

## Modules

| id | asks | targets |
|---|---|---|
| CK01 | Do the migrations leave an identical catalogue (policies, functions, triggers, grants, hook grants, bucket)? Is there no target branch in the client or migrations? | all |
| CK02 | Sign-up, sign-in, refresh and the hook claim; refusal shapes for wrong password, disabled user, expired token | all |
| CK03 | RLS matrix: owner / editor / viewer / non-member on catalogue rows and on storage objects (REST and S3 with the user's token) | all |
| CK04 | 2 GiB through S3 multipart, SIGKILL at 40 %, resume from a new process, full read verifies the plaintext SHA-256 | all |
| CK05 | The same through TUS | all |
| CK06 | 100 random plaintext ranges (1 KiB to 64 MiB) spread across the four read paths (25 each): bytes equal, body equals the covering chunks | all |
| CK07 | Flip a bit, swap two chunks, truncate: every read fails closed with a typed error, with and without the catalogue hash check | all |
| CK08 | No plaintext in the object store (marker scan with a positive control; the 2 GiB objects are scanned during CK04/CK05's full read), no DEK or KEK in Postgres, `storage.objects.metadata` recorded | all |
| CK09 | Key service stopped: uploads and reads fail closed, catalogue and object unchanged, recovery after restart | all |
| CK10 | A region-a token is refused by region-b's Auth, Data API, Storage REST and S3; the object key is absent there; the key service refuses the other region's token | region-a, region-b |
| CK11 | Headless Chromium: CORS preflights, S3 multipart from the page (part ETags), ranged reads through a signed URL | all |
| CK12 | One fixed set of failing requests per service: status, media type, body keys, code | all |
| CK13 | Service versions read live, self-hosted image tags; `scripts/parity.ts` puts the gap next to every CK12 difference | onprem vs managed |

## Run

```sh
make onprem                     # self-hosted, MinIO backend (about 15 min); stack and KEKs removed afterwards
make onprem-file                # file backend control
export PVLAB_ORG_PRO=...        # in the command environment only; never in a tracked file
sx SUPABASE_ACCESS_TOKEN -- make managed      # two Pro-org micro projects, deleted in the same make target
sx SUPABASE_ACCESS_TOKEN -- make sweep        # lists ck- projects left behind
make parity RUNS="evidence/<a>/run-*.json evidence/<b>/run-*.json ..."
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
make unit                       # envelope layout and AEAD binding, offline
make clean                      # stacks, key service, KEKs, fixtures, run dir
```

`CK_SLOT=b make onprem ...` uses its own run dir, key service container and
port (8791), so a self-hosted run can proceed while a managed run holds the
default slot. A managed run from a far region takes hours from one laptop
(the 2026-10-12 eu-central-1 reads ran at about 1 to 4 MiB/s); run it
detached (`nohup`) and under `caffeinate` (a sleeping laptop broke
transfers and skewed the Docker VM clock), and if it dies,
`bun scripts/ck.ts managed-down` and `make sweep` remove what it created.

The self-hosted stack runs as its own compose project (`ck-<name>`, no fixed
container names) on host ports 8100, 5532 and 6643, so it can run beside the
self-hosted-defaults rig on 8000 / 5432 / 6543. MinIO data lives in the stack
directory on the host disk (`work/stacks/<name>/volumes`); the file backend
uses a named volume on the Docker VM disk (`compose/docker-compose.ck-file.yml`,
the xattr finding in the RUNLOG).

`work/` is gitignored and holds everything secret or large: the pinned
clone, the stack copies and their generated `.env`, per-target configs with
keys, test users' passwords, the per-run KEKs (`work/keysvc/`, deleted by
`keysvc-down`) and the 2 GiB and 64 MiB fixtures (`make clean-fixtures`).

## Layout

- `tests/ck*.ts` - the modules (harness TestModules, run from source).
- `lib/ckrun.ts` - run directory, targets, child-process client runner, SQL per target, error-shape helper, secret scrubbing.
- `lib/flows.ts` - the interrupt-and-resume flow CK04 and CK05 share.
- `client/src/tus-fetch.ts` - tus-js-client HTTP stack on fetch with a per-request timeout (the library's Node stack stalled under Bun).
- `lib/sigv4.ts` - raw SigV4 for S3 requests whose XML error body CK12 keeps.
- `scripts/ck.ts` - stack, key service, managed projects, setup, sweep.
- `scripts/parity.ts` - the parity table from artifacts.
- `compose/` - the per-target compose overrides for the self-hosted stack.
