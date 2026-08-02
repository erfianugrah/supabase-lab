# privatelink-aws run log

Chronological record of every apply/destroy cycle. Newest last. Evidence
dirs (gitignored) hold the raw artifacts per run: `evidence/<ts>/REPORT.md`
plus the S3-pulled suite-out tarball.

## 2026-07-31 - run 2 (org A - account had Developer role only; aborted at project create)

- PAT auth reads fine in that org, but `POST /v1/projects` 403s:
  account is **Developer** role there - Developers cannot create projects
  OR change project settings (blocks supabase_project, supabase_settings,
  AND the PrivateLink association). Need Administrator, or an Owner
  pre-creates `lab-privatelink` + grants project-scoped Administrator
  (then `tofu import`).
- PrivateLink beta requires Team or Enterprise plan; personal org (Pro)
  is not a fallback.
- AWS side of the scaffold is proven: 17 resources up in 1m48s, clean
  destroy in 1m05s, no leftovers.
- The PAT used was revoked post-run; secrets.tfvars scrubbed to
  REPLACE_ME.

## 2026-07-31 - run 3 (org B - throwaway Team-plan org; full apply then destroy)

- Owner role on own Team org unblocks everything: project created
  (micro, ap-southeast-1) in 2m31s, `supabase_settings.network`
  restrictions JSON applied clean (shape verified), all 25 resources up.
- CONFIRMED: `/platform` routes reject PATs categorically - 401 "JWT
  could not be decoded" for the association POST, the associations GET,
  AND `/platform/organizations/{slug}/entitlements`. Owner-role PAT,
  and `supabase login` tokens are the same sbp_ type. restapi_object is
  now gated behind `var.send_association` (default false).
- BLOCKER (docs-vs-reality): PrivateLink UI did not appear on a fresh
  Team org. Studio gating chain (master): feature flag
  `integrations:aws_private_link` (per-org override; section hidden
  entirely when false) THEN entitlement `security.private_link`
  (dimmed + "Upgrade to Team" prompt when missing). Pricing data says
  team:true but the entitlement is granted server-side. Needs an
  internal ask to grant both for the org - or a support ticket. Docs
  and the 2026-01-27 launch blog both claim "available today for Team",
  no allowlist mentioned.
- Region note from Studio source: eu-central-2 is excluded from
  PrivateLink; ap-southeast-1 fine.
- Destroy verified clean: state 0, no AWS leftovers, project 400s.

## 2026-07-31 - run 4 (org B, Team plan; PRIVATE PATH PROVEN e2e)

After the org was granted `integrations:aws_private_link` +
`security.private_link` (beta grant), the dashboard AWS PrivateLink
section appeared; Add Account -> CREATING -> READY in ~2min.

Test matrix evidence (runner /home/ssm-user/evidence-20260731-071032.log):

- T02 PASS direct 5432 via PHZ name through the endpoint
- T03 PASS pooler 6543 through the endpoint (both SG rules needed)
- T09 PASS `link --skip-pooler` + db push over PrivateLink - the key
  CLI fact. T08 INFO: default link targets public Supavisor.
- T10 PASS db push --db-url with no link
- T11 FINDING: PREPARE/EXECUTE succeeded on 6543 transaction mode -
  Supavisor supports prepared statements now; the old
  "transaction mode breaks prepared statements" assumption is stale.
- T12 PASS endpoint survives public-access closure to a single /32;
  T12b confirms public Supavisor path blocked by the same restrictions
  -> restrictions + PrivateLink = full public DB lockout story works.
- T13 INFO Data API stays public (401 without key) as documented.
- T04 SKIP: Resource-type VPC endpoints do NOT expose dns_entry
  (answers the run-date unknown; PHZ A record with ENI IPs is the way).
- T05/T06 SKIP: user_data never fetched the project CA cert -
  verify-full untested at this point (covered by suite tls-tests.sh in
  run 5 instead of user_data).
- T14 (restart watch) not run interactively; automated in run 5.

Scaffolding bugs found and fixed this run:

- make arns: JMESPath NoneType when other invitations have null names;
  awscli queries RAM twice (phantom trailing page) -> --no-paginate +
  head -1; invitation must be ACCEPTED before list-resources shows the
  resource configuration -> make arns now accepts if PENDING.
- aws_ram_resource_share_accepter removed: chicken-and-egg (accept is a
  precondition for the ARNs, so it can never be declarative here).
- phase2 is two-pass: ENI data source for_each over the endpoint's
  network_interface_ids fails at plan (unknown keys).
- user_data: dnf metadata cold at boot (makecache --refresh), AL2023
  curl-minimal conflicts with curl (dropped), chown ssm-user fails
  pre-first-session (tolerated), run-matrix.sh $${...} expanded to PID
  (templatefile does not recurse into inserted payloads).

## 2026-08-02 - run 6 (org B, Team plan; Lambda path + corrections)

Enablement was unchanged from run 5 (org flag + entitlement persist), share
landed 32s after the dashboard click.

New evidence:

- Lambda in private subnets -> endpoint: BOTH ports work. Cold connect
  698ms (5432) / 218ms (6543), query 20ms / 3ms, named prepared
  statements OK on both. This was the last `design-only` row.
- Restart through the Lambda client on 6543: 93s outage (5s probe
  granularity). Failure mode is `timeout expired`, NOT refusal - a 30s
  Lambda timeout is spent entirely on one attempt.
- Endpoint replacement: ENI IPs DO churn (10.42.1.93/10.42.2.139 ->
  10.42.1.203/10.42.2.170); clients recover once the same apply refreshes
  the PHZ. Replacement needs the same two-pass treatment as phase 2.
- `ModifyVpcEndpoint --ip-address-type dualstack` -> `InvalidParameter:
  Modifying IpAddressType to DUALSTACK is not supported`. NARROW: this
  tests modify, not create-in-an-IPv6-VPC. The IPv6-first-VPC question
  remains open.
- Realtime: DNS split confirmed (API host -> public 104.18.38.10, DB host
  -> 10.42.2.139 ENI). The WebSocket upgrade probe returned 500 and is
  INCONCLUSIVE - a curl-shaped handshake, not a real ws client.
- Association DELETE: NOT exercised (probe ran its window, no removal
  performed).

Corrections to previously published claims:

- "First refusal at exactly 200 concurrent (micro)" was WRONG - and wrong
  in the worst way, by agreeing with the published figure. The ramp used
  `pgbench -c N -j N` (one thread per client) on a 2-vCPU runner, so a
  failure at high N could not be attributed to the server. Re-run with
  `-j 8`, a quiet system, instant queries, and the server's error text
  captured: below the limit PgBouncer QUEUES (`No server connection
  available in postgres backend, client being queued`); refusal
  (`FATAL: no more connections allowed (max_client_conn)`) first appeared
  at the 213th concurrent client.
- `pgbench` is in `postgresql16-contrib`, which user_data never installed.
  Run-5's throughput numbers came from a hand-installed pgbench on a live
  runner - real output, unreproducible setup. Fixed in user-data.sh.

Lab bugs found and fixed:

- `make arns` raced the RAM acceptance: the resource configuration is not
  visible to list-resources for a few seconds after ACCEPTED. Now polls.
- A full apply reverted the Lambda env block and silently wiped the
  out-of-band PGPASSWORD (`make lambda-secret`), leaving the probe
  authenticating with nothing. Password is now in-config - db_password is
  already in state via supabase_project, so this exposes nothing new.
- `make phase1` now builds the Lambda zip when enable_lambda=true.

## 2026-07-31 - run 5 (automated suite; full evidence report)

`make suite` built and run green end-to-end: 4 on-runner phases deployed
via SSM (tls-tests, bench-latency, ceiling, t14-restart), artifacts
pulled via S3 + boto3 put_object presign, REPORT.md rendered locally.
Evidence: `evidence/20260731-175026/REPORT.md` (plus two earlier
partial-suite runs same day).

Measured facts (micro compute, ap-southeast-1, in-VPC t3.micro runner):

- Connect latency (30 cold psql connects, p50): private-5432 37ms,
  private-6543 31ms, public-supavisor-6543 31ms.
- pgbench select-only (4 clients, 15s): private-5432 3810 tps @ 1.05ms,
  private-6543 3350 tps @ 1.19ms, public-supavisor 2258 tps @ 1.77ms -
  the private pooler path is ~48% faster than public Supavisor.
- TLS: verify-full PASS via PHZ name (T05), via extracted chain (T06),
  and via host/hostaddr split (T04b); verify-full against the raw
  endpoint IP fails by design (T04c). Endpoint cert: CN + single SAN =
  db.<ref>.supabase.co, 3-cert chain via STARTTLS.
- Data API is public-HTTP-only by design. PostgREST root `/rest/v1/`
  requires service_role on the current platform (anon gets 401 "Only
  the service_role API key can be used for this endpoint" - verified
  from off-VPC). An anon-key probe needs a real table: SQL-created
  tables get anon SELECT via default privileges and no RLS
  (dashboard-created tables get RLS). Probe: 200, warm p50 18.6ms.
- Pooler client ceiling (6543 transaction mode, Micro): first
  connection refusal at exactly 200 concurrent - matches the published
  Micro limit.
- T14 restart down window (Management API restart, psql probe every 2s
  over the endpoint): 49s. Three samples across runs: 49 / 72 / 131s.
- public-direct-5432 documented SKIP: the direct endpoint is IPv6-only,
  so an IPv4-only VPC runner has no public-direct path at all. The
  IPv4 add-on (~$4/mo) would make public-direct work but is moot for a
  PrivateLink design: the endpoint already provides in-VPC IPv4 on both
  ports, and the shared pooler is IPv4-only/free for anything else.
- Lockout scope note: restrictions refuse public DB paths at the socket
  level (tested, T12/T12b). What the support-ticket "disable public
  connectivity" action does beyond that - e.g. removing public ingress
  rather than refusing it - is untested; the ticket remains the path
  for ingress-removed.

Suite scaffolding bugs found and fixed this run:

- suite.sh read aws_account_id from experiment.tfvars; it lives in the
  root secrets.tfvars.
- `aws s3 presign` signs GET only - artifact upload needs a boto3
  put_object presign, with endpoint_url pinned regional (the global
  endpoint 307-redirects fresh buckets and breaks the host-signed URL).
- pgbench is not in AL2023 postgresql16 (client); deploy step installs
  postgresql16-contrib.
- suite-out persists on the runner between runs; bench-latency clears
  stale artifacts so the report never mixes runs.
- render-report.sh: nested-quote bug `"$(basename "$(pwd")")"` (quote
  closes before paren - invalid), ref extraction moved to evidence
  logs, matrix grep fixed for timestamped lines.

Destroy: verified clean same day (state 0; suite S3 bucket
supabase-lab-suite-* removed separately - it is created by suite.sh,
not tofu, so `make destroy` does not cover it; `make suite-clean` does).

## Open follow-ups

- [x] Generalise evidence into a public guide - done:
      lexicanum `reference/supabase-aws-privatelink`.
- [ ] Feed results back to the private findings notes (claims move from
      Inferred to Tested, linking the published guide).
- [ ] Optional: enable_lambda=true run for the Lambda-native tests.
- [ ] Optional: IPv4 add-on probe (T15) - enable via Management API,
      watch public-direct-5432 go from SKIP to green, disable.
      ~$0.0055/hr while on; argued moot for PrivateLink designs.
