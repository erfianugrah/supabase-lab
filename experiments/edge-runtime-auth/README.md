# edge-runtime-auth

Two platform questions about code that runs on Edge Functions, each answered on
a self-provisioned Pro-org project (created and deleted by the module, no
OpenTofu state):

- ER01: which credentials do the five `@supabase/server` auth modes (`none`,
  `user`, `secret`, `publishable`, `['user','secret']`) let through to the
  handler, on an Edge Function and on the Workers runtime? Fourteen credential
  presentations per mode: legacy anon and service_role keys, publishable and
  secret keys, a real user token, an expired one, a third-party-issuer token,
  an unregistered-key token and a legacy HS256 token. Each cell records the
  status, whether the handler ran, and which layer refused.
- ER02: an Edge Function canary that returns its build hash. How long are the
  old and new builds served side by side after a redeploy, does supabase-js
  `functions.invoke` retry a 503 the function returns, and what are the p50/p95
  over a sampling window, against an RPC twin of the same logic?

The Workers-runtime leg runs the Worker bundle on workerd inside a container
and, when a Cloudflare token is supplied, also deploys it to workers.dev and
deletes it again. A run without the token has only the workerd targets.

## Run

```
sx SUPABASE_ACCESS_TOKEN -- make probe PVLAB_ORG_PRO=<pro org slug> ONLY=ER01
sx SUPABASE_ACCESS_TOKEN -- make probe PVLAB_ORG_PRO=<pro org slug> ONLY=ER02
make unit      # pure logic: expectation table, drift arithmetic, percentile
```

Needs Docker for ER01's workerd leg. For the Cloudflare leg, put
`CLOUDFLARE_WORKERS_TOKEN` (Workers Scripts edit) and `CLOUDFLARE_ACCOUNT_ID` in
the environment (for example `sx CLOUDFLARE_WORKERS_TOKEN=CLOUDFLARE_WORKERS_TOKEN CLOUDFLARE_ACCOUNT_ID SUPABASE_ACCESS_TOKEN -- make probe ...`)
and have `wrangler` on PATH; the Worker is named with the prefix, receives the
keys as secrets, and is deleted at the end of the module.
`ER_PROJECT_PREFIX` names the throwaway projects and Workers (default `er-`). `ER_CYCLES` (default 5) and `ER_WINDOW_S` (default
600) size ER02. The harness registry is generated at build time: run
`bun harness/scripts/gen-registry.ts` after adding this directory so the runner
finds the modules.

The versions under test are pinned in this directory's `package.json`:
`@supabase/server` and `@supabase/supabase-js`. ER01 runs `bun install` here
itself (the Worker bundle and the recorded `@supabase/server` version come from
this directory). The repo-root `bun run typecheck` needs only the root and
`harness/` installs: nothing under the typecheck imports a package that lives
only here. ER02 records the `supabase-js` and `functions-js` versions it
resolved; the pinned ones only if this directory was installed first.

Results and what they do and do not show: `RUNLOG.md`.
