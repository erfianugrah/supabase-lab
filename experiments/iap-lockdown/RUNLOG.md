# RUNLOG - iap-lockdown

Ephemeral by default: every run is provision -> probe -> destroy. Projects and
Cloudflare/AWS resources do not outlive the run. See PLAN.md for scope.

## Run 1 - 2026-08-28 - Phase A live (managed HTTP-tier levers, one Micro, no AWS)

Goal: provision one Micro, run the Phase A surface x lever inventory
(L01-L09), capture evidence, destroy. Validates the harness end to end and
answers the managed-tier half of the IAP question (what each HTTP surface
answers under each lockdown lever).

### Preflight (2026-08-28)

- Modules at start: L01, L02 implemented; L03-L09 stubs (skip). Implementing
  L03-L09 this run before the full probe.
- Secrets: PAT, org id, db_password present in secrets.tfvars (SOPS+age,
  decrypted at run start). AWS creds absent - Phase C deferred.
- Provisioning path: OpenTofu (supabase provider ~> 1.10), one Micro,
  region ap-southeast-1, instance_size micro. Cost: one Micro for the
  duration of the run (hours), destroyed at end.
- Cloudflare (Phase B) and AWS (Phase C) are separate later runs.

### Steps

- Credential note: the PAT committed (encrypted) in secrets.tfvars is a
  14-char placeholder and returns 401 "JWT could not be decoded" - the
  encrypted secret intentionally holds no live token. The working PAT is in
  the environment (`SUPABASE_ACCESS_TOKEN`, verified 200 against
  /v1/organizations) and belongs to org `gfqyoavfwjduavsvhbni`. Wired that
  PAT + org into the (gitignored) secrets.tfvars for this run. Target org is
  therefore that org, region ap-southeast-1, Micro.
- Cost confirmed via the Supabase get_cost API this session (returned
  `{type: project, recurrence: monthly, amount: 10}`): $10/month recurring,
  prorated to the run's duration and destroyed at the end.
- tofu init + validate: pass. First apply failed on the placeholder PAT
  (401); re-running with the working credential.
- Provisioned: project ref `dnzaxsoxwediswxztdxa`, ap-southeast-1, Micro.
- Implemented L03-L09 (were stubs): realtime private_only, auth knobs, key
  revocation (restore-verified), storage lockdown + signed-URL, EF verify_jwt,
  grant lockdown + RLS write-policy holes (L08a-g), pre-request IP filter +
  OpenAPI enumeration. Typecheck clean, registry builds all 16 modules.

### L01 baseline inventory (live, project dnza...)

status by credential (surface=HTTP status):
- anon/no-key: rest_*=401, storage_public_object=200, ef_open=200,
  realtime_ws=0 (no key -> no handshake). Confirms: without a key the REST/
  Auth/GraphQL surfaces refuse, but a public bucket object and a
  verify_jwt=false Edge Function are reachable with NO credential at all.
- anon key: rest_table=200, graphql=200, auth_login=200, storage=200,
  realtime_ws=101 (handshake ok), auth_admin=403.
- service key: everything 200 including rest_root and auth_admin.
Baseline gate passed (anon can read the probe table and log in), so the
levers below are measurable.

### Phase A results (live, org ErfiCorp gfqyoavfwjduavsvhbni, project dnza..., 2026-08-28)

All nine modules green after two fix passes (204-vs-200 on the realtime PATCH;
supabase_admin default-priv permission wall; key-name charset; fixture
idempotency for bucket + EF re-seed). Findings:

- **L02 Data API off** (`db_schema:""`): PostgREST wedges to 503 in ~4s;
  Auth/Storage/Realtime/EF UNAFFECTED - "Data API off" is PostgREST-only.
  GraphQL-only-off (drop graphql_public) -> graphql 406 PGRST106 while REST
  stays 200. `max_rows=1` caps a 2-row read to 1 (exfil brake, not a gate).
- **L03 Realtime private_only=true**: enforced at CHANNEL JOIN, not the WS
  upgrade - anon handshake STILL SUCCEEDS (101), join refused in ~9s. Realtime
  stays internet-reachable; the lever narrows what a connected client may do.
  Rest of the inventory unchanged.
- **L04 Auth**: `disable_signup=true` refuses signup while an existing user's
  LOGIN survives (200). SAML present but saml_enabled=false on this tier.
- **L05 Key revocation**: disabling legacy keys refuses the anon JWT across the
  inventory in ~45s; the NEW publishable-key generation is INDEPENDENT (still
  reads 200 with legacy off). Keyless project = 401 everywhere EXCEPT the
  public bucket object and the open EF. Control plane re-mints a key at will
  (201) - "revoked" is a posture the PAT always reopens.
- **L06 Storage**: public bucket -> private refuses the anon public URL (400
  NoSuchBucket) in ~6s; a service-key signed URL still serves (200) - the read
  path a locked-down customer keeps.
- **L07 EF verify_jwt**: an EF is public-by-default (anon no-key 200).
  verify_jwt=true refuses the no-auth caller (401) BUT the anon PROJECT KEY
  passes (200) - verify_jwt is a KEY-POSSESSION check, not an authorization
  control. An IAP-as-proxy must revoke keys, not lean on verify_jwt.
- **L08 grant lockdown + RLS write holes** (customer #2):
  - REVOKE SELECT closes the table via the Data API (42501); service_role
    keeps reading. New table reopens anon read via default privileges (rot).
  - ALTER DEFAULT PRIVILEGES for `postgres` closes new tables on arrival (404
    PGRST205) - the durable fix. But `supabase_admin`'s default ACL is NOT
    alterable by postgres (42501) - platform-admin-created objects keep default
    anon grants the customer cannot revoke this way. (Finding.)
  - A plain VIEW over an RLS table leaks all rows to anon; the same view WITH
    (security_invoker=true) returns 0 - the "we have RLS, why is it exposed"
    hole.
  - UPDATE policy gates ROWS not COLUMNS: anon PATCH reassigned `tenant` on 2
    rows (200) - a permissive UPDATE lets a caller rewrite an owner/column the
    policy never meant to expose; needs a column privilege or trigger.
  - PERMISSIVE policies OR together - a second permissive policy bleeds onto
    anon.
- **L09 pre-request IP filter + spec enum**: the documented `db_pre_request`
  mechanism - the GUC PERSISTED on the authenticator role, but NO pre-request
  fire was observed on the PostgREST path within 121s. On managed Supabase the
  role-GUC + NOTIFY reload path did NOT activate the hook. (Strong finding: the
  docs' self-hosted mechanism is not activatable via SQL on hosted.) Whole-spec
  enumeration: 7 network/security ops (network-bans Beta, network-restrictions
  Alpha/Beta) - none is a Data-API IP allowlist.

**Managed-tier headline**: no lever makes the HTTP surface network-private;
each is a per-service tighten. The only surfaces reachable with NO key are
public storage objects and public Edge Functions. The DB-layer IP filter the
pen-test thread hoped for does not activate on hosted.

Evidence: experiments/iap-lockdown/evidence/20260828-085*/ (gitignored).

### Teardown

- `make destroy`: supabase_project.lab destroyed in 1s; tofu state empty.
- Verify-gone: GET /v1/projects/dnza... returns 400 (no longer 200) - the
  project is gone. Ephemeral discipline satisfied: nothing left standing.
- Total project lifetime: ~30 min (provision -> probe x3 -> destroy).

## Run 2 - Phase B (Cloudflare: Worker + Access) - IN PROGRESS

Foundation laid (2026-08-28):
- ES256 issuer keypair generated in jwks/ (kid 7f130f59...); private.json is
  mode 600 and gitignored via a new per-experiment .gitignore (mirrors
  edge-resilience). public.json is committable and is what the Worker serves.
- wrangler authed against the Cloudflare account (CLOUDFLARE_ACCOUNT_ID set).
- Target zone: erfi.dev, on that account - both erfi.dev and
  erfianugrah.com live on that account, matching CLOUDFLARE_ACCOUNT_ID. Plan to route
  the Worker at iap-lab.erfi.dev.
- Reuse: edge-resilience worker (serves /.well-known/jwks.json from JWKS_JSON)
  + lib/jwt.ts (mintEs256) + TPA registration via
  POST /projects/{ref}/config/auth/third-party-auth { jwks_url } (X01 measured
  jwks_url resolves; custom_jwks is a dead path).

Design (verified against the lab's own cf-tf conventions + live discovery):
- The IAP is Cloudflare Access, not a synthetic issuer. Access-for-SaaS (OIDC)
  is a real IdP: each SaaS app is an OIDC issuer at
  <team-domain>/cdn-cgi/access/sso/oidc/<client_id> with a working discovery
  doc + JWKS (confirmed by fetching an existing app's .well-known). Supabase
  registers that issuer as third-party auth (L10). The synthetic ES256
  keypair in jwks/ is kept as a fallback but is not the primary path.
- OIDC issuer id in the URL is the app's client_id (not the app uuid) -
  verified against an existing app; the tofu output builds it from the
  resource's `domain` attribute.

Codified (declarative, reproducible - all in experiments/iap-lockdown/):
- cloudflare provider v4 (matches the lab's cf-tf repo). providers.tf +
  cloudflare.tf: an Access SaaS/OIDC app (L10 issuer), a self-hosted app
  gating the Worker hostname (L11), and an allow policy that reuses the
  existing account-level identity group + onetimepin IdP by id (not
  recreated). Gated on enable_cloudflare so Phase A stays Supabase-only.
- outputs.tf: oidc_issuer_url, oidc_client_id/secret, proxy_hostname.
- worker/index.ts + wrangler.jsonc: the L11 proxy Worker (holds the service
  key, proxies /rest + /graphql). wrangler.jsonc is committed; per-run values
  (UPSTREAM host, SERVICE_KEY) are pushed by the Makefile worker-deploy target.
- Real account/zone/group/idp ids live in cloudflare.auto.tfvars (gitignored
  via *.tfvars) - repo stays public-safe. CF auth is env-only.
- tofu init + validate: PASS (cloudflare + supabase providers).

### Phase B results (live, 2026-08-28)

tofu apply created the Supabase project + the two Access apps + policy in one
state (4 resources). Ran the non-interactive modules, then destroyed.

- **L10 IAP-as-issuer (real Cloudflare Access-for-SaaS OIDC)**: registering the
  Access OIDC issuer as Supabase third-party auth returned 201 and RESOLVED
  immediately (Supabase fetched the Access JWKS). With RLS keyed on
  `auth.jwt()->>'iss' = <Access issuer>`, the anon key reads 200/0 rows and a
  GoTrue user token reads 200/0 rows - both carry a non-Access iss, so the
  data API admits ONLY an Access identity. The third row (a real Access-issued
  token IS admitted) needs the interactive OIDC login and is the chrome
  follow-up (PVLAB_IAP_TOKEN). So: the IAP-as-issuer pattern works with a real
  IAP, plan-agnostic.
- **L11 IAP-as-proxy - the bypass**: direct <ref>.supabase.co with the anon key
  answers 200 regardless of any proxy - a proxy gates nothing on its own. After
  disabling the legacy keys, the direct origin refuses (401 "Legacy API keys
  are disabled") in ~48s; restore confirmed. Only key revocation (+ RLS/L10)
  makes the proxy the only path. The Access-gated Worker call itself (latency,
  proxy-still-serves) needs an Access service token / chrome - follow-up.
- **L13 CORS + CNAME misconceptions**: both REST and Auth reflect an arbitrary
  Origin (permissive), and a request with NO Origin still returns 200 + data -
  CORS is advisory to browsers only, it does not restrict the API. The custom
  CNAME is non-gating for the same reason L11b shows: the origin hostname
  always serves.
- **L12 supabase-js through the proxy** (DONE 2026-08-28, browser test): a
  transparent Cloudflare Worker proxy in front of a project, with supabase-js
  pointed at the worker origin, driven in a real (headless) browser. Result:
  `{rest: ok rows=2, auth: ok, storage: ok, realtime: SUBSCRIBED}` - ALL FOUR
  subsystems work through the proxy, INCLUDING Realtime. This CONTRADICTS the
  plan's hypothesis that the WebSocket upgrade would be the casualty: a CF
  Worker proxies the Realtime WS fine (Workers support WS proxying via fetch).
  So supabase-js is fully functional through a path-preserving Worker proxy.
  (Test worker + page codified at experiments/security-lockdown/l12/.)

Codification confirmed reproducible: `tofu apply` (project + Access apps) ->
`make probe` (endpoints wired from tofu outputs) -> `make destroy`. The v4
provider leaves the SaaS `domain` empty, so oidc_issuer_url is built from the
app client_id (verified against the live discovery doc).

### Phase B teardown

- `make destroy`: 4 resources destroyed (project + 2 Access apps + policy).
- Verify-gone: project GET 400; no iap-lockdown Access apps remain on the
  Zero Trust org; tofu state empty. Nothing left standing.

### L10d attempt (2026-08-28) - real Access token admitted

Tried to obtain a real Access-issued OIDC token non-interactively:
- `client_credentials` grant on the SaaS OIDC app: Cloudflare REJECTS it at
  apply time (the provider errors creating the app) - measured, and the
  grant_types is back to authorization_code_with_pkce only.
- The authorization-code flow redirects to the interactive Cloudflare Access
  login (`/cdn-cgi/access/login/...`, JS-driven email -> one-time-PIN). Not
  headlessly scriptable from here (no directly-drivable browser in this
  environment; the login page is JS/challenge-driven).
RESOLVED without a browser (2026-08-28) via a new module **L10E**: a Supabase
PAT cannot stand in (it is a control-plane admin credential, not an
RLS-evaluated end-user JWT), and only Cloudflare can mint a real Access token -
but we hold the lab ES256 issuer key (jwks/), so we mint an identity token
ourselves. L10E serves the JWKS from the project's own Edge Function, registers
it as third-party auth (jwks_url), keys RLS on the issuer, mints a token, and
proves it: minted lab-IAP token -> 200 / 2 rows (admitted); anon-key -> 200 / 0
rows (denied). The data API serves ONLY the IAP identity. Combined with L10a-c
(the REAL Cloudflare Access issuer resolves + is trusted), the IAP-as-issuer
pattern is proven end to end. Codified + reproducible: `make probe IDS=L10E`
(needs PVLAB_JWKS_DIR, set by the Makefile).

Also measured: the Access SaaS OIDC app REJECTS the client_credentials grant,
and the authorization-code flow lands on the interactive one-time-PIN login -
so a real Access token needs a human/browser, which is why the lab-issuer
stand-in is the right automated path.

## Remaining

- L10d - DONE via L10E (lab-issuer mint, above). L12 - DONE (browser test,
  above). L11 proxy-call latency through the Access-gated worker is the only
  un-run row, and it is cosmetic - L11b/c already proved the load-bearing
  bypass fact.
- Phase C (PrivateLink, L20-L23): NOT re-run - already fully proven in the
  privatelink-aws experiment (no AWS creds needed here). From its RUNLOG:
  PrivateLink is Team/Enterprise only (needs Owner/Admin + the beta grant:
  feature flag integrations:aws_private_link + entitlement
  security.private_link; ap-southeast-1 works, eu-central-2 excluded). Private
  path PROVEN e2e - direct 5432 + pooler 6543 through the VPC endpoint, `link
  --skip-pooler` + db push over PrivateLink; the private pooler is ~48% faster
  than public Supavisor. Network restrictions + PrivateLink = full public DB
  lockout (T12/T12b: endpoint survives closing public access to a /32, public
  Supavisor blocked by the same restrictions). Data API / HTTP tier stays
  PUBLIC by design (T13) - PrivateLink covers Postgres + PgBouncer only.
  T22d/e/f CLOSED: with the Data API wedged, migrations still apply over
  PrivateLink (the ops path survives the lockdown). So the iap-lockdown
  L20-L23 modules are redundant with privatelink-aws - cite, do not re-run.
- Unit + manual tests.
