# governed-starter-kit

A starter kit for internal apps that non-specialist teams build on Supabase,
with the guardrails owned by a platform team. Two throwaway projects in a
Team-plan org, rebuilt with `make up` and removed with `make destroy`.

| Project | What it holds | Used for |
|---|---|---|
| `kit-live` | Kit baseline only (`sql/00-baseline.sql`) | A coding agent builds the app on it |
| `kit-ready` | Baseline + example app (`sql/10-app.sql`) + in-app agent schema (`sql/20-agent.sql`) | Fallback, and the target of the K01 RLS matrix |

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
export SUPABASE_ACCESS_TOKEN=...   # live PAT; secrets.tfvars holds a placeholder
make up        # init, apply, wait-ready, schema, seed, probe
make probe     # re-run the K01 matrix against kit-ready
make destroy   # remove both projects
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
  Management API on Pro or Team plans (measured in `supabase-org-topology`),
  so invite members and set roles in the dashboard. They are not removed by
  `make destroy`.
- Dashboard SSO needs a SAML identity provider configured on the org.

## Not built yet

The agent Edge Function and its chat UI.
