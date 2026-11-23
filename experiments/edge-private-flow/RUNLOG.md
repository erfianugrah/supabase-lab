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
Invoked from Singapore. Evidence: `out/2026-11-23/run-2026-11-23T06-41-57-722Z.json`
(redacted by `publish.ts`; all runs tabulated in `out/2026-11-23/facts.md`).

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
`out/2026-11-23/run2-2026-11-23T07-02-14-605Z.json`.

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

## Run 3 + repeats - 2026-11-23 07:24-07:34 UTC (`make full`, clean slate)

Same flow rebuilt from nothing, then runs 1 and 2 repeated after run 3, so
runs 1 and 2 now have three passes each (06:41/07:02 above, 07:27/07:28 and
07:32/07:33 here). Every check in the repeats matched run 1 and run 2. Run 3
adds the gaps a review of runs 1-2 named. Evidence (redacted, `out/2026-11-23/`, facts in `facts.md`): `run3-2026-11-23T07-32-15-132Z.json`,
`run-2026-11-23T07-27-51-750Z.json`, `run-2026-11-23T07-32-56-279Z.json`,
`run2-2026-11-23T07-28-33-036Z.json`, `run2-2026-11-23T07-33-38-999Z.json`.

| id | check | result |
|---|---|---|
| OWN1 | gateway trusting ONLY our own CA (Cloudflare BYO CA on the OWN host): own-CA RSA cert, own-CA named-curve EC cert | 200 / 200, `verified: SUCCESS`, issuer `CN=lab-own-ca` |
| OWN1 | Cloudflare-managed-CA cert / cert from a third CA / no cert | 403 / 403 (`unable to verify the first certificate`) / 403 (`presented: 0`) |
| TUN1 | Cloudflare Tunnel to a local origin (no inbound port) behind Access: service token + user JWT | 200, origin saw `cf-access-jwt-assertion` and validated the JWT |
| TUN1 | service token, no user JWT / no service token | 401 at the origin / 403 Access block page |
| ABR | function forced to us-east-1 calls the relay direct, unpinned | ran in us-east-1 |
| ABR | same caller, through the front Worker (pins ap-southeast-1) | ran in ap-southeast-1 |
| ABR | function forced to eu-central-1: direct unpinned / via front | eu-central-1 / ap-southeast-1 |
| ROT | client cert secret changed rot-a -> rot-b, no redeploy; subject read from the certauth.idrix.fr echo | the first call on each arm after the change already presented rot-b: the new-client-per-call arm at 5 s, the module-scope (reused) client arm at 10 s (seconds counted from just before the secrets POST, so they include its duration; one sample per arm) |

Rotation reading: a reused client did NOT keep the old certificate past a
secret change; the next requests after the change were served with the new
secret, consistent with workers being recycled on a secret update. One
change and one post-change sample per arm (the loop stopped once both arms
showed rot-b), so the window is "by 10 s", not a measured distribution, and
no call between the change and those samples was taken.

Egress addresses seen by the echo server (F3): 56.10.122.236 in the 06:41
pass; 54.179.73.206 in both repeat passes (07:27, 07:32), which ran on the
project rebuilt by `make full` (a different project from 06:41).

The X.509 v1 certificate used by V1 (`certs/v1.crt`, RSA) was signed on
macOS LibreSSL with `openssl x509 -req -in client-rsa.csr -CA ca.crt -CAkey
ca.key -CAcreateserial -days 30 -out v1.crt`, i.e. without `-extfile`;
`openssl x509 -text` reads `Version: 1 (0x0)`.

Reused vs new HttpClient, outbound time measured inside the function to the
gateway on the Cloudflare SIN edge, A/B interleaved per iteration:

| set | n per side | reused p50 / p90 | new client p50 / p90 |
|---|---|---|---|
| run 2 (07:02) | 20 | 17 / 40 ms | 243 / 887 ms |
| run 2 repeat (07:28) | 20 | 14 / 30 ms | 79 / 159 ms |
| run 2 repeat (07:33) | 20 | 24 / 49 ms | 63 / 101 ms |
| run 3 round 1 | 50 | 12 / 35 ms | 76 / 229 ms |
| run 3 round 2 | 50 (49 new) | 12 / 31 ms | 61 / 212 ms |
| run 3 round 3 | 50 | 18 / 60 ms | 62 / 134 ms |

Verdict: reuse was faster in 6 of 6 sets; reused p50 12-24 ms, new-client
p50 61-243 ms, so the gap exceeds the set-to-set spread. Limiter (inferred
from the mechanism, not counted): a new client opens a new TCP + TLS
connection with the client-certificate exchange on every call. Errors: one
new-client call of 210 across the six sets did not return ok (run 3 round 2,
49 of 50; the probe counts only status 200 with the arm ok, so the cause is
not recorded). The gateway is on Cloudflare's SIN edge (reused-client
minimum 10 ms), so only the relative gap transfers to a real upstream;
absolute times depend on where the upstream runs.
