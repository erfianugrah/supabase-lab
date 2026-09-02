# self-hosted-auth - RUNLOG

One project, no AWS, plus one local container. Can a GoTrue you run yourself
stand in for the managed Auth service on a managed project: share its auth
schema, mint tokens the managed PostgREST and Auth trust, take over refresh,
and verify the managed side's tokens in return. And what the self-hosted
tokens depend on that the platform can take away.

The self-hosted GoTrue is the public `supabase/gotrue` image, started by
`make gotrue-up` against the project's Postgres through the session pooler.
Nothing about it is a tofu resource; it lives for one probe run.

## Modules

| id   | mode        | question |
| ---- | ----------- | -------- |
| SH01 | read-only   | Which role can a self-hosted GoTrue connect as, and with what privileges on the auth schema? Which signing keys does the project hold, in what status? Which GoTrue version does the managed side run? |
| SH02 | destructive | Shared schema and trust: a user created through the self-hosted GoTrue is visible to the managed one; its HS256 token is accepted by managed Auth and PostgREST; the managed ES256 token against the self-hosted side. |
| SH03 | destructive | Refresh takeover: each side redeems the other's refresh tokens; reuse detection across sides. |
| SH04 | destructive | JWKS mode: the self-hosted GoTrue given the platform's ES256 public key as a verify-only JWK verifies managed tokens, while its own tokens stay accepted by both managed verifiers. |
| SH05 | destructive | Revoke the project's legacy HS256 key: time to rejection of a self-hosted token on managed Auth and PostgREST, and the collateral on the legacy API keys. Irreversible on the project. |

`make unit` covers the token-shape and error-code helpers.

## Validated 2026-09-02 (micro, ap-southeast-1, Pro org; managed GoTrue v2.196.0, image supabase/gotrue:v2.196.0, CLI n/a)

Three throwaway projects in one afternoon (each destroyed). Project 1: the
plain-mode battery (HS256 secret only) and SH05, then a JWKS run with an
arbitrary kid that exposed the kid rule. Project 2: JWKS with the platform's
HS256 key id as kid, SH01-SH05. Project 3: JWKS with a kid-less oct key
(SH02, SH04) and then SH05, the run in which every "before" row passed and
the revoke timing is therefore uncontaminated.
Evidence dirs 20260902-145333 (plain, SH01-SH04), 20260902-145442 (JWKS,
arbitrary kid), 20260902-145503 (SH05 on the first project),
20260902-145822 (JWKS, platform kid, SH01-SH05), 20260902-150030 (JWKS,
no kid, SH02+SH04) and 20260902-150058 (SH05 clean).

### The role map (SH01)

- `supabase_auth_admin`, the role the self-hosting compose uses, is reserved
  on the platform: `ALTER ROLE ... PASSWORD` answers
  `42501: "supabase_auth_admin" is a reserved role, only superusers can
  modify it` and `GRANT supabase_auth_admin TO <role>` answers `42501:
  "supabase_auth_admin" role memberships are reserved, only superusers can
  grant them`. `postgres` is not a superuser and not a member.
- So the self-hosted GoTrue connects as `postgres`. That role has USAGE on
  `auth`, INSERT on `auth.users`, `auth.refresh_tokens` and `auth.sessions`,
  no CREATE on the schema and no INSERT on `auth.schema_migrations`. The
  schema is owned by `supabase_admin`.
- `auth.schema_migrations` holds 77 rows (`00` .. `20260625000000`). The
  v2.196.0 image ships 70 migration files and every one of them is already in
  the table; the remaining seven rows are legacy 2017/2018 versions that only
  the platform applied.
- **`search_path` is the whole startup story.** `postgres` defaults to
  `"$user", public, extensions`; the migrator looked for `schema_migrations`
  in `public`, created an empty one there, decided nothing was applied, and
  died on `00_init_auth_schema`: `CREATE TABLE IF NOT EXISTS auth.users`
  -> `permission denied for schema auth (SQLSTATE 42501)` (the privilege
  check runs before the existence check). `supabase_auth_admin` carries
  `search_path=auth` in its rolconfig, which is why the managed one never
  hits this. Appending `?search_path=auth` to the connection URL made the
  same start report `GoTrue migrations applied successfully count=0`. Drop
  the stray `public.schema_migrations` if a first start left one.
- Keys: `ES256 in_use`, `HS256 previously_used`; the legacy `jwt_secret`
  (88 chars) is readable via `GET /v1/projects/{ref}/postgrest`.
- Direct `db.<ref>.supabase.co` is IPv6-only from this machine; the session
  pooler `aws-0-<region>.pooler.supabase.com:5432` with user
  `postgres.<ref>` is the IPv4 path. `aws-1-` for the same region answered
  `ENOTFOUND tenant/user`.

### Shared schema and trust (SH02) - all pass

- Admin create through the self-hosted GoTrue (service_role bearer) -> 200;
  the managed admin list shows the user (both GoTrues read the same
  `auth.users` table).
- Self-hosted password grant mints `HS256`, `iss
  https://<ref>.supabase.co/auth/v1` (mirrored by config), `aud
  authenticated`, `role authenticated`, 3600 s, no `kid`.
- That token -> managed `/auth/v1/user` **200**; -> managed PostgREST read
  of an authenticated-only table **200, 1 row** (anon control 0 rows). The
  managed tier trusts the self-hosted tokens because the HS256 key is
  `previously_used`, which still verifies.
- Managed password grant for the same user -> 200 (shared hash), `ES256`
  with `kid` = the in_use key id, same `sub`.
- Managed ES256 token -> self-hosted `/user` **403 bad_jwt** in plain mode.
  The self-hosted side holds only the HS256 secret.

### Refresh takeover (SH03) - all pass

- Self-hosted refresh token -> managed `/token?grant_type=refresh_token`
  **200**, new access token ES256.
- Managed refresh token -> self-hosted `/token` **200**, new access token
  HS256 (re-signed with what the self-hosted side has).
- Reuse across sides: the managed refresh token that the self-hosted side had
  already redeemed in SH03b was then presented to the managed side (its first
  presentation there) -> 200, which is the parent tolerance inside the reuse
  interval that auth-refresh-race measured, not a detection miss; the child
  the self-hosted side minted -> managed 200. Both sides write the same
  `auth.refresh_tokens` table and the tokens form one rotation family.

### JWKS mode (SH04) - and the kid finding

- `GOTRUE_JWT_KEYS` takes a JSON array of JWKs with exactly one `sign` key.
  Supplying the HS256 secret as an `oct` sign+verify JWK plus the managed
  project's ES256 public key (from `/auth/v1/.well-known/jwks.json`, key_ops
  `verify`) makes the self-hosted GoTrue advertise the ES256 key at its own
  `/.well-known/jwks.json` and **verify managed tokens: managed ES256 token
  -> self-hosted `/user` 200**.
- **The oct key must carry no `kid`.** With `GOTRUE_JWT_KEYS`, the
  self-hosted GoTrue stamps its signing key's kid into every token header,
  and the managed PostgREST answered **401 PGRST301** to a self-hosted HS256
  token carrying a kid - both an arbitrary `legacy-hs256` (project 1) and the
  platform's own HS256 key id from the signing-keys endpoint (project 2) -
  while the managed GoTrue verified the very same tokens (`/user` 200).
  Kid-less (project 3): managed `/user` 200 AND PostgREST 200. The two
  managed verifiers disagree on what an HS256 kid means, and PostgREST is the
  strict one. (The managed GoTrue's own ES256 tokens carry a kid and PostgREST
  accepts them; the rule is about HS256.)
- With the kid-less oct key + the ES256 verify key, every SH02 and SH04 row
  passes (20260902-150030): full mutual trust. SH03 was not re-run kid-less;
  its result rests on the plain-mode run (20260902-145333) and the
  platform-kid run (20260902-145822), where it also passed.

### Revoking the legacy HS256 signing key (SH05) - all pass on project 3 (kid-less JWKS, 20260902-150058)

- Before: self-hosted token accepted by managed `/user` (200) and PostgREST
  (200, 1 row).
- `PATCH /v1/projects/{ref}/config/auth/signing-keys/{id} {status:
  "revoked"}` -> 200.
- After: the same token -> managed `/user` **403 bad_jwt after 4 s**;
  PostgREST **401 PGRST301 after 4 s** (project 3, 20260902-150058). On
  project 1 (plain mode, 20260902-145503) `/user` flipped after 3 s; on
  project 2 (JWKS with the platform kid, 20260902-145822) after 6 s. PostgREST
  timing is not comparable on those two: on project 2 it was already 401
  before the revoke because of the kid, and on project 1 the JWKS-with-kid
  container was running by the time SH05 ran.
- Collateral: the legacy `anon` API key (an HS256 JWT under the same secret)
  -> PostgREST **401**; the legacy `service_role` key -> managed admin list
  **403** (the module's own cleanup had to fall back to SQL); the new
  `sb_publishable_` key -> PostgREST 200 and `sb_secret_` -> admin list 200.
  Revoking the legacy HS256 signing key has the same collateral as the
  platform's "disable legacy API keys" switch (the `anon` and `service_role`
  JWTs stop working), and it also kills the self-hosted signer; whether the
  API-keys switch does that too was not tested. The signing-key revoke is
  irreversible.
- The self-hosted GoTrue keeps minting (fresh password grant 200); nothing
  managed accepts the result. A self-hosted signer built on the legacy secret
  lives exactly as long as that key stays `previously_used`.

### What this does not settle

- Registering the self-hosted GoTrue as a third-party auth issuer (so the
  managed side would trust a self-hosted ES256 key of its own rather than the
  shared HS256 secret) needs the self-hosted JWKS reachable from the
  platform; the container here is local. cross-project-auth and iap-lockdown
  show the mechanism works for reachable issuers.
- Everything ran as `postgres` through the session pooler. Whether GoTrue's
  connection pool behaves under load through Supavisor session mode, and
  what happens on the transaction pooler, was not measured.
- One managed GoTrue version (v2.196.0) and the matching image. An image
  ahead of the platform's migration set would try to apply migrations as
  `postgres`, which cannot INSERT into `auth.schema_migrations`.
- The managed Auth endpoint cannot be turned off (http-tier-lockdown,
  iap-lockdown L04), so both GoTrues serve the same users for as long as the
  project exists; this experiment did not try to make the managed one
  unreachable.
