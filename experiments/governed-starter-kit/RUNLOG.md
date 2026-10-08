# governed-starter-kit - RUNLOG

## 2026-10-09 - BFF demo renamed to neutral names

The BFF demo was renamed to generic names; behaviour, mock delays,
Cache-Control values and checks are unchanged. The renamed identifiers:

- Edge Function `fanout-api` (`supabase/functions/fanout-api/`);
  `upstream-mock` unchanged.
- Upstream endpoints `profile`, `feed`, `inbox`, `stats` (`profile`
  max-age 300 and `feed` max-age 60 are cacheable; `inbox` and `stats` are
  no-store). Demo knobs `slow=stats` and `fail=feed`. The mock's payload
  fields are generic.
- Response `screen: "main"`.
- `private.fanout_cache`, RPCs `fanout_cache_get` / `fanout_cache_put`,
  policy `fanout_cache: own rows`, `sql/50-fanout.sql`.
- Env `FANOUT_UPSTREAM_TIMEOUT_MS`.
- `tests/k05-fanout-api.ts` (id K05 unchanged); `lib/bff-checks.ts` export
  `callFanout()`. Make targets `bff-test`, `bff-local`, `bff-deploy`
  unchanged.

The two 2026-10-08 BFF entries below were edited for the new identifiers
only (function, file, table, RPC and endpoint names, query params); their
numbers are as recorded on 2026-10-08.

Re-run with the renamed code, 2026-10-09 (Supabase CLI 2.120.0):

- `make bff-test`: 11 of 11 pass, 291 ms.
- `make bff-local`: 8 of 8 pass; L02-L05 wall medians 271 / 142 / 814 /
  198 ms (server 265 / 135 / 806 / 192). Artifact
  `evidence/bff-local-2026-10-08T22-17-22-400Z.json` (gitignored).
- Hosted, ready project: `make bff-deploy` (SQL, both functions, secrets
  check passed), then the previously named function deleted with `supabase functions
  delete`, and the previously named cache table and both cache RPCs
  dropped with a one-off SQL file through
  `scripts/kit.ts schema` (not committed). Afterwards the project lists
  `agent`, `webhook-sink`, `upstream-mock`, `fanout-api`, and only the
  `fanout_cache_*` RPCs.
- Warm-up: one K05 run, discarded. Its first call after the deploy answered
  http 502 in 3086 ms (the cold-start 502 again, third time), then 8 of 8.
- K05, two runs after the warm-up: 8 pass, 0 fail, 0 skip each; first call
  http 200 in 622 and 635 ms. Per-check medians over 5 requests (wall ms /
  server `total_ms`), run 1 and run 2:
  - all four upstreams, cache bypassed (`refresh=1`): 644 / 416 and
    653 / 459.
  - next call with profile and feed from the cache: 459 / 254 and
    563 / 281; cache read 53 and 59 ms.
  - `slow=stats` past the 800 ms per-call timeout: 1073 / 852 and
    1076 / 855, stats cut at 802 and 801 ms, partial.
  - `fail=feed`: 542 / 332 and 574 / 337, partial.
  - L06-L08 equivalents passed: all-failed 502, second user never served the
    first user's rows, `fanout_cache_put` as a user 403 `42501`, `private`
    schema 406 `PGRST106`.
  Artifacts `evidence/20261009-061934/` and `evidence/20261009-061954/`
  (warm-up `evidence/20261009-061907/`; gitignored).

## 2026-10-08 (later) - BFF fanout-api: first hosted run

`make up` rebuilt both projects (micro, ap-southeast-1, Team org) and the
existing probe matrix gave 35 pass, 0 fail, 2 skip (K03: no model key; K05:
fanout-api not yet deployed). `make bff-deploy` then applied
`sql/50-fanout.sql`, deployed `upstream-mock` and `fanout-api` with
`--use-api`, and set the two upstream secrets; the secrets list check
passed. Supabase CLI 2.120.0. Vantage: the operator's machine (`--where
local`), so wall times include the client round trip to the region.

- K05 (`make probe ONLY="--only K05"`), three runs: 8 pass, 0 fail, 0 skip
  each time. Per-check medians over 5 requests, runs 1 and 2 (wall ms /
  server `total_ms`):
  - all four upstreams, cache bypassed (`refresh=1`): 705 / 469 and
    662 / 459. Per-upstream times 182-381 ms against configured mock delays
    of 60-250 ms, so each hop from `fanout-api` to `upstream-mock` through
    the public functions URL adds roughly 100-130 ms (inferred from the
    difference; not measured separately).
  - next call with profile and feed from the cache: 525 / 311 and
    489 / 277; cache read through PostgREST 89 and 66 ms (4 ms locally).
  - `slow=stats` past the 800 ms per-call timeout: 1120 / 903 and
    1071 / 870, stats cut at 801-802 ms, partial.
  - `fail=feed`: 659 / 406 and 581 / 355, partial.
  - all upstreams failing: http 502 with the per-upstream report; a second
    user never received the first user's cached rows; `fanout_cache_put`
    as a user 403 `42501`, `private` schema 406 `PGRST106`.
- Cold start, reproduced twice: the first `fanout-api` call after a deploy
  answered http 502 (3314 ms, then 4203 ms after a redeploy); every later
  call passed. Likely cause (inferred, not confirmed from the 502 body or
  function logs): the four parallel calls each hit a cold `upstream-mock`
  isolate and all exceeded the 800 ms per-call timeout, which is the
  all-failed path. Run 2 without a redeploy had a first call of http 200 in
  639 ms. For a live demo, make one warm-up call after deploying.
- Not measured: hosted latency from any vantage other than the operator's
  machine; behaviour under concurrent load; upstreams that are not Edge
  Functions. Artifacts `evidence/20261008-2025*/` and
  `evidence/20261008-202628/` (gitignored).

## 2026-10-08 - agent chat loop local runner - built, model run pending

Added `make agent-local ENV_FILE=<path>` (`scripts/agent-local.ts`): K03's
chat checks on a throwaway local stack. Verified only with a dummy key
(an `ANTHROPIC_API_KEY` value that is not a key) and with an env file
holding no key. No chat scenario has run against a model yet, locally or
hosted.

- Code: K03's scenarios moved unchanged into `lib/agent-chat-checks.ts`,
  which `tests/k03-agent-chat.ts` and the local runner both call. One
  behaviour change: a first chat call answering `llm_error` (rejected key,
  unreachable API, timeout) now gives one K03 FAIL `BLOCKED: ...` with the
  reason, instead of eight failures with the same cause. The local-stack
  helpers moved out of `scripts/bff-local.ts` into `lib/local-stack.ts`, and
  the seed data out of `scripts/kit.ts` into `lib/seed.ts` (same SQL text).
  `functions serve` output now goes through one fd: with two `Bun.file`
  handles, stdout and stderr overwrote each other in `functions-serve.log`.
- Dummy key, 5 runs (Supabase CLI 2.120.0; the serve log reports
  `supabase-edge-runtime-1.77.4`; images already pulled): E01 and T01-T06
  pass; K03 FAIL `BLOCKED: the model call failed, so no chat scenario ran
  (http 502 llm_error: The assistant could not answer: the model API
  rejected the configured key.)`, exit 1, about 36 s end to end.
  `supabase start` 24640-25418 ms; agent ready 2259-3247 ms after serve.
  First run: `embed_8_ms` 3143, tool calls 6-24 ms (T02-T05), `gate_ms`
  293. T06: alice's top `search_kb` hit was `Sales client entertainment`,
  carol's 5 hits were company/Marketing only. Artifacts
  `evidence/agent-local-2026-10-08T10-1*.json` (gitignored).
- Env file without the key: same seven pass, K03 SKIP (503
  `llm_not_configured`), exit 0.
- Leak checks with the dummy key: no match for the key in the console
  output, `evidence/`, or the workdir including `functions-serve.log` (it
  logs `llm error 401 API key is invalid.`). During the run the key is in
  the `supabase_edge_runtime_kit-agent-local` container's `Config.Env` (1
  entry); after the run no `kit-agent-local` container is left, and after a
  `KEEP=1` run the four kept containers had no matching entry.
- Ctrl-C after seeding: `SIGINT: stopping`, stack stopped, exit 130, no
  `functions serve` process or container left. Ran beside a `KEEP=1`
  bff-local stack (5442x) without a clash; `make bff-local` on the shared
  lib still passes 8 of 8.
- Pending: the real-key run (`make agent-local ENV_FILE=...`), then K03
  against `kit-ready`.

## 2026-10-08 - BFF fanout-api demo - local only, NOT YET RUN LIVE

Added `supabase/functions/fanout-api` (one app request, four upstream calls
in parallel, per-call timeout, partial results, per-user cache),
`supabase/functions/upstream-mock`, `sql/50-fanout.sql` (cache in
`private.fanout_cache`), `lib/bff-checks.ts` (checks shared by K05 and the
local run), `tests/k05-fanout-api.ts`, `scripts/bff-local.ts`, and the
`bff-test` / `bff-local` / `bff-deploy` targets. Nothing deployed: `make
bff-deploy` and K05 against a project have not been run.

- `make bff-test`: 11 of 11 Deno unit tests pass (`--no-remote --no-npm`,
  fake fetch that honours the AbortSignal, in-memory cache), 295 ms.
- `make bff-local` on a local stack (Supabase CLI 2.120.0, Docker; db, auth,
  rest and kong only, `supabase functions serve` for the functions; ports
  shifted to 5442x): 8 of 8 checks pass, artifact
  `evidence/bff-local-2026-10-08T09-59-19-565Z.json` (gitignored). Mock
  delays (the defaults in `upstream-mock/index.ts`): profile 250 ms, feed
  180 ms, inbox 120 ms, stats 60 ms; per-call timeout 800 ms; 5 requests
  per timed row, client wall time measured on the same host as the stack.

| Check | Result (last request) | Wall ms, median (min-max) | Server `total_ms` median |
|---|---|---|---|
| L02 all upstreams ok, cache read skipped (`refresh=1`) | 4 of 4 upstream ok, `partial: false` | 273 (270-276) | 266 |
| L03 next call, cache hit | profile + feed from cache, inbox + stats live; cache read median 4 ms | 143 (136-158) | 136 |
| L04 stats slow (3 s) | stats `timeout` at 804 ms, other 3 ok, `partial: true`, http 200 | 815 (813-817) | 807 |
| L05 feed forced 503 | feed `error` http 503, other 3 ok, `partial: true`, http 200 | 199 (194-204) | 192 |

  L01: no token and a tampered signature both 401 at the gateway. L06: all
  four forced to fail -> http 502 with the per-upstream report. L07: a
  second user's first call was a cache miss, and both the response
  `user_id` and the profile's `user_id` were that user's. L08: `fanout_cache_put` as a user -> 403 `42501`; the
  `private` schema through the Data API -> 406 `PGRST106`;
  `fanout_cache_get` returned the caller's 2 rows (feed, profile).
- Cold start in that run: the first `fanout-api` call took 2246 ms
  (isolate boot plus the npm imports); `supabase start` took 24864 ms with
  images already pulled.
- Negative control (scratch script, same stack, not committed): with the
  cache policy changed to `using (true)` and insert/update/execute granted to
  `authenticated`, L07 and L08 failed (the second user's profile came from
  the cache carrying another user's id; the user's own `fanout_cache_put` returned 200 and
  `fanout_cache_get` returned 8 rows), the other six still passed. Restored
  by reapplying `sql/50-fanout.sql`.
- Manual pass with curl and a session minted through the Auth admin API plus
  password sign-in on the same stack (an earlier stack run, same code):
  `refresh=1` 267 ms server / 0.273 s curl; next call cache hit 150 ms /
  0.158 s; `slow=stats` 808 ms / 0.815 s with stats `timeout`;
  `fail=feed` 195 ms / 0.206 s. A `Server-Timing` header carries the same
  per-upstream figures.
- Not settled locally: function-to-function latency on the platform (the
  hosted `fanout-api` reaches the mock through the public functions URL;
  locally it goes through kong inside Docker), the cache round trip through
  hosted PostgREST, and cold starts on the platform.

## 2026-10-07 (later) - agent rehearsal of the troubleshooting segment, stage token, teardown

- Troubleshooting prompt run headless (`claude -p`, Claude Code 2.1.285,
  `claude-sonnet-5-5`) against the injected faults on the ready project:
  both faults found from advisors, `query_logs` and pg_stat_statements in
  46.5 s / 15 turns; the summary fix applied, the indexes-and-policy
  migration came back `{"status":"cancelled"}` (the MCP server's
  destructive-SQL confirmation, which `-p` cannot answer). One follow-up
  applied it with `alter policy` (15.9 s). Feed 2366-4343 ms -> 38-88 ms,
  summary 400 -> 200. Details: docs/OBSERVABILITY.md, "Rehearsal with a
  coding agent". Faults cleared; inventory identical to the snapshot.
- The same flags (`--setting-sources project,local --strict-mcp-config`)
  answered "None. No CLAUDE.md files were loaded" when asked what it loaded,
  with a user-scope CLAUDE.md present. The model's own account, not a trace.
- Cloudflare token `kit-stage-workers` (vault `CLOUDFLARE_STAGE_WORKERS_TOKEN`):
  hello-world Worker deploy 0 / 200, delete 0 / 404 with only the token and
  account id in the environment; 403 on DNS, zone settings, R2, members.
  Needed Workers KV Storage Read as well as Scripts Write. NOT RUN: the
  OpenNext app deploy with it.
- `scripts/stage-agent.sh` in a live session (stub workspace, after
  `/login` in `~/.claude-stage`): `/context` no memory files, `/hooks` 0
  configured, `/skills` no user or project skills; model Sonnet 5.5 from
  managed settings. The `/memory` menu still names `~/.claude/CLAUDE.md` as
  the user edit target, which suggests `--setting-sources project,local`
  rather than `CLAUDE_CONFIG_DIR` keeps it out (inferred; the flags were not
  tested separately).
- Chat loop still NOT RUN: needs a Console API key; a claude.ai subscription
  login is not permitted inside a product.
- `make destroy` equivalent: plan read (2 to destroy, only the two kit
  projects), applied; state empty, no kit projects left in the org.

## 2026-10-07 - demo gaps: chat hardening, deploy, provisioning, webhook, troubleshooting

Rebuilt from empty state first (`tofu plan` read, then applied; the
`~/.supabase/access-token` keyfile PAT now returns 401, so every step ran
under `sx SUPABASE_ACCESS_TOKEN`). Final matrix on the ready project through
`make probe` on macOS: K01 + K02 + K03 + K04 = 35 pass, 0 fail, 1 skip (K03,
no Anthropic key).

Agent chat:

- `make fn-secret ANTHROPIC_ITEM=<vault item>` sets the function secret from
  the vault without the value reaching argv or stdout (`sx` injects it, the
  CLI reads it as an env file on stdin). The stdin path was tested with a
  dummy secret, set and unset. No Anthropic key was available, so the
  secret is still unset.
- Agent function: model calls in one request now stop at 120 s (the runtime
  cuts a silent response at 150 s); a model failure after a confirmed write
  returns 200 with the transcript and an `error` field instead of a 502 that
  hid the write and left a dangling tool call; a refused turn is dropped
  from the transcript; the user-editable display name is quoted in the
  system prompt. Request parameters checked against current API docs and
  unchanged. Redeployed; `/assistant` restores the confirmation card when a
  confirm call fails. `next build` passes.
- K03 (chat + confirm, DB-checked outcomes, KB and user-message injection)
  written. Chat loop NOT RUN: no Anthropic key.

Deploy path and self-service backends:

- `make app-deploy` (kit-ready, workers.dev): 35 s. `/login` 200,
  `/dashboard` 307 to `/login` signed out; signed in through the
  `@supabase/ssr` cookie, alice and bob get both Sales requests, carol only
  the Marketing one. `make app-delete` removed it (404 afterwards). Wrangler
  auth: the email + global key pair; the Workers token at hand failed with
  10000.
- Live deploy recipe, on a fresh `create-next-app -e with-supabase` pointed
  at kit-live: as scaffolded (next 16.4.0, OpenNext 1.20.9) every page 500s
  on "Unexpected loadManifest(/.next/server/preview-props.json)"; next 16.3.8
  with `cacheComponents: true` hangs until the runtime cancels the request.
  Both needed: next 16.3.8 and no cacheComponents. `migrate` also defaults
  to an R2 cache bucket, an image binding and a Worker named `app-name`;
  `make live-app-prep` writes a plain Worker config instead. Then
  `npm run deploy` 26-33 s (three runs): `/` and `/auth/login` 200,
  `/protected` 307 signed out and 200 with the user's email for alice and
  carol. `make live-app-delete` removed it.
- `create-next-app -e` failed ("Could not locate an example") while the
  unauthenticated GitHub API limit was exhausted; 33-37 s once it reset.
- `make new-app NAME=demo1` (`PLAN=1`, plan read, then applied), twice:
  plan 2 s ("1 to add, 0 to change, 0 to destroy", only
  `supabase_project.app["demo1"]`), apply 5-6 s, healthy on the first poll,
  baseline + RLS check 3 s; 15-16 s request to ready. RLS on 2/2 public
  tables, private helpers SECURITY DEFINER, anon has no select on profiles.
  A plain plan with the app present: no changes. `make remove-app`: 1 to
  destroy, only that app. Both test apps removed.

Integration (decision webhook) and access control:

- `make integrations` on the ready project: pg_net enabled, trigger
  `on_purchase_request_decided`, `webhook-sink` deployed with JWT
  verification off (shared-secret header instead), secret stored as a
  function secret and in Vault, URL in Vault. No Slack URL set. Added to
  `make up` after `fn-deploy`.
- K04 8/8 in each run: the manager's approval through the Data API produced
  exactly one receipt, 235 ms and 315 ms from decided_at to receipt; payload
  keys are the 12 listed fields of the decided row only. The employee's
  self-approval and a cross-department rejection were refused ("not
  permitted or not found") and sent nothing in 8 s. With a wrong secret the
  sink answered 401 and the decision still committed; with the URL on a
  .invalid host pg_net logged "Couldn't resolve host name" and the decision
  still committed. One run logged that error twice for one decision; cause
  not established.
- pg_net's PUBLIC grants on `net.*` belong to supabase_admin: `postgres`
  cannot revoke them (REVOKE is a no-op warning). Users stay off net
  because anon/authenticated cannot log in and net is not exposed.
- docs/ACCESS-CONTROL.md: tiers re-read from docs and pricing. Pricing is
  self-inconsistent on dashboard SSO for Team (card yes, table "Contact
  Us"); audit log drain tier not stated. OpenAPI re-check: 169 operations,
  still only GET members for org membership. `supabase_read_only_user`
  has BYPASSRLS + pg_read_all_data, so dashboard Read-only sees all
  departments.

Troubleshooting segment:

- `make fault-inject` on the ready project: `activity_events` (policy with
  unwrapped `auth.uid()` and private helpers, no indexes) and
  `activity_summary()` (division by zero). At 400,000 rows the feed hit the
  8 s `authenticated` statement timeout (500 after 8039-8083 ms), so the seed
  is 100,000; then the feed answers 200 in 2408-5557 ms (alice) and
  3775-5310 ms (bob), the summary 400 `22012 division by zero`.
- All three surfaces saw it on the first check: performance advisor
  `auth_rls_initplan` (WARN) and two `unindexed_foreign_keys` (INFO);
  pg_stat_statements calls=26 mean=3401.8 ms for the PostgREST feed
  statement and no entry for the failing RPC (only completed statements are
  recorded); logs endpoint 25 edge 200s (origin_time p50 3741 ms), 25 edge
  400s and 24 postgres ERROR 22012 lines with `parsed.query_id`. MCP
  `get_advisors` and `query_logs` returned the same findings.
- Fix applied through MCP `apply_migration` (wrapped policy, indexes on
  `created_at desc` and both FKs, `nullif` in the summary): feed 33-83 ms,
  summary 200 in 49-73 ms. EXPLAIN as alice 1081-1466 ms -> 0.25-0.35 ms;
  FK indexes alone leave it at 375-425 ms.
- Metrics API scraped once (Basic `service_role` + secret key): 200, 306
  families, 872 samples; 401 without credentials.
- `make fault-clear`: inventory identical to the pre-inject snapshot (64
  objects), no migration rows left. Not run: a coding-agent session with the
  prompt, and the Explorer query in the dashboard.

Housekeeping (self-correcting loop graph, three nodes, each green against
its sensors; diff reviewed and adjusted by hand afterwards):

- `make probe` runs on macOS: non-Linux hosts run `bun harness/src/run.ts`
  instead of the linux-x64 `pvlab`; the Linux build is unchanged and still
  compiles. One loop iteration saw 26 pass, 1 fail: K01.01 counted a K02
  row another concurrent run had not yet cleaned up. Tests that share the
  seeded users are not safe to run concurrently.
- live/AGENTS.md: user-facing business-rule errors come from
  `raise exception ... using errcode` in a SECURITY INVOKER function or
  trigger, not a bare constraint (the rehearsal's raw check-constraint
  error).
- `make stage-agent` / `scripts/stage-agent.sh`: isolated
  `CLAUDE_CONFIG_DIR`, `--setting-sources project,local`,
  `--strict-mcp-config`. Tested with a fake `claude` on PATH (env, cwd,
  args, dry run launches nothing). NOT RUN in a live session.

## 2026-10-06 - rebuild and first live-segment rehearsal

- `make up` from an empty state recreated both projects; K01 + K02 = 27 pass,
  0 fail (chat still `llm_not_configured`). On macOS the probe step fails
  because `harness` compiles `pvlab` for linux-x64 only; the same run through
  `bun harness/src/run.ts` gave the result above. The local `secrets.tfvars`
  had the token line as a quoted placeholder, which beats `TF_VAR_` and made
  `tofu apply` reject the saved plan; commenting it out fixed it.
- `make live-reset` (dry run) on the live project: nothing beyond the
  baseline.
- Rehearsal: the docs/LIVE-SEGMENT.md prompt, pasted unchanged into an
  interactive Claude Code session (Sonnet 5.5) in the workspace, with
  `--strict-mcp-config` so the scoped server was the only MCP server. The
  pre-run check ("what are the kit rules for a new table?") restated the
  guardrails without tool calls. Wall clock from prompt to a running dev
  server: about 5 min 40 s (targets total 14 min).
  - Schema: 4 migrations in about 2 min, both advisors after each; only
    "unused index" findings on the new indexes, reported as expected.
  - All four trap moments handled in the database: update grant on `status`
    only, behind a manager-only policy; a trigger owns approver, timestamps
    and legal transitions; department and requester from defaults, pinned by
    `with check`, plus a composite FK so a loan cannot reference another
    department's item; self-approval refused by a check constraint; one
    approved loan per item as a partial unique index.
  - Prove-the-rules: 39 assertions as alice and bob in a rolled-back
    transaction, all as expected except one invalid probe (alice reading
    `auth.users`, permission denied). Self-approval surfaces as a raw
    check-constraint error rather than a readable message.
  - App: sign-up, password reset and tutorial files removed; `/auth/sign-up`
    and `/` redirect to `/auth/login` (307); `.env.local` holds only the URL
    and publishable key and is gitignored.
  - Session-level noise: the operator's user-scope Claude Code hooks blocked
    `npm` (the agent switched to `bun run`) and the user-scope instructions
    leaked into the agent's narration. A stage session should run under a
    clean Claude Code profile.

## 2026-10-05 - in-app agent and live-segment tooling

- Agent function deployed with the Supabase CLI (`--use-api`); Management
  API shows it active with `verify_jwt` on, and a call without a JWT returns
  401.
- 8 knowledge-base rows embedded with gte-small, all 384 dims, norm 1.0.
  Same question about Sales spend: the Sales employee's top hit is a Sales row
  (0.933); the Marketing employee gets no Sales-only rows.
- K02 11/11 pass through the function's tool layer (the same path the chat
  loop uses): a write without confirmation writes nothing; the employee's
  self-approval and a cross-department decision are both refused by the
  database ("not permitted or not found"); the same-department manager's
  approval succeeds; forged requester, department and status fields are
  ignored; 7 of 7 executed calls appear in `agent_audit` as the right user.
  K01 controls updated for the larger knowledge base; K01 + K02 = 27 pass.
- Chat loop NOT RUN: no valid Anthropic key was available, so `chat` and
  `confirm` return 503 `llm_not_configured`.
- `make live-reset` tested on the live project: 11 agent-style objects
  (tables, view, sequence, enum, public and private functions, an extra
  policy, column and index on profiles, one migration-history row) listed,
  dropped and confirmed gone after the baseline was reapplied; users and
  profiles kept. No coding-agent run against the live project yet.

## 2026-10-05 - first run (two micro projects, Team org, ap-southeast-1)

- `make up`: apply created both projects (about 5 s each in tofu, health
  checks passed shortly after); all three SQL files applied cleanly to both,
  including the trigger on `auth.users` as the `postgres` role.
- Seed FAILED on the first user: the Auth admin API returned 500 with
  `null value in column "department_id" of relation "profiles"`. The
  departments rows existed and the request carried
  `app_metadata.department`, so the insert trigger ran before the department
  was in `raw_app_meta_data` - the admin create writes app_metadata after the
  initial insert. Fix (00-baseline.sql): one trigger on
  `insert or update of raw_app_meta_data`; no profile is created until the
  department resolves (signed in, no access), then it is upserted. After the
  fix every seeded user had the expected department and role.
- K01: 16/16 pass after adding three positive controls (the original 13 also
  passed, but their "0 rows from another department" probes would pass for a
  user who could see nothing). Refusals are for the intended reason: column
  grants (`permission denied for table profiles` / `purchase_requests`), RLS
  through `decide_purchase_request` (`not permitted or not found`), and anon
  blocked by grants on the table and the function.
- Data API path (publishable key + password sign-in, supabase-js): employee
  sees own department only, cannot approve; manager of the same department
  can; an insert lands as `pending` with department and requester from the
  session.
- App: `next build` + `next start` against the ready project - `/` and
  `/login` 200, `/dashboard` unauthenticated redirects to `/login`.

## 2026-10-05 - scaffold, NOT YET RUN

Tofu (two micro projects in the Team org), kit SQL (00 baseline, 10 example
app, 20 agent schema), seed script and the K01 RLS matrix written. Nothing
applied or measured yet; no result in this file is a finding until a run line
below says so.

Same day: web app added under `app/` (Next.js + OpenNext, reused from an
earlier notes demo, switched to bun and to the publishable key, sign-up and
OAuth removed, notes replaced by purchase requests). `next build` passes with
placeholder env values; not yet run against a project.

Dependencies brought current: next 16.3.8, react / react-dom 19.3.0,
eslint-config-next 16.3.8; caret ranges already resolved to latest. Two held
back on purpose: typescript at ^6 (typescript-eslint 8.71.0 refuses TS 7, and
the `@typescript/typescript6` alias package self-resolves under bun, so it
exports nothing) and eslint at ^9 (eslint-plugin-react, pulled in by
eslint-config-next, still calls `context.getFilename`, removed in ESLint 10; its
peer range stops at ^9.7). `bun run lint`, `next build` and the OpenNext
`build:cf` all pass. `bun audit`: one high (braces <=3.0.3,
GHSA-vfj7-8cjw-p6xm) via the shadcn CLI and the Next ESLint plugin - dev
tooling only, and no patched braces is published.
