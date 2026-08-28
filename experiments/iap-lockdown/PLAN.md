# experiments/iap-lockdown - PLAN

Status: Phase A (L01-L09) and Phase B (L10/L11/L13) run live 2026-08-28 and
torn down - see RUNLOG.md for results. Remaining: the chrome-driven Access
login (L10d, L11 proxy call, L12), Phase C (PrivateLink, needs the Team-tier
org), and broader security dimensions beyond the IAP framing (network
restrictions applied, security advisors, auth hardening).

## The question under test

The question (generalised): can an Identity-Aware Proxy sit in front of
Supabase projects so nothing is publicly reachable except through the proxy,
and does the answer change on Enterprise?

The question splits into two surfaces with different answers:

- The Postgres socket (5432 direct, 6543/5432 pooler). Lockable today:
  PrivateLink plus "Restrict all access" network restrictions.
- The managed HTTP tier on `<ref>.supabase.co`: Data API (REST + GraphQL),
  Auth, Storage, Realtime, Edge Functions. No network-level lockdown exists
  on any plan; the available levers are per-service disable/tighten controls
  plus key management plus RLS.

Prior measured work this experiment builds on (do not re-measure, cite):

- `privatelink-aws`: PrivateLink association, VPC Lattice endpoint, PHZ,
  measured latency and pgbench deltas, network restrictions to a /32,
  dashboard-only association.
- `http-tier-lockdown` T22/T23: Data API "off" is `db_schema: ""` (a wedged
  PostgREST serving 503 PGRST002, gateway still answering 401 at `/rest/v1/`);
  the Dashboard toggle is the same lever and its round-trip is LOSSY (drops
  every schema but `public`); Realtime `private_only` is an authorization
  control (handshake still succeeds).
- `platform-downtime`: network restrictions do not touch the HTTP tier; they
  do reach the pooler (Supavisor enforces the allow-list).
- `edge-resilience` W01/W07: TPA JWKS trust mechanics, jwt skew, break-glass
  minting; `rls-wire-claims` C01/C02: claims-driven RLS without GoTrue, via
  TPA and wire GUCs.

## What stays open (this experiment's scope)

1. A complete surface x lever matrix, measured: after each lockdown lever is
   applied, what does each HTTP endpoint answer to an anonymous caller, to an
   anon-key caller, and to a service-key caller? Today we have point findings
   (T22, T23), not an inventory.
2. The IAP-as-issuer pattern: register the IAP's JWKS as third-party auth,
   key RLS on IAP claims, and measure that the data API then serves only
   requests carrying IAP identity. This is the authz-layer version of "IAP
   over the data APIs", and it is plan-agnostic.
3. The IAP-as-proxy pattern: a Cloudflare Worker behind Cloudflare Access
   validating the Access JWT and holding the service key server-side, with
   supabase-js pointed at the proxy. The measurement that matters: the
   bypass. The origin hostname keeps answering anyone holding a key, so the
   proxy only becomes a real gate when combined with key revocation and RLS.
4. The fully-locked end state: PrivateLink + restrict-all + Data API off +
   backend-holds-the-connection, verified from inside the VPC (the open
   T22d/e/f question from http-tier-lockdown) and inventoried from outside.
5. The claimed Edge Functions side effect under network restrictions (EFs
   lose direct DB access, fall back to the HTTP API) - asserted in a support
   answer, never measured here.
6. The custom-domain misconception, measured: a custom CNAME gates nothing
   because the origin hostname keeps serving.
7. The Enterprise axis, stated plainly ("possible on Enterprise?"). For the
   managed multi-tenant tier the HTTP answer is plan-independent: no network
   lockdown on any plan (Free..Enterprise). BYOC (the whole stack in your own
   VPC) and self-hosting are the genuine "private HTTP tier" answers, and both
   are outside what this lab can provision. The deliverable must still carry a
   BYOC row and a self-host row or it is silent on that axis.
8. The CORS surface, measured and de-mythologised. PostgREST honours an
   `Origin` (its CORS config is undocumented); Auth implements no CORS at
   all. Either way CORS is browser-only and gates nothing against a
   non-browser client - the misconception twin of the CNAME - but the
   PostgREST-yes / Auth-no asymmetry is a real fact worth recording.
9. "Private by default" as literally asked: every lever here is opt-in
   AFTER provisioning. A managed project is fully public from creation
   until a lever is applied; nothing makes it private at birth. That is the
   honest answer to "private by default" and it is a finding, not a lever.

## Phases and modules

Module ids use the L prefix. `where`/`requires` per harness contract.

### Phase A - surface inventory and hosted levers (one Micro, no AWS)

Self-provisioning (W21/rls-wire-claims pattern), Pro org, no tofu.

- L01 baseline-inventory: anonymous + anon-key + service-key probes against
  `/rest/v1/`, `/rest/v1/<table>`, `/graphql/v1`, `/auth/v1/health`,
  `/auth/v1/token`, `/storage/v1/bucket`, `/storage/v1/render/image/...`,
  Realtime WS handshake + join, one deployed Edge Function, hostname root.
  Records status + auth requirement per surface. This is the table every
  later module diffs against.
- L02 data-api-off-inventory: PATCH `db_schema: ""`, wait to effect, re-run
  the L01 inventory, restore. Superset of T22: adds Storage, Realtime, EF
  rows. (T22 covered REST/GraphQL/root only.)
- L03 realtime-private-only: re-run of T23 semantics inside the inventory.
- L04 auth-surface-knobs: `disable_signup`, email provider off, anonymous
  sign-ins off, phone off, via `PATCH /v1/projects/{ref}/config/auth`.
  Measures what remains issuable: signup refusal vs login for an existing
  user. Records whether SSO/SAML config exists on this plan tier.
- L05 key-revocation: mint publishable/secret keys, revoke the legacy
  anon/service_role pair, re-run the inventory with each key class. Records
  what a keyless project answers, and that the Management API can re-mint
  (control plane always re-opens; that is a governance fact, not a defect).
- L06 storage-lockdown: all buckets private, no public flags; anonymous and
  anon-key read/write/render attempts; signed URL still works.
- L07 ef-verify-jwt: deploy the same function with verify_jwt false and
  true; measure 401 shape and propagation delay.
- L08 grant-lockdown: the grant-layer alternative to RLS, on the same
  project. (a) `REVOKE SELECT ON <table> FROM anon, authenticated` closes
  the table through the Data API while service_role keeps reading
  unchanged. (b) The reopen path: `pg_default_acl` ships SELECT on new
  tables to anon/authenticated/service_role, so a bare REVOKE is undone by
  the next `CREATE TABLE`; measure that `ALTER DEFAULT PRIVILEGES ...
  REVOKE` is what makes the lockdown survive new migrations. (c) The
  pen-test shape: a view over an RLS-enabled table returns every row to
  anon unless the view is created `WITH (security_invoker = true)` -
  measured both ways. One statement per claim, all reversible. Two more
  write-policy holes that make "we added RLS" still fail a pen test,
  measured on the same project (L08f/L08g): an UPDATE-permitted role can
  rewrite a column the policy never meant to expose - e.g. reassigning a
  row's foreign-key owner / tenant id - unless a trigger, CHECK, or
  column-level privilege constrains which columns change; and a PERMISSIVE
  policy written for one role silently applies to others (PERMISSIVE
  policies OR together), so a relaxed admin policy can bleed onto anon.
  These are RLS-correctness edges, not network levers, but they are the
  shape of a real "we added RLS but a pen test still found data" exposure.
- L09 prerequest-ip-filter + spec enumeration. The DB-layer pre-request
  filter is NOT absent - it is a documented PostgREST mechanism (Source:
  /docs/supabase/guides/api/securing-your-api.md and
  /docs/supabase/guides/database/debugging-performance.md): set
  `pgrst.db_pre_request` to a function that reads
  `current_setting('request.headers')` (which carries `x-forwarded-for`)
  and RAISEs to reject. Measure it end to end on the actual PostgREST path,
  not just via /database/query: (a) the function fires on a `/rest/v1/`
  call; (b) it can read the forwarding header and reject a chosen value
  with a chosen status/hint; (c) its cost - a pre-request function runs on
  every request, and a filter that writes (rate-limit/IP-ban bookkeeping)
  forces a write per request; measure whether it works at all against a
  read replica (claimed not to). The one part that stays open by
  construction: whether the edge overwrites vs appends a client-supplied
  `x-forwarded-for` before PostgREST sees it. If it appends, the filter is
  spoofable and is not an allowlist - platform-internal, not lab-testable.
  Then the F05-method whole-spec enumeration of the /v1 OpenAPI for any
  network/restriction/allowlist/ip/private operation, so "no built-in IP
  allowlist for the Data API" is stated across the whole spec, not guessed.

### Phase B - IAP integration (Cloudflare: Worker + Access)

IdP dependency: no self-hosted identity provider (Authentik etc.) is
required or useful. L10 needs a PUBLICLY REACHABLE JWKS - Supabase's control
plane fetches it to resolve the TPA integration, so a localhost IdP cannot
work, and inline `custom_jwks` is a measured dead path (cross-project-auth
X01: accepted, never resolves). Use the edge-resilience pattern: local
ES256 keygen + a small Worker serving `/jwks.json` (or a
`/.well-known/openid-configuration` for the `oidc_issuer_url` shape, which
resolves fastest). L11 uses real Cloudflare Access as the IAP (already
available; publishes a JWKS, injects `Cf-Access-Jwt-Assertion`). A
self-hosted IAP would add no Supabase-side evidence and would still need to
be tunnel-exposed.

- L10 tpa-iap-issuer: lab ES256 issuer (reuse edge-resilience `lib/jwt.ts`
  + `scripts/keygen.ts`) standing in for the IAP's identity; register via
  `oidc_issuer_url`; RLS keyed on the IAP claim (rls-wire-claims C01/C02
  pattern). Assert: anon denied, GoTrue-issued user token without the IAP
  claim denied, IAP-claim token allowed. Also assert GoTrue signup disabled
  (L04) plus TPA gives "identity only via the IAP's IdP".
- L11 worker-access-proxy: Worker fronted by Cloudflare Access; worker
  validates `Cf-Access-Jwt-Assertion` against the Access certs endpoint,
  injects the service key from a Worker secret, proxies to REST. gocurl the
  added latency (p50/p95). The load-bearing row: direct-origin bypass with
  the anon key still answers, proving the proxy gates nothing on its own.
  Then L05-style key revocation + RLS and re-measure the bypass as closed.
- L12 supabase-js-behind-proxy: supabase-js pointed at the worker URL for
  rest/auth/storage/realtime. Records which subsystems survive path-prefix
  proxying (Realtime WS upgrade is the expected casualty) and which need
  per-client overrides.
- L13 custom-domain + CORS: activate a custom domain; measure the origin
  hostname still serving (the CNAME-as-gate misconception, settled with
  evidence). Attempt CF proxying in front of the custom hostname and record
  cert / verification behaviour. Same misconception family - the CORS
  surface: measure that PostgREST honours an `Origin` header (its CORS
  config is undocumented) while Auth implements no CORS at all, and that
  both are browser-only, so a non-browser client (curl) ignores CORS
  entirely and it gates nothing. Record the PostgREST-yes / Auth-no
  asymmetry as a fact and "CORS locks my API" as the misconception.

### Phase C - network lockdown (AWS, reuse privatelink-aws tofu)

Requires the Team org with the PrivateLink entitlement and an AWS VPC in the
project region. Reuses `privatelink-aws` lattice/vpc/runner/lambda .tf as-is
where possible; this experiment adds its own state dir.

- L20 locked-private-path: PrivateLink up, network restrictions at
  restrict-all, Data API off. From the VPC runner: DB connects on 5432 and
  6543 over the endpoint (closes the T22d/e/f gap). From outside: the L01
  inventory shows exactly which HTTP surfaces still answer.
- L21 backend-holds-connection: Lambda in the VPC runs the only data query;
  invocation fronted by an IAM/sigv4 or Access-gated URL. Measures the real
  "Supabase as database only, IAP in front" architecture end to end.
- L22 ef-under-restrictions: Edge Function holding a direct postgres-driver
  connection, before and after restrict-all. Records the failure mode and
  whether the documented supabase-js-over-HTTP fallback is what actually
  happens.
- L23 control-plane-stays-public: api.supabase.com and Studio reachable
  throughout; recorded as a scope boundary of any "private by default"
  claim.

### Phase D - synthesis

- D1 surface x lever x plan-tier x evidence-id matrix (markdown, in-repo).
  Must include a BYOC row and a self-host row (docs-backed, not lab-run) so
  the plan-tier axis is complete and the Enterprise answer is explicit:
  managed-tier rows carry lab evidence ids, the BYOC/self-host rows carry
  doc citations. Without them the matrix is silent on "Enterprise?".
- D2 lexicanum reference doc (generalised, no customer detail).
- D3 short answer text, backed by evidence ids.
- Scope boundary to name, not solve: RLS write-policy correctness (UPDATE
  column scope, PERMISSIVE bleed, SELECT-logic reused across DELETE/UPDATE)
  is a distinct problem from network/proxy lockdown - L08f/L08g touch its
  surface but a real RLS-policy test harness belongs in its own experiment.
  Flag it in D2 as future work so the reader knows the gap is known.

## Docs to re-check at execution time (platform moves)

- PrivateLink, Network Restrictions, Securing your Data API, Custom Domains
  (docs.erfi.io `supabase` source) - confirm no new private-HTTP lever has
  shipped since 2026-08; any answer quoting the absence of one must be
  re-measured, not re-quoted.
- The published /v1 OpenAPI spec, enumerated whole (platform-facts F05
  method) for any new network/security operation.
- Cloudflare Access docs for the JWT validation surface.

## Lifecycle and teardown (ephemeral by default)

Every resource in this experiment is OpenTofu- or Wrangler-managed and MUST be
destroyed as soon as its probes finish. Nothing is left standing between runs:
a run is provision -> probe -> destroy in a single invocation, and the destroy
runs even when the probes fail (trap / one-shot target, not a manual follow-up
step). The goal is a clean account after every run, not a lab full of paused
Micros and orphaned Workers.

- Phase A (tofu): one Micro. `make apply && make probe && make destroy` collapses
  into a single ephemeral target so the project never outlives the run. Destroy
  is trapped: a failed probe still tears the project down. Because L02/L05/L08
  each mutate the one shared project globally (schema wedge, legacy-key disable,
  grants), a crash mid-lever can leave it wedged - teardown by full project
  delete, not by config-restore, is what guarantees the next run starts clean.
- Phase B (wrangler + tofu): the Worker, its secrets, the Cloudflare Access
  application + policy, and any custom domain / DNS record are NOT in tofu state.
  They leak silently if teardown only runs `tofu destroy`. Teardown MUST also
  `wrangler delete` the Worker (and its secrets/routes), remove the Access app
  and policy, and unbind the custom domain. Free-tier cost is zero, but a
  lingering Access-fronted Worker holding a service key is a standing exposure,
  which is the whole point of the experiment - so it comes down with everything
  else.
- Phase C (tofu + AWS): VPC/Lattice/Lambda/runner. Highest-cost footprint;
  destroyed via `make destroy` plus `suite-clean` (the S3 suite bucket is
  orchestration state tofu does not track) in the same run. Never left overnight.

Verify-gone, not assume-gone (lab ethos): after teardown, assert the project ref
returns 404 from the Management API and the Worker URL / custom hostname stop
resolving. A destroy that "returned 0" is not evidence the thing is gone; the
404 is. Record it as the run's final line.

## Open questions for the operator

1. Which IAP flavour to privilege in Phase B: Cloudflare Access (available
   on the lab CF account) versus a generic OIDC assertion. L10 is
   flavour-agnostic by construction (JWKS); L11 is Access-specific.
2. AWS and Cloudflare accounts are available, so Phases B and C are
   executable now; spend is bounded by the ephemeral lifecycle (provision ->
   probe -> destroy in one run), not gated on separate approval. The only
   still-blocked path is BYOC, which needs Supabase-side enablement rather
   than a self-served AWS account.
3. Whether the deliverable includes the lexicanum doc in this pass or a
   follow-up.
4. Whether the edge layer overwrites (vs appends) a client-supplied
   forwarding header before PostgREST sees it - the answer decides whether
   any header-based pre-request check could be an allowlist. Not
   answerable from the lab; needs someone with platform-internal access.

## Loop usage

Module implementation is a candidate for a local-model self-correcting loop
(sensors: `bun run build` + registry gen + a `pvlab` plan listing of the L
ids, plus `bun test` on any harness changes). Live probes stay operator-run:
they spend money and touch the shared orgs.
