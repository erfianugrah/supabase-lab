# experiments/iap-lockdown - PLAN

Status: planned, not yet provisioned. Nothing in this directory has run.

## The question under test

A customer asked (paraphrased, generalised): can an Identity-Aware Proxy sit
in front of their Supabase projects so nothing is publicly reachable except
through the proxy, and does the answer change on Enterprise?

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
  measured both ways. One statement per claim, all reversible.
- L09 prerequest-hook-probe: whether any published Management API surface
  configures a Postgres-side pre-request hook for PostgREST (headers or
  otherwise), and whether `current_setting('request.headers')` is readable
  in SQL on a managed project. Recorded as an inventory of what exists,
  not an assertion about what a hook could do - whether the edge overwrites
  or appends a spoofable forwarding header is platform internals and is
  NOT lab-testable, so that question stays open by construction.

### Phase B - IAP integration (Cloudflare: Worker + Access)

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
- L13 custom-domain: activate a custom domain; measure the origin hostname
  still serving (the CNAME-as-gate misconception, settled with evidence).
  Attempt CF proxying in front of the custom hostname and record cert /
  verification behaviour.

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
- D2 lexicanum reference doc (generalised, no customer detail).
- D3 short answer text for the sales thread, backed by evidence ids.

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
