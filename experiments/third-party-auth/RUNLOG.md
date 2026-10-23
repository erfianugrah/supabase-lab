# third-party-auth - RUNLOG

One project, no AWS, no container. The question is what changes when a customer
uses an external identity provider (Clerk / Auth0 / Firebase / Cognito / a
generic OIDC issuer) instead of Supabase Auth for sign-in. An in-process ES256
key is the "external IdP": its public JWKS is published from an Edge Function on
the project and registered as third-party auth, and it mints tokens the modules
present to the data plane. That is a faithful external issuer - Supabase never
sees the private key and GoTrue never issues these tokens - without standing up
Clerk/Auth0, which are generic OIDC and need no paid account to model.

Signing is Web Crypto ES256 (`lib/idp.ts`), the same primitive the
self-hosted-auth keygen uses; no `jose` dependency. Registration is
`POST /config/auth/third-party-auth {jwks_url}` (from self-hosted-auth SH06).

## Modules

| id    | mode        | question |
| ----- | ----------- | -------- |
| TPA01 | destructive | An external issuer's token is trusted by managed PostgREST via JWKS (a token GoTrue never issued), and the same token is refused by managed GoTrue `/auth/v1/user` - the data plane and GoTrue are different verifiers. |
| TPA02 | destructive | RLS reads the third-party claims: `owner = auth.uid()` filters on the token's `sub`, and a custom claim rides through to `auth.jwt()`. So policies key off the external subject, not a foreign key into auth.users. |
| TPA03 | destructive | GoTrue and its migrations persist under third-party auth: `auth.schema_migrations` still populated, `/auth/v1/health` still 200, and a native GoTrue token still reads the data API. TPA is additive, not a swap - which is why the migration-lock guidance still applies. |
| TPA04 | destructive | Third-party login bypasses the GoTrue sign-in rate-limit surface: N distinct external logins minted with zero `/auth/v1` calls all read the data plane, so GoTrue's anonymous/email/token buckets never enter the login path. |
| TPA05 | destructive | Storage verifies a third-party token: a private bucket whose storage.objects policies key on a custom `tenant` claim, probed with download for all seven tokens (allowed, other-tenant, claim-less, forged-signature, unknown-kid, expired, anon); list with allowed, other-tenant and forged; upload with those plus expired; signed URL with allowed, other-tenant and forged. |
| TPA06 | destructive | Realtime verifies a third-party token: private Broadcast joins and sends under realtime.messages policies keyed on the claim, Postgres Changes on an RLS table keyed on the claim, and an expiring token on an open channel (left alone, refreshed, or replaced by a forged token). |

## Why this experiment exists

Three earlier results (auth rate limits, Edge Function concurrency,
auth.users migration locks) leave one question: does using your own SDK or an
external IdP change any of them? Two claims answer it, and this experiment
proves them rather than asserting them:

- Under third-party auth the rate-limit section mostly falls away for sign-in
  (TPA04), and RLS reads the provider's claims (TPA02).
- The migration-lock guidance STILL applies, because Supabase Auth keeps running
  and migrating on the project regardless of the external IdP (TPA03). This is
  the non-obvious one and the reason it is worth a live check.

"Own client instead of supabase-js" needs no experiment: the auth-rate-limits
and auth-users-locks runs already hit the raw `/auth/v1/*` and `/rest/v1/*`
endpoints with plain fetch and an apikey header, no supabase-js, so a custom
client is the same endpoints and the same behaviour by construction.

## Run it

```
make apply                 # provision the throwaway project
make probe                 # TPA01-TPA06
make probe IDS=TPA03       # narrow it
make destroy               # tear the project down
```

Needs `make secrets-decrypt` at the repo root first. First-time issuer kid
propagation to the gateway can take ~30s, so the modules poll PostgREST up to
120s before the first acceptance.

## Validated 2026-09-08 (Pro and Free orgs, ap-southeast-1)

Ran TPA01-TPA04 on one throwaway project in a Pro org and one in a Free org,
then destroyed both. 14 pass / 0 fail per tier, identical results - third-party
auth is NOT plan-gated, it works on Free too. Evidence held locally (refs
redacted by not committing it).

| Row | Result (identical on Pro and Free) |
|---|---|
| TPA01a | external issuer registered via `POST /config/auth/third-party-auth {jwks_url}` -> `201`, id set; JWKS served 200 from the Edge Function. |
| TPA01b | a self-minted ES256 token (one GoTrue never issued) read managed PostgREST `200`, one row, accepted 5s after registration. |
| TPA01c | the same token against managed GoTrue `/auth/v1/user` -> `403`. The data plane trusts the external issuer; GoTrue does not. Different verifiers. |
| TPA02a | RLS `owner = auth.uid()` returned exactly the sub's row - `auth.uid()` resolved to the external token's `sub`, not any auth.users id. |
| TPA02b | a custom claim minted into the token round-tripped through `auth.jwt()->>'org_marker'`. Provider claims are visible to policies. |
| TPA03a | `auth.schema_migrations` = 77 rows with the external issuer registered - the migration machinery is present and Auth-owned regardless of TPA. |
| TPA03b | managed GoTrue `/auth/v1/health` -> `200` (v2.196.0) alongside the external issuer. |
| TPA03c | native GoTrue still issues (admin-create 200, password grant 200) and its token still reads PostgREST 200 - TPA is additive, not a swap. |
| TPA04a | 20/20 external logins minted with ZERO `/auth/v1` calls all read PostgREST 200 - GoTrue's sign-in rate-limit buckets never enter the third-party login path. |

Takeaway for the email: under third-party auth, the data plane trusts the
external issuer via JWKS and RLS keys off its sub (TPA01/TPA02); the sign-in
rate-limit section falls away for login (TPA04); but GoTrue and its migrations
stay on the project (TPA03), so the auth.users migration-lock guidance still
applies. All tier-independent, and it is not a paid-only feature.

## 2026-10-23 - TPA05/TPA06: Storage and Realtime verify the third-party token

One throwaway Micro project in a Pro org, ap-southeast-1, created through the
Management API (not `make apply`), probed with `PVLAB_REF` set, deleted the
same session. Lab commit 661afdf plus the uncommitted tree that adds
TPA05/TPA06. Three runs on that project, each with a
fresh issuer key registered and removed in the module:

| run | modules | artifact |
|---|---|---|
| 1 | TPA05 | `out/2026-10-23/run-2026-10-23T08-04-15-019Z.json` (22 pass) |
| 2 | TPA06 | `out/2026-10-23/run-2026-10-23T08-05-56-795Z.json` (20 rows, 17 pass, 3 info) |
| 3 | TPA05, TPA06 | `out/2026-10-23/run-2026-10-23T08-08-13-268Z.json` (42 rows, 39 pass, 3 info) |

So n = 2 per row (runs 1 and 3 for TPA05, runs 2 and 3 for TPA06). Every
status and body below was the same in both runs except where a row gives two
values.

The issuer is the TPA01 one: an in-process ES256 key whose JWKS an Edge
Function on the project serves, registered with `POST
/config/auth/third-party-auth {jwks_url}`. Every token carries `role:
authenticated`, `aud: authenticated` and `iss` = the jwks_url. The token set:

| token | claims | signed by |
|---|---|---|
| A | `tenant: acme` (TPA06 adds `can_write: "true"`) | the registered key |
| A2 (TPA06) | `tenant: acme` | the registered key |
| B | `tenant: globex` | the registered key |
| noclaim | no `tenant` | the registered key |
| forged | `tenant: acme`, the registered key's kid | a second, unregistered key |
| unknownkid | `tenant: acme`, the second key's own kid | the second key |
| expired | `tenant: acme`, `exp` 600 s in the past | the registered key |
| anon | the legacy anon API key JWT as bearer (TPA05), or no `access_token` in the join (TPA06) | - |

The forged and unknownkid tokens carry the same claims as A. A service that
decoded the token without checking its signature would let them through; none
did.

### Storage (TPA05)

A private bucket with `acme/a.txt` and `globex/b.txt` (written with the
service_role key) and two policies on `storage.objects` for `authenticated`:
SELECT `using` and INSERT `with check` both
`bucket_id = '<bucket>' and (storage.foldername(name))[1] = (auth.jwt()->>'tenant')`.
The `apikey` header was the legacy anon key on every call. Every probe
response whose headers were recorded (all probe rows except TPA05d-A) carried
`sb-gateway-mode=direct`, `sb-gateway-version=1`, `server=cloudflare`.

| row | request, token | status and body (verbatim) |
|---|---|---|
| TPA05a-A | `GET /storage/v1/object/authenticated/<bucket>/acme/a.txt`, A | `200 acme-secret` |
| TPA05a-B | same, B | `400 {"statusCode":"404","error":"not_found","message":"Object not found","code":"NoSuchKey"}` |
| TPA05a-noclaim | same, noclaim | `400` NoSuchKey body as B |
| TPA05a-anon | same, anon key as bearer | `400` NoSuchKey body as B |
| TPA05a-forged | same, forged | `400 {"statusCode":"403","error":"Unauthorized","message":"signature verification failed","code":"AccessDenied"}` |
| TPA05a-unknownkid | same, unknownkid | `400 {"statusCode":"403","error":"Unauthorized","message":"Key for the ES256 algorithm must be one of type CryptoKey, KeyObject, or JSON Web Key. Received an instance of Uint8Array","code":"AccessDenied"}` |
| TPA05a-expired | same, expired | `400 {"statusCode":"403","error":"Unauthorized","message":"\"exp\" claim timestamp check failed","code":"AccessDenied"}` |
| TPA05b-A-acme | `POST /storage/v1/object/list/<bucket> {prefix:"acme/"}`, A | `200`, names `["a.txt"]` |
| TPA05b-A-globex | list `globex/`, A | `200`, names `[]` |
| TPA05b-B-acme | list `acme/`, B | `200`, names `[]` |
| TPA05b-B-globex | list `globex/`, B | `200`, names `["b.txt"]` |
| TPA05b-forged-acme | list `acme/`, forged | `400` "signature verification failed" body as TPA05a-forged |
| TPA05c-A-acme | `POST /storage/v1/object/<bucket>/acme/<new>.txt`, A | `200 {"Key":"<bucket>/acme/<new>.txt","Id":"<uuid>"}` |
| TPA05c-B-acme | upload into `acme/`, B | `400 {"statusCode":"403","error":"Unauthorized","message":"new row violates row-level security policy","code":"AccessDenied"}` |
| TPA05c-B-globex | upload into `globex/`, B | `200` with Key and Id |
| TPA05c-forged-acme | upload into `acme/`, forged | `400` "signature verification failed" body |
| TPA05c-expired-acme | upload into `acme/`, expired | `400` "\"exp\" claim timestamp check failed" body |
| TPA05d-A | `POST /storage/v1/object/sign/<bucket>/acme/a.txt {expiresIn: 60}`, A | `200`; the returned signed URL fetched with no apikey and no bearer -> `200 acme-secret`; the signed URL's own token header was `{"kid":"<uuid>","alg":"HS512"}` |
| TPA05d-B | sign `acme/a.txt`, B | `400` NoSuchKey body as TPA05a-B |
| TPA05d-forged | sign `acme/a.txt`, forged | `400` "signature verification failed" body |

Which side verified: the body shape (`statusCode`/`error`/`message` plus the
S3-style `code` `NoSuchKey` or `AccessDenied`) shows Storage answered, so the
API gateway passed the forged, unknown-kid and expired tokens through and
Storage refused them (read from the response shape, not probed at the
gateway). The policy-denied tokens were verified, then filtered by RLS on the
claim: for B, download and signed-URL creation answer as if the object did
not exist, list answers `200` with an empty list, upload answers "new row
violates row-level security policy"; noclaim and anon were probed on download
only and got the same NoSuchKey.

Inference, not measured: the unknown-kid message reads as Storage finding no
JWKS key for that kid and trying a symmetric secret (a `Uint8Array`) with
ES256. The token is refused either way; the message text is not a stable
contract.

The signed URL is Storage's own credential: once created with token A, it
served the object with no third-party token, until its `expiresIn` (60 s here;
expiry was not probed). Its token is HS512, not the issuer's ES256.

Timing (TPA05-setup): PostgREST first answered `200` to a token from the new
issuer 5 s after registration in both runs (polled every 5 s), and Storage
answered `200` to token A on the first try right after that (0 s after the
PostgREST `200`, both runs).

### Realtime (TPA06)

Raw Phoenix protocol (`lib/rtws.ts`, vsn 1.0.0) on
`wss://<host>/realtime/v1/websocket?apikey=<legacy anon key>`, one socket per
case. The third-party token rides in the `phx_join` payload's `access_token`,
which the API gateway does not read as a bearer, so every reply quoted here is
Realtime's own. Policies on `realtime.messages` for `authenticated`: SELECT
`using (realtime.topic() = 'tenant:' || (auth.jwt()->>'tenant'))`, INSERT
`with check` the same AND `(auth.jwt()->>'can_write') = 'true'`. A public
warm-up join ran first (realtime-surface RT03: the day's `realtime.messages`
partition does not exist before the first join).

| row | case | Realtime's answer (verbatim) |
|---|---|---|
| TPA06a-A | private join `tenant:acme`, A | `{"status":"ok","response":{"postgres_changes":[]}}` |
| TPA06a-A2 | same, A2 | `{"status":"ok", ...}` as A |
| TPA06a-B | same, B | `{"status":"error","response":{"reason":"Unauthorized: You do not have permissions to read from this Channel topic: tenant:acme"}}` |
| TPA06a-noclaim | same, noclaim | the same "Unauthorized" reason |
| TPA06a-anon | same, no `access_token` | the same "Unauthorized" reason |
| TPA06a-forged | same, forged | `{"reason":"JwtSignatureError: Failed to validate JWT signature"}` |
| TPA06a-unknownkid | same, unknownkid | `{"reason":"JwtSignerError: Failed to generate JWT signer for key ID (kid) \"<the second key's kid>\", check your JWT secret or JWKS configuration"}` |
| TPA06a-expired | same, expired | `{"reason":"InvalidJWTToken: Token has expired 623 seconds ago"}` (624 in run 3) |
| TPA06b | `realtime.send(..., 'tenant:acme', true)` and the same to `tenant:globex`, from SQL | A received `to-acme` only, A2 `to-acme` only, B (joined `tenant:globex`) `to-globex` only |
| TPA06c-A | client Broadcast on `tenant:acme` with `ack: true`, A (`can_write: "true"`) | ack `{"status":"ok","response":{}}`; received once by A (self) and once by A2 |
| TPA06c-A2 | same, A2 (no `can_write`) | ack `{"status":"error","response":{"error":"unauthorized"}}`; received by neither |
| TPA06d-A | Postgres Changes INSERT on `public.tpa06_rows` (RLS `tenant = auth.jwt()->>'tenant'`), A | join ok, `system` "Subscribed to PostgreSQL"; of 3 acme and 3 globex rows inserted, received acme 3, globex 0 |
| TPA06d-B | same, B | join ok, subscribed; received acme 0, globex 3 |
| TPA06d-anon | same, no `access_token` | join ok, subscribed; received acme 0, globex 0 |
| TPA06d-forged | same, forged | join refused, `JwtSignatureError: Failed to validate JWT signature` |

Postgres Changes needed one canary round in both runs: one acme and one
globex row, inserted before the measured batch, reached A and B within the
2 s check window, so the first change after subscribe was not lost here.

So Realtime checks the signature, the kid and `exp` of a third-party token
at join, and its channel and row checks read the token's claims: a token from
the registered issuer with the wrong `tenant` claim was refused the private
topic, and the INSERT policy's `can_write` claim decided whether a client
Broadcast went out.

Expiry on an open channel (TPA06e, info rows): three sockets joined
`tenant:acme` with tokens that expire 30 s after mint. Times are relative to
that `exp` as computed by the test process clock.

| row | what the client did | frames on the channel | `realtime.send` 15 s after exp |
|---|---|---|---|
| TPA06e-E | nothing | at +0.0 s (run 2) and +0.4 s (run 3): a `system` frame with status `error`, extension `system`, message `Token has expired 0 seconds ago`, then `phx_close` | not received |
| TPA06e-R | pushed `access_token` with a fresh 1 h token about 10 s after mint | none (no reply to the push, no system frame) | received |
| TPA06e-F | pushed `access_token` with a forged token (registered kid, other key) about 10 s after mint | at -19.0 s (run 2) and -19.7 s (run 3): a `system` frame with status `error`, extension `system`, message `:signature_error`, then `phx_close` | not received |

Realtime closes the channel itself when the token's `exp` passes, a refresh
pushed on the open channel keeps it alive, and a forged refresh closes the
channel at the push rather than at expiry.

Timing (TPA06-setup): the first private join with token A succeeded on the
first try, right after PostgREST's first `200` (PostgREST 5 s after
registration in both runs). No error replies were seen while polling.

### What this does not settle

- Presence on a private channel (the `extension` column split in
  realtime.messages policies): not run.
- Storage TUS resumable uploads, the S3 protocol, image transformation reads:
  not run. Public buckets need no token by design.
- `iss` strictness: every token's `iss` was the registered jwks_url; a
  mismatched `iss` signed by the registered key was not tried.
- A token with no `role` claim (the docs say requests then run as `anon`):
  not run; every token here carried `role: authenticated`.
- The cross-project shape (project A's own Auth as the issuer, as in
  cross-project-auth and key-rotation) registers the same way but was not run
  here; the issuer here is a lab-held ES256 key.
- One project, one region, one Pro org, n = 2. The apikey header was the
  legacy anon key throughout; `sb_publishable_` was not tried on these paths.

Cost: one Micro project, under 20 minutes from create to delete (deleted 08:12 UTC).
