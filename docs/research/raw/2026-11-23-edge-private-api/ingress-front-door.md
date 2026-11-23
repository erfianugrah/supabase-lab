# Putting a customer-owned edge (WAF, rate limit, bot, DDoS) in front of hosted Supabase, and stopping bypass

Raw notes, 2026-11-23. Scenario: a mobile/web app backend on hosted Supabase
(AWS ap-southeast-1). A security review wants app traffic to pass through the
app owner's own edge (WAF, rate limiting, bot protection, DDoS) and, ideally,
the project to be unreachable except through that edge. The question as asked:
"Cloudflare Workers in front, mTLS to Supabase".

Taken as known (verified earlier, not re-researched here): network
restrictions cover Postgres and the pooler only; `<ref>.supabase.co` stays
reachable after a custom domain is added; hosted PostgREST `db_pre_request`
does not fire; `request.headers` is readable from SQL; Edge Functions run
caller-nearest unless pinned with `x-region` / `forceFunctionRegion`.

Labels: **verified-from-source** = quoted from the vendor page or measured in
this lab (run named); **inferred** = reasoning from verified pieces, not
measured; **untested** = open.

## 0. Prior lab evidence that already answers parts of this

From `AGENTS.md` in this repo (re-read 2026-11-23):

- iap-lockdown L11 (2026-08-28): "direct <ref>.supabase.co with the anon key
  answers 200 regardless of any proxy - a proxy gates nothing on its own.
  After disabling the legacy keys, the direct origin refuses (401 "Legacy API
  keys are disabled") in ~48s ... Only key revocation (+ RLS/L10) makes the
  proxy the only path."
- iap-lockdown L12 (2026-08-28, browser): transparent Cloudflare Worker proxy,
  supabase-js pointed at the Worker origin: `{rest: ok rows=2, auth: ok,
  storage: ok, realtime: SUBSCRIBED}`. A Worker proxies the Realtime WebSocket
  when it forwards the whole path (the path-prefix `/rest`+`/graphql` proxy in
  the closeout run did not carry the WS upgrade).
- iap-lockdown L10/L10E: third-party auth as the gate. RLS keyed on
  `auth.jwt()->>'iss'` admitted only tokens from the registered issuer
  (Cloudflare Access OIDC issuer resolved; a lab ES256 issuer admitted 2 rows,
  anon 0 rows).
- iap-lockdown L13: REST and Auth reflect any Origin; a request with no Origin
  still gets 200 + data. CORS does not restrict the API.
- iap-lockdown: "The only surfaces reachable with NO key are a public storage
  object and a `verify_jwt=false` Edge Function." L07: `verify_jwt` is a
  key-possession check (the anon key passes).
- iap-lockdown L05: disabling legacy keys 401s the anon JWT in ~45 s, but new
  publishable keys can be minted at will from the control plane.
- http-tier-lockdown / L02: "Data API off" wedges PostgREST (503 PGRST002);
  Auth, Storage, Realtime, Edge Functions unaffected. Realtime `private_only`
  is enforced at channel join, not at the WS upgrade.
- security-lockdown S16: `request.headers` on managed PostgREST carries
  `cf-connecting-ip`, `cf-ew-via`, `cf-ipcountry`, `x-forwarded-for`,
  `x-forwarded-proto`. S22a: a client-supplied `cf-connecting-ip` gets 403 at
  the edge. S25: Storage RLS sees `request.headers`; a `storage.objects`
  policy on `cf-connecting-ip` gave 200 on match, 400 `NoSuchKey` otherwise.
  S25: `sb_secret_` key with a browser User-Agent -> 401; with curl UA -> 200.
- security-lockdown S04/S05/S20: nginx `limit_req` and an XFF filter work
  only when the origin is closed to everything but the proxy (self-hosted
  PostgREST). "The filter is an allowlist only when PostgREST is reachable
  from nowhere but the edge - a deployment property."
- hostname-path HP03d/HP04 (2026-10-10): with a custom domain active, the
  OAuth `redirect_uri` is `<custom host>/auth/v1/callback` whichever host the
  client entered at; the access token `iss` stays `<project host>/auth/v1`.
  HP05: supabase-js builds every URL (signed URLs included) from the base URL
  it was given; Storage sign responses carry no hostname.
- Lab custom-domain DNS was always written DNS-only (`proxied: false`,
  `experiments/hostname-path/lib/cfdns.ts`): a proxied (orange-cloud) CNAME in
  front of a Supabase custom domain has never been run here.

## 1. Does Supabase verify client certificates (mTLS) on the API edge?

- Supabase docs, TLS for project APIs:
  https://supabase.com/docs/guides/security/tls
  > "These settings apply to your project's default domain,
  > `<project_ref>.supabase.co`, and to custom domains. It covers every service
  > on that domain: Auth, the Data API, Storage, Realtime, and Edge Functions."
  The page lists TLS versions and cipher suites only; no client-certificate
  option.
- Supabase docs, custom domains:
  https://supabase.com/docs/guides/platform/custom-domains
  > "Your custom domain supports the same TLS versions and cipher suites as
  > your project's default domain." No mTLS / client-cert setting. Also: "You
  > can only attach a single custom domain to any given Supabase project" and
  > "The Supabase project domain continues to work and serve requests".
- The only client-certificate field in the Supabase docs mirror is outbound,
  for Log Drains: https://supabase.com/docs/guides/observability/log-drains
  > "Client Certificate - PEM-encoded client certificate for mutual TLS (mTLS)"
- GitHub: `gh search issues --repo supabase/supabase` for "mTLS", "mutual TLS"
  returned 0 issues; "client certificate" returned 3 unrelated issues. Web
  search for discussions found only
  https://github.com/orgs/supabase/discussions/18710 (Postgres server CA,
  not client certs) and an Answer Overflow thread about presenting a bank's
  client cert FROM an Edge Function (outbound):
  https://www.answeroverflow.com/m/1407359757743947786
- Measured 2026-11-23 (one handshake each, `openssl s_client` against a live
  ap-southeast-1 project host, TLS 1.2 and 1.3): "No client certificate CA
  names sent", no "Requested Signature Algorithms" line, i.e. no
  CertificateRequest from the edge. Response headers `server: cloudflare`,
  `cf-ray: ...-SIN`; host resolves to Cloudflare anycast addresses.

Reading: no documented or observed inbound mTLS on the project API edge.
Default: none (doc-checked + one handshake). Not ruled out: a per-account
enterprise arrangement; nothing found that suggests one.

### Is the custom domain Cloudflare for SaaS?

- The CLI's recorded `GET /v1/projects/{ref}/custom-hostname` response wraps a
  Cloudflare v4 envelope (`errors`, `messages`, `success`, `result` with
  `custom_origin_server`, `ownership_verification`, `ssl.validation_records`):
  https://github.com/supabase/cli/tree/main/apps/cli-e2e/fixtures/recorded (the `GET_v1_projects_..._custom_hostname` recorded response)
- Lab comment, `experiments/hostname-path/lib/cfdns.ts`: "the custom hostname
  is served by Cloudflare for SaaS on the platform's account".
- Inferred (strong): custom domains are Cloudflare for SaaS custom hostnames.
  Supabase's public docs do not say so.

### Orange-to-Orange (customer's proxied Cloudflare zone in front of the Supabase custom domain)

- Cloudflare, How O2O works:
  https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/how-it-works/
  > "O2O is a specific traffic routing configuration where traffic routes
  > through two Cloudflare zones" ... "the settings configured in your
  > Cloudflare zone will be applied to the traffic first, and then the
  > settings configured in the SaaS provider's zone".
  > "Cloudflare sets the HTTP header `cf-connecting-o2o: 1` on requests
  > entering the SaaS provider's zone."
  The page names no provider opt-in and no plan requirement.
- Cloudflare, O2O product compatibility:
  https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/product-compatibility/
  Customer-zone "Yes": WAF managed rules, WAF custom rules, Bot Management,
  API Shield, Access, Rate Limiting (Yes*), Workers (Yes*). "No": Load
  Balancing, Origin Rules, Spectrum, WebSockets (the row is the customer
  zone's WebSockets setting; whether Realtime's upgrade passes in O2O is
  untested).
- Cloudflare provider-guides index lists BigCommerce, HubSpot, Kinsta, Render,
  Salesforce Commerce Cloud, Shopify, Webflow, WP Engine; Supabase is not
  listed: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/provider-guides/
- Cloudflare error 1014:
  https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1014/
  > "A DNS CNAME record points between domains in different Cloudflare
  > accounts." Fix: "the domain owner of the CNAME target must use Cloudflare
  > for SaaS".
- Community 1014 reports with Supabase:
  - Answer Overflow thread "Error 1014: CNAME Cross-User Banned with custom
    domain through Cloudflare" (title only; page returned HTTP 429 twice):
    https://www.answeroverflow.com/m/1425172247324135454 . A search snippet
    of it says Supabase's setup tells users to disable the proxy when
    Cloudflare is their DNS; not confirmed from the page itself.
  - velog post, 2026-02-15: a CNAME to the Supabase project host without the
    custom-domain add-on gave 1014; author chose a Worker proxy instead:
    https://velog.io/@jihwankim128/cloud-flare-1014-우회
- Supabase docs do not mention proxy status / orange cloud at all (custom
  domains page above; 1016 troubleshooting page
  https://supabase.com/docs/guides/troubleshooting/cloudflare-origin-error-1016-on-custom-domain-a57af4
  is about certificate re-verification only).
- Third-party (unofficial) tutorial advising DNS-only:
  https://rapidevelopers.com/supabase-tutorial/how-to-connect-supabase-to-a-custom-domain

Reading: O2O is a Cloudflare mechanism that should apply to any Cloudflare
for SaaS hostname, and Supabase custom domains look like one. No Supabase doc
supports or forbids it; the lab has never run it. Open risks: certificate
issuance/renewal (TXT `_acme-challenge` validation should be unaffected,
HTTP validation would be), Realtime WebSockets given the "WebSockets: No"
row, and the default `<ref>.supabase.co` host remaining open regardless.
Untested.

## 2. Cloudflare-side options

- Workers mTLS binding (present a client cert to an origin):
  https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/
  > "mTLS for Workers cannot be used for requests made to a service that is a
  > proxied zone on Cloudflare." (Cloudflare returns 520.)
  Supabase project hosts are proxied by Cloudflare (`server: cloudflare`,
  measured above), and the edge requests no client cert. So "Workers ->
  Supabase over mTLS" is blocked twice: Cloudflare refuses the binding toward
  a proxied zone, and Supabase would not check the cert anyway. Inferred from
  two verified facts; not run.
- Authenticated Origin Pulls:
  https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/
  > "helps ensure requests to your origin server come from the Cloudflare
  > network". All plans. It is a setting the ORIGIN enforces; Supabase's edge
  > would have to verify Cloudflare's client cert. Not applicable (inferred).
- Cloudflare HTTP headers on Worker subrequests:
  https://developers.cloudflare.com/fundamentals/reference/http-headers/
  > "In cross-zone subrequests from one Cloudflare zone to another Cloudflare
  > zone, the `CF-Connecting-IP` value will be set to the Worker client IP
  > address '2a06:98c0:3600::103'" ("for security reasons").
  > "`CF-Worker` is added to all Worker subrequests sent via `fetch()`" (value
  > = the zone that owns the Worker). WAF rules should use
  > `cf.worker.upstream_zone` (that field exists on the RECEIVING zone, i.e.
  > Supabase's, not the customer's).
  Consequences (inferred): (a) every user proxied through a Worker shares one
  client IP at Supabase, so Auth's per-IP rate limits and `cf-connecting-ip`
  RLS checks see the Worker, not the user; (b) `cf-worker` might be usable in
  RLS as a "came via our Worker" signal, but whether a direct client can set
  `CF-Worker` itself and have it reach `request.headers` is untested.
- Supabase Auth IP forwarding:
  https://supabase.com/docs/guides/auth/rate-limits
  > "set the `Sb-Forwarded-For` header to the end-user IP address and make a
  > request with a secret API key. Publishable API keys and legacy
  > `anon`/`service_role` API keys are not supported." Must be enabled per
  > project. A proxy therefore needs the secret key to restore per-user Auth
  > rate limiting.
- API Shield mTLS (client cert from app/device to the customer's own zone):
  https://developers.cloudflare.com/api-shield/security/mtls/
  Every plan can use a Cloudflare-managed CA; "upload up to five non-Cloudflare
  CAs" is Enterprise. This is where "mTLS" fits: mobile app -> customer zone.
  It authenticates the app to the edge, not the edge to Supabase.
- Access service tokens:
  https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
  Headers `CF-Access-Client-Id` / `CF-Access-Client-Secret`, configurable
  expiry. Protects an Access application on the customer's hostname (lab
  iap-lockdown closeout used one to reach an Access-gated Worker
  browserlessly). Machine clients only; does not touch the Supabase origin.
- Workers WebSockets:
  https://developers.cloudflare.com/workers/runtime-apis/websockets/
  32 MiB message cap; "Connections still open when the grace period for
  runtime updates ends are disconnected." Lab L12: Realtime SUBSCRIBED through
  a transparent Worker.

## 3. Non-Cloudflare fronts

- Azure Front Door Standard/Premium WebSocket (ms.date 2026-07-17):
  https://learn.microsoft.com/en-us/azure/frontdoor/standard-premium/websocket
  > "WAF inspections are applied during the WebSocket establishment phase.
  > After the connection is established, the WAF doesn't perform further
  > inspections." "The idle timeout is five minutes." "WebSocket connections
  > ... remain open for no longer than two hours." "Disable caching for
  > WebSocket routes." "Front Door doesn't support Server-Sent Events (SSE)."
  Supabase-specific (inferred): origin host header must be the project host
  (or activated custom domain); Realtime heartbeats (interval recalled, not
  checked, as well under 5 minutes) keep the socket alive; the 2-hour cap
  means reconnects.
- Azure API Management WebSocket passthrough (ms.date 2026-03-16):
  https://learn.microsoft.com/en-us/azure/api-management/websocket-api
  Not in Consumption tier; policies only on `onHandshake`; "the set-header
  policy doesn't support changing certain well-known headers, including Host
  headers, in onHandshake requests"; CORS policy unsupported on onHandshake.
  The Host limitation is a direct risk for proxying Realtime to
  `<ref>.supabase.co` (inferred, untested).
- AWS CloudFront WebSockets:
  https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html
  Forward `Sec-WebSocket-Key` and `Sec-WebSocket-Version` (or all viewer
  headers). Viewer WebSockets over HTTP/1.1 only.
  Host header: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html
  `AllViewerExceptHostHeader` exists because some origins "expect the `Host`
  header to contain the origin domain name"; with `AllViewer` the viewer's
  Host goes to Supabase, which would not route it (inferred). AWS WAF on
  CloudFront is the WAF layer (not fetched).
- Generic reverse proxy (nginx, Kong, Envoy, Akamai): same shape. Lab S04/S05:
  nginx `limit_req` turned a 15-request burst into 2x200 + 13x429 - "only
  works fronting a CLOSED origin". Supabase origin is never closed, so the
  proxy's controls bind only the traffic that chooses to use it.

Common Supabase-specific gotchas for any front (from lab + community):
- Host must be rewritten to the project host (or the activated custom
  domain): dev.to 2026-03-01
  https://dev.to/ritvikdayal/supabase-is-blocked-in-india-heres-the-exact-fix-using-a-cloudflare-worker-2ejf
  and JioBase blog 2026-02-27
  https://jiobase-web.pages.dev/blog/proxy-supabase-cloudflare-workers
  ("Without this, Supabase will reject the request").
- Redirect `Location` headers pointing at `.supabase.co` need rewriting
  (JioBase). Lab HP03d: OAuth `redirect_uri` always names the project host or
  the custom domain, never a third-party proxy hostname, so the OAuth
  callback leg goes straight to Supabase unless the proxy IS the custom domain
  (O2O) or OAuth is done by the customer's own IdP.
- CORS: Supabase reflects any Origin (L13); a proxy that adds its own CORS
  must handle OPTIONS (JioBase).
- Signed Storage URLs: built client-side from the base URL (HP05) and carry
  only a token, so a URL issued via the edge can be replayed against
  `<ref>.supabase.co` (inferred from HP05 + token-only signing). Revocation:
  "To revoke all signed URLs, rotate your project's URL signing key"
  https://supabase.com/docs/guides/storage/serving/downloads
- Per-IP Auth rate limits collapse onto the proxy's egress IP unless
  `Sb-Forwarded-For` + secret key (rate-limits doc above).
- Server-side clients often keep calling Supabase directly (dev.to).

## 4. Making bypass useless at the Supabase side

| Lever | Protects | Leaves open | Evidence |
|---|---|---|---|
| Edge holds the API key; app ships no key (publishable key injected by the edge, or secret key with UA scrubbed + Sb-Forwarded-For); rotate the key, disable legacy keys | Data API, Auth, Storage, Realtime all need `apikey` (S25: no apikey -> 401 "No API key found") | Public bucket objects and `verify_jwt=false` functions need no key (iap-lockdown); anyone who extracts the key from the edge path; control plane can re-mint keys (L05); a user JWT replayed to Edge Functions with `verify_jwt` (key-or-JWT check, L07) | L11 (direct 401 after legacy keys off), api-keys doc https://supabase.com/docs/guides/getting-started/api-keys ("A secret key doesn't work in a browser. Supabase matches on the User-Agent header") |
| Shared-secret header set by the edge, checked in RLS (`current_setting('request.headers')::json->>'x-edge-...'`) as a RESTRICTIVE policy | Data API (S16), Storage (S25) | Auth endpoints, Realtime (no request.headers in Realtime RLS - inferred), Edge Functions, `service_role`/BYPASSRLS callers; secret sits in policy text or a lookup table | Mechanism verified with `cf-connecting-ip` (S16, S25); a custom header's pass-through not measured |
| Shared-secret header checked in Edge Function code (`Deno.env` secret) | Edge Functions | Everything else | inferred (plain code check) |
| `cf-worker` header in RLS | Data API, Storage | Spoofability untested | Cloudflare headers doc above |
| Third-party auth only (customer IdP mints asymmetric JWTs), RLS on `iss`, Supabase Auth signups off | Data API, Storage, Realtime authz (only IdP tokens admitted) | Requests are still accepted from anywhere for a valid token; Auth endpoints still answer; anon-role surfaces | L10/L10E; https://supabase.com/docs/guides/auth/third-party/overview ("must use asymmetrically signed JWTs") |
| Data API off, all reads/writes via Edge Functions | Data API (503 PGRST002) | Auth, Storage, Realtime, Functions unaffected (L02) | http-tier-lockdown |
| Realtime `private_only` + realtime.messages RLS | Realtime channel join | WS upgrade still succeeds (L03) | http-tier-lockdown |
| Auth CAPTCHA (Turnstile/hCaptcha), disable signup, rate limits, before-user-created hook | Auth signup + password login (S19: `400 captcha_failed`) | Other Auth endpoints; does not force traffic through the edge | S14/S19; https://supabase.com/docs/guides/auth/auth-captcha |
| Network restrictions | Postgres + pooler only | All HTTP APIs | S02/S10 |

## 5. Community reports of a WAF/proxy in front of hosted Supabase

- supabase/supabase#43142 (2026-02-24, closed 2026-03-04), ISP DNS hijack of
  `supabase.co`: a commenter's Worker proxy "has been working perfectly ...
  All Supabase features work (REST API, Realtime, Auth, Storage)"
  (unverified user claim); an unanswered question whether it covers
  `*.functions.supabase.co`; mixed reports that a custom domain did or did not
  help. https://github.com/supabase/supabase/issues/43142
- supabase/supabase#12429 (custom domains request, 2022): May 2023 reply
  describes the custom domain as a CNAME on Cloudflare "(or any other
  provider)"; nothing on proxying. https://github.com/supabase/supabase/issues/12429
- supabase/supabase#27189: self-hosted behind Cloudflare Access 403 (self-host,
  not hosted). https://github.com/supabase/supabase/issues/27189
- JioBase (2026-02-27) and dev.to (2026-03-01) Worker-proxy guides: gotchas
  are Host rewrite, Location rewrite, WebSocketPair relay with close/error
  forwarding, CORS preflight, CSP `connect-src` for `wss://`, free-tier
  100k requests/day. URLs above.
- Cloudflare 1014 when CNAMEing to the project host without the add-on
  (velog 2026-02-15, above).
- Reference implementations (not read in depth):
  https://github.com/kristianfreeman/supabase-workers-proxy ,
  https://github.com/razikus/supabase-cache-proxy

## Coverage ledger

| Candidate | State |
|---|---|
| Supabase inbound mTLS | checked: none documented, none requested in handshake (2026-11-23) |
| O2O on Supabase custom domain | checked docs: unaddressed by Supabase; untested in lab |
| Workers mTLS binding to Supabase | eliminated by Cloudflare doc (proxied-zone restriction) |
| Authenticated Origin Pulls | eliminated (origin-side feature) |
| Worker reverse proxy | measured L12 (all four services) |
| API Shield mTLS client->edge | checked doc |
| Access service tokens | checked doc + L12 closeout |
| Azure Front Door | checked doc; Supabase run untested |
| Azure APIM | checked doc; Host-header limit on WS handshake is a risk; untested |
| CloudFront (+AWS WAF) | checked doc; untested |
| Akamai / Kong / nginx | generic; nginx measured on self-hosted only (S05) |
| `cf-worker` RLS signal | untested (spoofability) |
| Custom shared header in RLS | mechanism measured with cf-connecting-ip; custom header untested |
| Edge-held key / keyless client | L11 + S25 measured pieces; end-to-end untested |
