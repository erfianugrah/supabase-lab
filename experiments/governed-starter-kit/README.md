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
make probe     # re-run K01-K04 against kit-ready (macOS runs the harness from source)
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
make app-deploy                   # workers.dev, needs wrangler auth
```

`make app-env` writes `app/.env.production` (gitignored) with the project URL
and publishable key; `NEXT_PUBLIC_*` values are inlined at build time.
`make destroy` deletes the Worker before destroying the projects (wrangler may
ask for confirmation).

## Manual steps tofu cannot do

- Org member and role assignment (project-scoped Developer, Read-only) has no
  Management API write on any plan (measured in `supabase-org-topology`;
  re-checked against the OpenAPI spec on 2026-10-07, where the only
  membership operation is `GET /v1/organizations/{slug}/members`), so invite
  members and set roles in the dashboard. They are not removed by
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
fails after a confirmed write, the reply still reports the write.

## Live segment

A coding agent builds a new app on `kit-live` from a scoped workspace outside
this repo. `make mcp-config` writes `.mcp.json` and `.codex/config.toml`
(gitignored) pointing the hosted Supabase MCP server at the live project only;
`make live-workspace [WORKSPACE=...]` creates the workspace with the guardrail
instructions from `live/`; `make live-reset [APPLY=1]` returns `kit-live` to
the baseline between rehearsals, keeping seeded users. Runbook and prompt:
`docs/LIVE-SEGMENT.md`.
`make stage-agent` starts Claude Code in the workspace without the operator's
user-scope settings, memory, hooks or MCP servers (`scripts/stage-agent.sh`).

## Self-service backends and deploys

`make new-app NAME=<slug>` turns a request into another guarded project in
the same Team org: a checked plan (exactly one create, nothing else), apply,
health, `sql/00-baseline.sql`, a check that every public table has RLS on,
then the URL and publishable key - 15-16 s in two runs on 2026-10-07. The
request list is `apps.auto.tfvars` (gitignored), so `make apply` and
`make destroy` include the apps; `make remove-app NAME=<slug>` deletes one
through the same check, `make apps` lists them, and `PLAN=1` stops after the
plan. Deploys go to Cloudflare Workers (workers.dev only): `make app-deploy`
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
