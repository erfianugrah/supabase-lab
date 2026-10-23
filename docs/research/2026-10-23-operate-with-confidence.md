# "Operate with confidence": agent data, tools and controls against observability-surface (2026-10-23)

Question: which of the agent-facing data sources, tools and controls in the
two "Operate with confidence" posts has the lab not measured, and what would
an experiment for each look like? `experiments/observability-surface`
(OB01-OB05, 2026-10-10) is the baseline. Raw captures:
`raw/2026-10-23-operate-with-confidence/` (redacted probe log, and the
read-only MCP `tools/list` with the `query_logs` schema).

Sources, all read 2026-10-23:

- Launch post, 2026-10-02: https://supabase.com/blog/select-2026-operate-with-confidence
- Follow-up, 2026-10-20: https://supabase.com/blog/operate-with-confidence-check-production-with-your-coding-agent
- Recap: https://supabase.com/blog/supabase-select-2026-recap
- Docs (read from the supabase/supabase `apps/docs` sources):
  https://supabase.com/docs/guides/observability/automate-with-agents ,
  https://supabase.com/docs/guides/observability/automate-with-agents/health ,
  https://supabase.com/docs/guides/observability/detecting ,
  https://supabase.com/docs/guides/observability/advanced-log-filtering ,
  https://supabase.com/docs/guides/observability/advisors

## Inventory and coverage

| release (post) | what it is | lab coverage |
|---|---|---|
| `query_logs` MCP tool | read-only ClickHouse SQL on the project's `logs` table, up to 24 h per call | not covered as an MCP tool; the logs endpoint it fronts is OB03 (sources, lag) and logs-volume (row sizes). Probed today, below |
| Health Check Advisors | Health tab, `POST /v2/projects/{ref}/advisors/run` | OB02 (thresholds, bucket rule, timing) |
| Database Connections | dashboard page: sessions, long queries, idle in transaction, blockers, cancel/terminate; "on by default for every project, including self-hosted" | not covered |
| Notebooks and Explorer | notebook files, `supabase notebooks pull/push`, v2 notebooks API; Explorer is the new SQL editor | OB05 (CLI and v2 API); Explorer itself not covered (dashboard UI) |
| Updated agent skills / plugin | `supabase` skill points at observability docs for debugging | not covered |
| Agent prompts (Health, Security, Performance, Resources) | prompts that run the "detection checks" through read-only MCP on a schedule | not covered |
| Local runtime, pg-delta ("Autonomy") | see the Build post | `experiments/cli-surface` CL01-CL04, CL20-CL22 |
| Enterprise-Managed Auth for MCP | Okta-governed access to the Supabase MCP server, short-lived member-bound tokens, GA | not covered |
| Scoped PATs | GA, default for new dashboard tokens | `experiments/scoped-pats` SP01-SP10 |
| MCP elicitations | confirm paid resources and destructive SQL | `experiments/governed-starter-kit` K07 |
| Pipelines | public alpha, Pro and up | `experiments/pipelines` PL01-PL08 (open-source engine; the managed service is not PAT-drivable) |

## Probes (2026-10-23, Pro org, two throwaway projects, both deleted)

From `raw/2026-10-23-operate-with-confidence/probe-2026-10-23.txt` and
`mcp-tools-list-read-only.json`:

- Hosted MCP (`serverInfo` version 0.14.0; K07 read 0.13.0 on 2026-10-10)
  with `project_ref` and `read_only=true` lists 13 tools, `query_logs` among
  them with `readOnlyHint: true`. Input: `sql` (required),
  `iso_timestamp_start`, `iso_timestamp_end`; the description says the window
  defaults to the last 24 hours and "The API caps the requested range at 24
  hours". A call counting `edge_logs` rows returned the same value as the logs
  endpoint (5, from five unauthenticated REST calls), wrapped in an
  `untrusted-data-<uuid>` boundary with an instruction not to follow
  instructions inside it.
- Logs endpoint, ClickHouse dialect: `select *` answered HTTP 200 with
  `{"error":"restricted wildcard (*) in a result column"}`; the per-source
  table name `edge_logs` answered `Table "edge_logs" does not exist.`;
  `count(*)` returned a result although the docs say "The logs query surface
  rejects `select *` and `count(*)`". Errors arrive as HTTP 200 with an
  `error` key.
- A 48-hour window ending now returned `n: 0` for the query that returned `5`
  over the last hour (n = 1, a project minutes old). No error was raised for
  the over-long range. One explanation is that the cap keeps the first 24
  hours from the start; that is inference from one call.
- Read-only MCP `execute_sql` runs as `supabase_read_only_user`, which is a
  member of `pg_read_all_stats` and `pg_monitor`. With a 75 s `pg_sleep`
  running as `postgres` through the Management API SQL route, it saw every
  client backend with state and query text (authenticator, pgbouncer,
  postgres, supabase_admin), and the detection check's long-running-session
  query (threshold lowered to 5 s) returned the sleeping `postgres` session.
  So the Health and Performance checks that need "permission to read all
  sessions" have it under `read_only=true` (n = 1 project). That project read
  `max_connections` 60.

## What is new and worth an experiment

### 1. Detection checks against Health Check Advisors (deterministic, no LLM)

The two detectors use different rules. Health Check Advisors (OB02): at least
5 failing 5xx requests in each of two consecutive five-minute buckets; 1%
fired. The Health detection check (detecting.md): per source over the last
complete UTC hour against the hour before, at least 20 server errors, a rate
of at least 1%, at least twice the preceding rate, and at least 100 responses
in both windows, otherwise "unable to assess".

Proposed module OB06 in `experiments/observability-surface`, one micro
project, OB02's fault recipes (`raise sqlstate 'PT500'`, raising
`auth.users` trigger):

- load A: 25 server errors over one hour, at most 4 per five-minute bucket, at
  2% of responses. Prediction: detection check fires, advisor does not.
- load B: 5 errors in each of two consecutive buckets, 10 in the hour, at 2%.
  Prediction: advisor fires, detection check does not (under 20).
- load C: 99 responses in one of the two hours. Prediction: "unable to
  assess".
- load D: Auth only, through the `auth.users` trigger: whether
  `auth_logs.log_attributes['status']` carries the status the query reads.

Measure: the check's SQL result through the logs endpoint per hour window,
the advisor's lint list at 30 s polling, and which rule fired. Cost: one
micro project for about 3 h per run (two complete UTC hours plus setup),
a few cents (inference from micro pricing, not looked up). Blockers: none.

### 2. Agent prompts end to end

Proposed module OB07: `claude -p` with the hosted MCP server project-scoped
and `read_only=true` (the K07 headless setup), the Health prompt pasted
verbatim from its docs page, run on a clean project and on loads A and B
from OB06. Measure: whether the report matches the deterministic check,
whether a clean run is silent, whether a run without saved alert state says
it cannot tell what is new (the follow-up post's claim), the tools called and
their count, and run time. Add an injection probe: a request path or
`RAISE LOG` message carrying an instruction, to test "The prompts tell the
agent to ignore instructions found in log messages or query results"
alongside the MCP server's own `untrusted-data` wrapper. Cost: LLM tokens
per run plus the OB06 project. Blockers: the prompts fetch the detection-check
docs at run time, so the run needs outbound web access from the agent.

### 3. Database Connections

Proposed module SD09 in `experiments/self-hosted-defaults` (the blog says the
page is on for self-hosted, and that rig needs no project): open the page in
headless Chromium, read which SQL Studio sends through pg-meta and as which
role (SD04: Studio connects as `postgres`, not a superuser), then cancel and
terminate a long query owned by `postgres`, by `authenticator` and by
`supabase_admin`. Prediction: the `supabase_admin` backend cannot be signalled
by a non-superuser (Postgres rule for superuser-owned backends; to verify).
Hosted: neither OpenAPI document has a connections route, so the hosted page
is a dashboard hand-off. Cost: local only. Blockers: none for self-hosted.

### 4. `query_logs` and logs endpoint edge cases

Fold into OB03 as OB03d: over-24 h windows (does the cap anchor at the start
or the end; is a silent zero the answer), `count(*)` against the docs, the
default window when no start is given, the row cap, and MCP-tool versus
endpoint parity on the same SQL and window. Cost: one micro project for
about 30 min. Blockers: none. Part of this ran today (above).

### 5. Enterprise-Managed Auth for MCP

Not runnable by the lab today. Needs a Team or Enterprise org with SSO
configured and an Okta tenant as the identity provider (recap: "Set it up on
a Team or Enterprise plan with SSO configured"), plus a second member to
test revocation. What to measure once available: token lifetime, behaviour
on member removal and on removing the app from Authorized Apps (time to
refusal), and whether a PAT still reaches the MCP server alongside it.

### 6. Agent skill debugging guidance

Low value as a platform experiment: it changes what an agent reads, not how
the platform behaves. Skip unless an eval harness for agent answers exists.
