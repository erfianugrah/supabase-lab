/**
 * DD03 - platform lockdowns met by the postgres role: extension versions and
 * the realtime schema.
 *
 * Source claims (public changelog):
 *   - supabase.com/changelog/extension-version-pinning-ignored (from
 *     2026-08-05): CREATE EXTENSION ... VERSION and ALTER EXTENSION ... UPDATE
 *     TO succeed, ignore the requested version, install/update to the default
 *     and warn "only superusers can specify extension versions".
 *   - supabase.com/changelog/realtime-schema-locked-down-against-modification
 *     (2026-07-14, Realtime v2.112.7): ALTER/DROP of realtime objects, new
 *     objects in the schema, and INSERT or DELETE on realtime.schema_migrations
 *     fail with "permission denied for schema realtime"; policies on
 *     realtime.messages still work.
 *
 * Two vantages, both the postgres role: the Management API query endpoint
 * (mgmt) and a session-mode pooler connection (pg), which is the one that
 * surfaces NOTICE/WARNING text.
 *
 *   DD03a  who the two vantages are (current_user, is_superuser).
 *   DD03b  CREATE EXTENSION citext VERSION '1.5' / '9.9': warning text, resulting
 *          extversion against the default on offer.
 *   DD03c  ALTER EXTENSION citext UPDATE [TO ...]: error/notice text, extversion
 *          after; ALTER EXTENSION ... SET SCHEMA as a control statement.
 *   DD03d  realtime.messages policy create/list/drop (control: allowed).
 *   DD03e  ten blocked operations (eight from the changelog, plus UPDATE and
 *          ALTER on realtime.schema_migrations as extensions), each wrapped in
 *          begin; ...; rollback; so an allowed statement leaves nothing behind;
 *          then a post-check that the objects and rows are unchanged.
 *
 * The update path where installed < default (a real upgrade) is not exercised:
 * a version pin is ignored at create, so no older version can be installed to
 * update from.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { skipWithoutPro, brief, currentProject, ensureProject, pgSession, sql, type DdProject, type PgSession } from "../lib/project.js";

const fmtErr = (code: string | undefined, msg: string | undefined) => `${code ?? "?"} ${(msg ?? "").replace(/\s+/g, " ")}`.trim();

const BLOCKED: { key: string; stmt: string }[] = [
  { key: "create_table", stmt: "create table realtime.dd_probe (id int)" },
  { key: "create_function", stmt: "create function realtime.dd_fn() returns int language sql as 'select 1'" },
  { key: "alter_messages_drop_column", stmt: "alter table realtime.messages drop column topic" },
  { key: "drop_messages", stmt: "drop table realtime.messages" },
  { key: "drop_function_topic", stmt: "drop function realtime.topic()" },
  { key: "drop_trigger_tr_check_filters", stmt: "drop trigger tr_check_filters on realtime.subscription" },
  { key: "insert_schema_migrations", stmt: "insert into realtime.schema_migrations (version, inserted_at) values (99999999999999, now())" },
  { key: "update_schema_migrations", stmt: "update realtime.schema_migrations set inserted_at = inserted_at where version = 99999999999998" },
  { key: "delete_schema_migrations", stmt: "delete from realtime.schema_migrations where version = 99999999999998" },
  { key: "alter_schema_migrations", stmt: "alter table realtime.schema_migrations add column dd text" },
];

const mod: TestModule = {
  id: "DD03",
  title: "Extension version pinning ignored; realtime schema locked down (as postgres)",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const skip = skipWithoutPro(ctx, "DD03");
    if (skip) return skip;
    let p: DdProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "DD03", title: "DD03", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const red = (s: string) => brief(currentProject(), s, 300);
    let pg: PgSession | null = null;
    try {
      pg = p.poolerHost ? await pgSession(p) : null;
    } catch (e) {
      pg = null;
      results.push({ id: "DD03-pg", title: "DD03: pooler session", status: "info", detail: `no pg vantage: ${red(String(e))}` });
    }
    try {
      // ---- DD03a ----
      const w = await sql(ctx, p.ref, "select current_user as u, current_setting('is_superuser') as su");
      const wp = pg ? await pg.query("select current_user as u, current_setting('is_superuser') as su") : null;
      results.push({
        id: "DD03a",
        title: "DD03a: role and superuser flag per vantage",
        status: "info",
        measurements: {
          mgmt_current_user: String(w.rows?.[0]?.u ?? "?"),
          mgmt_is_superuser: String(w.rows?.[0]?.su ?? "?"),
          pg_current_user: String(wp?.rows[0]?.u ?? "no pg vantage"),
          pg_is_superuser: String(wp?.rows[0]?.su ?? "no pg vantage"),
        },
      });

      // ---- DD03b: CREATE EXTENSION ... VERSION ----
      const avail = await sql(ctx, p.ref, "select default_version from pg_available_extensions where name = 'citext'");
      const def = String(avail.rows?.[0]?.default_version ?? "?");
      const extver = async () => {
        const r = await sql(ctx, p.ref, "select extversion from pg_extension where extname = 'citext'");
        return String(r.rows?.[0]?.extversion ?? "absent");
      };
      const bm: Record<string, number | string> = { default_version: def };
      let bOk = true;
      if (pg) {
        for (const v of ["1.5", "9.9"]) {
          await pg.query("drop extension if exists citext");
          const r = await pg.query(`create extension citext version '${v}'`);
          const after = await extver();
          bm[`pg_create_v${v}_error`] = r.error ? fmtErr(r.code, r.error) : "none";
          bm[`pg_create_v${v}_notices`] = r.notices.join(" | ") || "none";
          bm[`pg_create_v${v}_extversion`] = after;
          if (r.error || after !== def || !/only superusers can specify extension versions/.test(r.notices.join(" "))) bOk = false;
        }
        await pg.query("drop extension if exists citext");
      }
      await sql(ctx, p.ref, "drop extension if exists citext");
      const mc = await sql(ctx, p.ref, "create extension citext version '1.5'");
      bm.mgmt_create_v1_5_status = mc.status;
      bm.mgmt_create_v1_5_response = mc.status < 300 ? red(mc.text) : red(mc.error ?? mc.text);
      bm.mgmt_create_v1_5_extversion = await extver();
      results.push({
        id: "DD03b",
        title: "DD03b: CREATE EXTENSION ... VERSION is accepted, ignored, and warned about",
        status: pg ? (bOk ? "pass" : "fail") : "info",
        detail: pg ? `pg warning on v1.5: ${red(String(bm["pg_create_v1.5_notices"]))}` : "mgmt vantage only (no pooler session)",
        measurements: bm,
      });

      // ---- DD03c: ALTER EXTENSION ... UPDATE ----
      // citext is installed from the mgmt statement above (at the default).
      const cm: Record<string, number | string> = { extversion_before: await extver(), default_version: def };
      const stmts: [string, string][] = [
        ["update_bare", "alter extension citext update"],
        ["update_to_1_4", "alter extension citext update to '1.4'"],
        ["update_to_default", `alter extension citext update to '${def}'`],
        ["update_to_9_9", "alter extension citext update to '9.9'"],
      ];
      for (const [k, s] of stmts) {
        const m = await sql(ctx, p.ref, s);
        cm[`mgmt_${k}`] = m.status < 300 ? `ok ${m.status}` : `HTTP ${m.status} ${red(m.error ?? "")}`;
        if (pg) {
          const r = await pg.query(s);
          cm[`pg_${k}_error`] = r.error ? fmtErr(r.code, r.error) : "none";
          cm[`pg_${k}_notices`] = r.notices.join(" | ") || "none";
        }
      }
      cm.extversion_after = await extver();
      // Control: a different ALTER EXTENSION form, to separate "all ALTER EXTENSION"
      // from "the UPDATE form".
      const ctl = await sql(ctx, p.ref, "alter extension citext set schema public");
      cm.control_set_schema_public = ctl.status < 300 ? `ok ${ctl.status}` : `HTTP ${ctl.status} ${red(ctl.error ?? "")}`;
      await sql(ctx, p.ref, "alter extension citext set schema extensions");
      results.push({
        id: "DD03c",
        title: "DD03c: ALTER EXTENSION ... UPDATE [TO version] outcome and extversion after",
        status: "info",
        detail: `extversion ${cm.extversion_before} -> ${cm.extversion_after}; update_to_1_4 (pg): ${red(String(cm.pg_update_to_1_4_error ?? "-"))}`,
        measurements: cm,
      });
      await sql(ctx, p.ref, "drop extension if exists citext");

      // ---- DD03d: control, a realtime.messages policy ----
      const cp = await sql(ctx, p.ref, "create policy dd03_policy on realtime.messages for select to authenticated using (true)");
      const lp = await sql(ctx, p.ref, "select policyname from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'dd03_policy'");
      const dp = await sql(ctx, p.ref, "drop policy dd03_policy on realtime.messages");
      results.push({
        id: "DD03d",
        title: "DD03d: control - a policy on realtime.messages can be created and dropped",
        status: cp.status < 300 && (lp.rows ?? []).length === 1 && dp.status < 300 ? "pass" : "fail",
        detail: `create ${cp.status}, listed ${(lp.rows ?? []).length}, drop ${dp.status}`,
        measurements: { create_policy_status: cp.status, listed: (lp.rows ?? []).length, drop_policy_status: dp.status },
      });

      // ---- DD03e: blocked operations ----
      const em: Record<string, number | string> = {};
      const acl = await sql(
        ctx,
        p.ref,
        `select has_schema_privilege('postgres','realtime','USAGE') as usage,
                has_schema_privilege('postgres','realtime','CREATE') as create_priv,
                (select nspowner::regrole::text from pg_namespace where nspname = 'realtime') as schema_owner,
                (select relowner::regrole::text from pg_class where oid = 'realtime.messages'::regclass) as messages_owner,
                (select relowner::regrole::text from pg_class where oid = 'realtime.schema_migrations'::regclass) as migrations_owner,
                (select relacl::text from pg_class where oid = 'realtime.schema_migrations'::regclass) as migrations_acl,
                exists(select 1 from pg_trigger where tgname = 'tr_check_filters' and tgrelid = 'realtime.subscription'::regclass) as trigger_exists,
                (select max(version)::text from realtime.schema_migrations) as latest_migration,
                (select count(*)::int from realtime.schema_migrations) as migration_rows`,
      );
      const a0 = (acl.rows?.[0] ?? {}) as Record<string, unknown>;
      em.schema_usage = String(a0.usage);
      em.schema_create = String(a0.create_priv);
      em.schema_owner = String(a0.schema_owner);
      em.messages_owner = String(a0.messages_owner);
      em.schema_migrations_owner = String(a0.migrations_owner);
      em.schema_migrations_postgres_acl = red(String(a0.migrations_acl));
      em.schema_migrations_rows_before = Number(a0.migration_rows ?? -1);
      em.tr_check_filters_exists_before = String(a0.trigger_exists);
      em.latest_migration_version = String(a0.latest_migration);
      let refused = 0;
      let allowed = 0;
      for (const { key, stmt } of BLOCKED) {
        const r = await sql(ctx, p.ref, `begin; ${stmt}; rollback;`);
        const ok = r.status < 300;
        if (ok) allowed++;
        else refused++;
        em[`mgmt_${key}`] = ok ? `ALLOWED (${r.status})` : red(r.error ?? r.text);
      }
      if (pg) {
        for (const { key, stmt } of BLOCKED.filter((b) => /schema_migrations|create_table/.test(b.key))) {
          await pg.query("begin");
          const r = await pg.query(stmt);
          await pg.query("rollback");
          em[`pg_${key}`] = r.error ? red(fmtErr(r.code, r.error)) : "ALLOWED";
        }
      }
      // Post-check: nothing persisted, nothing dropped.
      const post = await sql(
        ctx,
        p.ref,
        `select (select count(*)::int from realtime.schema_migrations) as rows_after,
                (select count(*)::int from realtime.schema_migrations where version >= 99999999999990) as probe_rows,
                to_regclass('realtime.dd_probe') is not null as dd_probe_exists,
                exists(select 1 from information_schema.columns where table_schema = 'realtime' and table_name = 'messages' and column_name = 'topic') as topic_col,
                to_regprocedure('realtime.topic()') is not null as topic_fn`,
      );
      const p0 = (post.rows?.[0] ?? {}) as Record<string, unknown>;
      em.schema_migrations_rows_after = Number(p0.rows_after ?? -1);
      em.probe_rows_persisted = Number(p0.probe_rows ?? -1);
      em.dd_probe_table_persisted = String(p0.dd_probe_exists);
      em.messages_topic_column_present = String(p0.topic_col);
      em.topic_function_present = String(p0.topic_fn);
      em.operations_refused = refused;
      em.operations_allowed = allowed;
      if (Number(p0.probe_rows ?? 0) > 0) await sql(ctx, p.ref, "delete from realtime.schema_migrations where version >= 99999999999990");
      results.push({
        id: "DD03e",
        title: "DD03e: realtime schema operations named in the changelog, as postgres",
        status: "info",
        detail: `${refused} of ${BLOCKED.length} refused, ${allowed} allowed (each inside begin/rollback)`,
        measurements: em,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: "DD03", title: "DD03", status: "fail", detail: `test threw: ${msg}` });
    } finally {
      await pg?.close();
    }
    return results;
  },
};
export default mod;
