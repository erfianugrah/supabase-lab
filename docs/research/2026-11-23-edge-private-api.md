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

## Not measured

Forward proxy and HTTPS_PROXY-as-secret, v1 cert rejection, reused-client
latency to a nearby upstream, `cf-worker` spoofing, the shared-IP Auth rate
limit behind a Worker; O2O, keyless client with the
key at the edge, Realtime through Azure Front Door / APIM, the iPaaS runtime
truststore behaviour on a real tenant.
