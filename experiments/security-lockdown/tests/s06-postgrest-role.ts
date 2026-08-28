/**
 * S06 - the self-hosted PostgREST should NOT connect as postgres.
 *
 * The own-PostgREST path (S04) connected as the postgres superuser for
 * brevity, which defeats the point: a superuser connection bypasses RLS and
 * every grant. PostgREST is meant to connect as a non-superuser
 * "authenticator" role that can only SET ROLE to anon/authenticated, so RLS
 * and grants still bind. This verifies the safe role shape:
 *
 *   S06a - the platform's own `authenticator` role is NOSUPERUSER +
 *          NOBYPASSRLS (the role the managed PostgREST uses).
 *   S06b - a dedicated login role granted anon/authenticated is safe to run
 *          PostgREST as: NOSUPERUSER, NOBYPASSRLS, can SET ROLE anon, and RLS
 *          filters under it - unlike postgres, which reads everything.
 *
 * DESTRUCTIVE: creates a role + RLS fixture; drops them in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { sql } from "../lib/sec.js";

async function rows(ctx: Ctx, q: string): Promise<Record<string, unknown>[]> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query: q });
  return Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
}

const T = "s06_docs";
const ROLE = "pgrst_own";

const mod: TestModule = {
  id: "S06",
  title: "self-hosted PostgREST connection role: non-superuser, RLS still binds",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    try {
      const auth = await rows(ctx, "select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'authenticator';");
      const a = auth[0] ?? {};
      results.push({
        id: "S06a",
        title: "the managed `authenticator` role is safe (NOSUPERUSER, NOBYPASSRLS)",
        status: a.rolsuper === false && a.rolbypassrls === false ? "pass" : "fail",
        detail: `authenticator: rolsuper=${a.rolsuper} rolbypassrls=${a.rolbypassrls} - this is what the managed PostgREST connects as, and what a self-hosted one should mirror.`,
      });

      // A dedicated PostgREST connection role, and proof RLS binds under it.
      await sql(ctx, `
drop role if exists ${ROLE};
create role ${ROLE} noinherit login password 'x-not-used-here';
grant anon, authenticated to ${ROLE};
create table if not exists public.${T} (id bigint generated always as identity primary key, note text);
truncate public.${T};
insert into public.${T} (note) values ('a'),('b');
grant select on public.${T} to anon;
alter table public.${T} enable row level security;
drop policy if exists s06_none on public.${T};
create policy s06_none on public.${T} for select to anon using (false);
`);
      const check = await rows(ctx, `
select
  (select rolsuper from pg_roles where rolname = '${ROLE}') as super,
  (select rolbypassrls from pg_roles where rolname = '${ROLE}') as bypass,
  pg_has_role('${ROLE}', 'anon', 'MEMBER') as can_anon,
  pg_has_role('${ROLE}', 'authenticated', 'MEMBER') as can_auth;`);
      const c = check[0] ?? {};
      const safe = c.super === false && c.bypass === false && c.can_anon === true && c.can_auth === true;
      results.push({
        id: "S06b",
        title: "a dedicated login role is safe to run PostgREST as (non-superuser, can SET ROLE anon/authenticated)",
        status: safe ? "pass" : "fail",
        detail: `${ROLE}: rolsuper=${c.super}, rolbypassrls=${c.bypass}, member of anon=${c.can_anon}, authenticated=${c.can_auth}. Connect the self-hosted PostgREST as a role like this (or the existing authenticator), never as postgres - postgres is a superuser and bypasses RLS and every grant.`,
        measurements: { rolsuper: String(c.super), rolbypassrls: String(c.bypass) },
      });
    } catch (e) {
      results.push({ id: "S06err", title: "S06 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await sql(ctx, `drop table if exists public.${T} cascade; drop role if exists ${ROLE};`).catch(() => {});
    }
    return results;
  },
};
export default mod;
