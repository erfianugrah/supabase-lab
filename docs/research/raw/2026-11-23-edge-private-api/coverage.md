# Coverage ledger - edge-private-api (2026-11-23)

Statuses: untested | checked | eliminated. Evidence is about that exact
candidate. Lab = experiments/edge-private-flow/RUNLOG.md run 1.

## Ingress (customer edge in front of Supabase)

| candidate | source | status | direct evidence |
| --- | --- | --- | --- |
| Worker reverse proxy + secret header checked in the function | lab | checked | G1-G4, F1 |
| RLS on request.headers (Data API gate) | lab | checked | D1-D4 |
| db_pre_request header/IP filter on hosted | lab L09, S16 | eliminated | does not fire on hosted PostgREST |
| Workers mTLS binding to Supabase | https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/ + lab T1 | eliminated | proxied-zone restriction; project edge sends no CertificateRequest |
| Authenticated Origin Pulls | https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/ | eliminated | origin enforces it; Supabase is the origin [inf] |
| API Shield mTLS app -> customer zone | https://developers.cloudflare.com/api-shield/security/mtls/ | checked | doc; leaves edge -> Supabase leg |
| O2O proxied CNAME to Supabase custom domain | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/product-compatibility/ | untested | WebSockets "No" in CF table |
| Edge holds the API key, legacy keys off | ingress-front-door.md | untested | pieces in L11, S25; #343 |
| Third-party auth only, RLS on iss | lab L10/L10E | checked | earlier run |
| A cloud front door / CDN WAF in front | ingress-front-door.md | untested | WebSocket idle and duration caps in vendor docs; #343 |
| A cloud API gateway in front | ingress-front-door.md | untested | one checked cannot rewrite Host on the WS handshake; #343 |
| CloudFront + AWS WAF | ingress-front-door.md | untested | doc only |
| cf-worker header in RLS | https://developers.cloudflare.com/fundamentals/reference/http-headers/ | eliminated | run 2 H2/H3: always supabase.co |

## Egress (function -> private API)

| candidate | source | status | direct evidence |
| --- | --- | --- | --- |
| mTLS via Deno.createHttpClient | lab F2/F3, edge-runtime PR #515/#766 | checked | 400 -> 200 with cert on hosted 1.79.1 |
| Forward user JWT, JWKS validation upstream | lab F4 | checked | ES256 verified by jose against project JWKS |
| Function-signed JWT | vendor notes (local only) | untested | WebCrypto available [inf] |
| Enterprise-IdP client credentials | vendor notes (local only) | untested | doc |
| Forward proxy via createHttpClient({proxy}) | vendor notes (local only), edge-runtime vendor/deno_fetch/proxy.rs | checked | run 2 P1: dead proxy -> connect error (honoured) |
| HTTPS_PROXY as function secret | edge-runtime ext/env/lib.rs | eliminated | run 2 X1-X3: visible in env, fetch ignores it |
| Cloudflare Tunnel + Access service token | an options longlist O8 | untested | doc |
| A cloud relay service | vendor notes (local only) | untested | doc |
| Single mTLS+JWT gateway in front of several process APIs (Cloudflare mTLS stand-in) | lab run 2 GW1 | checked | no cert / wrong CA 403, no JWT 401, cert+JWT 200 |
| Cloudflare Access service token in front of the gateway | lab run 2 SV1 | checked | 200 with token, 403 without |
| A cloud or self-hosted API gateway in front of the iPaaS | vendor notes (local only) | untested | doc |
| Queue / reverse flow | egress O10/O11 | untested | doc |
| iPaaS inbound mTLS (ingress truststore) | vendor notes (local only) | untested | dedicated-network tier only on the one checked; optional-mTLS docs conflict; #343 |
| VPN / mesh agent / sidecar in the function | edge-runtime ext/os/os.js | eliminated | no subprocess, no UDP, no VPC |
| pg_net with a client cert | supabase/pg_net a6b7841f | eliminated | no client-cert or proxy option |
| PrivateLink outbound | Supabase PrivateLink docs | eliminated | DB inbound only |
