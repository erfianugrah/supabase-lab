# Edge Functions behind a customer edge, calling a private API (2026-11-23)

Question: app traffic should reach hosted Supabase through an
operator-owned edge (WAF, bot and rate controls), and Edge Functions should call an
internal-only integration layer (an iPaaS runtime on another cloud). Which
designs work today, and what does each leave open?

Sources: lab run `experiments/edge-private-flow/RUNLOG.md` (run 1, 2026-11-23),
raw research in `docs/research/raw/2026-11-23-edge-private-api/`
(`ingress-front-door.md`) and candidate ledger `coverage.md` there; the
vendor-specific egress, adversarial and iPaaS notes are kept local only
measured in run 1, [src] read in code, [doc] vendor doc read 2026-11-23,
[inf] inferred, [untested].

## Ingress: the customer edge in front of Supabase

- The project edge never asks for a client certificate [lab T1], and Cloudflare
  documents that the Workers mTLS binding cannot target a proxied Cloudflare
  zone [doc]. mTLS from the customer edge to Supabase is not available. mTLS
  can sit between the app and the customer's own zone (API Shield) [doc].
- `<ref>.supabase.co` stays reachable whatever sits in front [lab O1/O2, L11].
  The edge becomes the only useful path only where the project checks something
  the edge adds:
  - Edge Functions: check a shared-secret header in code [lab G1/G2].
  - Data API: an RLS policy that reads `request.headers` through a SECURITY
    DEFINER function admits rows only with the edge's header [lab D1-D4].
    `db_pre_request` is not an option on hosted (L09, S16).
  - Auth and Storage: not gated by a header [lab O1/O2]. Cover Auth with
    CAPTCHA, signup controls and rate limits (S19); Storage with RLS on
    `storage.objects` (a header check there is [untested]).
- Behind a Worker every user arrives from one Cloudflare address
  (`CF-Connecting-IP 2a06:98c0:3600::103` on cross-zone subrequests) [doc], so
  Auth per-IP rate limits see one client unless `Sb-Forwarded-For` is set up
  [doc, untested here].
- A customer Cloudflare zone proxied in front of a Supabase custom domain
  (Cloudflare for SaaS "O2O") is undocumented by Supabase; Cloudflare's
  compatibility table marks WebSockets "No" [doc]. [untested]
- Region: Edge Functions run nearest the caller unless pinned; the edge can pin
  with `x-region` + `forceFunctionRegion` [lab R1-R3]; a pinned call is not
  re-routed in an outage [doc].

## Egress: function to the private API

| option | from a hosted function | gate on the API side | evidence |
|---|---|---|---|
| mTLS client cert (`Deno.createHttpClient({cert, key})`) | yes, runtime 1.79.1 [lab F2/F3] | a truststore on the integration platform's ingress (on one major iPaaS only in its dedicated-network tier) [doc]; a cloud API gateway in front as the alternative [doc] | lab + edge-runtime PR #515, #766 |
| Forward the user's Supabase JWT | yes [lab F4] | JWT policy against `/auth/v1/.well-known/jwks.json`; ES256 accepted by the JWT policies of the iPaaS and cloud API gateways checked [doc] | lab + docs |
| Function-signed JWT or enterprise-IdP client credentials | yes (WebCrypto / public token endpoint) [inf] | JWT policy with PEM key or the IdP's JWKS [doc] | docs |
| Fixed-IP forward proxy (`createHttpClient({proxy})`) + IP allowlist | yes per code [src], [untested] | the iPaaS firewall checked takes no custom CIDR, and its IP-allowlist policy reads `x-forwarded-for` by default [doc] | code + docs |
| Cloudflare Tunnel + Access service token | yes (two headers) [doc] | cloudflared inside their network | docs |
| A cloud relay service (HTTPS sender side) | yes per protocol [doc], [untested] | custom listener | docs |
| Queue or reverse flow (their side pulls / pushes) | n/a | their integration flows; PrivateLink is DB-only, Team/Enterprise | docs |
| VPN, mesh agent, sidecar, pg_net with a cert | no (no subprocess, no UDP, no VPC; pg_net has no client-cert option) [src] | - | code |

Caveats that change the build:

- Client cert format: X.509 v3 [src]; RSA or NAMED-curve EC - an
  explicit-parameters EC key fails with `KeyMismatch` [lab]. Before runtime
  v1.78.1 a bad cert crashed the worker (PR #766); hosted ran 1.79.1 [lab F1].
- Create the HttpClient and the supabase-js client once per worker, not per
  request: per-request clients refetch the JWKS and redo the TLS handshake
  (`getClaims` caches JWKS per client instance for 10 min [src]); the 2 s CPU
  budget is per worker [doc]. The iPaaS ingress checked closes idle
  connections after 15 s [doc], so keep the pool idle timeout under the
- Hosted outbound fetch has open reports of HTTP/2 stream errors (#685) and a
  ~75 s first-connect stall on cold isolates (#738) [doc]; set a timeout.
- Only asymmetric signing keys publish a JWKS entry; a project still on the
  legacy HS256 secret fails JWKS validation [doc]. A project created on
  2026-11-23 started on ES256 [lab].
- Key rotation: Supabase edge caches JWKS 10 min, the gateways checked 60 min
  (one refetches on an unknown kid at most every 5 min) [doc]; publish a standby
  key well before rotating. Neither side sees sign-out: a token is valid until
  `exp`.
- An iPaaS JWT policy may validate a `client_id` claim by default that
  Supabase user tokens do not carry [inf]; skip it. Vendor docs can disagree
  on whether optional mTLS exists [doc]; test that a no-cert request is
  refused and remove any default hostname that skips the mTLS listener [inf].

## Run 2 additions (2026-11-23 07:02 UTC)

- A single gateway enforcing mTLS (Cloudflare-managed CA) and JWT in front of
  two process APIs works from a hosted function: no cert 403, wrong-CA cert
  403, no JWT 401, cert + JWT 200 [lab GW1]. An Access service token in front
  works as the no-PKI variant [lab SV1].
- `createHttpClient({proxy})` is honoured; `HTTPS_PROXY` as a function secret
  is not [lab P1, X1-X3]. X.509 v1 certs fail per request without taking the
  worker down [lab V1/V2].
- Behind a Worker every user arrives as `2a06:98c0:3600::103` at the function
  and in `request.headers`; `cf-worker` is always `supabase.co` [lab H1-H3].
- Reused HttpClient p50 17 ms vs new client p50 243 ms to a nearby gateway
  (n=20 each, run 2).

## Run 3 additions (2026-11-23 07:24-07:34 UTC, runs 1-2 repeated)

- A gateway that trusts only our own CA admits our RSA and named-curve EC
  certs and refuses a Cloudflare-issued cert, a third CA's cert and no cert
  [lab OWN1] - the shape of an enterprise CA with its own truststore.
- Cloudflare Tunnel + Access service token to an origin with no inbound port:
  200 with token + JWT, 401 without JWT, 403 without token [lab TUN1].
- A caller outside Singapore runs the function where it is (us-east-1,
  eu-central-1) unless pinned; through the pinning Worker it ran in
  ap-southeast-1 [lab ABR].
- A cert secret change reached both per-call and reused clients by 10 s (one post-change sample per arm)
  without a redeploy [lab ROT, n=1].
- Reused client faster in 6 of 6 interleaved sets (p50 12-24 ms vs 61-243 ms
  to a gateway a few ms away); only the gap transfers to a real upstream.

## Not measured

The Auth per-IP rate limit behind a Worker and `Sb-Forwarded-For`; which
spoofed header triggered the 403 in H4. Commercial iPaaS
and cloud API gateways themselves (no accounts; docs only). O2O, keyless
client with the key at the edge, Realtime through a cloud front door or API
gateway, an iPaaS truststore on a real tenant.
