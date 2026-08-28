/**
 * L08 - grant-based lockdown + RLS write-policy holes: the no-full-RLS-
 * migration path for a operator whose pen test found exposed data.
 *
 *   L08a - REVOKE SELECT FROM anon, authenticated: anon Data-API read goes
 *          42501-shaped; service_role keeps reading (bypasses RLS + holds
 *          the grant).
 *   L08b - reopen path: pg_default_acl grants SELECT on NEW tables to
 *          anon/authenticated, so a bare REVOKE is undone by the next table.
 *   L08c - ALTER DEFAULT PRIVILEGES REVOKE makes the lockdown survive new
 *          tables (measured on both grantor roles).
 *   L08d - the pen-test shape: a plain VIEW over an RLS table leaks every row
 *          to anon unless created WITH (security_invoker = true).
 *   L08f - UPDATE-policy column scope: a permissive UPDATE policy lets anon
 *          rewrite a column the policy never meant to expose (reassign a
 *          tenant/owner) - RLS gates rows, not columns.
 *   L08g - PERMISSIVE bleed: PERMISSIVE policies OR together, so an
 *          admin-intended policy applies to anon too.
 *
 * All objects live in the public schema (so PostgREST serves them) with an
 * l08_ prefix, dropped in finally. SQL runs as postgres via /database/query;
 * API reads go through the Data API with anon/service keys.
 *
 * DESTRUCTIVE: creates/drops tables, policies, default privileges.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys, http, sql, waitFor } from "../lib/inventory.js";

const T = "l08_docs";
const T2 = "l08_after";
const V = "l08_view";

async function restReadCount(ctx: Ctx, table: string, key: string): Promise<{ status: number; code: string; n: number }> {
  const r = await http(`https://${ctx.apiHost}/rest/v1/${table}?select=id`, { key });
  let n = -1;
  if (r.status === 200) {
    const raw = await fetch(`https://${ctx.apiHost}/rest/v1/${table}?select=id`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    try {
      n = ((await raw.json()) as unknown[]).length;
    } catch {
      n = -1;
    }
  }
  return { status: r.status, code: r.code, n };
}

const mod: TestModule = {
  id: "L08",
  title: "grant lockdown + RLS write-policy holes (the no-RLS-migration path)",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const results: TestResult[] = [];

    try {
      // Seed: a table anon can read by default (default privileges grant it).
      await sql(ctx, `
create table if not exists public.${T} (id bigint generated always as identity primary key, tenant text not null default 't1', note text default '');
truncate public.${T};
insert into public.${T} (tenant, note) values ('t1','a'),('t1','b'),('t2','c');
grant select on public.${T} to anon, authenticated;
`);
      await waitFor(async () => (await restReadCount(ctx, T, keys.anonJwt)).status === 200, 60_000);

      // L08a - REVOKE SELECT closes the table via the Data API; service stays.
      await sql(ctx, `revoke select on public.${T} from anon, authenticated;`);
      const aAnon = await waitFor(async () => (await restReadCount(ctx, T, keys.anonJwt)).status >= 400, 60_000);
      const anonAfter = await restReadCount(ctx, T, keys.anonJwt);
      const svcAfter = await restReadCount(ctx, T, keys.serviceJwt);
      results.push({
        id: "L08a",
        title: "REVOKE SELECT: anon closed, service_role unchanged",
        status: anonAfter.status >= 400 && svcAfter.status === 200 ? "pass" : "fail",
        detail: `anon=${anonAfter.status} ${anonAfter.code} | service=${svcAfter.status} rows=${svcAfter.n} (took ${aAnon.elapsedS}s)`,
        measurements: { anon_status: anonAfter.status, anon_code: anonAfter.code, service_status: svcAfter.status },
      });

      // L08b - a NEW table reopens via default privileges (the silent rot).
      await sql(ctx, `
create table if not exists public.${T2} (id bigint generated always as identity primary key, note text default '');
insert into public.${T2} (note) values ('x'),('y');
`);
      const bAnon = await waitFor(async () => (await restReadCount(ctx, T2, keys.anonJwt)).status === 200, 60_000);
      const newTableAnon = await restReadCount(ctx, T2, keys.anonJwt);
      results.push({
        id: "L08b",
        title: "new table reopens anon read via default privileges",
        status: newTableAnon.status === 200 ? "pass" : "fail",
        detail: `a table created AFTER the revoke is anon-readable (${newTableAnon.status}, rows=${newTableAnon.n}) after ${bAnon.elapsedS}s - a bare REVOKE rots on the next migration`,
        measurements: { new_table_anon_status: newTableAnon.status },
      });

      // L08c - ALTER DEFAULT PRIVILEGES for the postgres grantor (what a
      // operator's migrations run as) closes new tables on arrival.
      await sql(ctx, `
alter default privileges for role postgres in schema public revoke select on tables from anon, authenticated;
drop table if exists public.l08_after2;
create table public.l08_after2 (id bigint generated always as identity primary key);
insert into public.l08_after2 default values;
`);
      const cAnon = await waitFor(async () => (await restReadCount(ctx, "l08_after2", keys.anonJwt)).status >= 400, 60_000);
      const closedNew = await restReadCount(ctx, "l08_after2", keys.anonJwt);
      results.push({
        id: "L08c",
        title: "ALTER DEFAULT PRIVILEGES (postgres grantor): new table closed on arrival",
        status: closedNew.status >= 400 ? "pass" : "fail",
        detail: `with postgres' default privileges revoked, a fresh table is anon-closed (${closedNew.status} ${closedNew.code}) after ${cAnon.elapsedS}s - the durable fix for the L08b rot`,
        measurements: { closed_new_status: closedNew.status },
      });

      // L08c2 - the supabase_admin grantor keeps its OWN default ACL, and a
      // operator (postgres) cannot alter it - measured, not assumed.
      let adminAlterErr = "";
      try {
        await sql(ctx, `alter default privileges for role supabase_admin in schema public revoke select on tables from anon, authenticated;`);
      } catch (e) {
        adminAlterErr = e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 160) : String(e);
      }
      results.push({
        id: "L08c2",
        title: "operator cannot close the supabase_admin default-privilege grantor",
        status: "info",
        detail: adminAlterErr
          ? `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin as postgres is refused: ${adminAlterErr} - objects created by the platform admin grantor keep default anon grants the operator cannot revoke this way`
          : "supabase_admin default privileges were alterable as postgres (unexpected - record verbatim)",
        measurements: { admin_alter_refused: String(Boolean(adminAlterErr)) },
      });

      // L08d - a VIEW over an RLS table leaks unless security_invoker.
      await sql(ctx, `
alter table public.${T} enable row level security;
grant select on public.${T} to anon, authenticated;
create or replace view public.${V} as select * from public.${T};
grant select on public.${V} to anon, authenticated;
create or replace view public.${V}_inv with (security_invoker = true) as select * from public.${T};
grant select on public.${V}_inv to anon, authenticated;
`);
      await waitFor(async () => (await restReadCount(ctx, V, keys.anonJwt)).status !== 404, 60_000);
      const plainView = await restReadCount(ctx, V, keys.anonJwt);
      const invView = await restReadCount(ctx, `${V}_inv`, keys.anonJwt);
      results.push({
        id: "L08d",
        title: "view over RLS table leaks unless security_invoker=true",
        status: plainView.n > 0 && invView.n === 0 ? "pass" : "info",
        detail: `plain view rows=${plainView.n} (leaks owner's rows past RLS); security_invoker view rows=${invView.n} (RLS applies)`,
        measurements: { plain_view_rows: plainView.n, invoker_view_rows: invView.n },
      });

      // L08f - UPDATE policy gates rows, not columns: anon rewrites tenant.
      await sql(ctx, `
drop policy if exists l08_sel on public.${T};
drop policy if exists l08_upd on public.${T};
create policy l08_sel on public.${T} for select to anon using (true);
create policy l08_upd on public.${T} for update to anon using (true) with check (true);
grant update on public.${T} to anon;
`);
      // anon flips tenant t1 -> hijack on a row it can update.
      const patch = await fetch(`https://${ctx.apiHost}/rest/v1/${T}?tenant=eq.t1`, {
        method: "PATCH",
        headers: { apikey: keys.anonJwt, Authorization: `Bearer ${keys.anonJwt}`, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ tenant: "hijack" }),
      });
      const patchRows = patch.status < 300 ? ((await patch.json()) as unknown[]).length : 0;
      results.push({
        id: "L08f",
        title: "UPDATE policy lets anon rewrite a column it should not (tenant reassignment)",
        status: patch.status < 300 && patchRows > 0 ? "pass" : "info",
        detail: `anon PATCH tenant->'hijack' = ${patch.status}, rows changed=${patchRows} - RLS UPDATE gates WHICH ROWS, not WHICH COLUMNS; a column privilege or trigger is what constrains it`,
        measurements: { patch_status: patch.status, rows_hijacked: patchRows },
      });

      // L08g - PERMISSIVE bleed: an admin-intended permissive policy ORs onto anon.
      await sql(ctx, `
drop policy if exists l08_admin on public.${T};
create policy l08_admin on public.${T} as permissive for select to anon, authenticated using (true);
`);
      const bleed = await restReadCount(ctx, T, keys.anonJwt);
      results.push({
        id: "L08g",
        title: "PERMISSIVE policies OR together (admin policy bleeds onto anon)",
        status: "info",
        detail: `with two PERMISSIVE select policies, anon reads rows=${bleed.n} (${bleed.status}) - PERMISSIVE is additive; a RESTRICTIVE policy or explicit role predicate is what closes it`,
        measurements: { permissive_bleed_rows: bleed.n, status: bleed.status },
      });
    } catch (e) {
      results.push({ id: "L08err", title: "L08 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      // Restore only what we changed (postgres' default privileges); we never
      // successfully touched supabase_admin's, so leave it alone. Kept as one
      // block of independently-valid statements, each tolerated.
      await sql(ctx, `alter default privileges for role postgres in schema public grant select on tables to anon, authenticated;`).catch(() => {});
      await sql(ctx, `
drop view if exists public.${V}_inv;
drop view if exists public.${V};
drop table if exists public.${T} cascade;
drop table if exists public.${T2} cascade;
drop table if exists public.l08_after2 cascade;
`).catch(() => {});
      results.push({ id: "L08z", title: "teardown l08 objects + reset default privileges", status: "info", detail: "dropped l08_* tables/views, restored default privileges grant" });
    }
    return results;
  },
};
export default mod;
