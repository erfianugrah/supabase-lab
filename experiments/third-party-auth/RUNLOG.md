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

## Why this experiment exists

A customer email answered three things (auth rate limits, Edge Function
concurrency, auth.users migration locks) and then asked whether using their own
SDK or an external IdP changes any of it. Two claims went into the reply that
this experiment proves rather than asserts:

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
make probe                 # TPA01-TPA04
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
