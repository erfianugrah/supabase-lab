# Live segment: a coding agent builds an app on the kit

The platform team turns a request into a guarded backend in under a
minute, then a coding agent, connected to `kit-live` through the Supabase
MCP server and reading the kit's guardrails, builds a small internal app on
top of the baseline (departments, profiles, private helpers) and deploys it
to a public URL. The audience watches it go from a request to a running
environment, not a localhost demo, and sees where the guardrails stopped the
usual mistakes.

`kit-ready` is never touched by this segment; it is the fallback.

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Guardrails | `live/AGENTS.md`, `live/CLAUDE.md` (imports AGENTS.md) | Rules the agent loads at session start |
| MCP config | `live/.mcp.json.example` -> `make mcp-config` -> `live/.mcp.json` (gitignored) | Hosted MCP server scoped to the live project |
| Workspace | `make live-workspace` -> `~/kit-live-demo` (default `WORKSPACE`) | The agent's working directory, outside this repo |
| Reset | `make live-reset [APPLY=1]` | Back to baseline-only, users kept |
| Self-service backend | `make new-app NAME=<slug>` / `make remove-app NAME=<slug>` | One more guarded project in the same org, baseline applied and checked |
| Deploy | `make live-app-prep` (setup), then the agent's `npm run deploy` in `web/`; `make live-app-deploy` / `make live-app-delete` | The agent's app on Cloudflare Workers (`kit-live-app.<subdomain>.workers.dev`) |

### MCP server

URL, from the Supabase MCP guide
(https://supabase.com/docs/guides/getting-started/mcp, "Configuration
options"):

```
https://mcp.supabase.com/mcp?project_ref=<project-ref>&features=database,debugging,development,docs
```

- `project_ref` scopes the server to one project and disables the account
  tools (list, create, pause projects), so the agent cannot reach any other
  project in the org.
- `features` keeps only the groups this app needs: `database` (migrations,
  SQL, table listing), `debugging` (advisors, logs), `development` (project
  URL, publishable key, types), `docs`. Left out: `functions` (no Edge
  Functions in this app), `branching`, `storage` (off by default anyway).
  Group identifiers as listed in the server source
  (https://github.com/supabase/mcp, `packages/mcp-server-supabase/src/types.ts`).
- `read_only` is not set: the agent must apply migrations.
- Keep the client's manual tool approval ON. The docs recommend it, and it
  is good stage material: each migration is visible before it runs. When the
  client supports form elicitation, the server also asks before destructive
  SQL (same guide, "Destructive SQL confirmations"); do not set
  `skip_elicitations`.

Authentication is OAuth in the browser on first use (same guide, "AI Agent
CLI"): in the workspace, run `claude /mcp`, pick `supabase`, then
Authenticate. The config can also be added with
`claude mcp add --scope project --transport http supabase "<url>"`; the
generated `.mcp.json` is the same thing. Sign in as an account that can see
only the lab org if you have one.

Codex: `make mcp-config` also writes `.codex/config.toml` with the same
scoped URL, and `make live-workspace` copies it in. Codex reads a
project-scoped `.codex/config.toml` for trusted projects only
(https://learn.chatgpt.com/docs/extend/mcp?surface=cli); trust the workspace,
or add the server globally with `codex mcp add supabase --url "<url>"`. Then
`codex mcp login supabase` and `/mcp` inside Codex to verify
(https://supabase.com/docs/guides/getting-started/mcp, "Codex"). Codex reads
AGENTS.md from the git root down to the cwd, 32 KiB combined by default
(project_doc_max_bytes), and does not read CLAUDE.md
(https://learn.chatgpt.com/docs/agent-configuration/agents-md).

### Why the workspace is outside the repo

- Agents walk up the directory tree for instruction files. This repo's root
  `AGENTS.md` is lab notes (about 129 KB): irrelevant to the agent, and an
  agent that reads AGENTS.md with a size budget (32 KiB by default for one
  common agent, per its docs) would fill the budget with it and never reach
  `live/AGENTS.md`. Not measured; derived from the documented root-to-cwd
  concatenation.
- `terraform.tfstate` and `evidence/users-*.json` (seeded passwords) sit in
  this experiment directory; the agent has no reason to see them.
- A fresh git repo lets you show the agent's diff on screen.

Inside the workspace, `CLAUDE.md` holds one line, `@AGENTS.md`. Agents that
read CLAUDE.md expand the import at launch (a CLAUDE.md present means
AGENTS.md is not read on its own, so the import is what loads it); agents
that read AGENTS.md read it directly. One file to maintain.

### Agent skills (optional)

From https://supabase.com/docs/guides/ai-tools/ai-skills:

```bash
cd ~/kit-live-demo
npx skills add supabase/agent-skills              # both skills, project scope
npx skills add supabase/agent-skills --skill supabase-postgres-best-practices
```

Project scope is the default (skills land in the workspace, not your home
directory); do not pass `--global`. `--agent <name>` and `-y` target one
agent and skip prompts (https://github.com/vercel-labs/skills). The
one-step plugin (`npx plugins add supabase-community/supabase-plugin`,
https://supabase.com/docs/guides/ai-tools/plugins) also installs an MCP
server entry; whether that entry is project-scoped was not checked, so use
the explicit scoped config above instead of the plugin for this segment.

## Setup (T-30 min)

```bash
cd experiments/governed-starter-kit
export TOK_CMD='sx SUPABASE_ACCESS_TOKEN --'   # any way of putting a live PAT in the env

eval "$TOK_CMD make live-reset"            # read the plan
eval "$TOK_CMD make live-reset APPLY=1"    # drop, reapply baseline, re-check
rm -rf ~/kit-live-demo && make live-workspace
cd ~/kit-live-demo
npx create-next-app@latest web -e with-supabase   # about 35 s
git add -A && git commit -m "scaffold"
cd - && make live-app-prep                        # OpenNext adapter, about 20 s
cd ~/kit-live-demo && git add -A && git commit -m "deploy setup"
```

Pre-scaffold, do not leave it to the agent: `create-next-app -e` looks the
example up through the unauthenticated GitHub API (60 requests an hour per
IP), and on 2026-10-07 it failed with "Could not locate an example named
with-supabase" until the limit reset - on conference wifi that limit is
shared with the room. `make live-app-prep` (Makefile, "deploy + provisioning")
makes `web/` deployable as the Worker `kit-live-app`; the comment above it
lists the three changes and why each was needed.

Then start the agent in `~/kit-live-demo` with Cloudflare credentials in its
environment, for step 5, through `make stage-agent`:

```bash
make stage-agent DRY=1                     # print the command, launch nothing
sx CLOUDFLARE_API_TOKEN=CLOUDFLARE_STAGE_WORKERS_TOKEN CLOUDFLARE_ACCOUNT_ID -- make stage-agent
```

`scripts/stage-agent.sh` runs Claude Code with none of the operator's
user-scope config: `CLAUDE_CONFIG_DIR` points at an isolated directory
(`STAGE_CLAUDE_HOME`, default `~/.claude-stage`; the Claude Code docs say
settings, session history and plugins move with it,
https://code.claude.com/docs/en/settings), `--setting-sources project,local`
skips user settings and memory, and `--strict-mcp-config` limits MCP to the
workspace `.mcp.json`. It does not use `--bare`, which would stop CLAUDE.md
discovery and so the guardrails. The 2026-10-06 rehearsal needed this: the
operator's hooks blocked `npm` and their instructions leaked into the
narration. The isolated directory starts logged out; run `/login` in it once
at T-30. Not yet verified in a live session: that no user-scope CLAUDE.md
reaches the stage agent (ask it what instructions it loaded).

The vault item `CLOUDFLARE_STAGE_WORKERS_TOKEN` is the API token
`kit-stage-workers`: one account, two permission groups, Workers Scripts
Write and Workers KV Storage Read. Scripts Write covers upload, the
workers.dev subdomain and delete
(https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/).
KV Read is there because `wrangler delete` removes the script and then lists
the account's KV namespaces; without it the Worker is gone but wrangler exits
1 with "Authentication error [code: 10000]". Tested 2026-10-07 with wrangler
4.148.0 and only the token and account id in the environment, on a
hello-world Worker: `wrangler deploy` exited 0 and the workers.dev URL
returned 200, `wrangler delete --force` exited 0 ("Successfully deleted") and
the URL returned 404. The same token got 403 on DNS records, zone settings,
R2 buckets, account members, `/user` and `/memberships`; it can still list
the account's zones and their metadata. Not yet tested with it: the
`kit-live-app` deploy, which uploads static assets. The earlier verification
run used the account's email + global key pair (`CLOUDFLARE_EMAIL`,
`CLOUDFLARE_API_KEY`), which reaches everything in every account the login
has; do not give it to an agent on stage. Authenticate the MCP
server, check that it lists the `supabase` tools and that the instructions
loaded (ask it "what are the kit rules for a new table?"). Quit, and start a
fresh session the same way for the run.

Off screen: open `evidence/users-<live ref>.json` for the seeded passwords.
Users: alice (Sales, employee), bob (Sales, manager), carol (Marketing,
employee), dave (Marketing, manager), all `@example.com`.

Starter scaffold: `npx create-next-app@latest <dir> -e with-supabase`
(https://supabase.com/docs/guides/getting-started/quickstarts/nextjs). It
ships a sign-up page; the guardrails tell the agent to remove it.

## Opener: the platform team provisions a backend (1 min)

A platform team turns a request for a backend into a guarded project. Show
that side first, in the kit repo terminal:

```bash
eval "$TOK_CMD make new-app NAME=demo1" \
  | sed -E 's/[a-z]{20}/<ref>/g; s/(sb_publishable_)[A-Za-z0-9_-]+/\1.../'
```

What happens, in order, and what to say over it:

1. The request lands in `apps.auto.tfvars` (the app list tofu reads on
   every plan); `supabase_project.app` in `supabase.tf` has one project per
   entry, same Team org, region and size as the kit projects.
2. A saved plan, checked before anything is applied: it must be exactly one
   create of `supabase_project.app["demo1"]`. Anything else, a change to
   `kit-live` or `kit-ready` included, aborts and restores the list. The
   screen shows one line, `plan: create supabase_project.app["demo1"]`.
3. Apply, then health (db, rest, auth), then the kit baseline
   (`sql/00-baseline.sql`), then a check that every `public` table has RLS
   on (`baseline: RLS on 2/2 public tables`).
4. The URL and publishable key the requesting team needs, and the elapsed
   time.

Measured 2026-10-07, two runs (Team org, micro, ap-southeast-1), each with
a `PLAN=1` stop to read the plan: plan 2 s, apply 5-6 s, healthy on the
first poll both times, baseline and RLS check 3 s; 15-16 s from request to
ready including the plan read. Two samples on one day; rehearse it on the
day, and if it takes minutes, start it before the framing and come back to
it.

The coding agent still builds on `kit-live`, whose MCP auth and seeded users
were set up before the session; `demo1` is the same baseline on a project
nobody has touched, which is the point of the opener. Remove it in the
teardown. `PLAN=1` stops after the checked plan if you want to show the full
`tofu show` output before applying.

## The prompt

Paste as-is:

```text
Build an equipment loan tracker on this Supabase project, on top of the kit
baseline that is already there (read AGENTS.md first and follow it).

What it does:
- Each department has equipment (laptops, cameras, projectors). Managers add
  and retire equipment for their own department. Everyone in the department
  can see their department's equipment and whether each item is available.
- An employee requests a loan of an available item for a date range.
- A manager of the same department approves or rejects the request. A
  manager cannot approve their own request.
- When the item comes back, a manager marks the loan returned, which makes
  the item available again.
- An item can be out on at most one approved loan at a time; the database
  must enforce that, not only the UI.
- Nobody can see or touch another department's equipment or loans.
- A borrower cannot change a loan's status, approver, department or
  borrower, even by calling the API directly.

Do it in this order:
1. Schema as migrations through the MCP server, then run the security and
   performance advisors and fix what they report.
2. Prove the rules in the database before writing UI: in a transaction you
   roll back, act as alice (Sales employee) and show that she cannot approve
   her own request, cannot set status on a loan, and sees no Marketing rows;
   then act as bob (Sales manager) and show he can approve alice's request.
   Look the user ids up in auth.users by email.
3. A Next.js app in web/ (scaffold it with
   `npx create-next-app@latest web -e with-supabase` if web/ does not exist):
   email/password sign-in only, no sign-up; an equipment list with
   availability; a "request loan" form; a manager view of pending requests
   with approve/reject and "mark returned". Use the project URL and
   publishable key from the MCP server in web/.env.local.
4. Run it with `npm run dev` and tell me the URL.
5. Deploy it: web/ is already set up for Cloudflare Workers (wrangler.jsonc,
   Worker name kit-live-app). Stop the dev server, run `npm run deploy` in
   web/, then curl the workers.dev URL it prints: the login page must answer
   200 and the protected page must redirect to login when signed out. Tell me
   the URL and the status codes. The build reads the project URL and
   publishable key from web/.env.local; put nothing else in the bundle, and
   do not create any other Cloudflare resource.

Keep each migration small and explain each policy in one line as you go.
```

## What a good result looks like

Schema (names may differ):

- `equipment (id, department_id default private.my_department(), name,
  description, retired_at, created_at)`; RLS on; select for the department;
  insert/update only for `(select private.is_manager())` in the department.
- `equipment_loans (id, equipment_id, department_id default
  private.my_department(), borrower_id default auth.uid(), starts_on,
  due_on, status check in (requested, approved, rejected, returned),
  decided_by, decided_at, returned_at, created_at)`; RLS on.
- Column grants: `insert (equipment_id, starts_on, due_on)` only; no
  table-wide `update` for `authenticated`. Status changes go through
  `SECURITY INVOKER` functions (`decide_loan`, `mark_returned`) or an update
  policy limited to managers plus column grants on the decision fields.
- A partial unique index on `equipment_loans (equipment_id) where status =
  'approved'` - availability as a constraint.
- Availability shown through a query or a `security_invoker` view.
- Indexes on every foreign key and policy column; `(select auth.uid())`
  wrapped in every policy.
- Both advisors clean for the new objects. `sql/10-app.sql` is the same
  pattern for purchase requests if you need a reference on stage.

App: sign-in, equipment list with availability, request form, manager
queue. alice and bob in two browser windows; carol sees no Sales rows.

Deploy: one `npm run deploy` (OpenNext build, then `wrangler deploy`), about
30 s measured on the bare scaffold (2026-10-07, three runs, 26-30 s); the
agent's app adds pages, so expect a little more. On the scaffold pointed at
`kit-live`, the deployed URL answered `/` 200, `/auth/login` 200,
`/protected` 307 to `/auth/login` signed out, and 200 with the user's email
after signing in as alice and as carol. On stage, repeat the alice and bob
sign-ins on the agent's pages at the public URL.

## Trap moments to point out

1. The writable status column. The common first draft grants `update` on
   the whole loans table with a policy "borrower can update own loan", which
   lets a borrower set `status = 'approved'` with one API call. Look for
   column-level grants or a state-change function; step 2 of the prompt
   makes the agent prove it.
2. Department from the client. A form that sends `department_id`, or a role
   read from `user_metadata`, lets a user write into another department or
   promote themselves. The kit's answer: department defaults to
   `private.my_department()`, `with check` pins it, role comes only from
   `app_metadata`.
3. Manager-only in the UI only. Hiding the approve button is not
   enforcement. The approve path must check `private.is_manager()` and the
   department in the database, and refuse self-approval.
4. Advisor findings. If the first migration leaves an unindexed foreign key
   or an unwrapped `auth.uid()`, the advisors flag it and the agent fixes it
   in a follow-up migration. Show that loop rather than hiding it.
5. What ships to the browser. `NEXT_PUBLIC_*` values are inlined into the
   client bundle at build time, so anything the agent puts there is public.
   The URL and publishable key are meant to be (RLS is what protects the
   data); a secret key, or a server-only value given a `NEXT_PUBLIC_` name
   to make an error go away, would ship to every visitor. The opposite
   mistake breaks the app instead: putting the URL and key only in Worker
   secrets (`wrangler secret put`) leaves the browser bundle without them.
   Look at `web/.env.local` off screen before step 5.

## Timing targets

| Step | Target | Cut-off |
|---|---|---|
| Opener: `make new-app` | 1 min | 2 min |
| Framing, show AGENTS.md and the scoped MCP URL | 1 min | 2 min |
| Schema migrations + advisors | 4 min | 7 min |
| Prove-the-rules step | 2 min | 4 min |
| App (pre-scaffolded) | 5 min | 8 min |
| Run it, sign in as alice and bob | 2 min | 3 min |
| Deploy, sign in on the public URL | 2 min | 4 min |
| Total, with the opener | 17 min | 26 min |

These are targets to rehearse against, not measurements. Past a cut-off, or
on any MCP auth or network failure, switch to the fallback.

## Fallback

1. A pre-recorded run of the same prompt (record one at the last rehearsal,
   after `make live-reset APPLY=1`).
2. Or the finished example on `kit-ready`: `make app-dev` (purchase requests,
   same guardrails), and walk through `sql/10-app.sql` as "what the agent
   produces". `make app-deploy` before the session puts it on workers.dev
   too (`starter-kit-app`; measured 2026-10-07: `/login` 200, `/dashboard`
   307 to `/login` signed out, and after sign-in the seeded rows for the
   user's department only).
3. Deploy step only: if the agent's deploy fails or stalls past its
   cut-off, run `make live-app-deploy` in the kit terminal (the same
   `npm run deploy`, with your credentials). If the opener's apply fails,
   say what it would have printed and move on: `kit-live` is the same
   baseline on a project made the same way.

## What to show on screen

- The MCP URL with `project_ref` and `features` (ref blurred), and
  `AGENTS.md`.
- The agent's tool-approval prompts, each migration's SQL before it runs,
  and `supabase/migrations/` filling up in the workspace.
- Advisor output before and after a fix.
- The dashboard for `kit-live`: tables with RLS enabled, the policy list.
- Two browser windows (alice, bob) and the refused action.
- `git diff` in the workspace at the end.
- The opener's output: the one `plan:` line, `baseline: RLS on 2/2 public
  tables`, and the elapsed time.
- The deploy: the workers.dev URL from step 5 opened in a browser, signed
  in as alice - the same app, now not on localhost.

Never show `evidence/`, `.env.local`, the dashboard API keys page, or the
terminal while a token is in scope.

## After the segment

```bash
make live-app-delete                         # the agent's Worker (wrangler auth in env)
make app-delete                              # starter-kit-app, if you deployed the fallback
eval "$TOK_CMD make remove-app NAME=demo1"   # the opener's project and its data
eval "$TOK_CMD make live-reset APPLY=1"
rm -rf ~/kit-live-demo
```

`live-app-delete` deletes by name, so it works after the workspace is gone;
both Workers are workers.dev only, no DNS or custom domain to remove.
`remove-app` runs the same checked plan as `new-app`, which must be exactly
one delete. `make apps` lists any app backends still in state.

The reset drops everything in `public` and `private` beyond the baseline,
extra policies, columns, constraints, indexes and triggers on the baseline
tables, extra kit-side triggers on `auth.users`, and the migration history
rows, then reapplies `sql/00-baseline.sql` and re-checks. It keeps users,
profiles and departments, and reports (never drops) unknown schemas and
storage buckets. It does not touch Edge Functions (the MCP config does not
enable them), auth settings, or default privileges.
