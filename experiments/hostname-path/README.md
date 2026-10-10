# hostname-path

What a custom hostname does and does not change on the client path to a
project, and what survives when `supabase.co` stops resolving at a resolver.
Two questions:

1. Custom domain as a workaround for a network that blocks or mishandles
   `supabase.co`: which hosts appear in an OAuth round trip and in the URLs
   supabase-js builds (`getPublicUrl`, `createSignedUrl`), and which requests a
   client given only the custom hostname still sends to `supabase.co`.
2. A resolver that answers NXDOMAIN for `supabase.co`: how the project hostname
   and the custom hostname resolve through different paths, whether a client
   configured with the custom hostname keeps working, and where the latency
   goes (DNS, TCP, TLS, first byte).

Self-provisioning, no OpenTofu state: HP01 creates one Pro-org project named
`hp-<ms>` (ap-southeast-1, default compute), HP09 deletes it with the
custom hostname, the DNS records and the `custom_domain` add-on. Run state
(project ref, hostname) is in `.state.json`, gitignored; `make down` tears down
from it after a crash.

## Modules

| id | claim |
|---|---|
| HP01 | provision: project, mock OIDC issuer in the Keycloak provider slot (an Edge Function, no third-party credential), buckets, table, user |
| HP02 | baseline before any custom domain: OAuth `redirect_uri`, callback and `iss` hosts; every host in supabase-js requests and returned URLs |
| HP03 | custom domain up (add-on, hostname, DNS in a Cloudflare zone, verify, activate); seconds until the Auth `redirect_uri` carries the custom host |
| HP04 | OAuth round trip with the custom domain active, entered at each host |
| HP05 | SDK and server URL hosts with the custom domain active: supabase-js given each host, and the raw sign, upload and PostgREST-root bodies |
| HP06 | resolution of both hostnames through the system resolver, 1.1.1.1, 8.8.8.8, 9.9.9.9 and DoH; delegation, DNSSEC, wildcard |
| HP07 | `supabase.co` NXDOMAIN at a local recursive resolver (Docker): app on the project host, on the custom host as CNAME, and as A/AAAA; cache survival |
| HP08 | per-phase latency (DNS, TCP, TLS, TTFB), project host vs custom host, one vantage |
| HP09 | teardown and confirmation that no `hp-` project remains |

## Run

```bash
# the custom hostname must be in a Cloudflare zone the global key can edit;
# credentials are injected per command, the org slug comes from the environment
sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL -- \
  env PVLAB_ORG_PRO=<pro org slug> make run DOMAIN=<host>.<zone>
make unit      # pure parsers, no network
make down DOMAIN=<host>.<zone>   # tear down from .state.json after a crash
```

Needs `dig`, `curl` and Docker (HP07 pulls `alpine` and `oven/bun:alpine`).
Billable while it runs: the custom domain add-on is charged per hour, the
project at the default compute size.

Not measured: ISP resolvers (regional block reports) and `.co` TLD resolution, and an
eastern-US vantage at :00/:30. HP08 is vantage-agnostic; run it from a host
there to fill the second gap. See RUNLOG.md.
