# hostname-path - RUNLOG

What a custom hostname changes on the client path to a project, and what
survives when `supabase.co` stops resolving at a resolver. One Pro-org
project, ap-southeast-1, default compute, created and deleted by the suite
(HP01, HP09). Public background:
https://supabase.com/blog/navigating-regional-network-blocks (a proxy domain
restored REST, Realtime and Functions during a regional block; auth callbacks
and storage object URLs stayed affected) and
https://supabase.com/docs/guides/platform/custom-domains (register the custom
domain's callback in the provider next to the project one).

## 2026-10-10 - one run, n=1 per row unless a count is given

Vantage: an APAC network; the project hostname and the custom hostname were
both answered by the SIN Cloudflare colo (HP08). Local orchestrator, no runner
VM. DNS for the custom hostname went through the Cloudflare v4 API in a zone on
the operator's own account (global key; the scoped API token from the vault did
not list that zone on this date - an unrecorded observation, no artifact). The hostname and the project are deleted.

Artifacts (gitignored `evidence/<ts>/`, copies kept outside the repo; not yet
published to `out/`): `20261010-122802` (HP01, HP02 first pass),
`20261010-122852` (HP02, HP03 first cycle, HP04, HP05), `20261010-123323` (HP04
re-run), `20261010-123430` (HP06, HP07, HP08), `20261010-124147` (HP03 second
cycle, HP04), `20261010-124315` (HP05 with HP05d), `20261010-124339` (HP09).

Measured values below are from those artifacts. "Docs" marks a claim from the
public pages above that the run did not test.

### Provision (HP01)

- Project create answered `201`; `ACTIVE_HEALTHY` at the first poll, 12 s after
  the call. The mock issuer (an Edge Function standing in for the Keycloak
  provider slot, no third-party credential) deployed `201`, its `/ping`
  answered `200`, and `/auth/v1/settings` reported the keycloak provider 7 s
  after the config PATCH. Buckets, one object each, a table and a confirmed
  password user were created on the first try.
- The Keycloak slot appends `/protocol/openid-connect/{auth,token,userinfo}`
  to `external_keycloak_url` (read from the open-source Auth server's
  keycloak provider source; the round trip below confirms it end to end).

### Baseline, no custom domain (HP02)

- OAuth round trip entered at the project hostname (302 > 302 > 302, landing
  on the configured site URL with a session): the `redirect_uri` the Auth
  server sent the issuer was `<project host>/auth/v1/callback`; the issuer sent
  the browser to that host; the `redirect_uri` in the Auth server's token
  request to the issuer was the same; the access token's `iss` was
  `<project host>/auth/v1`.
- supabase-js against the project hostname, 12 operations: every request and
  every returned URL carried the project hostname.

### Custom domain up (HP03), two cycles on the same project

| cycle | ownership TXT written | `_acme-challenge` TXT written | `reverify` to `3_challenge_verified` | `activate` | host answered through 1.1.1.1's address |
|---|---|---|---|---|---|
| 1 (`122852`) | 2 s | 65 s (arrived on a later poll) | 221 s | `201` on the first call | 1 s after activation |
| 2 (`124147`) | 2 s | none asked for | 66 s | `201` on the first call | 1 s after activation |

- Status after verification was `4_origin_setup_completed` both times, and
  `5_services_reconfigured` was already reported on the first poll after
  `activate`, so "0 s" in the artifact is the poll granularity, not a
  measurement of instantaneous activation. The `activate` `400` that
  static-hosting recorded once did not occur in these two cycles.
- Cycle 2 was started after deleting the hostname and its DNS records from
  cycle 1 (`DELETE custom-hostname` `200`, 3 records removed, a later `GET`
  `400 "No custom hostname configuration found."`). That cleanup was done by
  hand and is not recorded in an artifact (the `123410` evidence directory is
  empty); only HP09's own teardown (2 records removed) is on file. The add-on
  stayed.

### OAuth callback follows the custom domain, a few seconds after activation (HP03d, HP04, HP09)

- Cycle 1: an OAuth round trip started within seconds of `activate` still put
  the project hostname in `redirect_uri` (artifact `122852`, entered at either
  host); the same round trip 31 s after that run ended put the custom hostname
  there (artifact `123323`).
- Cycle 2, polled every 5 s on the `/authorize` redirect, entered at each host:
  1 s after the API reported `5_services_reconfigured`, both entries named the
  project host; 6 s after, both named the custom host. Resolution is the 5 s
  poll plus up to 10 s on when `5_` was first observed.
- With the custom host active (cycle 2, HP04), entered at either host: the
  `redirect_uri` sent to the issuer, the issuer's redirect, and the
  `redirect_uri` in the token request were all `<custom host>/auth/v1/callback`
  - the entry host did not matter. The session landed on the configured site
  URL. The access token's `iss` stayed `<project host>/auth/v1`, and the token
  was accepted by `/auth/v1/user` on both hosts (`200`, `200`).
- Removal (HP09): 5 s after `DELETE custom-hostname` the `redirect_uri` named
  the project host again (first poll that read it).
- What this means for a real provider is inferred, not tested: the callback the
  provider is asked to redirect to changes from the project host to the custom
  host about 6 s after activation, and back about 5 s after removal. A provider
  app that has only the project-host callback registered would be asked for a
  `redirect_uri` it does not list. Whether the project-host callback still
  completes a flow after activation (docs: register both) was not run.

### SDK and server URL hosts with the custom domain active (HP05)

- supabase-js given the custom hostname, 12 operations (`getPublicUrl` with
  plain, `download` and `transform` options, `createSignedUrl`,
  `createSignedUrls`, `createSignedUploadUrl`, `upload`, `download`, `list`, a
  REST select, `functions.invoke`, password sign-in): every request and every
  returned URL carried the custom hostname; the same client given the project
  hostname after activation used the project hostname throughout. Signed and
  public URLs fetched `200` on the host they were built for (the `transform` and
  signed-upload URLs were built, not fetched).
- `getPublicUrl` sends no request: it concatenates the client's URL with the
  bucket path. The Storage server's sign, sign-upload and upload responses
  (raw, called on both hosts) contain no hostname: the SDK adds the host.
  This is why the returned host is whichever the client was given.
- Hosts that are NOT the custom host, on the server side: the access token's
  `iss` is `<project host>/auth/v1` for a password grant entered at the custom
  host (HP05d; the JWKS endpoint answers `200` with 1 key on both hosts). The
  PostgREST OpenAPI root (`GET /rest/v1/`) reports `host` as
  `<project host>:443` on both hosts (HP05c counts the project host as the
  only hostname in the 3913-byte body on both; the `host` field itself was read
  by hand, not recorded in an artifact). A verifier that requires `iss` to equal
  the host the client used, or a Swagger/codegen tool that trusts `host`, would
  see the project host. Neither was run against such a tool.
- Realtime through the custom host subscribed (HP07b, `SUBSCRIBED`); the
  per-request host capture covers `fetch` only, so the websocket host is the URL
  the client was given, not an observation.

### Resolution, six paths (HP06)

- Project hostname, A: `NOERROR`, 2 addresses, TTL 300, the same address set
  through the system resolver, 1.1.1.1, 8.8.8.8, 9.9.9.9 and DoH on Cloudflare
  and Google. AAAA: `NOERROR` with no records on all six (no IPv6 address).
  `ad` flag false everywhere.
- Custom hostname: 1 CNAME (TTL 60) to the project host, then the same 2
  addresses (TTL 300), same set on all six paths; AAAA is the CNAME alone.
- Query time over UDP/53 for the A record, in milliseconds, order system
  resolver / 1.1.1.1 / 8.8.8.8 / 9.9.9.9: project host 24 / 9 / 18 / 14;
  custom host 27 / 18 / 35 / 35.
- `dig +trace`: root 13 NS, `co.` 4 NS, `supabase.co.` 2 NS (`christina` and
  `neil` on `ns.cloudflare.com`). `supabase.co` has no DS at `.co` and no
  DNSKEY when asked through 1.1.1.1 (not DNSSEC-signed, so a validating
  resolver has no signature to check an NXDOMAIN against). An unused label
  under `supabase.co` answers NXDOMAIN (no wildcard).

### NXDOMAIN on supabase.co at a resolver (HP07)

Rig: a recursive Unbound in Docker (no `.` forwarder, so a CNAME chain is
followed by this resolver), the app in a container whose only resolver is that
Unbound, and an Unbound zone forward sending `supabase.co.` to a dnsmasq that
answers NXDOMAIN for it. The app is supabase-js on one base URL doing a DNS
lookup, password sign-in, a REST read, a public Storage object, an Edge
Function call and a Realtime subscription (6 operations).

- Control, recursion intact: 6 of 6 operations ok on the custom host and on the
  project host.
- `supabase.co` NXDOMAIN, custom host a CNAME to the project host: the custom
  hostname itself answered NXDOMAIN (the CNAME is in the answer, the target is
  NXDOMAIN); the app on the custom host 0 of 6 ok, on the project host 0 of 6
  ok (`getaddrinfo ENOTFOUND`). A custom hostname that is a CNAME to
  `<ref>.supabase.co` does not survive a resolver that cannot resolve
  `supabase.co`.
- `supabase.co` NXDOMAIN, the CNAME replaced by A records holding the project
  host's 2 addresses: the custom hostname answered `NOERROR` with 2 A, the app
  6 of 6 ok. Before this, the custom hostname served over the project host's
  addresses with curl pinned (HP07a: `200` on both addresses, SNI = custom
  host). The platform still reported `5_services_reconfigured` a few seconds
  after the CNAME was removed. Not tested: how long the addresses stay valid
  (they are shared anycast addresses; n=1, minutes), a `reverify` or certificate
  renewal without the CNAME, and whether the platform supports address records
  (docs: not checked). This is a measured behaviour, not a recommendation.
- Cache: with the chain resolved just before the outage and no flush, the
  custom hostname kept answering `NOERROR` at every 30 s sample to 271 s and
  answered NXDOMAIN at 301 s, which matches the 300 s TTL of the cached target
  A record (the 60 s CNAME was re-fetched from the zone that still held it).
  This is one resolver configuration (no serve-stale, no prefetch); resolvers
  that serve stale answers would differ. Not run.
- Not simulated: an outage seen by some resolvers and not others, a failure at
  the `.co` TLD (the custom hostname sits under a different TLD, so only the
  CNAME target would be affected), and any ISP-side filtering.

### Latency, phase split (HP08), this vantage only

`GET /auth/v1/health` with the anon key, fresh curl process (new connection
and handshake) per sample, 40 samples per host interleaved, one run, started
04:40 UTC. All 40 of 40 returned `200` on both hosts. Cells are p50 / p95 in
milliseconds.

| | DNS | TCP | TLS | TTFB | total |
|---|---|---|---|---|---|
| project host | 3 / 6 | 10 / 14 | 15 / 18 | 27 / 107 | 56 / 135 |
| custom host | 3 / 4 | 10 / 12 | 14 / 18 | 26 / 43 | 57 / 75 |

- DNS is curl's `time_namelookup` through the system resolver, so mostly its
  cache. A separate timing against 1.1.1.1 (10 queries each; min / p50 / max in
  milliseconds): project host 6 / 14 / 19, custom host 7 / 37 / 78 (two names
  to resolve).
- p50 phase times differ by at most 1 millisecond. The p95 TTFB gap (107 vs 43)
  is from 40 samples in one run and is not reported as a difference.

### Not measured

- Eastern-US vantage at :00/:30: no host was created. The vault's AWS key
  pair was rejected by STS (`InvalidClientTokenId`; an unrecorded observation,
  no artifact) on 2026-10-10, so the
  t4g.nano in us-east-1 was not attempted. HP08 is vantage-agnostic; the
  :00/:30 hypothesis is untested.
- ISP resolvers (regional block reports) and `.co` TLD resolution from other
  networks: one APAC vantage only; HP06c records the delegation structure, not
  any ISP's behaviour.
- A real OAuth provider: the flow ran through a mock issuer in the Keycloak
  slot. The Auth server's behaviour after the provider is the same slot code,
  but a provider-side `redirect_uri` mismatch was not exercised.
- An `iss`-checking JWT verifier, a Swagger/codegen consumer of the PostgREST
  `host`, the image-transform URL fetch, and the project-host callback after
  activation.

### Harness notes

- The Keycloak provider keeps the userinfo claims under
  `identity_data.custom_claims`, not at the top level; the first HP02 pass
  read the wrong place and reported "-" for the token request's
  `redirect_uri`.
- Docker container IPs are not routable from macOS: dig runs inside the
  Unbound container (`lib/resolver.ts`).
- Cost: one Pro-org project for about 15 minutes and the custom domain add-on
  for about 15 minutes across two cycles (from the artifact timestamps, roughly
  04:28 to 04:43 UTC; the cycle-1 teardown is unrecorded). Not metered from
  billing.
