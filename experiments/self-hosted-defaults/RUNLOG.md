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

## Run 2 - 2026-10-23, SD09-SD12 (the gaps Run 1 listed as not measured)

Same pin (`8617532ae1a41571d5d557cd24c6f5f2565d9230`), same Docker Desktop
host (Apple silicon; the engine reported 10 CPUs and MemTotal 8214851584
bytes, operator read, not in the artifacts; version 29.9.2 and storage driver
overlay2 are in the SD12 artifacts), lab base commit `661afdf` with the experiment
changes uncommitted while they ran. Another lab agent ran this rig's default
stack (project `supabase`, the fixed container names, host ports 8000, 5432,
6543) on the same engine for most of the session (operator read), so every stack here is a SLOT
stack: own compose project, own host ports, no fixed container names (Makefile
comment). SD01-SD04 were re-run on the first SLOT stack as a regression check
of that change: 14 pass, 1 info (SD02d), 0 fail
(`out/2026-10-23/run-2026-10-23T08-44-06-658Z.json`).

### SD09 and SD10 - Realtime and Edge Functions with the `sb_` keys

Artifact: `out/2026-10-23/run-2026-10-23T09-46-42-669Z.{json,facts.md}`, slot
stack `sd-a` started from scratch with `make stack pull up SLOT=a ...` (host
port 8210 and the `up` wall time are operator reads, not in the artifact); one
run of each module, n = 1. This run replaces the 08:42 UTC run, withdrawn
because SD10c's environment labels had a `name=sb_secret` shape that secret
scanners flag; the module now writes `default:secret`, and every other
measurement of the two runs was identical (operator diff, no artifact for the
withdrawn run). Development runs of SD09 at 08:38 and 08:40 UTC are not
published either (the supabase-js private-channel case moved from the client's
`accessToken` option to a password sign-in, and a publishable-socket plus
`sb_secret_` access_token case was added).

| Module | What was measured | Result |
| --- | --- | --- |
| SD09a | Raw Phoenix socket on a public channel, per credential | publishable key as the `apikey` query parameter, secret key as the query parameter, publishable key as an `apikey` header, legacy anon JWT: handshake 101, join ok, own broadcast received. No key and a made-up `sb_publishable_` key: `HTTP/1.1 401 Unauthorized`, body `Unauthorized`, at the handshake |
| SD09b | Private channel, RLS on `realtime.messages` with one policy for `authenticated` on topic `sd09-private` | publishable key: join refused, `{"reason":"Unauthorized: You do not have permissions to read from this Channel topic: sd09-private"}`. Secret key: join ok, broadcast received. Publishable key plus a user's access token in the join payload: join ok, broadcast received. An `sb_` key in the join payload's access_token changed nothing in either direction: publishable socket with access_token `sb_publishable_` or `sb_secret_` refused as above; secret socket with access_token `sb_publishable_` or `sb_secret_` admitted |
| SD09c | supabase-js 2.112.3 | public channel with either key: `SUBSCRIBED; broadcast received`. Private channel: publishable key `CHANNEL_ERROR: Unauthorized: ...`; secret key `SUBSCRIBED; broadcast received`; publishable key after `auth.signInWithPassword`: `SUBSCRIBED; broadcast received`. The client's `accessToken` option with the same user token: `CHANNEL_ERROR` (recorded, not asserted; whether the option is applied after the first join was not separated) |
| SD09d | `POST /realtime/v1/api/broadcast` with a secret-key socket listening on the topic | publishable key HTTP 202, listener got the message; secret key HTTP 202, got it; no key HTTP 401 `Unauthorized`, nothing delivered |
| SD10a | `POST /functions/v1/hello` (the shipped function, `withSupabase({ auth: ["publishable", "secret"] })`), `FUNCTIONS_VERIFY_JWT=false` as `.env.example` ships it | `apikey` publishable or secret: 200 "Hello from Edge Functions!". Publishable key in `apikey` and as `Bearer`: 200. Publishable `apikey` plus a user's ES256 JWT as `Bearer`: 200. Envoy's own 401 (`text/plain`): made-up `sb_secret_` key "Invalid API key"; publishable `apikey` with the secret key as `Bearer` "Conflicting API keys". The function's 401 from `@supabase/server`: no credentials `MISSING_CREDENTIALS`; publishable key only as `Bearer` `UNUSABLE_CREDENTIAL` ("the Authorization header carried an sb_* API key, not a user JWT"); legacy anon or service_role JWT in `apikey` `INVALID_API_KEY`; legacy anon JWT or a user JWT only as `Bearer` `INVALID_CREDENTIALS`; a client-supplied `sb-api-key` header carrying the asymmetric service_role JWT, nothing else: `MISSING_CREDENTIALS` |
| SD10b | supabase-js 2.112.3 `functions.invoke("hello")` | publishable key, secret key, and publishable key after a password sign-in: all `ok {"message":"Hello from Edge Functions!"}` |
| SD10c | A probe function written into `volumes/functions` for the run (reports kinds, never values) | it receives `apikey` as sent and `Authorization` as sent; no `sb-api-key` header in any of the five cases (by the code at the pin, Envoy adds one for an `sb_` key and the main router deletes it before the function runs; the two steps were not observed separately); environment: `SUPABASE_PUBLISHABLE_KEYS` `default:publishable`, `SUPABASE_SECRET_KEYS` `default:secret`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` HS256 JWTs, `SUPABASE_URL` `http://api-gw:8000`; from inside the function, the environment's secret key read `200 rows 1` and the publishable key `200 rows 0` from a table with RLS on and no policy |
| SD10d | `hello` again with `FUNCTIONS_VERIFY_JWT=true` (functions container recreated alone, `.env` restored afterwards) | `apikey` publishable or secret: 200, and the two other 200 cases above stay 200. No credentials, a legacy JWT in `apikey`, and a client `sb-api-key` header alone now stop at the main router: 401 `UNAUTHORIZED_NO_AUTH_HEADER` "Missing authorization header". The Envoy 401s and the `@supabase/server` 401s for the Bearer-only cases are unchanged |

### SD11 - Postgres 15 to 17 data-directory upgrade

What the guide and script say (read at the pin, not measured by itself):
`apps/docs/content/guides/self-hosting/postgres-upgrade-17.mdx` lists the
requirements (all containers running, `bash`, root or `sudo`, 2x the database
size plus 5 GB free), the backups to take first (`cp -a ./volumes/db/data
./volumes/db/data-manual-backup` and the pgsodium key through
`docker compose run --rm db cat /etc/postgresql-custom/pgsodium_root.key`),
the command `sudo bash utils/upgrade-pg17.sh` (`--yes` skips the prompts), and
a rollback block. The script builds a PG 17 binary tarball from
`supabase/postgres:17.6.1.063`, runs `initiate.sh` (pg_upgrade) in a PG 15
container and `complete.sh` in a 17.6.1.063 container, swaps
`volumes/db/data` with the new cluster (keeping `volumes/db/data.bak.pg15`),
starts the stack with `-f docker-compose.yml -f docker-compose.pg17.yml`, and
applies seven migrations plus an `ALTER EXTENSION ... UPDATE` for every
extension against `supabase/postgres:17.6.1.136`. Neither the script nor the
guide changes `COMPOSE_FILE` in `.env`.

| Module | What was measured | Result |
| --- | --- | --- |
| SD11a | PG 15 stack (`sh run.sh config add pg15`, `sh run.sh start`), seeded | `supabase/postgres:15.8.1.085`, server_version 15.8; data directory 186 MB; 55 tables counted; seeded checksums, e.g. `sd11.t_big 200000 rows md5 1d029872c105d519814ca2266530e855`, `sd11.t_child 50000 rows md5 27dbfc93dec46e6d1440528bb0ec6e64`; extensions pg_cron 1.6, pg_graphql 1.5.11, pg_net 0.14.0, pg_stat_statements 1.10, supabase_vault 0.3.1 (and four more) |
| SD11b | `bash utils/upgrade-pg17.sh --yes` as root, run directory on the host copy (host bind mount, fstype `fakeowner`), clean stack | exit 0 in 170.9 s: building the binary tarball from `17.6.1.063` 92.6 s (1214 MB, cached afterwards), `initiate.sh` (pg_upgrade) 40.0 s, `complete.sh` 7.7 s, starting the stack on 17 16.7 s; the rest under 5 s each |
| SD11c | After the upgrade | `17.6.1.136`, server_version 17.6, `PG_VERSION` 17; seeded checksums differing: none; row counts differing (of 55 tables): none; extensions changed: pg_cron 1.6 -> 1.6.4, pg_net 0.14.0 -> 0.20.3, pg_stat_statements 1.10 -> 1.11 (pg_graphql 1.5.11 kept); Vault decrypts to the same value; cron job active; the pre-upgrade user signs in (200, same id); REST with the publishable key 10 rows and the secret key 100 rows; GraphQL 200; 11 of 11 containers healthy; `data.bak.pg15` and `pgsodium_root.key.bak.pg15` present; `.env` still `COMPOSE_FILE=docker-compose.yml:docker-compose.pg15.yml` |
| SD11d | The next `docker compose up -d --wait` (what `sh run.sh start` runs) with that `.env` | compose recreated db on `15.8.1.085`; exit 1, "dependency failed to start: container sd-u-db-1 is unhealthy"; db log "FATAL: database files are incompatible with server" / "The data directory was initialized by PostgreSQL version 17, which is not compatible with this version 15.8." After `sh run.sh config remove pg15` and start: exit 0, server_version 17.6, seeded checksums unchanged, 11 of 11 healthy |
| SD11e | The guide's rollback block, as written, as root | exit 0 in 25.0 s; `15.8.1.085`, server_version 15.8; seeded checksums equal to SD11a; Vault decrypts; 11 of 11 healthy; REST, sign-in and GraphQL as before |

Artifact for the rows above: `out/2026-10-23/run-2026-10-23T09-02-37-193Z.json`
(the clean run). The same procedure ran five times in total. Attempts 1-3 ran
on slot stack sd-u (attempt 2 on attempt 1's data, attempt 3 on a fresh
stack); attempts 4-5 on sd-v (attempt 5 on attempt 4's data).

| Attempt | Artifact | Run directory | Outcome |
| --- | --- | --- | --- |
| 1 | `run-2026-10-23T08-50-20-551Z` | host copy | `initiate.sh` failed after 95.1 s: pg_upgrade "Restoring database schemas in the new cluster *failure*"; the script reported the data directory unchanged and exited 1. The cause, read from the pg_upgrade log on disk by the operator and not in the artifact (the log was deleted with the stack): `PANIC: could not open file "base/1": No such file or directory` on `CREATE DATABASE "template1" ... OID = 1` in the new cluster |
| 2 | `run-2026-10-23T08-58-48-533Z` | host copy, same data after attempt 1 | script exit 0 (76.9 s, tarball cached); SD11c and SD11e failed: this module version checksummed the full `auth.users` row (flagging its own sign-in) and its row counts caught the sign-in's auth rows and one `cron.job_run_details` run (0 -> 1); fixed before attempt 3 |
| 3 | `run-2026-10-23T09-02-37-193Z` | host copy, fresh stack | the clean run above |
| 4 | `run-2026-10-23T09-07-05-541Z` | engine VM ext4 (`make vmfs-up`) | script exit 1 at "Starting Postgres 15 in upgrade container": `pg_ctl: could not start server` |
| 5 | `run-2026-10-23T09-09-47-902Z` | engine VM ext4, same data | `initiate.sh` ran `apt-get update` in the PG 15 container and got "At least one invalid signature was encountered" for every Ubuntu focal source, then failed |

Attempts 4 and 5 ran with little VM disk left: the script's pre-flight read
5873 MB available before attempt 4 and 4681 MB before attempt 5, against its
own estimate of 5370 MB, and warned before attempt 5 (SD11b evidence). The
tarball and its staging copy were on the VM disk for those two, on the host
disk for 1-3. Disk exhaustion would explain both failures, but free space was
not measured while they ran, so the ext4 runs say nothing either way about the
filesystem; the attempt-1 PANIC is one failure in three host-copy runs, cause
not isolated. Two controls the operator ran outside the harness (no artifact):
stock `pg_upgrade` 16 -> 17 from the `postgres:17` image into the same kind
of bind mount, and into a bind mount reached through a symlink as the
script's `/data_migration` is, both succeeded.

Deviations from the guide: root was a `docker:29-dind` container used as a
shell (sudo needs a password here), and TMPDIR was set to
`volumes/db/.upgrade-tmp` inside the stack so the script's staging bind mounts
resolve on the Docker host (bash and curl added with apk); neither is in the
evidence string. The script ran from a copy with two lines changed (the diff
is in each SD11b evidence string): `DB_CONTAINER` (a SLOT
stack has no `supabase-db` container) and the db-config volume lookup, which
upstream is `grep -E '^db-config$|_db-config$' | head -n 1` over every volume
on the engine; this engine also held the other agent's `supabase_db-config`.
Reading the script, an unmodified run on an engine with two stacks would act
on whichever volume and `supabase-db` container it found (not run).

The clean run's script log (SD11b evidence) also shows
`ERROR:  extension "pg_cron" has no update path from version "1.6" to version "1.6.4"`
from `update_extensions.sql` and the reconcile step's
`NOTICE:  skipped extension pg_cron` while verification read pg_cron 1.6.4,
and `NOTICE:  changing version from 2.39 to 2.40` (collation) on `postgres`,
`template1` and `_supabase` with no reindex step in the log.

### SD12 - linux/amd64 images, emulated on the arm64 engine

Not a native amd64 measurement. Artifacts: native comparison
`out/2026-10-23/run-2026-10-23T09-11-43-286Z.json`, emulated
`out/2026-10-23/run-2026-10-23T09-57-29-678Z.json`; one slot stack (`sd-m`,
operator read), images local before each `up`, n = 1 each. The emulated run
replaces one at 09:13 UTC withdrawn for the SD10c label shape (see SD09/SD10);
that run's per-service outcome was the same, its numbers are not cited. Nine services ran from their amd64 images
by manifest digest (`make amd64-layer`); Studio and imgproxy stayed arm64
(VM disk was the constraint).

| Measure | Native arm64 | Emulated amd64 (9 of 11 services) |
| --- | --- | --- |
| `docker compose up -d --wait` | 22372 ms, exit 0 | 82620 ms, exit 1 (compose stopped waiting when Realtime turned unhealthy, so this is not a start-up time; reading, not measured) |
| Healthy at the module's read | 11 of 11 | 10 of 11; Realtime "starting", 7 restarts |
| Database `uname -m` / version() | aarch64 / PostgreSQL 17.6 on aarch64-unknown-linux-gnu | x86_64 / PostgreSQL 17.6 on x86_64-pc-linux-gnu |
| Sum of squares over 3,000,000 numerics, EXPLAIN ANALYZE ms, 3 runs | 531, 522, 516 | 845, 834, 801 |
| Image pull | 3328 ms (cached, inferred from the time) | 41076 ms (nine amd64 images, pulled while slot stack sd-a was still running idle, operator read) |

Realtime under emulation restarted 7 times and stayed "starting" (SD12a); the
operator read "undefined function erlang:nif_error/1 in function
prim_tty:isatty/1" then "Kernel pid terminated (application_controller)" in
its log (not in the artifact). Supavisor, the other Elixir service,
started healthy. On the emulated stack SD02a-c and SD10a-d passed (SD02d is info) and SD03 passed apart from SD03a, whose check compares the
running image name with the compose tag and so fails on a digest reference;
it read server_version 17.6 and `PG_VERSION` 17. SD09 was not run there
(Realtime down).

### Not measured in Run 2

- Realtime `postgres_changes` with the `sb_` keys (SD09 covers join,
  broadcast, private-channel authorisation and REST broadcast only).
- Edge Functions deployed through Studio or the CLI; SD10 used the shipped
  `hello` and a function file written into `volumes/functions`.
- The PG 15 -> 17 upgrade on a native Linux host, with a database larger than
  186 MB, or with Storage objects (the file backend does not store uploads on
  this Mac, see storage-surface); `pg_graphql` in use beyond `{ __typename }`.
- Index validity after the collation refresh (2.39 -> 2.40) was not checked.
- Whether attempt 1's PANIC repeats on the host copy at some rate, and why
  attempts 4 and 5 failed on ext4 (free disk during the run).
- Native amd64. SD12 is emulation; Studio and imgproxy were not run as amd64.
- Repeats: n = 1 for SD09, SD10 and SD12; SD11 as listed.

### Teardown (Run 2)

`make clean SLOT=a|u|v|m` and `make vmfs-down SLOT=v`; afterwards the operator
listed 0 containers, volumes and networks labelled with the four compose
projects, removed the images this run pulled (`supabase/postgres:15.8.1.085`,
`supabase/postgres:17.6.1.063`, the nine amd64 images, `docker:29-dind`) and
checked the arm64 `supabase/postgres:17.6.1.136` tag still pointed at an arm64
image (unrecorded: no listing saved). One named Docker volume from a discarded
docker-in-docker attempt, `sd168-dind-probe-data`, is left on the engine;
its removal is tracked on the board.
