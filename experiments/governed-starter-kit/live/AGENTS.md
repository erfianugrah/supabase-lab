# Kit guardrails for coding agents

You are building an internal app on a Supabase project that a platform team
owns. The project already holds the kit baseline; your job is to add one app
on top of it without weakening anything the baseline enforces. These rules
are not suggestions: if a request conflicts with one, stop and say which rule
it breaks instead of working around it.

## The project

- You have exactly one Supabase project, reached through the MCP server named
  `supabase` in this directory's MCP config. It is scoped to that project
  with `project_ref`, so account tools (list or create projects) do not
  exist. Never point any tool, client or env file at another project, and
  never ask for or invent a different project ref or URL.
- The baseline is already applied. `kit/00-baseline.sql` is a read-only copy
  for reference; do not re-run it, edit it, or apply it as a migration. The
  MCP table-listing tool on the `public` schema shows what is live.

### What the baseline gives you

- `public.departments (id, name)` - the tenancy unit.
- `public.profiles (id, department_id, role, display_name)` - one row per
  user; `role` is `employee` or `manager`. A trigger on `auth.users` keeps it
  in step with `app_metadata`.
- `private.my_department()` returns the caller's department id;
  `private.is_manager()` returns true for a manager. Both are
  `SECURITY DEFINER` in the `private` schema, which the Data API does not
  expose. Use them in policies as `(select private.my_department())` and
  `(select private.is_manager())`.
- Users are provisioned by the platform team with `department` and `role`
  in `app_metadata`. There is no sign-up.

Do not alter, drop or add policies, columns, triggers or grants on
`departments`, `profiles`, `auth.*` or the `private` helpers. If the app
seems to need a change there, stop and explain why.

## Schema changes

1. Every schema change is a migration applied with the MCP `apply_migration` tool,
   with a short snake_case name. The MCP SQL tool is for reads and for
   checking your work, never for DDL.
2. Save the exact SQL of each migration to
   `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` in this directory so a
   human can review it.
3. After every migration, run `get_advisors` for `security` and again
   for `performance`. Fix every finding your change introduced with a
   follow-up migration before moving on. Report any finding you believe is
   pre-existing or a false positive, with the reason; do not silence it.

## Every table you create

- `alter table ... enable row level security` in the same migration that
  creates the table.
- A `department_id uuid not null default private.my_department()
  references public.departments (id)` column when the rows belong to a
  department, plus an owner column such as
  `requester_id uuid not null default auth.uid() references public.profiles (id)`
  when rows belong to a user.
- Explicit grants; do not rely on default privileges:
  `revoke all on <table> from anon, authenticated;` then grant only what the
  app needs to `authenticated`. Grant `insert` and `update` on named columns
  only, so a user cannot write a column the server owns (department, owner,
  status, approval fields, timestamps).
- Policies are `TO authenticated`, one per action, and use
  `(select auth.uid())` and `(select private.my_department())` - wrapped in
  `select` so they are evaluated once per statement. Never `TO public`, never
  `TO anon`, never `using (true)`.
- Every `insert` and `update` policy has a `with check` that pins
  `department_id` to the caller's department and the owner column to the
  caller.
- An index on every foreign key column and on every column a policy filters
  on.

## Manager-only actions and protected columns

- A manager-only action (approve, reject, mark returned) is enforced in the
  database, not only hidden in the UI: a policy or function that checks
  `(select private.is_manager())` and the department.
- Prefer a `SECURITY INVOKER` function in `public` with
  `set search_path = ''` for a multi-column state change, so RLS still
  decides who may do it. Raise an error when it updates zero rows rather than
  returning success.
- If something genuinely needs `SECURITY DEFINER`, put it in `private`, set
  `search_path = ''`, revoke execute from `public` and `anon`, and say why in
  the migration.
- Department and role come only from `app_metadata` via the baseline
  helpers. Never read them from `user_metadata`, a request body, a query
  string, or a column the user can write.
- Views use `with (security_invoker = true)`.

## Keys and the web app

- The browser and server code use the project URL and the publishable key
  only; get them with the MCP `get_project_url` and `get_publishable_keys` tools and write
  them to the app's `.env.local`, which must be gitignored.
- Never use, request, print or log the secret key or `service_role` key, in
  any file, command or message. The app does not need it.
- Do not print the contents of env files to the terminal.
- No sign-up page and no OAuth buttons: users are provisioned. Remove any
  sign-up route a template ships with. A signed-in user with no profile sees
  an empty state, not an error.

## Done means

- The table-listing tool shows your tables with RLS enabled.
- Both advisors return no findings caused by your migrations.
- You can state, for each table, which role can select, insert, update and
  delete which columns, and why a user in another department sees nothing.
- The app builds and runs locally, sign-in works with an existing user, and
  the manager-only action is refused for an employee by the database.
