# RUNLOG - experiments/hyperdrive-direct

Cloudflare Hyperdrive against the Supabase direct connection
(`db.<ref>.supabase.co:5432`). One throwaway Pro project per module,
self-provisioning (no tofu); the probe Worker and the Hyperdrive config are
created with wrangler and deleted in the same run.

Run: `PVLAB_ORG_PRO=<slug> pvlab --where local --experiment hyperdrive-direct --only H01 --destructive`
with `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` in the
env (the Global API Key trio; a scoped token fails wrangler's account lookup
on this box). H01 self-skips without them.

## Findings, by module

- H01 (2026-10-05): Hyperdrive reaches the IPv6-only direct connection with
  no IPv4 add-on, and node-postgres named prepared statements work through it.

## 2026-10-05 - IPv6-only origin and named prepared statements (H01)

Cloudflare's Supabase page recommends the direct connection string and its
node-postgres page documents named prepared statements; neither says
Hyperdrive connects to an IPv6-only origin. Fresh Micro project in
`ap-southeast-1`, Pro org, no IPv4 add-on.

- Direct host DNS: 1 AAAA record, 0 A records (IPv6-only).
- `wrangler hyperdrive create --caching-disabled` against
  `postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres` saved on the
  first attempt. Hyperdrive runs a live connect check before it saves, so the
  save alone proves the origin is reachable from Cloudflare over IPv6.
- A Worker (`nodejs_compat`, `pg` 8.23.1, new `Client` per request) returned a
  row through the binding; `family(inet_server_addr())` read 6 (IPv6);
  `server_version` 17.11.
- A named query (`{ name, text, values }`) executed twice on one client
  returned the right values, and again on a second request.
- Reading: the direct string works behind Hyperdrive without the IPv4 add-on
  (this run; Cloudflare does not publish it as a guarantee). It matches the
  2026-07 observation in the lexicanum cloudflare-supabase-architecture
  reference.

Evidence: run artifact `run-2026-10-05T08-17-22-027Z` (gitignored). Project,
Worker and config deleted in the run's `finally`.
