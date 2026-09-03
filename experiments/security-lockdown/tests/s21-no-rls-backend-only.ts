/**
 * S21 - the no-RLS, service_role-from-the-backend shape: close the Data API
 * to anon and authenticated with grants alone, keep the backend working, and
 * measure what the exposed-schema move does to the backend.
 *
 * Managed project. Legacy anon and service_role JWTs; a GoTrue user token
 * for `authenticated` (admin-created user, password grant). SQL through the
 * query endpoint as postgres, the grantor whose default ACL the owner
 * controls (L08: supabase_admin's is not alterable).
 *
 *   S21a  a plain table (no RLS) is readable by anon and by authenticated
 *         through REST (the pen-test exposure)
 *   S21b  REVOKE ALL on tables/sequences/functions in public, REVOKE USAGE on
 *         schema public from anon, authenticated, ALTER DEFAULT PRIVILEGES for
 *         postgres: anon and authenticated status+code on a table and an RPC;
 *         service_role still 200. The RPC row is the trap: Postgres grants
 *         EXECUTE on functions to PUBLIC, so a revoke aimed at anon and
 *         authenticated leaves every function callable.
 *   S21b2 the same revoke aimed at PUBLIC (functions + default privileges):
 *         anon RPC now refused
 *   S21c  a table and a function created AFTER both steps: anon refused on
 *         the table; the function is STILL callable, because a per-schema
 *         ALTER DEFAULT PRIVILEGES entry adds to the global default and cannot
 *         remove PUBLIC's built-in EXECUTE
 *   S21c2 the GLOBAL form (no IN SCHEMA) of the default-privilege revoke, then
 *         another new function: anon refused
 *   S21d  exposed schema moved to `api` only (PATCH db_schema): service_role
 *         on a public table -> status+code; api.* via Accept-Profile -> 200;
 *         restored
 *
 * Not settled by this module: objects owned by supabase_admin (L08);
 * Storage and Realtime (S15); RPC through a SECURITY DEFINER function that
 * anon can still EXECUTE elsewhere.
 *
 * DESTRUCTIVE: revokes and regrants schema privileges (restored to the
 * platform defaults for anon/authenticated), PATCHes db_schema (restored),
 * creates a user (deleted), tables/functions/schema (dropped).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, httpBody, errCode, sql, waitFor } from "../lib/sec.js";

const T = "sec21_pii";
const T2 = "sec21_new";
const nonce = () => Math.random().toString(36).slice(2, 10);
const count = (json: unknown) => (Array.isArray(json) ? json.length : -1);

const mod: TestModule = {
  id: "S21",
  title: "no-RLS backend-only shape: grants close anon/authenticated, service_role keeps reading, exposed-schema move is project-wide",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    const rest = (path: string, key: string, headers: Record<string, string> = {}) => httpBody(`https://${ctx.apiHost}/rest/v1/${path}`, { key, headers });
    const asUser = (path: string, token: string) => httpBody(`https://${ctx.apiHost}/rest/v1/${path}`, { headers: { apikey: keys.anonJwt, Authorization: `Bearer ${token}` } });
    let userId = "";
    const baseline = (await mgmt(ctx, "GET", `/projects/${ctx.ref}/postgrest`)).json as { db_schema?: string };
    try {
      await sql(ctx, `
create table if not exists public.${T} (id bigint generated always as identity primary key, note text);
truncate public.${T};
insert into public.${T} (note) values ('pii-1'), ('pii-2');
create or replace function public.sec21_fn() returns int language sql stable as $$ select 1 $$;
notify pgrst, 'reload schema';
`);
      const email = `s21-${nonce()}@example.com`;
      const pw = `S21-${nonce()}-${nonce()}-Qz!`;
      const created = await httpBody(`https://${ctx.apiHost}/auth/v1/admin/users`, { method: "POST", key: keys.serviceJwt, body: { email, password: pw, email_confirm: true } });
      userId = String((created.json as { id?: string })?.id ?? "");
      // A preceding module's auth-config restore (captcha off, hook off) can
      // still be propagating; retry the login for up to 60s before calling it.
      let login = await httpBody(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, { method: "POST", key: keys.anonJwt, body: { email, password: pw } });
      await waitFor(async () => {
        if (login.status === 200) return true;
        login = await httpBody(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, { method: "POST", key: keys.anonJwt, body: { email, password: pw } });
        return login.status === 200;
      }, 60_000, 5000);
      const userTok = String((login.json as { access_token?: string })?.access_token ?? "");
      if (!userTok) throw new Error(`no user token (admin create ${created.status}, login ${login.status} ${errCode(login.json, login.text)})`);

      await waitFor(async () => (await rest(`${T}?select=id`, keys.anonJwt)).status === 200, 60_000);
      const a0 = await rest(`${T}?select=id`, keys.anonJwt);
      const u0 = await asUser(`${T}?select=id`, userTok);
      out.push({
        id: "S21a",
        title: "the exposure: a plain table (no RLS) reads for anon and authenticated",
        status: a0.status === 200 && u0.status === 200 ? "pass" : "fail",
        detail: `anon GET ${T} -> ${a0.status}, ${count(a0.json)} rows; authenticated -> ${u0.status}, ${count(u0.json)} rows. Default grants make every public table readable by any key holder.`,
        measurements: { anon_status_before: a0.status, anon_rows_before: count(a0.json), authed_status_before: u0.status },
      });

      await sql(ctx, `
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke usage on schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
notify pgrst, 'reload schema';
`);
      const closed = await waitFor(async () => (await rest(`${T}?select=id`, keys.anonJwt)).status !== 200, 60_000);
      const a1 = await rest(`${T}?select=id`, keys.anonJwt);
      const u1 = await asUser(`${T}?select=id`, userTok);
      const r1 = await httpBody(`https://${ctx.apiHost}/rest/v1/rpc/sec21_fn`, { method: "POST", key: keys.anonJwt, body: {} });
      const s1 = await rest(`${T}?select=id`, keys.serviceJwt);
      const acl = (await sql(ctx, `select (select nspacl::text from pg_namespace where nspname = 'public') as schema_acl, (select proacl::text from pg_proc where proname = 'sec21_fn') as fn_acl;`)) as { schema_acl: string; fn_acl: string | null }[];
      const fnAcl = acl[0]?.fn_acl ?? "null (default: EXECUTE for PUBLIC)";
      const schemaAcl = acl[0]?.schema_acl ?? "";
      const rpcNote = r1.status === 200
        ? `STILL CALLABLE - functions carry EXECUTE for PUBLIC (proacl ${fnAcl}) and schema public keeps USAGE for PUBLIC (nspacl ${schemaAcl})`
        : errCode(r1.json, r1.text);
      out.push({
        id: "S21b",
        title: "REVOKE from anon, authenticated (+ USAGE, + default privileges): tables closed, RPC still open via PUBLIC",
        status: a1.status !== 200 && u1.status !== 200 && s1.status === 200 && count(s1.json) === 2 ? "pass" : "fail",
        detail: `closed after ${closed.elapsedS}s. anon table -> ${a1.status} ${errCode(a1.json, a1.text)}; authenticated table -> ${u1.status} ${errCode(u1.json, u1.text)}; service_role table -> ${s1.status}, ${count(s1.json)} rows. anon RPC -> ${r1.status} ${rpcNote}.`,
        measurements: { anon_status: a1.status, anon_code: errCode(a1.json, a1.text).slice(0, 40), authed_status: u1.status, anon_rpc_status: r1.status, service_status: s1.status, service_rows: count(s1.json), closed_after_s: closed.elapsedS, fn_acl: String(acl[0]?.fn_acl ?? "null"), schema_acl: String(acl[0]?.schema_acl ?? "") },
      });

      await sql(ctx, `
revoke execute on all functions in schema public from public;
alter default privileges for role postgres in schema public revoke execute on functions from public;
notify pgrst, 'reload schema';
`);
      const rpcClosed = await waitFor(async () => (await httpBody(`https://${ctx.apiHost}/rest/v1/rpc/sec21_fn`, { method: "POST", key: keys.anonJwt, body: {} })).status !== 200, 60_000);
      const r1b = await httpBody(`https://${ctx.apiHost}/rest/v1/rpc/sec21_fn`, { method: "POST", key: keys.anonJwt, body: {} });
      const s1b = await httpBody(`https://${ctx.apiHost}/rest/v1/rpc/sec21_fn`, { method: "POST", key: keys.serviceJwt, body: {} });
      out.push({
        id: "S21b2",
        title: "REVOKE EXECUTE from PUBLIC (+ default privileges): anon RPC closed, service_role RPC open",
        status: r1b.status !== 200 && s1b.status === 200 ? "pass" : "fail",
        detail: `after revoking EXECUTE from PUBLIC (closed after ${rpcClosed.elapsedS}s): anon RPC -> ${r1b.status} ${errCode(r1b.json, r1b.text)}; service_role RPC -> ${s1b.status}. The grantee that matters for functions is PUBLIC, not anon.`,
        measurements: { anon_rpc_status_after_public_revoke: r1b.status, service_rpc_status: s1b.status, closed_after_s: rpcClosed.elapsedS },
      });

      await sql(ctx, `
create table public.${T2} (id bigint generated always as identity primary key, v text);
insert into public.${T2} (v) values ('new');
create or replace function public.sec21_fn2() returns int language sql stable as $$ select 2 $$;
notify pgrst, 'reload schema';
`);
      await waitFor(async () => (await rest(`${T2}?select=id`, keys.serviceJwt)).status === 200, 60_000);
      const a2 = await rest(`${T2}?select=id`, keys.anonJwt);
      const r2 = await httpBody(`https://${ctx.apiHost}/rest/v1/rpc/sec21_fn2`, { method: "POST", key: keys.anonJwt, body: {} });
      const s2 = await rest(`${T2}?select=id`, keys.serviceJwt);
      out.push({
        id: "S21c",
        title: "created afterwards: the table stays closed; the function reopens (per-schema default-privilege revoke cannot remove PUBLIC's EXECUTE)",
        status: a2.status !== 200 && s2.status === 200 ? "pass" : "fail",
        detail: `new table: anon -> ${a2.status} ${errCode(a2.json, a2.text)}, service_role -> ${s2.status}, ${count(s2.json)} rows. New RPC: anon -> ${r2.status}${r2.status === 200 ? " - CALLABLE AGAIN: the IN SCHEMA public default-privilege revoke adds to the global default and cannot take away the built-in EXECUTE for PUBLIC" : ` ${errCode(r2.json, r2.text)}`}.`,
        measurements: { new_table_anon_status: a2.status, new_rpc_anon_status_schema_revoke: r2.status, new_table_service_status: s2.status },
      });

      await sql(ctx, `
alter default privileges for role postgres revoke execute on functions from public;
create or replace function public.sec21_fn3() returns int language sql stable as $$ select 3 $$;
notify pgrst, 'reload schema';
`);
      await waitFor(async () => (await httpBody(`https://${ctx.apiHost}/rest/v1/rpc/sec21_fn3`, { method: "POST", key: keys.serviceJwt, body: {} })).status === 200, 60_000);
      const r3 = await httpBody(`https://${ctx.apiHost}/rest/v1/rpc/sec21_fn3`, { method: "POST", key: keys.anonJwt, body: {} });
      const s3fn = await httpBody(`https://${ctx.apiHost}/rest/v1/rpc/sec21_fn3`, { method: "POST", key: keys.serviceJwt, body: {} });
      out.push({
        id: "S21c2",
        title: "global ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC: a new function is closed to anon",
        status: r3.status !== 200 && s3fn.status === 200 ? "pass" : "fail",
        detail: `after the global (no IN SCHEMA) revoke, a third new RPC: anon -> ${r3.status} ${errCode(r3.json, r3.text)}; service_role -> ${s3fn.status}. Default EXECUTE for PUBLIC is removed by the global entry only.`,
        measurements: { new_rpc_anon_status_global_revoke: r3.status, new_rpc_service_status: s3fn.status },
      });

      await sql(ctx, `
create schema if not exists api;
create or replace view api.pii as select id from public.${T};
grant usage on schema api to service_role;
grant select on api.pii to service_role;
`);
      const p = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/postgrest`, { db_schema: "api" });
      const moved = await waitFor(async () => (await rest(`${T}?select=id`, keys.serviceJwt)).status !== 200, 90_000);
      const s3 = await rest(`${T}?select=id`, keys.serviceJwt);
      const s3api = await rest(`pii?select=id`, keys.serviceJwt, { "Accept-Profile": "api" });
      const s3bare = await rest(`pii?select=id`, keys.serviceJwt);
      out.push({
        id: "S21d",
        title: "exposed schema = api only: service_role loses public until it sends Accept-Profile",
        status: p.status < 300 && s3.status !== 200 && s3api.status === 200 ? "pass" : "fail",
        detail: `PATCH db_schema=api -> ${p.status}, effective after ${moved.elapsedS}s. service_role GET public.${T} -> ${s3.status} ${errCode(s3.json, s3.text)}; GET api.pii with Accept-Profile: api -> ${s3api.status}, ${count(s3api.json)} rows; GET pii with no profile header -> ${s3bare.status}. The setting is project-wide: the backend's own calls move with it.`,
        measurements: { patch_status: p.status, service_public_status: s3.status, service_public_code: errCode(s3.json, s3.text).slice(0, 40), service_api_status: s3api.status, service_bare_status: s3bare.status, effective_after_s: moved.elapsedS },
      });
    } catch (e) {
      out.push({ id: "S21err", title: "S21 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/postgrest`, { db_schema: baseline.db_schema ?? "public, graphql_public" }).catch(() => {});
      await sql(ctx, `
drop schema if exists api cascade;
drop table if exists public.${T} cascade;
drop table if exists public.${T2} cascade;
drop function if exists public.sec21_fn();
drop function if exists public.sec21_fn2();
drop function if exists public.sec21_fn3();
alter default privileges for role postgres grant execute on functions to public;
grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant all on all functions in schema public to anon, authenticated;
grant execute on all functions in schema public to public;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated;
alter default privileges for role postgres in schema public grant execute on functions to public;
notify pgrst, 'reload schema';
`).catch(() => {});
      if (userId) await httpBody(`https://${ctx.apiHost}/auth/v1/admin/users/${userId}`, { method: "DELETE", key: keys.serviceJwt }).catch(() => {});
      out.push({ id: "S21z", title: "cleanup", status: "pass", detail: "db_schema restored; grants and default privileges regranted to anon/authenticated and PUBLIC; fixtures and user removed" });
    }
    return out;
  },
};
export default mod;
