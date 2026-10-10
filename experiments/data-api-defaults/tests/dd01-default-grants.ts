/**
 * DD01 - Data API default privileges on a project created through
 * POST /v1/projects (no dashboard).
 *
 * Source claim (public rollout notice, github.com/orgs/supabase/discussions/45329,
 * 2026-04-28): tables created in `public` stop being exposed to the Data API
 * unless granted; opt-in at project creation from 2026-04-28, default for new
 * projects from 2026-05-30, applied to existing projects on 2026-10-30. The dashboard "Automatically expose new tables"
 * checkbox running ALTER DEFAULT PRIVILEGES ... REVOKE is recalled, not
 * quoted from the notice. A missing grant is answered with SQLSTATE 42501 and
 * a hint "Grant the required privileges to the current role with: GRANT ...".
 *
 *   DD01a  pg_default_acl for schema public on the fresh project (read-only).
 *   DD01b  table created in SQL; anon (legacy JWT) and publishable key read it.
 *   DD01c  apply the notice's opt-in statements (the 2026-10-30 end state),
 *          re-read pg_default_acl, create a second table; anon, publishable,
 *          service_role and sb_secret reads: status, code, hint verbatim.
 *   DD01d  GRANT SELECT to anon; re-read: status and relacl.
 *
 * Not run here: the standing-project re-run after 2026-10-30 (a project
 * created before 2026-05-30, before and after the enforcement date).
 *
 * Deletes nothing itself; DD99 deletes the project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { skipWithoutPro, brief, currentProject, dataApi, ensureProject, pollApi, sql } from "../lib/project.js";

const ACL_SQL = `select defaclrole::regrole::text as role, defaclobjtype as objtype, defaclacl::text as acl
  from pg_default_acl where defaclnamespace = 'public'::regnamespace order by 1, 2`;

const REVOKE_SQL = `
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;`;

type Row = { role: string; objtype: string; acl: string };

function aclFor(rows: Row[], role: string, objtype: string): string {
  return rows.find((r) => r.role === role && r.objtype === objtype)?.acl ?? "absent";
}
/** Privilege letters a role holds in an ACL string, e.g. "arwdDxtm"; "none" if the role is absent. */
const privsOf = (acl: string, who: string) => acl.match(new RegExp(`[{,]${who}=([a-zA-Z*]*)/`))?.[1] ?? "none";
const mentions = (acl: string, who: string) => (new RegExp(`[{,]${who}=`).test(acl) ? 1 : 0);

function errShape(j: unknown): { code: string; message: string; hint: string } {
  const o = (j ?? {}) as { code?: string; message?: string; hint?: string };
  return { code: o.code ?? "", message: o.message ?? "", hint: o.hint ?? "" };
}

const mod: TestModule = {
  id: "DD01",
  title: "Data API default privileges on an API-created project",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const skip = skipWithoutPro(ctx, "DD01");
    if (skip) return skip;
    let p;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "DD01", title: "DD01", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const red = (s: string) => brief(currentProject(), s, 300);
    try {
      // ---- DD01a ----
      const a = await sql(ctx, p.ref, ACL_SQL);
      const rowsA = (a.rows ?? []) as unknown as Row[];
      const tabA = aclFor(rowsA, "postgres", "r");
      results.push({
        id: "DD01a",
        title: "DD01a: pg_default_acl (schema public) on a fresh project from POST /v1/projects",
        status: "info",
        detail: `postgres/tables acl=${tabA}`,
        measurements: {
          postgres_tables_acl: tabA,
          postgres_sequences_acl: aclFor(rowsA, "postgres", "S"),
          postgres_functions_acl: aclFor(rowsA, "postgres", "f"),
          anon_in_tables_acl: mentions(tabA, "anon"),
          anon_privs_in_tables_acl: privsOf(tabA, "anon"),
          authenticated_in_tables_acl: mentions(tabA, "authenticated"),
          service_role_in_tables_acl: mentions(tabA, "service_role"),
          supabase_admin_tables_acl: aclFor(rowsA, "supabase_admin", "r"),
          postgres_version: p.pgVersion,
        },
      });

      // ---- DD01b: default state, table created in SQL ----
      const c1 = await sql(
        ctx,
        p.ref,
        `create table public.dd01_default (id int primary key, note text);
         insert into public.dd01_default values (1, 'row');`,
      );
      const acl1 = await sql(ctx, p.ref, "select relacl::text as acl from pg_class where oid = 'public.dd01_default'::regclass");
      // The new table reaches PostgREST's schema cache a moment after CREATE.
      const b = await pollApi(
        () => dataApi(p.host, "/rest/v1/dd01_default?select=id", p.keys.anon),
        (r) => r.status !== 404,
      );
      const bPub = await dataApi(p.host, "/rest/v1/dd01_default?select=id", p.keys.publishable);
      results.push({
        id: "DD01b",
        title: "DD01b: SQL-created table under the default privileges, anon read",
        status: "info",
        detail: `create HTTP ${c1.status}; anon GET -> ${b.last.status} ${red(b.last.body)}`,
        measurements: {
          create_status: c1.status,
          relacl: String(acl1.rows?.[0]?.acl ?? "absent"),
          anon_status: b.last.status,
          anon_code: errShape(b.last.json).code || "-",
          anon_seconds_to_serve: b.s,
          publishable_status: bPub.status,
        },
      });

      // ---- DD01c: apply the opt-in revoke (the 2026-10-30 end state) ----
      const rev = await sql(ctx, p.ref, REVOKE_SQL);
      const acl2 = await sql(ctx, p.ref, ACL_SQL);
      const tabC = aclFor((acl2.rows ?? []) as unknown as Row[], "postgres", "r");
      const c2 = await sql(
        ctx,
        p.ref,
        `create table public.dd01_revoked (id int primary key, note text);
         insert into public.dd01_revoked values (1, 'row');`,
      );
      const acl3 = await sql(ctx, p.ref, "select relacl::text as acl from pg_class where oid = 'public.dd01_revoked'::regclass");
      const readRevoked = (key: string) => dataApi(p.host, "/rest/v1/dd01_revoked?select=id", key);
      const cAnon = await pollApi(() => readRevoked(p.keys.anon), (r) => r.status !== 404);
      const cPub = await readRevoked(p.keys.publishable);
      const cSvc = await readRevoked(p.keys.service);
      const cSec = await readRevoked(p.keys.secret);
      const an = errShape(cAnon.last.json);
      const pu = errShape(cPub.json);
      const sv = errShape(cSvc.json);
      const se = errShape(cSec.json);
      const hintOk = /Grant the required privileges/i.test(an.hint);
      results.push({
        id: "DD01c",
        title: "DD01c: after the opt-in ALTER DEFAULT PRIVILEGES REVOKE, a new SQL table is not readable",
        status: an.code === "42501" && hintOk ? "pass" : "fail",
        detail: `revoke HTTP ${rev.status}; anon GET -> ${cAnon.last.status} ${red(cAnon.last.body)}`,
        measurements: {
          revoke_status: rev.status,
          postgres_tables_acl_after: tabC,
          anon_privs_in_tables_acl_after: privsOf(tabC, "anon"),
          service_role_privs_in_tables_acl_after: privsOf(tabC, "service_role"),
          new_table_relacl: String(acl3.rows?.[0]?.acl ?? "absent"),
          create_status: c2.status,
          anon_status: cAnon.last.status,
          anon_code: an.code || "-",
          anon_message: an.message || "-",
          anon_hint: an.hint || "-",
          anon_hint_has_grant_text: hintOk ? 1 : 0,
          publishable_status: cPub.status,
          publishable_code: pu.code || "-",
          publishable_hint: pu.hint || "-",
          service_role_status: cSvc.status,
          service_role_code: sv.code || "-",
          service_role_hint: sv.hint || "-",
          sb_secret_status: cSec.status,
          sb_secret_code: se.code || "-",
          sb_secret_hint: se.hint || "-",
        },
        evidence: `anon body: ${red(cAnon.last.body)}`,
      });

      // ---- DD01d: GRANT then re-read ----
      const g = await sql(ctx, p.ref, "grant select on public.dd01_revoked to anon");
      const acl4 = await sql(ctx, p.ref, "select relacl::text as acl from pg_class where oid = 'public.dd01_revoked'::regclass");
      const d = await pollApi(() => readRevoked(p.keys.anon), (r) => r.status === 200, 30_000);
      const dPub = await readRevoked(p.keys.publishable);
      const dSvc = await readRevoked(p.keys.service);
      results.push({
        id: "DD01d",
        title: "DD01d: GRANT SELECT to anon re-opens the table for anon only",
        status: d.ok ? "pass" : "fail",
        detail: `grant HTTP ${g.status}; anon GET -> ${d.last.status} ${red(d.last.body)}`,
        measurements: {
          grant_status: g.status,
          relacl_after_grant: String(acl4.rows?.[0]?.acl ?? "absent"),
          anon_status: d.last.status,
          anon_seconds_to_serve: d.s,
          publishable_status: dPub.status,
          service_role_status_still: dSvc.status,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: "DD01", title: "DD01", status: "fail", detail: `test threw: ${msg}` });
    }
    return results;
  },
};
export default mod;
