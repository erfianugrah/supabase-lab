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
| SH06 | destructive | The self-hosted GoTrue signing with its OWN ES256 key (`make gotrue-up OWNKEY=1`): public half published from an Edge Function, registered as third-party auth, the resulting token accepted by PostgREST; then the legacy HS256 key is revoked and the own-key token is re-tested. Irreversible; run alone on a fresh project. |
| SH07 | destructive | The legacy anon key in the `apikey` header after the HS256 signing key is revoked: probed at 10 to 600 s and after a project restart, against a never-issued JWT and a re-signed one, to tell an issued-key match at the gateway from a cache window. Self-provisions and deletes its own project; run with `--only SH07`. |

`make unit` covers the token-shape and error-code helpers.

## Validated 2026-09-02 (micro, ap-southeast-1, Pro org; managed GoTrue v2.196.0, image supabase/gotrue:v2.196.0, CLI n/a)

Four throwaway projects in one day (each destroyed). Project 1: the
plain-mode battery (HS256 secret only) and SH05, then a JWKS run with an
arbitrary kid that exposed the kid rule. Project 2: JWKS with the platform's
HS256 key id as kid, SH01-SH05. Project 3: JWKS with a kid-less oct key
(SH02, SH04) and then SH05, the run in which every "before" row passed and
the revoke timing is therefore uncontaminated. Project 4: own-key mode, SH06
alone (20260902-173041).
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

### The self-hosted GoTrue on its own key (SH06) - all pass, project 4 (20260902-173041)

The dependency SH05 exposed is removable. `make gotrue-up OWNKEY=1` generates
an ES256 pair (`lib/keygen.ts`, into gitignored `evidence/ownkey/`) and starts
GoTrue with `GOTRUE_JWT_KEYS` = [own private key, sign+verify; the managed
ES256 public key, verify; the legacy HS256 secret as an `oct` verify-only key
so the legacy `service_role` bearer still works for admin calls to the
self-hosted GoTrue]. The
container is local, so the public half is published from an Edge Function ON
THE PROJECT (`pvlab-sh06-jwks`, verify_jwt false) and that URL is registered
as third-party auth with the `jwks_url` shape.

- Registration -> 201, `type custom`, `resolved_at` set on the create
  response.
- Self-hosted password grant -> ES256 with the own kid, iss set to the managed
  issuer URL.
- That token -> managed PostgREST **200, 1 row, 4 s after the registration**
  (a first-time issuer kid; edge-resilience W01/W05 had measured ~30 s cold
  for a lab issuer - this one resolved faster, n=1). Managed `/auth/v1/user`
  -> **403 bad_jwt**: the managed GoTrue does not honour third-party keys,
  only PostgREST does.
- Storage `GET /storage/v1/bucket`: anon 200, own-key bearer 200, managed
  bearer 200. The bucket list answers anon, so this probe does not
  discriminate; whether Storage VERIFIES a third-party token is still open
  (a private-object read with RLS keyed on the claim would decide it).
- **Revoke the legacy HS256 key -> the own-key token still reads 200 from
  PostgREST**, both with the legacy anon key in the `apikey` header and with
  the `sb_publishable_` key. The legacy anon JWT was still accepted in the
  apikey header when probed 10 s after the revoke, while as a BEARER it had
  failed within 4 s in SH05. One reading: the API gateway in front of
  PostgREST matches the apikey by value and PostgREST verifies only the
  bearer. The other: a gateway cache that had not yet expired (the legacy-key
  disable took ~45 s to propagate in iap-lockdown L05). A later probe was not
  run, so the two are not separated. A fresh self-hosted grant still mints.
  (SH07, 2026-10-23, separates them: no cache window; the gateway accepts
  only the issued key. See the section at the end.)
- Cleanup: the legacy `service_role` call to the MANAGED admin API was 403
  after the revoke (as in SH05); the user was deleted via SQL.

So a self-hosted GoTrue can be an issuer the Data API trusts on a key you
own, independent of the legacy secret, as long as its JWKS is reachable from
the platform. The Edge Function is a convenient place to publish it because it
lives on the project's own hostname.

### What this does not settle

- Whether Storage or Realtime verify a third-party token: the bucket-list
  probe answers anon too. Realtime was not probed.
  Closed 2026-10-23 by third-party-auth TPA05/TPA06 for a lab-held ES256
  issuer registered the same way: Storage and Realtime both verify the
  signature, kid and exp, and their policies read the token's claims.
- Everything ran as `postgres` through the session pooler. Whether GoTrue's
  connection pool behaves under load through Supavisor session mode, and
  what happens on the transaction pooler, was not measured.
- An image AHEAD of the platform's migration set could not be tested on
  2026-09-02: no public `supabase/gotrue` tag newer than v2.196.0 existed
  (v2.197.0 to v2.200.0 all absent). Such an image would try to apply its
  extra migrations as `postgres`, which cannot INSERT into
  `auth.schema_migrations`.
- The managed Auth endpoint cannot be turned off (http-tier-lockdown,
  iap-lockdown L04), so both GoTrues serve the same users for as long as the
  project exists; this experiment did not try to make the managed one
  unreachable.
- SMTP, hooks and OAuth providers on the self-hosted side were not run.

## SH07 - the legacy anon apikey after the HS256 revoke (2026-10-23, micro, ap-southeast-1, Pro org, n=3)

SH06f left two readings open for the legacy anon JWT that still worked in the
`apikey` header 10 s after the HS256 signing key was revoked. The gateway in
question is the platform's API gateway in front of the MANAGED project's
PostgREST. A self-hosted Kong or envoy is a different program, so restarting
one on local Docker would not test it; SH07 runs on managed projects only and
no local stack was involved. The platform gateway cannot be restarted from
outside; the closest lever is `POST /v1/projects/{ref}/restart`.

The module provisions its own project, revokes the HS256 key, and probes the
Data API at 10, 30, 45, 60, 120, 300 and 600 s, then after a project restart.
The bearer is a managed ES256 user token (the project's in-use key), which
PostgREST accepts whatever happens to the HS256 key, so only the `apikey`
header varies:

| variant | apikey | bearer |
| ------- | ------ | ------ |
| A | legacy anon key (HS256, the revoked key) | ES256 user token |
| F | anon claims re-signed under a random secret | ES256 user token |
| V | anon claims with `iat` + 1, signed with the project's own legacy secret (`GET /postgrest` `jwt_secret`) | ES256 user token |
| P | `sb_publishable_` | ES256 user token |
| S | legacy service_role key | ES256 user token |
| K | none | ES256 user token |
| N | legacy anon key | the same anon key (the SH05 shape) |
| H | legacy anon key, `GET /auth/v1/health` | the same anon key |

Three projects (A, B, C), each created, revoked, restarted and deleted by the
module. Project A ran before V was added. Two earlier attempts were discarded
(not recorded): one failed its first SQL call about 30 s after creation
(`28P01`, "If you recently created this project, wait a moment"; the module
now retries), one was stopped to add V. Both projects were deleted. Signing
keys on all three before the revoke: `HS256:previously_used,ES256:in_use`;
the bearer was ES256 with a kid. Evidence: `out/2026-10-23/run-2026-10-23T08-46-09-461Z` (A),
`run-2026-10-23T08-48-10-179Z` (B), `run-2026-10-23T08-48-15-089Z` (C), each
`.json` and `.facts.md`.

- **Before the revoke** (SH07b, A/B/C): A 200, P 200, S 200, N 200, H 200.
  F 401 from the gateway (`Invalid API key`), K 401 from the gateway (`No API
  key found in request`). V 401 from the gateway (`Invalid API key`) on B and
  C: a JWT carrying a valid signature under the project's legacy secret is
  refused as an apikey while the key is still `previously_used`.
- **Revoke** (SH07c): `PATCH signing-keys/{id} {status: revoked}` -> 200,
  key status `revoked`, on all three.
- **The ladder** (SH07d, every mark on A, B and C): A 200, P 200, S 200,
  H 200; F 401 and V 401 from the gateway; N 401 `PGRST301`, PostgREST
  refusing the anon key as a bearer, from the 10 s mark on.
- **After the restart** (SH07e): restart 200, `pg_postmaster_start_time`
  changed on all three, Data API back 60 s (A), 71 s (B), 60 s (C) after the
  restart call, probed at 661 s (A), 672 s (B), 662 s (C) after the revoke.
  The same cells as the ladder: A 200, F and V 401 from the gateway, N 401
  `PGRST301`.

Reading. No cache window: A never flipped across 600 s and a restart, three
projects, so the SH06 observation was not a propagation delay. The gateway
accepts the legacy anon key on something the HS256 revoke does not change,
and it accepts only the issued key: a valid signature is not enough (V,
signed with the project's legacy secret and differing from the issued key
only in `iat`, refused before and after the revoke, n=2), and the issued
claims with another signature are refused (F, n=3). V rests on the
`GET /postgrest` `jwt_secret` being the anon key's signing secret. Projects
A to C did not check that; the module now does (SH07a,
`secret_reproduces_anon`). A one-off check on a fourth throwaway micro
(2026-10-23 09:27 UTC, n=1, a script outside the harness, no artifact in
`out/`): re-signing the legacy anon key and the legacy service_role key with
that secret, claims unchanged, reproduced each key byte for byte; the project
was deleted (HTTP 200). F rules out a check on
the claims alone. Whether the gateway compares the whole string or checks the
claims plus the signature against the legacy secret (which the revoke does
not change) was not separated. The SH07f detail string in the published
artifacts says "the gateway matches the issued key by value" (B, C) or "on
its value or a key set the revoke did not change" (A); both overstate, and
this paragraph is the reading. PostgREST verifies
the bearer independently (N), so the revoked anon key still opens the Data
API to anyone who also holds a token PostgREST accepts.

What SH07 does not settle:

- Whether disabling legacy API keys (`PUT api-keys/legacy?enabled=false`,
  iap-lockdown L05, ~45 s with the anon key as apikey AND bearer) refuses the
  anon apikey when paired with an ES256 bearer. Not run.
- Storage, Realtime and Edge Function routes with the revoked anon apikey:
  only `/rest/v1` and `/auth/v1/health` were probed.
- The gateway behaviour beyond 672 s after the revoke.
