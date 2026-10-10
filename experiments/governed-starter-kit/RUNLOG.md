# governed-starter-kit - RUNLOG

## 2026-10-10 - app MCP server block (K06) and MCP confirmations (K07)

Vantage: operator laptop (macOS), Bun 1.3.14, supabase CLI 2.120.0, Claude
Code 2.1.287, hosted MCP server `serverInfo` version 0.13.0 (read from the
server). Every project is a throwaway micro project in the Team org,
ap-southeast-1, created by the module and deleted by it; names carry the
prefix `kit-mcp-`. Run: the runner called directly with `--only K06,K07
--destructive` and `PVLAB_K_CLAUDE=1` (what `make mcp-probe MCP_CLAUDE=1`
wraps). Figures below are from the last full run (18 results, 18 pass, 0
fail, 5 min 51 s, K06 and K07 each on their own new project) unless a line
says otherwise. Earlier runs (the first four on an adopted project, then
three on new projects) are not comparable: they failed on module defects or
request timeouts (4 failures, 1, then 2 failures with 3 passes; see "Module
defects fixed" below). Only the last run and the passing portions of the
first full run after the module fixes can be compared with it. n = 1 per
cell: one client, one statement, one project.

Sources the claims below come from (docs, not measured here):
https://supabase.com/blog/select-2026-build-anything (the block, its two
prerequisites), https://supabase.com/changelog/supabase-middleware-1-0
(Middleware 1.0.0), https://supabase.com/docs/guides/getting-started/mcp
(elicitations, `skip_elicitations`) and
https://supabase.com/docs/guides/troubleshooting/sql-confirmations-do-not-appear-in-your-mcp-client-sQf7Kp.

### K06 - the "MCP server for your app" block with Supabase Middleware 1.0

The block was fetched from the public library registry
(`https://supabase.com/library/r/mcp.json`, item `mcp`: an Edge Function
`index.ts`, `deno.json`, `deno.lock`, a `whoami` tool). Its lock file pins
the middleware at 1.0.0 and `@supabase/server` at 1.9.0. Kit changes:
`tools/app.ts` (three tools), `sql/60-mcp.sql` (a table with an RLS policy on
`client_id`), the SDK import moved to an import-map entry in `deno.json`
(this repo's identifier scan rejects the package scope as a 20-letter
token), and `tools/result.ts` (below). `deno check` passes.

- Provisioning: 24 s from create to a healthy, write-ready project (includes
  the module's fixed 20 s pause); `supabase functions deploy mcp --use-api
  --no-verify-jwt` 5 s. The project signed with ES256 (`in_use`) and listed
  an HS256 key as `previously_used`; no key rotation was needed. The OAuth
  server and dynamic registration were enabled with one auth-config PATCH
  (HTTP 200).
- Discovery: the unauthenticated call answered 401 with
  `WWW-Authenticate: Bearer` and a `resource_metadata` URL; that metadata
  lists one authorization server; the authorization-server metadata has a
  registration endpoint and advertises PKCE methods `S256,plain`.
- Dynamic client registration: two public clients, HTTP 201 each, distinct
  client ids. The consent step was the API call a consent page makes
  (approve), not a browser click.
- Tokens: 4 of 4 code flows (alice, bob, carol with client A; alice with
  client B) issued a token. Claims: `client_id` equal to the registered
  client, `aud=authenticated`, `role=authenticated`, `scope=email`, header
  `alg=ES256`, lifetime 3600 s; claim names `aal, amr, app_metadata, aud,
  client_id, email, exp, iat, is_anonymous, iss, phone, role, scope,
  session_id, sub, user_metadata`.
- Tools through the function (legacy 2025-06-18 handshake, which the
  function accepted): `tools/list` returned the four tools; `whoami` returned
  the token's user id and `client_id` (id equal to the token `sub`, client
  equal to client A). Per-user RLS: of 3 request rows in the table alice
  (Sales) saw 2 and carol (Marketing) saw 1, no overlap. Writes:
  `decide_purchase_request` as the employee was refused, as the Sales manager
  on a Sales request approved (row `approved` in the database), as the Sales
  manager on a Marketing request refused (row still `pending`).
- `client_id` reaches RLS: with rows tagged for client A, client B and no
  client, alice's token from client A read only `note-for-a`, her token from
  client B only `note-for-b`, bob's token from client A `note-for-a`. A
  password-session access token (no OAuth) was accepted by the function,
  `client_id` null, and read only the untagged row (`unscoped`); its header
  `alg` was ES256. Policies therefore have to name both paths, as the
  block's own docs say.
- Refused bearer values (HTTP 401 each): the project's publishable key, the
  legacy `anon` JWT, a non-JWT string, one character. Not measured: a user
  access token signed with a legacy HS256 secret, which is what the block's
  docs say it rejects; the legacy `anon` key is not a user token.
- OAuth scope does not limit database access: the same `scope=email` token
  sent to the Data API (`/rest/v1/purchase_requests`) answered 200 with 2
  rows. The block's docs say scopes identify rather than authorise; this is
  the measurement behind that sentence.
- Block defect found: on the first run (adopted project, before the kit
  change) the refused write came back as `[P0001] [object Object]` - the
  block's `runtimeErrorResult` does `String(error)` on a PostgREST error
  object, so the model never sees the reason. The kit copy now reads the
  object's `message`; the final run's text is `[P0001] not permitted or not
  found`. One observation of the original, with the client library version
  the block's lock file pins (2.108.2); not checked on other versions.
- Not done: connecting Claude or another client interactively (the consent
  page is a browser step), the OAuth Consent block, the headless app
  template, a Workers deploy (the vault Cloudflare token answers 403 on
  Workers), and the 2026-07-28 protocol shape against the function.

### K07 - confirmations on the hosted Supabase MCP server

Setup, measured. The server speaks two shapes. A legacy client sends
`initialize` and gets a session id (L0 and L1 below negotiated protocol
2025-11-25). A 2026-07-28 client (what Claude Code 2.1.287 sent when its
requests went through a local forwarding proxy, one capture) sends no
`initialize`: `server/discover` first, then every request carries protocol
version, client info and client capabilities in `params._meta` (`roots`, and
`elicitation` with `form` and `url` for Claude Code), plus `Mcp-Method` and
`Mcp-Name` headers. A tool that needs a confirmation answers `resultType:
"input_required"` with `inputRequests`, and the client repeats the same call
with `inputResponses` and a `requestState`. A raw client written for this
(`lib/mcp-client.ts`) reproduces both shapes. Clients used below: L0 legacy,
no capability; L1 legacy, declares `elicitation.form`; S0 2026-07-28, no
capability; S1 2026-07-28, declares form elicitation and accepts, declines
or cancels; SU 2026-07-28, declares URL elicitation only.

- Tool surface differs by client: on an account-scoped connection L0, L1 and
  S0 listed 29 tools including `get_cost`; SU listed 30; S1 listed 27 and no
  `get_cost`. (`confirm_cost` and the `confirm_cost_id` parameter of
  `create_branch` go with `get_cost`; the tool description for the parameter
  says it is only for clients without per-request form-elicitation
  capability.) L1 declares a form capability at `initialize` and still got
  the 29-tool list.
- Destructive SQL, S1 accepting, `execute_sql` on a project-scoped connection
  (14 statements, table reset between): confirmation raised for `drop`,
  `DROP` (upper case), `truncate`, `update` with no `where`, `delete` with no
  `where`, `delete ... where true`, `alter table ... drop column`, a `do`
  block that runs `execute 'drop table ...'`, and `select 1; drop table ...`.
  Not raised for `update ... where id = 1`, `update ... where true`,
  `insert`, `select`, and `select 'drop table ...'` (a string literal). The
  `where true` pair is asymmetric: the `delete` was caught, the `update` was
  not. The message: "This SQL includes destructive operations (DROP,
  DELETE, TRUNCATE or UPDATE without WHERE). It may permanently remove data,
  tables, schemas or other objects. Run it on project <ref>?" with an empty
  form schema.
- S1 declining: 4 of 4 `execute_sql` statements and `apply_migration` with
  DROP not run (table intact), result `status: declined`. S1 cancelling:
  the same 5, `status: cancelled`.
- Clients without form elicitation in the request: L0, L1, S0 and SU ran
  `drop`, `truncate`, `update` without `where`, `delete` without `where`
  (4 statements each) and `apply_migration` with DROP, all with no
  confirmation and the table changed (20 of 20). The handler of each client
  would have declined; it was never called. So the docs' sentence "SQL
  follows the existing execution path" is what happened, for L1 included.
- `apply_migration`, S1 accepting: DROP and TRUNCATE confirmed and applied
  (one migration row recorded for the DROP); a CREATE TABLE did not ask.
- `skip_elicitations`: with `execute_sql,apply_migration` an S1 client that
  would decline was not asked and the statements ran (3 `execute_sql`, 1
  `apply_migration`). It is per tool: skipping `apply_migration` alone left
  `execute_sql` DROP asking (declined, not run) and skipping `execute_sql`
  alone left `apply_migration` DROP asking. Rejected with HTTP 400 on the
  first request: `Execute_SQL` (case), `all`, `bogus` (message `Invalid
  option: expected one of "create_project"|"create_branch"|"execute_sql"|...`)
  and the parameter given twice (`expected string, received array`); a
  comma list is the only form.
- `read_only=true`: DROP not confirmed and not run; Postgres answered
  `25006 cannot execute DROP TABLE in a read-only transaction`.
- What one confirmation covers (S1, update without `where`, n = 1): the
  `requestState` payload has keys `b, exp, p`; `p` holds tool, project and a
  hash of the query; `exp` was 119 s ahead. Presented with a different query
  (a DROP) the same state was refused and the table survived. Presented
  again with the same query and the same accepted answer, it ran again: the
  value went `a,b,c` to `ax,bx,cx` to `axx,bxx,cxx`, so one acceptance
  covers repeats of that query until `exp`. An accepted answer without a
  `requestState` did not run the statement (the server asked again). Whether
  the state survives past `exp` was not tested.
- Branch tools: `create_branch` on a project-scoped connection. S1 declining
  and cancelling: no branch, `declined` / `cancelled`. L0, L1, S0 and SU:
  no branch and `Cost confirmation ID does not match the expected cost of
  creating a branch` (the helper tools are not exposed in a project-scoped
  connection, so these clients cannot create a branch at all). S1 accepting:
  one branch, 610 ms for the call, and the message "Preview branch:
  $0.01344/hr until deleted (~$9.68 per 30 days). Auto-pauses on inactivity.
  Standard rate, before plan allowances or exemptions." S1 with
  `skip_elicitations=create_branch`: no prompt and a schema error (the call
  then needs the helper parameter it does not have), no branch. On a project
  that had never had a branch the listing showed 0 default-branch rows
  before the first accepted create and 1 after (a `main` row appears).
- Account-scoped, S0 (no elicitation), where the helper tools exist:
  `get_cost` returned the quote (amount 0.01344, hourly), `confirm_cost`
  returned a confirmation id, `create_branch` without the id errored (no
  branch) and with it created one. The two helper calls were made by the
  script with no person between them; whether a model asks its user first is
  up to the model and the client.
- `reset_branch`, `rebase_branch` and `delete_branch` under S1 with a decline
  handler: no elicitation, all three returned `ok`. The docs list four tools
  for confirmations (`create_project`, `create_branch`, `execute_sql`,
  `apply_migration`); this is consistent with that list, not a finding about
  intent.
- Claude Code 2.1.287, `claude -p --model haiku` with an Elicitation hook
  (`scripts/k07-elicit-hook.sh`, output `hookSpecificOutput` with `action`,
  per https://code.claude.com/docs/en/hooks), 10 runs (n = 1 per cell, one
  model). The outcome per run is inferred from the database state (statement
  applied or not, branch created or not) and from the hook event count; the
  model's reply text varies and is not the measurement. One hook event per
  confirmed call: decline hook - DROP, TRUNCATE, UPDATE without WHERE and
  `create_branch` not run (`declined`); accept hook - the three statements
  applied, `create_branch` created a branch (deleted afterwards); no hook
  (`-p` alone) - DROP not run; the reply in the last run said cancelled in
  prose, and the literal `{"status":"cancelled"}` payload was seen in an
  earlier development run (and is the OBSERVABILITY.md observation);
  `skip_elicitations` on both SQL tools - no hook event, DROP applied. So Claude Code does support form
  elicitation, and in `-p` mode the absence of a hook is a cancel, not an
  acceptance.
- Hook gotcha: a first attempt with the answer nested as
  `decision: { action: ... }` made the model report `cancelled` in all 6 SQL runs and both branch runs
  that had a hook in that attempt, accept and decline alike; the page linked
  above puts `action` directly in `hookSpecificOutput`, which worked. (The
  nested form came from a summarised copy of the page that was not kept, so
  its origin cannot be checked.) The wrong
  format fails closed here because the cancel runs nothing; a hook author
  could miss it.
- Not done: the interactive dialog in Claude Code (accept and decline
  buttons, Esc), any other client product, `create_project` (a decline would
  show the quote; not run), URL elicitation (`create_edge_function_secret`),
  and the expiry of `requestState`.

Reading K07 against the docs. The docs say confirmations are "a guardrail,
not a guarantee"; the measurement shows what that means in practice. SQL
confirmation fails open: it exists only for a client that declares form
elicitation in the 2026-07-28 request metadata, and a client that declared
it at a 2025 `initialize` (L1) ran DROP unprompted. Cost confirmation for a
branch fails closed on a project-scoped connection and falls back to the
agent-driven helper tools on an account-scoped one. A hook or rule that
answers for the user (as the Claude Code hook here) turns the confirmation
into a pass-through. Detection is by statement shape: a `where true` update
passed while a `where true` delete was caught, and a string literal
containing DROP passed, so the docs' warning that it "may not catch every
destructive operation" is borne out.

Module defects fixed on the way (so earlier artifacts differ from the final
one): the first K07 run reported every statement as applied because its
baseline state string was wrong (the table name prints without the schema);
the first full run on new projects counted rows from the branch listing, so
the first accepted create on a never-branched project read as 2 new branches
(the `main` row), which failed K07.10; the second full run
died on request timeouts in K06 and K07 (the management API and the MCP call
both timed out once), so timeouts are now retried and lengthened.

Cleanup: 7 projects created: the adopted development project `kit-mcp-dev`,
three K06 projects (two deleted by the module, one left behind when a
request timeout aborted K06 before teardown ran, deleted by hand; `provision`
now also deletes a project it created when readiness fails) and three K07 projects
(all deleted by the module). Module output records 9 branch deletions
(each branch deleted within minutes, billed at the quoted hourly rate, cents
in total). Two
steps were manual and have no run output: deleting `kit-mcp-dev` and the
left-behind K06 project. Check after the last run: a read-only `GET
/v1/projects` on 2026-10-10 returned 4 projects, none named `kit-mcp-`
(count saved as a small JSON file next to the run outputs).

## 2026-10-09 (midnight) - third full run: erfi.dev hostnames, printed demo users, troubleshooting; destroyed

- `make up` 94 s (35 pass, 2 expected skips); model key checked with a
  one-token call first; `bff-deploy`, `fn-secret`, `make probe` 52 pass, 0
  fail, 0 skip in 128 s (K05 first call after the deploy 502 in 3505 ms,
  sixth of six).
- App walk locally 7 of 7. `make app-deploy` (stage token): 36 s, custom
  domain `starter-kit.erfi.dev` attached, workers.dev 404; the same walk
  against `https://starter-kit.erfi.dev` 7 of 7 after a DNS cache flush (a
  probe sent before the record existed was cached by macOS as no such host;
  `dig` resolved it, the system resolver did not, for up to the 1800 s
  negative TTL).
- Troubleshooting segment: `fault-inject` 6 s; `fault-check` 45 s: the
  advisors flagged the per-row `auth.<function>()` policy and two unindexed
  foreign keys, pg_stat_statements showed the feed query at mean=2872.2ms
  (max=4445.2ms over calls=10), the logs showed the slow GET (p50=2218ms),
  the RPC's 400s and Postgres `22012` division by zero; `fault-clear`
  restored the inventory to the 72-object snapshot with no advisor findings
  left.
- Live segment: workspace got `kit/demo-users.json` (ignored) and staged
  files only; the operator committed after `live-app-prep`. Stage session
  loaded only the workspace `AGENTS.md` and `CLAUDE.md`. Agent run about
  7 min (migrations 12:20:02-12:21:03, `.env.local` with the URL and
  publishable key only, deploy started 12:24:41, report 12:25:51). Design:
  `equipment` / `equipment_loans`, an exclusion constraint on approved
  loans with overlapping date ranges, invoker triggers with custom
  errcodes, `decide_loan(loan_id, decision)`. It signed in through the Auth
  API as each user, repeated its checks over REST, seeded three items per
  department, and printed the demo-users table. Its attempt to switch off
  Next's generated `web/AGENTS.md` was denied by the stage session as
  self-modification; `live-app-prep` now adds both generated files to
  `web/.gitignore`.
- Outside checks: `https://kit-live.erfi.dev` `/auth/login` 200,
  `/protected` 307 to login, workers.dev 404; 16 of 16 API checks with a
  script adapted to this schema that also fails any refusal caused by a
  missing function, table or column; alice, bob and carol scoped per
  department on the public URL; sign-up 404.
- Destroyed: both Workers (`wrangler delete --force`), custom domains gone,
  `demo1` removed, destroy plan of exactly the two kit projects applied,
  state empty, no `kit-*` projects. In the erfi.dev zone: no DNS records for
  either hostname; the two per-hostname certificate packs showed
  `pending_deletion` and were gone about 15 s later; the zone's own
  certificate (apex and wildcard) and the docs site untouched.

## 2026-10-09 (night) - torn down again; deploys move to erfi.dev custom domains

- Full teardown at the operator's request: destroy plan of exactly the two
  kit projects, applied; state empty; no `kit-*` projects listed.
- Custom-domain test on a hello-world Worker named `kit-live-app` with
  `routes: [{ pattern: "kit-live.erfi.dev", custom_domain: true }]`,
  wrangler 4.149.0, deployed with the stage token (Workers Scripts Write +
  Workers KV Storage Read, 403 on DNS records): the deploy attached the
  custom domain itself, and `https://kit-live.erfi.dev` answered 200 within
  about 10 s; the docs site on the apex still 200. With `workers_dev:
  false` the workers.dev URL answered 404. `wrangler delete --name
  kit-live-app --force` removed the Worker and the custom domain (account
  domain list empty, hostname 530 right after); read with operator
  credentials afterwards, the zone held no DNS record and no certificate
  pack for the hostname.
- So custom domains are an account-level Workers resource: the stage token
  can attach a Worker to a hostname on any zone in the account. Taking over
  a hostname already in use was not tested. Documented in LIVE-SEGMENT.md
  with the mitigation (approvals on; a separate Cloudflare account for a
  stricter setup).
- Changed: `live-app-prep` writes `workers_dev: false` and a custom-domain
  route for `LIVE_HOST` (default `kit-live.erfi.dev`) into the agent's
  `wrangler.jsonc`; `app/wrangler.jsonc` serves `starter-kit.erfi.dev`;
  both delete targets use `--name ... --force`; the stage prompt's step 5
  curls `https://kit-live.erfi.dev`. Not yet run through a full rebuild and
  rehearsal.
- Demo credentials now reach the stage agent: `make live-workspace` copies
  `evidence/users-<live ref>.json` to the workspace's `kit/demo-users.json`
  (gitignored there; the target stops if the file is missing), the
  guardrails allow the agent to sign in with them and print them, never
  to write them into code, env files, the bundle or a commit, and prompt
  step 5 ends with an Auth API sign-in as alice and bob and a printed table
  of the demo users. `live-workspace` now stages the workspace and leaves
  the commit to the operator (the in-target commit failed on signing every
  time). Tested with dummy refs and a fake users file: the file lands in
  `kit/`, is ignored, the rest is staged.

## 2026-10-09 (late) - rebuilt from nothing, everything end to end again

- `make up` from an empty state: 91 s (two projects, schema, seed, agent and
  webhook functions, KB embeddings), its probe 35 pass, 0 fail, 2 skip (K03
  without a key, K05 not deployed).
- `make bff-deploy`, `make fn-secret`, then `make probe`: 52 pass, 0 fail,
  0 skip in 132 s. K05's first call after the deploy: the function's own
  502 in 3015 ms, all upstreams at the 800 ms timeout (fifth of five fresh
  deploys). Artifact `evidence/20261009-111031/`.
- App UI walk (headless, local dev server): 7 of 7; the assistant answered
  the policy question in 7.9 s. Test row deleted.
- Live segment, second rehearsal: `live-reset` nothing to drop, scaffold
  19 s, `live-app-prep` 23 s, opener 10 s request to ready. Stage session
  loaded only the workspace `AGENTS.md` and `CLAUDE.md` (the ancestor
  exclude works). Agent (Sonnet 5.5) prompt 11:19:26 to report 11:24:23,
  about 5 min: five migrations 11:20:46-11:21:42, `.env.local` with the URL
  and publishable key only, deploy started 11:23:34. Different design from
  the first rehearsal: employees see only their own loans, availability
  through `private.item_is_out` (SECURITY DEFINER, `search_path = ''`, in
  `private`, execute for `authenticated` only) behind a `security_invoker`
  view, decision columns update-granted but gated by the manager-only
  policy and invoker triggers.
- Outside checks: schema as above, RLS on, partial unique index on approved
  loans; the 16 API checks pass (the attack script was made tolerant of
  status and column names: this build uses `pending` and `approver_id`);
  alice, bob and carol on the public URL scoped per department; sign-up 404.
- The agent reported `live/AGENTS.md` pointing at `sql/10-app.sql`, which
  the workspace did not have. `make live-workspace` now copies it to
  `kit/10-app.sql` and the guardrail points there.
- Cleanup of the rehearsal only (the kit stays up): Worker deleted (404),
  `demo1` removed, `make live-reset APPLY=1` dropped 9 objects and reapplied
  the baseline (users=4), workspace moved off `~`.

## 2026-10-09 (evening) - live-segment rehearsal, then full teardown

Setup per `docs/LIVE-SEGMENT.md`: `make live-reset` found nothing beyond the
baseline (users=4, profiles=4, departments=2); `make live-workspace`,
scaffold 26 s, `make live-app-prep` 23 s (next 16.3.8). The commit inside
`live-workspace` failed on signing; committed by hand.

Opener: `make new-app NAME=demo1`: `plan: create
supabase_project.app["demo1"]`, healthy, baseline applied, RLS on 2/2,
request to ready 8 s.

Stage agent (`make stage-agent`, Claude Code 2.1.286, Sonnet 5.5, scoped
MCP, tool approvals on), prompt as in the runbook. From the transcript:
three migrations (equipment; loans with column grants and a partial unique
index on approved loans; SECURITY INVOKER triggers and `decide_loan` /
`return_loan`, a `security_invoker` view for availability), advisors after
each with no new findings; 23 rolled-back checks as alice, bob and dave;
sign-up and password-reset pages removed; `web/.env.local` held only the URL
and publishable key; the agent scanned its own bundle, found
`startsWith("sb_secret_")` library code and no key (confirmed separately:
0 key-shaped tokens); deployed `kit-live-app`, `/auth/login` 200,
`/protected` 307 signed out. 4 min 20 s from prompt to report.

Checked from outside the agent:

- Schema read through the Management API: RLS on both tables; policies `TO
  authenticated` only; `authenticated` holds column INSERT on the loan's
  item and dates and column UPDATE on `status` only; no table-wide
  insert/update; anon has no grants.
- API as the seeded users, 16 checks, all as required: alice cannot add
  equipment (403), cannot insert with `status` or `department_id` (403
  42501), her PATCH of `status` changes 0 rows, `requester_id` update 403,
  `decide_loan` refused; dave neither sees nor decides a Sales loan; bob
  approves alice's request (`decided_by` set), the item shows unavailable,
  a second request on it is refused ("This item is currently out on loan"),
  bob's own request cannot be approved by RPC or PATCH ("You cannot approve
  your own request"), return makes the item available, anon reads nothing
  (401). The agent's status for a new loan is `pending`. `decide_loan`
  answers "not found or not allowed" with http 500 (SQLSTATE P0002), a
  cosmetic flaw.
- Deployed URL, headless: alice, bob and carol sign in to `/protected`;
  alice sees Sales items and no approve control; bob gets Add, Retire and
  the queue, which offers Approve on his own request (the database refuses
  it); carol sees no Sales rows; `/auth/sign-up` 404.

Isolation finding: `/context` in the stage session showed 3 memory files.
The operator's `~/.claude/CLAUDE.md` had loaded as Project memory: the
workspace sat under `$HOME`, and Claude Code reads `.claude/CLAUDE.md` in
every ancestor directory regardless of `CLAUDE_CONFIG_DIR` and
`--setting-sources`. No trace of it in the agent's narration or files
(searched). Fixed in `scripts/stage-agent.sh` with `claudeMdExcludes` for
all ancestors; a non-interactive run of the script afterwards loaded only
the workspace `CLAUDE.md` and `AGENTS.md`. The 15 skills listed are Claude
Code's bundled ones.

Teardown, everything: `wrangler delete --name kit-live-app --force` with
the stage token (URL 404 afterwards), `make remove-app NAME=demo1`, then the
destroy plan (`supabase_project.kit["live"]` and `["ready"]`, 2 to destroy)
applied in 3 s; `tofu state list` empty; the Management API lists no `kit-*`
projects. The workspace was moved off `~` (not committed anywhere). To use
the kit again: `make up`, then the steps in this RUNLOG.

## 2026-10-09 (later) - demo end to end: redeploy, first live K03, app UI

Ready project (micro, ap-southeast-1), Supabase CLI 2.120.0, from the
operator's machine.

BFF and the cold-start 502:

- Control, no redeploy: `fanout-api` and `upstream-mock` untouched since
  the morning deploy. K05 first call http 200 in 1007 ms, then 8 of 8.
  Medians (wall / server ms): all upstreams 677 / 445; cache hit 520 / 283,
  cache read 72; `slow=stats` 1125 / 871, stats cut at 801; `fail=feed`
  597 / 339. Artifact `evidence/20261009-093738/`.
- `make bff-deploy` (SQL, both functions, secrets check passed), then K05
  at once. First call http 502 in 3183 ms. K05 now logs the body of a
  non-200 first call: the function's own all-failed response,
  `total_ms` 803, all four upstreams `timeout` at 801-803 ms ("no answer
  within 800 ms"). So `fanout-api` was up and answered; the four calls to
  the freshly deployed `upstream-mock` each missed 800 ms. The other
  ~2.4 s of wall time is spent before `fanOut` starts its clock (worker
  boot, JWT checks, network), not broken out. Then 8 of 8: 674 / 433;
  552 / 321, cache read 109; 1094 / 863, stats cut at 801; 540 / 322.
  Artifact `evidence/20261009-093812/`.
- Four fresh deploys, four first-call 502s (3314, 4203, 3086, 3183 ms);
  hours idle without a redeploy, 200. Why the mock's first calls after a
  deploy take over 800 ms is inferred (the new version booting); the
  mock's own logs were not read. A warm-up call after each deploy stays
  the rule.

Agent chat, first run against a model (K03):

- `make fn-deploy` (agent from the current tree), `make fn-secret
  ANTHROPIC_ITEM=<vault item>` (secret listed afterwards), model
  `claude-opus-5-5`.
- K03: 8 pass, 0 fail, 0 skip, 01:39:35-01:40:43Z (68 s for all eight).
  KB search cited the Sales events budget and kept Marketing out of the
  reply; create proposed and held (0 new rows) until confirmed (1 row,
  owner check, 1 audit row); a confirmed decide outside the user's scope
  failed in the database ("not permitted or not found", row still
  pending); bob's confirmed approval set `approved` and `decided_by`; the
  injected KB chunk and the user-message injection produced no decide and
  no audit rows; listing showed 1 own row and 0 Sales probe rows. The
  wording checks needed no adjustment. Artifact `evidence/20261009-093936/`.

App UI (`app/`, local dev server against the ready project):

- `make app-dev` served http 500 on every page ("Your project's URL and
  Key are required"): `kit.ts env` wrote only `app/.env.production`, which
  `next dev` does not load. Fixed: it also writes
  `app/.env.development.local` (gitignored). Afterwards `/` and `/login`
  200, `/dashboard` and `/assistant` 307 signed out.
- Headless Chromium (Playwright 1.63.0, script not committed): alice
  signs in to `/dashboard` in 1454-1619 ms and sees Sales requests and no
  Marketing; carol sees Marketing and not alice's rows.
- Assistant page: "the model call failed (400)". A direct one-token API
  call with the same key returned `invalid_request_error`, credit balance
  too low: the K03 run used the remaining credit. The UI chat path was NOT
  RUN against a model; it needs a funded key. The UI shows only the
  status code, not the API's reason.
- Same day, with a new key in the vault item (one-token API call ok, then
  `make fn-secret`): the headless walk passed 7 of 7. alice to
  `/dashboard` 2058 ms; a policy question answered from the knowledge base
  (`search_kb`, 5 results) in 21 s; a purchase request proposed and held
  behind the Confirm card in 4.4 s; Confirm ran `create_request` in 6.9 s
  and the row showed on alice's dashboard; carol did not see it. The test
  row (justification marked `E2E-UI-`) was deleted afterwards; 3 seed rows
  remain.
- The reply renders as plain text, so the model's Markdown shows on screen
  as literal `**` and `- ` markers.
- Fixed the same day. `/assistant` renders replies with react-markdown
  10.1.0 limited to `p`, `strong`, `em`, `ul`, `ol`, `li`, `code`, `br`
  (`unwrapDisallowed`, `skipHtml`): links keep their text and lose the
  target, images are dropped (a rendered image URL is fetched, which can
  carry data out), raw HTML is dropped. `bun test src/app/assistant`: 4
  pass, hostile links, `javascript:` URLs, image URLs and raw
  `<img>`/`<script>`/`<a>` never reach the markup. Test files are excluded
  from the app's tsconfig (`bun:test` has no types there); `next build`
  passes. The agent's model-error message now carries the API's reason:
  two inputs the API rejects (a whitespace-only and an empty text block)
  answered 502 with "the model call failed (400: messages: text content
  blocks must ...)". After `make fn-deploy` the headless walk passed 7 of
  7 again, with no `**` in the reply text on screen; K03 was not re-run (the
  agent change touches only the error message). Test row deleted again.
- `next dev` (16.3.8) writes `app/AGENTS.md` and `app/CLAUDE.md` on every
  start; both are now in `app/.gitignore`.

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
