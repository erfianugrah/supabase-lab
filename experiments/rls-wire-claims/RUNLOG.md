# RUNLOG - experiments/rls-wire-claims

One throwaway project per module, self-provisioning (no tofu), Pro org.
Validates the lexicanum reference `reference/rls-without-supabase-auth`:
keeping per-user RLS while dropping PostgREST/GoTrue by setting
`request.jwt.claims` over the wire.

Probe: `.pi/probe-rls-wire-claims.sh C01[,C02,C03]`.
C03 additionally needs `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` in
env (wrangler auth; self-skips without them).

## Modules

- C01 - claims GUC drives RLS as a custom `claims_user` role over psql:
  session pooler (5432) per-user isolation, bare-SET leak to a subsequent
  session, transaction pooler (6543) same-query vs next-query semantics,
  prepared-statement parity.
- C02 - GoTrue-issued JWT claims (real user, admin API + password grant)
  drive RLS over the wire with no PostgREST; tampered-sub control proves
  the GUC is unprivileged (database enforces whatever the GUC says).
- C03 - Hyperdrive end to end via wrangler: SET forms (tx / multi-statement
  / bare), cache claims-blindness (identical SQL + parameter, different
  claims GUC -> cached replay across users), and the split-binding fix
  (cache-disabled config filters per claims).

## Findings (validated 2026-08-20)

- **The pattern works as designed.** As a custom non-owner role
  (`claims_user`, no BYPASSRLS), claims set over the wire drive per-user RLS:
  USER_A's claims see exactly A's row, USER_B's see B's, no claims see 0 -
  on BOTH the session pooler (5432) and the transaction pooler (6543), and
  through Hyperdrive's tx and multi-statement forms (C01, C03).
- **Managed Supabase silently no-ops `GRANT USAGE ON SCHEMA auth`** for a
  custom role - `has_schema_privilege` stays false and `auth.uid()` then
  errors `permission denied for schema auth` at runtime. `GRANT EXECUTE ON
  FUNCTION auth.uid()` succeeds but is not sufficient without schema usage.
  The working shape is a SECURITY DEFINER wrapper owned by postgres
  (`public.claims_uid() -> auth.uid()`), granted EXECUTE to the custom role;
  the policy then reads `owner = public.claims_uid()`. This is a real
  production prerequisite the doc's first draft missed.
- **GoTrue claims over the wire work end to end** (C02): a real user created
  via the Auth admin API, signed in via password grant, and its `sub` set as
  `request.jwt.claims` over the pooler sees exactly its row. A tampered sub
  (valid uuid, no user, no rows) is enforced as-is - the GUC-is-unprivileged
  hazard made concrete: the database cannot distinguish a verified JWT from a
  forged claims string.
- **Session pooler (5432) RESETs GUCs on return**: a bare `SET` of
  `request.jwt.claims` did NOT leak to any of 5 subsequent invocations.
- **Transaction pooler (6543) DOES leak a bare SET across invocations**
  (FINDING): set claims in one psql session, count with no claims in the
  next -> the second session saw the first's rows. This is the opposite of
  the 5432 behavior and of the doc-derived expectation; transaction mode
  does not reset session GUCs on return. Reinforces the rule: claims go in a
  transaction (`set_config(..., true)` or `SET LOCAL`), never a bare `SET`.
- **Prepared statements work over 6543** (parity with T11).
- **Hyperdrive did NOT replay across claims** (C03, against expectation):
  identical SQL text + parameter under claims A warmed the cache (n=1); the
  same query under claims B returned 0, not A's row. Either Hyperdrive's
  cache key includes claims-relevant session state, or claims-carrying
  transactions are excluded from caching. The doc's sharp edge 2 survives
  as a rule (split-binding stays the documented control for claims-dependent
  queries) but its worst case was NOT reproduced - downgrade from "leaks"
  to "not observed to leak in this probe; do not rely on it".
- **Operational**: Hyperdrive's create-time connect check races fresh-project
  Supavisor warmup (ENOTFOUND tenant/user) - warm the pooler locally first
  and retry the create. The probe worker needs `nodejs_compat` for
  postgres.js. wrangler auth works with its stored Global API Key +
  CLOUDFLARE_ACCOUNT_ID (no API token needed).
