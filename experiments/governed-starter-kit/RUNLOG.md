# governed-starter-kit - RUNLOG

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
