# auth-providers

Sign-in methods on the managed Auth server, measured on throwaway projects:
custom OIDC providers, passkeys (experimental), and what a synthetic sign-in
canary can see per method (password, `signInWithIdToken`, OAuth browser flow,
SAML SSO). Sources: https://supabase.com/docs/guides/auth/custom-oauth-providers,
https://supabase.com/docs/guides/auth/passkeys,
https://supabase.com/docs/guides/platform/sso/testing-best-practices.

Self-provisioning, no OpenTofu state: each module creates a `au-*`
project on the Pro org (`PVLAB_ORG_PRO`) and deletes it in `finally`. AU01 and
AU03 also deploy a Cloudflare Worker (`worker/issuer.ts`, a standards-shaped
OIDC issuer with a per-run RS256 key) and delete it. AU02 drives headless
Chromium with a CDP virtual authenticator inside a Playwright container; AU04
signs SAML responses with xml-crypto inside a bun container. Nothing runs on
the host except `docker`, `wrangler`, `openssl` and the harness.

| id | claim |
|---|---|
| AU01 | custom OIDC: create validation, provider quota (Pro and Free), immutability of `provider_type`/`identifier`, provider-side PKCE default and `pkce_enabled=false`, sign-in with and without an email claim (`email_optional`), `aud` vs `client_id`/`acceptable_client_ids` |
| AU02 | passkeys: disabled control, `registerPasskey` / `signInWithPasskey`, origin outside `webauthn_rp_origins`, `webauthn_rp_id` that is not a suffix of the page host, RP ID change after enrolment, admin list/delete, per-user cap |
| AU03 | canary: per-method status and latency, negative-control error classes, a session while the client cannot reach `/auth/v1`, global sign-out vs an issued access token, IdP outage (issuer deleted) |
| AU04 | SAML SSO canary with a lab-signed IdP response: provider create from metadata XML, SP-initiated sign-in, replay, bad signature / unsigned / audience / expiry / recipient / IdP-initiated / other-domain email |

## Run

```bash
export PVLAB_ORG_PRO=<pro-org-slug> PVLAB_ORG_FREE=<free-org-slug>
sx SUPABASE_ACCESS_TOKEN -- make probe ONLY=AU01      # one module
make sweep                                            # list au-* leftovers
```

AU02 needs `docker pull mcr.microsoft.com/playwright:v1.64.0-noble`; AU04 needs
the `oven/bun:1` image. AU01 needs `PVLAB_ORG_FREE` only for the Free-org quota row.
AU03 holds a 60 s `jwt_exp` wait plus up to 4 min of REST polling and an IdP
outage series of up to about 8 min.

Sibling context: `identity-transfer` (Keycloak slot driven from a Keycloak-shaped
worker), `third-party-auth`, `session-carry`, `auth-rate-limits`.
