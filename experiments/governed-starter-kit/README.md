# governed-starter-kit

A starter kit for internal apps that non-specialist teams build on Supabase,
with the guardrails owned by a platform team. Two throwaway projects in a
Team-plan org, rebuilt with `make up` and removed with `make destroy`.

| Project | What it holds | Used for |
|---|---|---|
| `kit-live` | Kit baseline only (`sql/00-baseline.sql`) | A coding agent builds the app on it |
| `kit-ready` | Baseline + example app (`sql/10-app.sql`) + in-app agent schema (`sql/20-agent.sql`) + decision webhook (`sql/30-integrations.sql`) | Fallback, the target of K01-K04, and the troubleshooting segment |

## What the kit enforces

- Tenancy by department. Department and role come from `app_metadata`, which
  only the secret key can write; users cannot move or promote themselves. A
  trigger on insert and on update of `raw_app_meta_data` keeps the profile in
  step; no known department means no profile and no access.
- RLS on every table, explicit grants (no reliance on default privileges),
  policies scoped `TO authenticated` with `(select auth.uid())`.
- Column-level grants: users may update their display name and nothing else
  on their profile; request rows accept only the request fields.
- Decisions go through `decide_purchase_request`, a `SECURITY INVOKER`
  function, so RLS still decides who may approve what.
- Helper functions are `SECURITY DEFINER` in a `private` schema that the
  Data API does not expose, with an empty `search_path`.
- The in-app agent schema (`kb_chunks`, `agent_audit`, `match_kb_chunks`)
  runs as the calling user, so retrieval and writes stay inside the same
  policies.

## Run

```bash
# live PAT in the env; secrets.tfvars holds a placeholder. Prefix each with
# `sx SUPABASE_ACCESS_TOKEN --` (the old ~/.supabase/access-token keyfile is revoked).
make up        # init, apply, wait-ready, schema, seed, fn-deploy, integrations, kb-embed, probe
make probe     # re-run K01-K05 against kit-ready (macOS runs the harness from source; K05 skips until make bff-deploy)
make destroy   # remove the projects
```

Seeded users (alice/bob in Sales, carol/dave in Marketing; employee then
manager) get generated passwords in `evidence/users-<ref>.json` (gitignored).
Knowledge-base rows carry placeholder embeddings until the agent's Edge
Function writes real ones.

## The web app (`app/`)

Next.js on Cloudflare Workers through OpenNext, adapted from an earlier notes
demo: `@supabase/ssr` clients, email/password sign-in, and a purchase-request
dashboard (submit; managers approve or reject through
`decide_purchase_request`). There is no sign-up page and no OAuth button on
purpose - users are provisioned with a department and role in
`app_metadata`, and a user without a known department gets no profile, so
they can sign in but see nothing until the platform team assigns one.

```bash
make app-dev                      # local dev against kit-ready
make app-dev APP_REF=<live ref>   # or against kit-live after a live build
make app-deploy                   # https://starter-kit.erfi.dev, needs wrangler auth
```

`make app-env` writes `app/.env.production` (gitignored) with the project URL
and publishable key; `NEXT_PUBLIC_*` values are inlined at build time.
`make destroy` deletes the Worker before destroying the projects (wrangler may
ask for confirmation).

## Manual steps tofu cannot do

- Org member and role assignment (project-scoped Developer, Read-only) has no
  Management API write below Enterprise (measured in `supabase-org-topology`;
  re-checked against the OpenAPI specs on 2026-10-07: v1 has only
  `GET /v1/organizations/{slug}/members`, and the v2 role and invitation
  writes carry `x-allowed-plans: ["Enterprise"]`), so invite members and set
  roles in the dashboard. They are not removed by
  `make destroy`. Walkthrough and plan tiers: `docs/ACCESS-CONTROL.md`.
- Dashboard SSO needs a SAML identity provider configured on the org.

## In-app agent

`supabase/functions/agent` (deploy with `make fn-deploy`) is an Edge Function
that acts strictly as the signed-in user: JWT verification on, a client built
from the caller's token (`withSupabase({ auth: 'user' })` from
`@supabase/server`), and every tool running through it, so RLS and grants
decide each outcome. Modes: `tool` (deterministic tool calls), `chat` (Claude
tool loop), `confirm` (runs a pending write after the user confirms), `embed`
(gte-small vectors, no table access). Tools: knowledge-base search, list
requests, create a request, decide a request. Write tools ask for
confirmation first; every executed call is written to `agent_audit` as the
caller. The `/assistant` page in the app is the chat UI.

`make kb-embed` replaces the seed's placeholder vectors with gte-small
embeddings (8 knowledge-base rows: 4 company-wide, 2 per department).

The chat loop needs an Anthropic key as a function secret:
`make fn-secret ANTHROPIC_ITEM=<vault item>` (under `sx SUPABASE_ACCESS_TOKEN`)
reads it from the vault and sets it without printing it. Without one, `chat`
and `confirm` return 503 `llm_not_configured`; the tool layer and K02 work
regardless, and K03 (the chat loop: confirmation-gated writes, outcomes
checked in the database, prompt injection through a knowledge-base row and
through the user's own message) skips with that reason. Model calls in one
request stop after 120 s, inside the runtime's 150 s idle limit; if the model
fails after a confirmed write, the reply still reports the write. K03 first
ran against a model (`claude-opus-5-5`) on 2026-10-09: 8 of 8 in 68 s
(RUNLOG). A failed model call shows the API's reason on the `/assistant`
page, e.g. "the model call failed (400: Your credit balance is too low...)".
Replies render as Markdown limited to paragraphs, emphasis, lists and inline
code: no links, images or raw HTML, since a reply can quote untrusted
knowledge-base text (`app/src/app/assistant/reply-markdown.tsx`; `bun test
src/app/assistant` in `app/` runs the hostile cases).

### Agent chat locally

```bash
make agent-local ENV_FILE=/path/to/anthropic.env   # file holds ANTHROPIC_API_KEY=...
```

Runs K03's chat checks (`lib/agent-chat-checks.ts`, shared with K03) on a
throwaway local stack in Docker: ports 5452x and project id
`kit-agent-local`, so it runs beside `make bff-local` (5442x) or a default
local stack. It applies `sql/00`, `10` and `20` (not the integrations file),
seeds the kit users the way `make seed` does (`lib/seed.ts`; passwords in
`evidence/users-agent-local.json`), serves only the `agent` function,
embeds the KB rows with gte-small through `embed` mode, runs six tool-mode
checks that need no model (T01-T06), then the eight K03 scenarios, writes
`evidence/agent-local-<ts>.json` and stops the stack. `ENV_FILE` is
required; its path goes only to `supabase functions serve --env-file`, and
nothing reads or prints its contents. While the function is served, the key
is in the local edge-runtime container's environment (`docker inspect`
shows it); that container is gone when the run ends, Ctrl-C included.
Without the key in the file K03 reports skip; with a rejected key it
reports one FAIL, `BLOCKED: the model call failed`, with the reason.
Checks 1-8 make live model calls (up to about 2 minutes each).

## Live segment

A coding agent builds a new app on `kit-live` from a scoped workspace outside
this repo. `make mcp-config` writes `.mcp.json` and `.codex/config.toml`
(gitignored) pointing the hosted Supabase MCP server at the live project only;
`make live-workspace [WORKSPACE=...]` creates the workspace with the guardrail
instructions from `live/`; `make live-reset [APPLY=1]` returns `kit-live` to
the baseline between rehearsals, keeping seeded users. Runbook and prompt:
`docs/LIVE-SEGMENT.md`.
`make stage-agent` starts Claude Code in the workspace without the operator's
user-scope settings, memory, hooks or MCP servers (`scripts/stage-agent.sh`),
and excludes instruction files in the workspace's ancestor directories, which
otherwise load the operator's `~/.claude/CLAUDE.md` when the workspace is
under `$HOME` (seen in the 2026-10-09 rehearsal).

## Self-service backends and deploys

`make new-app NAME=<slug>` turns a request into another guarded project in
the same Team org: a checked plan (exactly one create, nothing else), apply,
health, `sql/00-baseline.sql`, a check that every public table has RLS on,
then the URL and publishable key - 15-16 s in two runs on 2026-10-07. The
request list is `apps.auto.tfvars` (gitignored), so `make apply` and
`make destroy` include the apps; `make remove-app NAME=<slug>` deletes one
through the same check, `make apps` lists them, and `PLAN=1` stops after the
plan. Deploys go to Cloudflare Workers at erfi.dev custom domains (workers.dev off): `make app-deploy`
for the example app, and for a `create-next-app -e with-supabase` app
`make live-app-prep` (OpenNext adapter, next pinned to 16.3.8, no
cacheComponents - both broke on Workers) then `npm run deploy`;
`make live-app-delete` / `make app-delete` remove them.

## Integration: decision webhook

`make integrations` (part of `make up`, after `fn-deploy`) wires purchase
decisions to an external system: an AFTER UPDATE trigger on
`purchase_requests` queues a pg_net POST that is sent only after the decision
commits, to the `webhook-sink` Edge Function, which checks a shared secret
header and records a receipt in `private.webhook_receipts` (the Data API
cannot reach it). The payload is the decided row's own fields, so a receiver
never sees another department's data, and a down receiver cannot fail the
decision. Delivery is at most once (pg_net does not retry); use Supabase
Queues for guaranteed delivery. Setting a `SLACK_WEBHOOK_URL` function secret
makes the sink also post each decision to Slack. K04 tests the path end to
end.

## BFF demo: fan-out API

A backend-for-frontend for one app screen. The app sends one request to
`supabase/functions/fanout-api`; the function calls four upstream endpoints
(`profile`, `feed`, `inbox`, `stats`) in parallel and returns one JSON
document with the data, a per-upstream report (status, source, ms) and a
`partial` flag. `supabase/functions/upstream-mock` stands in for the
upstream integration layer, with a configurable delay per endpoint and
forced failure or slowness per call.

- Auth: JWT verification on, `withSupabase({ auth: 'user' })`; the user id
  sent upstream comes from the verified claims. The mock checks a shared
  key (`UPSTREAM_API_KEY`) and is deployed with `--no-verify-jwt`, since
  its caller is the function rather than a user.
- Timeouts: one `AbortController` per upstream call
  (`FANOUT_UPSTREAM_TIMEOUT_MS`, default 800). A late or failed upstream is
  `null` in `data`, has its reason in `upstreams`, and sets
  `partial: true`; the response is 200 while anything came back, 502 when
  nothing did. No retries.
- Cache: what the upstream marks `Cache-Control: max-age=N` (the mock does
  this for `profile` and `feed`) is stored for N seconds per user in
  `private.fanout_cache` (`sql/50-fanout.sql`). Reads run as the user
  through `fanout_cache_get` with RLS; writes go through
  `fanout_cache_put`, which only service_role may execute, so a user cannot
  plant data in the cache. Postgres rather than an in-memory map because
  hosted functions run many isolates, so a per-isolate map would miss
  unpredictably; the SQL file has the trade-off.
- Demo knobs: `?slow=stats`, `?fail=feed` (comma lists), `?refresh=1`
  (skip the cache read). They steer the mock only; remove them in front of
  a real upstream.

```bash
make bff-test     # offline Deno unit tests for the fan-out logic
make bff-local    # local Docker stack: start, SQL, two users, functions serve, checks, stop
sx SUPABASE_ACCESS_TOKEN -- make bff-deploy                 # SQL, both functions, secrets
sx SUPABASE_ACCESS_TOKEN -- make probe ONLY="--only K05"    # same checks, deployed
```

`make bff-local` and K05 run the same checks (`lib/bff-checks.ts`): all
upstreams ok, a cache hit on the next call, one upstream slow past the
timeout, one failing, all failing, a second user never served the first
user's cached data, and the cache closed to Data API writes. Local timings are
in RUNLOG.md (2026-10-08). The deployed path passed K05 8/8 on every hosted
run 2026-10-08/09. The first call after each of four fresh deploys answered
502: the function's own all-failed response, all four upstreams cut at the
800 ms timeout (body read 2026-10-09), while the same functions idle for
hours without a redeploy answered the first call 200. Make one warm-up call
after a deploy before showing it.

## App MCP server and MCP confirmations (K06, K07)

`supabase/functions/mcp` is the "MCP server for your app" library block
(https://supabase.com/blog/select-2026-build-anything) with Supabase
Middleware 1.0 (https://supabase.com/changelog/supabase-middleware-1-0): one
Edge Function that answers OAuth discovery for MCP clients, verifies the
caller's Supabase access token and hands every tool a client that runs as that
user. The kit adds three tools to the block's `whoami`:
`list_purchase_requests`, `decide_purchase_request` (both go through the same
policies and the same `decide_purchase_request` function as the web app) and
`list_client_notes` (rows scoped by the token's `client_id`,
`sql/60-mcp.sql`). The block needs asymmetric signing keys and the project's
OAuth server; deploy with `supabase functions deploy mcp --use-api
--no-verify-jwt`. Two changes to the block's own files: `tools/result.ts`
reads `error.message` from a PostgREST error object (the original printed
`[object Object]`, RUNLOG 2026-10-10), and the MCP SDK import goes through the
`mcp-sdk` entry in `deno.json` instead of an inline `npm:` specifier.

K06 checks it end to end and K07 measures the hosted Supabase MCP server's
confirmations (destructive SQL, paid branches, `skip_elicitations`) from
clients with and without elicitation support, including Claude Code with an
Elicitation hook. Both provision their own throwaway project, so neither
needs `make up` and neither touches kit-live or kit-ready:

```bash
sx SUPABASE_ACCESS_TOKEN -- make mcp-probe                 # K06 + K07, project names kit-mcp-*
sx SUPABASE_ACCESS_TOKEN -- make mcp-probe MCP_CLAUDE=1    # K07 also drives `claude -p` (needs a login)
sx SUPABASE_ACCESS_TOKEN -- make mcp-probe ONLY=K06 PROJECT_PREFIX=my-prefix-
```

Not covered: connecting Claude (or any client) interactively to the deployed
function (the consent step needs a browser and a consent page; K06 approves
the consent through the API a page would call), and the OAuth Consent block
and headless app template from the same announcement. Cloudflare Workers
deploys of the kit app are separate (`make app-deploy`).

## Troubleshooting segment

`make fault-inject` adds two faults to `kit-ready` in objects of their own
(`sql/40-faults.sql`): an activity feed whose RLS policy and missing indexes
make each read take seconds, and an RPC that fails with a division by zero.
`make fault-check` drives app traffic as seeded users and confirms each
fault is visible in the performance advisor, pg_stat_statements and the
logs endpoint; `make fault-workspace` writes an MCP config scoped to the
ready project for the agent that finds and fixes them; `make fault-clear`
drops the faults and proves the schema matches the pre-inject snapshot.
Runbook, prompt, measured before/after numbers and the metrics/log-drain
export options: `docs/OBSERVABILITY.md`.
