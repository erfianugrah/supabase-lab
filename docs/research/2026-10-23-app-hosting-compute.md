# "Deploy your web app and services next to your database": what shipped (2026-10-23)

Question: the Select 2026 "Build anything" post says your agent can "deploy
the services behind your app". Is that a hosting product beyond what the lab
already measured (CLI, Docker-less stack, static files through Storage and
Edge Functions), and if so what would an experiment cover? Raw captures:
`raw/2026-10-23-app-hosting-compute/` (the Compute operations from the
published v2 OpenAPI document, and the redacted Management API probe).

Sources, all read 2026-10-23:

- Blog, 2026-10-02: https://supabase.com/blog/select-2026-build-anything
- Product page: https://supabase.com/compute
- Management API v2 OpenAPI: https://api.supabase.com/api/v2-json (v1:
  https://api.supabase.com/api/v1-json)
- CLI source, pinned (Compute command family, config schema, URL, sizes):
  https://github.com/supabase/cli/blob/ce77899cb45383dfca7f4ee5f44a285f342536c0/apps/cli/docs/compute-commands.md ,
  https://github.com/supabase/cli/blob/ce77899cb45383dfca7f4ee5f44a285f342536c0/packages/config/src/compute.ts ,
  https://github.com/supabase/cli/blob/ce77899cb45383dfca7f4ee5f44a285f342536c0/apps/cli/src/shared/compute/compute-url.ts ,
  https://github.com/supabase/cli/blob/ce77899cb45383dfca7f4ee5f44a285f342536c0/apps/cli/src/shared/compute/compute-runtimes.ts ,
  https://github.com/supabase/cli/blob/ce77899cb45383dfca7f4ee5f44a285f342536c0/apps/cli/src/shared/compute/compute-logs.sql.ts
- Unmerged docs page (open PR, head 09d0f31c):
  https://github.com/supabase/supabase/pull/50507 , file
  https://github.com/supabase/supabase/blob/09d0f31c256ff8291fade4b67073c1f9e9ad9762/apps/docs/content/guides/ai-tools/compute-private-alpha.mdx
  (not in the merged docs; a search of the `apps/docs` sources for
  "Supabase Compute" found nothing)

## What the post announces, item by item

| item | status in the post | lab coverage |
|---|---|---|
| Docker-less local stack, one stack per directory | alpha, off by default | `experiments/cli-surface` CL20-CL22 |
| Declarative Schemas 2.0 / pg-delta | default for new `supabase init` | `experiments/cli-surface` CL01-CL03 |
| `config pull`, `supabase pull` | shipped | `experiments/cli-surface` CL04 |
| Your app's MCP server block (`@supabase/mcp-server`) | shipped | `experiments/governed-starter-kit` K06 |
| `@supabase/server` and Supabase Middleware | shipped | `experiments/edge-runtime-auth` (1.9.1), K06 (Middleware 1.0) |
| Headless app template | shipped | not covered (an app template, no platform behaviour of its own) |
| Supabase Compute | private alpha, waitlist | not covered: new |

Only Compute is new hosting. Static sites remain as `experiments/static-hosting`
found them (HS01-HS06, 2026-10-06): Storage and the Edge Function path rewrite
HTML to `text/plain` on project hostnames, and a custom domain lifts that for
functions only under `/functions/v1/<slug>/`.

## What Compute is, from public sources

- Post: long-lived services in any language "next to your database", no run
  time limit, chosen memory and CPU, a full Linux environment, deploy from the
  CLI or the Management API, definition in `config.toml`, same default
  environment variables as Edge Functions, a public HTTP URL per service or
  private (no HTTP endpoint), instance count with load balancing, network
  restrictions can limit database access to Compute instances. Private alpha.
- Product page: Node, Deno or any Dockerfile; "Services suspend when idle and
  resume in under a second. You pay nothing while they sleep."; each workload
  "in its own microVM"; per-workload firewalls; "cloaked" secrets; sandboxes
  provisioned through the API or MCP server. Private alpha behind a waitlist.
- Management API v2 (published, every operation marked Alpha, FGA
  permissions `workers_read` / `workers_write`):
  `GET /v2/projects/{ref}/compute`, `GET|DELETE /v2/projects/{ref}/compute/{name}`,
  `POST /v2/projects/{ref}/compute/{name}/uploads` (presigned PUT slot for a
  `.tar.gz` build context), `POST /v2/projects/{ref}/compute/{name}/deploy`
  (202; `build_state` goes `building` to `active` or `failed`). The spec is
  `runtime`, `size` (example `2gb-1vcpu`), `exposure` (free string),
  `instances`; the instance read-back carries `declared`, `live`, `ready`,
  `stale` counts. Names are DNS labels (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`).
  The v1 document (115 paths) has no Compute route.
- CLI (TypeScript CLI source on `develop`; the draft guide says "Compute ships
  in the beta channel"): opt-in with `SUPABASE_EXPERIMENTAL_COMPUTE=1` or
  `[experimental] compute = true`; commands `compute new|push|list|status|logs|delete`;
  sources under `supabase/compute/<name>/`; `[compute.<name>]` keys `runtime`,
  `size`, `exposure`, `instances`, `source`, `exclude`. Runtimes `dockerfile`,
  `node`, `deno` (default `deno`); sizes `2gb` and `4gb` only, "There is no
  resize - a different size means a new compute"; exposure `public` (default)
  or `private`. The public URL is derived, not returned by the API:
  `https://<ref>.supabase.co/compute/v1/<name>`, next to `/functions/v1/`.
  Logs come through the analytics logs endpoint in three streams
  (`worker_guest_logs` app, `worker_ingress_logs` requests, `worker_api_logs`
  builds).
- Unmerged guide (PR 50507): node/deno deploys "build-free and serve in
  ~15s", dockerfile "~1-2 min build"; public instances listen on `$PORT`
  (default 8080) and must accept connections within 50 s of start or are
  relaunched with backoff; `2gb` gives "about 1.9 GiB" and `4gb` "about 3.8
  GiB" to the app, past which the process is killed; a request during boot
  answers "compute instance <name> is starting"; saturation answers 503 with
  `Retry-After`; secrets are the project's Edge Function secrets, picked up
  "within about a minute"; with database network restrictions on, direct
  Postgres connections from Compute need four published egress CIDRs on the
  allowlist (Data API calls are unaffected). The merged docs do not carry it.

Disagreements between sources, to settle by running it: the product page
says services "suspend when idle" while the post says "a service that stays
up" and "no limit on how long a service runs"; the API's `size` example is
`2gb-1vcpu` while the CLI sends a memory-only size; none of the sources names
a price, a custom-domain path or a request timeout.

## Probe (2026-10-23, Pro org, one throwaway project, deleted)

`raw/2026-10-23-app-hosting-compute/probe-2026-10-23.txt`:

- `GET /v2/projects/{ref}/compute`, `GET .../compute/probe-nl` and
  `POST .../compute/probe-nl/uploads` all answered `404
  {"error":{"code":"compute_not_enabled","message":"Compute is not available
  for this project"}}`. The PAT passed the permission check (no 403), so the
  route is live and gated per project, matching the draft guide's "If the CLI
  answers `Compute is not available for project <ref>.`, the project is not
  enrolled".
- The org's entitlement list (64 features) has no key containing compute,
  worker, service, container or app other than
  `instances.compute_update_available_sizes` (the database size set).
  Enrollment is not visible as an org entitlement to this token.

## Proposed experiment: `experiments/compute-surface` (needs enrollment)

Self-provisioning, one Pro project in `ap-southeast-1`, deleted at the end.
Modules:

- CS00 gate: the probe above as a module, so a later enrollment shows up as a
  changed result. Runnable now.
- CS01 deploy path: CLI `compute push` (beta channel, pinned) and the raw API
  (upload slot, PUT, deploy, poll) for `deno`, `node`, `dockerfile`; time from
  deploy call to `build_state=active` and to first 200; `state_reason` on a
  deliberately broken build; redeploy and the window where old and new answer
  (`stale` count).
- CS02 serving: does `/compute/v1/<name>/` serve `text/html` on the project
  hostname, or apply the Storage/Edge Function `text/plain` rewrite
  (static-hosting HS01 method, same fixture types); SSE streaming; request
  and response body limits; a long request (where does it time out); the
  503/`Retry-After` saturation answer at `instances=1`.
- CS03 idle and cold start: request latency after 1, 5, 15, 60 min idle
  (tests "resume in under a second" against "stays up"); whether a private
  service's loop keeps running across idle (writes a heartbeat row).
- CS04 limits: memory kill near 1.9 / 3.8 GiB, the 50 s `$PORT` bind window,
  vCPU count seen inside (`nproc`), default egress, outbound addresses against
  the published egress ranges.
- CS05 database path: default env vars present, Data API and direct Postgres
  latency from inside (the "single-digit millisecond" claim), and the
  network-restrictions interaction (direct blocked, Data API not) with the
  `/v1/projects/{ref}/network-restrictions` routes the lab already drives
  (platform-downtime D02, s2z-wake).
- CS06 custom domain: does an active custom hostname route
  `/compute/v1/<name>/` the way it routes `/functions/v1/<slug>/` (HS05).
- CS07 logs and billing: the three log streams through the logs endpoint;
  billing lines need the dashboard (OB03 found the platform organization usage
  route rejects a PAT, and the v1 document has no org usage route), so a human
  reads usage while a service runs and while it is idle.

Cost: unknown, no price published. The project itself is the lab's usual
micro baseline; Compute instance-hours are the open variable CS07 reads.

Blockers:

- Enrollment. The org's projects answer `compute_not_enabled`; the waitlist
  on https://supabase.com/compute is the only stated path. CS01-CS07 wait for
  it.
- The private-alpha terms (not read here) may restrict what can be published
  about it; read them on enrollment before writing results to a public repo.
