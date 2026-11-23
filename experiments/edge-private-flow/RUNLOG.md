# edge-private-flow - RUNLOG

Question: can a hosted Edge Function sit behind a customer-owned edge (a
Cloudflare Worker) and call an internal integration API with an mTLS client
certificate and the caller's Supabase JWT, and which parts of the project can
the edge actually gate?

Flow under test:

```
client -> front Worker (adds x-gw-secret, pins region) -> Edge Function relay
       (checks x-gw-secret, then the user JWT with getClaims)
       -> mTLS upstream (client.badssl.com, certauth.idrix.fr)
       -> JWT upstream (a Worker validating the token against the project JWKS)
```

## Run 1 - 2026-11-23 06:41 UTC

Setup: one micro project in ap-southeast-1 (OpenTofu, `make apply`), two
workers.dev Workers, function deployed with `--no-verify-jwt` (the function
does its own claims check; gateway verify_jwt is a key-possession check, L07).
Invoked from Singapore. Evidence: `evidence/run-2026-11-23T06-41-57-722Z.json`
(gitignored, local only).

| id | check | result |
|---|---|---|
| G1/G2 | function direct, no / wrong front secret | 403 both |
| G3/G4 | via front, no / garbage user JWT | 401 both |
| F1 | runtime | `supabase-edge-runtime-1.79.1 (compatible with Deno v2.1.4)`; `Deno.createHttpClient` and `Deno.connectTls` are functions |
| F2 | mTLS to a CA-verifying server (client.badssl.com) | without client cert 400, with cert 200 |
| F3 | mTLS with our own CA's cert (echo server) | server saw `CN=lab-edge-function-client-ec`, issuer `CN=lab-test-ca`, TLSv1.2 |
| F4 | JWT upstream (jose, remote JWKS, issuer + audience) | user token 200 (`alg` ES256, verify 43 ms in the Worker); no token 401 |
| R1/R2 | via front, pinned / unpinned (POST) | both ap-southeast-1 (Worker colo SIN, so nearest is also SIN) |
| R3 | direct with `forceFunctionRegion=us-east-1` | ran in us-east-1 |
| D1 | Data API via front (RLS policy reads `request.headers` x-gw-secret) | 2 rows |
| D2-D4 | Data API direct: no header / wrong header / valid user JWT, no header | 0 rows each |
| O1 | `/auth/v1/settings` direct | 200 (Auth is not gated by any of this) |
| O2 | `/storage/v1/bucket` direct | 200 (empty list; Storage not gated by the header) |
| T1 | `openssl s_client` to `<ref>.supabase.co:443` | `No client certificate CA names sent` - the project edge never requests a client cert |

Latency, client in Singapore -> Worker (SIN) -> function (ap-southeast-1), n=20
each, sequential:

| arm | p50 | p90 | max |
|---|---|---|---|
| probe (no outbound) | 38 ms | 64 ms | 64 ms |
| jwt-upstream (one fetch to a Worker) | 61 ms | 90 ms | 91 ms |
| mtls-echo (one mTLS fetch to France) | 1294 ms | 1771 ms | 1801 ms |

The mTLS number is dominated by distance (echo server in France) and by a new
HttpClient per request (no connection reuse, full handshake every call). It
says nothing about mTLS overhead to a nearby upstream. Not measured: reused
client, a Singapore upstream.

Other observations:

- A new project's signing keys at creation: `HS256:previously_used,
  ES256:in_use`; user tokens carried `alg: ES256` with a `kid` that is in the
  public JWKS. No rotation step was needed for JWKS validation.
- The mTLS call left from `56.10.122.236`; the 2026-11-23 egress probe saw
  13.214.168.194 and 13.214.202.160 from the same region. More evidence the
  egress address is not fixed.
- Multi-line PEM cert and key survived `POST /v1/projects/{ref}/secrets` (JSON
  body) and loaded in `createHttpClient`.
- Local gotcha (Deno 2.9.8, macOS LibreSSL): `openssl req -newkey ec -pkeyopt
  ec_paramgen_curve:P-256` wrote an EC key with EXPLICIT curve parameters
  (`Field Type: prime-field`, no `ASN1 OID`); `createHttpClient` refused it
  with `keys may not be consistent: KeyMismatch` although cert and key matched.
  A named-curve key (`openssl ecparam -name prime256v1 -genkey`) and RSA 2048
  both worked. Issue client certs as RSA or named-curve EC.
- `supabase functions deploy` from an agent run stops with
  `HostedMutationConsentRequiredError`; `--yes` is the user's call (`make
  function` passes it, run by a human).

Not tested here (cards): forward-proxy option and HTTPS_PROXY-as-secret, X.509
v1 cert rejection, reused HttpClient latency, `cf-worker` header spoofing, the
shared Worker egress IP against Auth per-IP rate limits;
customer Cloudflare zone proxied in front of a Supabase custom domain, keyless
client with the key held at the edge, Realtime through a cloud front door / API gateway,
an iPaaS ingress truststore on a real tenant.

## Run 2 - 2026-11-23 07:02 UTC

Adds an integration-gateway stand-in and the runtime arms run 1 left open.
Gateway: one Worker on two lab hostnames under a personal zone. The GW host
has Cloudflare mTLS enabled (client cert issued by the Cloudflare-managed CA
from our CSR); the Worker refuses unless `cf.tlsClientAuth.certVerified` is
`SUCCESS`, then validates the forwarded JWT against the project JWKS, and
routes two mock "process APIs". The SVC host sits behind a Cloudflare Access
self-hosted app with a service-token (non_identity) policy. Same project and
front Worker as run 1; relay redeployed with module-scope clients. Evidence:
`evidence/run2-2026-11-23T07-02-14-605Z.json` (local only).

| id | check | result |
|---|---|---|
| GW1 | cert + JWT, two process APIs | 200 / 200, `verified: SUCCESS`, subject `CN=lab-edge-function-gw` |
| GW1 | cert, no JWT | 401 (JWT gate) |
| GW1 | JWT, no cert | 403 (mTLS gate, `presented: 0`) |
| GW1 | cert from a CA the gateway does not trust | 403, `verified: FAILED:unable to verify the first certificate` |
| SV1 | Access service token + JWT | 200 |
| SV1 | no service token | 403 (Access block page, HTML) |
| P1 | `createHttpClient({proxy: {url: "http://127.0.0.1:9"}})` | `tcp connect error` - the proxy option is honoured |
| X0-X3 | `HTTPS_PROXY` set as a function SECRET pointing at a dead proxy | secret visible in `Deno.env`, plain `fetch` still 200 direct (3 of 3, 30 s after the set) - the secret does not proxy fetch |
| V1/V2 | X.509 v1 client cert | `invalid peer certificate: ... UnsupportedCertVersion`; next request on the same function answered normally |
| E1 | EC key with explicit curve parameters | hosted: `failed to parse private key as RSA, ECDSA, or EdDSA` (local Deno 2.9.8 said `KeyMismatch`); refused either way |
| H1 | headers the function sees via the front Worker | `cf-connecting-ip: 2a06:98c0:3600::103` (Cloudflare Workers egress), `cf-worker: supabase.co` |
| H2 | headers Postgres sees via the front Worker (`request.headers`) | same address, `cf-worker: supabase.co`, secret header present |
| H3 | headers Postgres sees direct | the client's own address, `cf-worker: supabase.co` |
| H4 | direct with client-set `cf-worker`, `cf-connecting-ip`, `x-forwarded-for`, `x-real-ip` | 403 before reaching PostgREST (one combined request: which header triggered it is not isolated) |

Outbound latency measured INSIDE the function to the gateway (Cloudflare SIN
edge, a few ms away), n=20 each, interleaved:

| client | p50 | p90 | max |
|---|---|---|---|
| module-scope HttpClient, reused | 17 ms | 40 ms | 43 ms |
| new HttpClient per request | 243 ms | 887 ms | 954 ms |

Readings:

- Every user reaches Supabase from one Workers egress address behind a
  Worker, so per-IP limits (Auth) see one client. Not measured here: the
  Auth rate limit itself and `Sb-Forwarded-For`.
- `cf-worker` is `supabase.co` on every request (direct and via the front),
  so it is the platform's own Worker, not a signal that the customer's edge
  was crossed. Gate on a secret header instead (run 1 D1-D4).
- The proxy option works and an `HTTPS_PROXY` secret does not, so a fixed-IP
  forward proxy has to be passed explicitly per client.
- Reusing the client is the difference between ~17 ms and ~240 ms per call.
