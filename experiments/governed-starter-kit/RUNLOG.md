# governed-starter-kit - RUNLOG

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
