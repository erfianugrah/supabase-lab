# self-hosted-defaults - RUNLOG

What the self-hosted Docker stack (`docker/` in the public supabase/supabase
repository) does out of the box after the 2026 default changes: Envoy as the
API gateway, Postgres 17, Studio and postgres-meta as `postgres`, logs and
analytics as an opt-in override, `API_EXTERNAL_URL` ending in `/auth/v1`.
Everything runs locally in Docker; no Supabase project, no PAT, no cloud
spend. The stack is brought up from a pinned commit by `make fetch stack up`
and removed by `make clean`.

Vantage for every module: the Docker Desktop host (Apple silicon, so the
Postgres image answered `aarch64-unknown-linux-gnu`), requests to the
published gateway port `127.0.0.1:8000`, `docker exec` into the database
container, and `docker compose` in the stack directory. Pinned source:
supabase/supabase commit `8617532ae1a41571d5d557cd24c6f5f2565d9230` (master,
committed 2026-10-09). Image tags are the ones in `docker-compose.yml` and the
override files at that commit; the modules below record the gateway, database,
logs and Kong tags they observed, and the per-test values are in the facts
file.

## What the docs say (not measured by itself)

All four statements are from `docker/CHANGELOG.md` at the pinned commit, except
the 8443 detail in the last row, which is from a comment in
`docker/docker-compose.kong.yml` at the same commit ("Kong re-adds an HTTPS
listener on 8443"); the changelog entry itself says only that Envoy is the
default, that Kong is an opt-in override (`sh run.sh config add kong`) and that
the `kong` service is renamed `api-gw`. The numbered discussions are public:

| Changelog date | Statement | Public source |
| --- | --- | --- |
| 2026-06-03 | Logs and analytics removed from the default `docker-compose.yml`; `docker-compose.logs.yml` added | https://github.com/orgs/supabase/discussions/46084 |
| 2026-06-17 | Postgres 17 is the default; Studio and Postgres Meta connect as `postgres`, not `supabase_admin`; `pg_graphql` is disabled by default on fresh installs | https://github.com/orgs/supabase/discussions/46080 and https://github.com/orgs/supabase/discussions/46081 |
| 2026-07-07 | `API_EXTERNAL_URL` default ends in `/auth/v1`; SAML endpoints move to `/auth/v1/sso/saml/*` | https://github.com/orgs/supabase/discussions/47093 |
| 2026-08-11 | Envoy replaces Kong as the default gateway; Kong stays as an opt-in override (the override file's comment says it re-adds an HTTPS listener on 8443) | https://github.com/orgs/supabase/discussions/48048 |

Guides cited by those entries:
https://supabase.com/docs/guides/self-hosting/self-hosted-envoy,
https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys,
https://supabase.com/docs/guides/self-hosting/self-hosted-saml-sso,
https://supabase.com/docs/guides/self-hosting/remove-superuser-access.

## Run 1 - 2026-10-10, n = 1 fresh stack, 26 pass, 0 fail (SD01-SD08)

Artifact: `out/2026-10-10/run-2026-10-10T01-01-31-585Z.{json,facts.md}`
(published with `make publish-evidence`; the lab commit in the artifact is the
base commit of the working tree, the experiment itself was uncommitted when it
ran). One stack, started from scratch (`make clean`, `make stack`, `make up`)
immediately before the run, with every module run in id order in that one
process. Unrecorded operator observation, not in the artifact: the images were
in the local Docker cache from earlier runs the same day, so the `up` wall
times below (7 s and 13 s) probably exclude image pulls; the artifact does not
show a cache state.

Stack preparation, as the self-hosting guide does it: `docker/` copied out of
the pin, `.env.example` copied to `.env`, then `utils/generate-keys.sh` and
`utils/add-new-auth-keys.sh` run with their option that writes the result into
`.env`.

Development runs earlier the same day are not published and have no artifact
(unrecorded operator account). One of them failed SD02c because an exploratory
probe had left a table behind that the module's setup then reused (two rows
where one was expected); the setup now drops and recreates the table. The
published run is the first full run after the last module change.

| Module | What was measured | Result |
| --- | --- | --- |
| SD01a | Resolved compose model | 11 services, one of them `api-gw` on an `envoyproxy/envoy` image; 0 services or images matching "kong"; the gateway publishes `8000:8000` only |
| SD01b | Running containers | one gateway container, `supabase-envoy`, 0.0.0.0:8000 only; 0 Kong containers; 11 containers running |
| SD01c | Wire | `server: envoy` on `GET /auth/v1/health` (HTTP 200 with the publishable key); TCP connect to host 8443 refused and to 8001 refused; `GET /` without credentials 401, with the dashboard credentials 307 to `/project/default` |
| SD01d | Network aliases of the Envoy container | `supabase-envoy`, `api-gw`, `envoy`, `kong`: the name `kong` still resolves inside the compose network, to Envoy |
| SD02a | No key, and a made-up `sb_secret_` key | 401 with body `Unauthorized`, `content-type: text/plain`, `server: envoy`, on `/auth/v1/settings`, `/rest/v1/`, `POST /pg/query`, a table read and an RPC. `/storage/v1/bucket` answered HTTP 400 without a key instead of 401, which is consistent with that route not being gated by Envoy's key check; one request, the gateway config was not read |
| SD02b | Status per key kind, six routes | publishable key: settings 200, OpenAPI 403, `/pg/query` 403, table read 200, RPC 200, storage 200. Secret key: 200 on all six. Legacy anon JWT: same as publishable. Legacy service_role JWT: same as secret. Table with RLS on and no policy: 0 rows for the publishable key and the legacy anon JWT, 1 row for the secret key and the legacy service_role JWT |
| SD02c | `request.jwt.claims` inside PostgREST | secret key arrives with `role` service_role, publishable key with `role` anon; claim names for the secret key are `exp`, `iat`, `iss`, `role`, with `iss` "supabase"; the opaque key value does not appear in the claims |
| SD02d | Effect of `utils/add-new-auth-keys.sh` | it uncommented 4 lines in `docker-compose.yml`: `GOTRUE_JWT_KEYS`, `API_JWT_JWKS`, `JWT_JWKS`, `SUPABASE_JWKS` |
| SD03a | Database version | the compose model and the running container name the same `supabase/postgres` image, a 17.x tag; `server_version` reported a 17.x value; the `PG_VERSION` file said 17; `version()` began "PostgreSQL 17" on aarch64-unknown-linux-gnu |
| SD03b | Override files, read as files | `docker-compose.pg17.yml` repeats the base tag; `docker-compose.pg15.yml` pins a 15.x tag (Postgres 15 was not started) |
| SD03c | `pg_graphql` on the fresh stack | 0 rows in `pg_extension`; listed in `pg_available_extensions`; schemas `graphql` and `graphql_public` exist; `POST /graphql/v1` with the publishable key answered HTTP 200 with body `{"errors": [{"message": "pg_graphql extension is not enabled."}]}` |
| SD04a | Container environment | postgres-meta `PG_META_DB_USER=postgres`; Studio `POSTGRES_USER_READ_WRITE=postgres` |
| SD04b | `current_user` and `session_user` | `postgres` and `postgres` through the gateway's `/pg/query` route (secret key) and through Studio's `/api/platform/pg-meta/default/query` (dashboard credentials), both HTTP 200 |
| SD04c | `pg_stat_activity` during a `pg_sleep` on each path | the one active backend per path belonged to `postgres`, with an application name starting `postgres-meta`, on both paths |
| SD04d | Roles | `postgres` rolsuper false; `supabase_admin` rolsuper true; at the snapshot, sessions existed for `authenticator`, `supabase_admin` and `supabase_storage_admin`; `supabase_admin` application names included Realtime, Supavisor, `pg_cron scheduler`, `pg_net` and a `psql` session (by its code path, likely the probe's own `docker exec psql`; not confirmed from the session list) |
| SD05a | Default stack and logs | no `analytics` or `vector` service in the model, no such container running, no Logflare or Vector image, 0 services mounting the Docker socket, Studio `ENABLED_FEATURES_LOGS_ALL=false` |
| SD05b | With `docker-compose.logs.yml` | the override adds exactly `analytics` and `vector`; both healthy; `docker compose up -d` with its wait option returned after 13 s (warm image cache); Studio's `ENABLED_FEATURES_LOGS_ALL` flag read `true` afterwards (the flag flipped; whether the container was recreated was not recorded); the only service mounting the Docker socket is `vector` |
| SD05c | `GET /analytics/v1/health` with the secret key | 401 "User authentication failed. Missing username and password.", which reads like the dashboard route's basic-auth gate; consistent with Envoy having no analytics route, from this one request |
| SD06a | `API_EXTERNAL_URL` | `http://localhost:8000/auth/v1` in `.env`, on the auth container, and as `GOTRUE_JWT_ISSUER`; `SUPABASE_PUBLIC_URL` is `http://localhost:8000` |
| SD06b | A real access token | admin create user 200, password grant 200; `iss` `http://localhost:8000/auth/v1`; header `alg` ES256 with a `kid`; `aud` authenticated; the ES256 signature verifies against the one key in the gateway's `/auth/v1/.well-known/jwks.json` |
| SD06c | `generate_link` (magic link) | 200; the `action_link` path is `/auth/v1/verify`, not `/auth/v1/auth/v1/verify`, while `MAILER_URLPATHS_CONFIRMATION` is `/auth/v1/verify` |
| SD06d | SAML before it is enabled | `GET /auth/v1/sso/saml/metadata` 404 with `error_code` `saml_provider_disabled` (the request reached Auth); `GET /sso/saml/metadata` 401 from the dashboard gate, without credentials |
| SD06e | SAML enabled the guide's way (2048-bit RSA key, `GOTRUE_SAML_ENABLED`, applied as an override file) | metadata 200 `application/xml`; `entityID` `http://localhost:8000/auth/v1/sso/saml/metadata`; ACS `Location` `http://localhost:8000/auth/v1/sso/saml/acs` |
| SD06f | Flow through Envoy with an invented IdP | register IdP with the secret key 201; `POST /auth/v1/sso` for its domain 200 with a redirect to the IdP host carrying a `SAMLRequest`; `POST /auth/v1/sso/saml/acs` with no apikey and a garbage `SAMLResponse` 303 to the site URL with `error_code=validation_failed` (Auth's answer, not Envoy's 401); IdP deleted afterwards |
| SD07a | Control: Kong override | gateway container from a `kong/kong` image, ports 8000 and 8443 published; TCP 8443 accepted; HTTPS 8443 `/auth/v1/health` 200 with a `server: kong/...` header; port 8000 also answered with a Kong `server` header; through Kong, publishable key OpenAPI 403, secret key OpenAPI 200, no key 401; `up` 7 s |
| SD07b | Control: override removed | gateway back to an `envoyproxy/envoy` image; 8443 refused; `server: envoy`; `up` 13 s |
| SD08a | Opaque-key variables emptied in `.env`, gateway container recreated alone | Envoy logged "Envoy running in legacy API key mode (sb_ keys disabled)"; publishable key: settings 401, OpenAPI 401; secret key: settings 401, OpenAPI 401; legacy anon: settings 200, OpenAPI 403; legacy service_role: settings 200, OpenAPI 200 |
| SD08b | `.env` restored, gateway recreated | "Envoy sb_ key translation enabled"; publishable key settings 200, OpenAPI 403; secret key settings 200, OpenAPI 200 |

### Docs claim against measurement

- Envoy default, no Kong, no 8443 (2026-08-11 entry): measured on this pin.
  SD01a to SD01c each report an absence; SD07 is the control showing the 8443
  and `server`-header probes see Kong when the Kong override is applied, so the
  absences are not a probe that cannot see.
- `kong` as a network alias: stated in `docker-compose.yml` and in the Envoy
  guide ("exposes `envoy` and `kong` as network aliases"); SD01d read it from
  the running container. A hostname configuration that still says `kong`
  reaches Envoy, so a configuration that only greps for the name does not
  show Kong is gone.
- Opaque keys through Envoy: measured with the key-generation step run, and
  with the four values emptied afterwards (SD08). `.env.example` ships
  `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `ANON_KEY_ASYMMETRIC` and
  `SERVICE_ROLE_KEY_ASYMMETRIC` empty. SD08 emptied the four values on a stack
  that had them; it did not start a second stack from an untouched
  `.env.example`, so "a stack that never ran `utils/add-new-auth-keys.sh`
  behaves like SD08a" is a reading of the entrypoint script and the SD08a
  result, not a separate observation. The key script also edits
  `docker-compose.yml` (SD02d).
- Postgres 17 and `pg_graphql` off on a fresh install (2026-06-17 entry):
  measured (SD03a, SD03c). The `/graphql/v1` request returned HTTP 200 with an
  error body, so a client that checks only the status code does not notice the
  extension is absent.
- Studio and postgres-meta as `postgres` (2026-06-17 entry): measured as the
  session role through both paths and as the role of the backend (SD04). The
  database cannot tell the two paths apart, because Studio's pg-meta route
  goes through postgres-meta and both showed a `postgres-meta` application
  name. Whether Studio makes a connection of its own (the compose file gives it
  `POSTGRES_USER_READ_WRITE=postgres`) was not observed.
- Logs optional (2026-06-03 entry): measured (SD05).
- `API_EXTERNAL_URL` with `/auth/v1` and SAML at `/auth/v1/sso/saml/*`
  (2026-07-07 entry): measured for the token issuer, the generated email link,
  and the SAML metadata, entity id and ACS URL (SD06). The word "move" in the
  docs compares with the earlier layout; this run did not start the earlier
  layout, so only the current location is measured. SD06d shows the
  unprefixed path does not reach Auth on this gateway, without dashboard
  credentials.

### Not measured

- Realtime and Edge Functions with `sb_` keys. The functions container is
  given `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` by the compose
  file; no function was deployed or called.
- A valid SAML assertion from a real IdP. SD06f stops at the redirect to an
  invented IdP and at a rejected garbage response.
- The browser-facing dashboard. Only Studio's API route and the gateway's
  basic-auth gate were requested.
- Upgrading an existing Postgres 15 data directory (`utils/upgrade-pg17.sh`)
  and running the Postgres 15 override.
- Linux amd64. The stack ran on aarch64.
- Per-image digests. Tags are recorded in the facts file; the registry could
  move a tag.
- Repeat runs of the published run. n = 1; most module outcomes are
  deterministic configuration reads, but no repetition separates a flaky
  healthcheck from a stable one.

### Teardown

`make clean` ran `docker compose down -v` (logs and Kong overrides named, with
orphan removal), removed the bind-mounted `volumes/db/data` and
`volumes/storage`, and deleted the stack copy with its generated `.env`.
Afterwards the operator listed the Docker engine and found 0 containers, 0
volumes and 0 networks labelled with the compose project (unrecorded: no
listing was saved). The generated secrets were in `work/stack/.env`; result
strings go through `scrub`, and the operator's scan of the evidence, the
published artifact and the sources for every secret-looking `.env` value found
none (unrecorded: no scan output was saved).
