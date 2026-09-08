/**
 * A01 - who can write to the audit trail on a FRESH project, and what the
 * logging defaults are.
 *
 * Managed project, PAT only (the Management query endpoint runs as `postgres`).
 * Read-only: nothing here mutates the project.
 *
 *   A01a  auth.audit_log_entries: owner, ACL, columns, constraints, triggers
 *   A01b  has_table_privilege for every role a tenant can reach, x
 *         select/insert/update/delete/truncate
 *   A01c  role attributes and memberships for those roles (login, bypassrls)
 *   A01d  the platform logging defaults: log_statement, log_connections,
 *         log_min_duration_statement, pgaudit installed/available
 *
 * Not settled by this module: whether a role that HOLDS a privilege can
 * exercise it (A02 runs the statements), and which identity the Dashboard SQL
 * Editor connects as (A11 - it needs a human in the Dashboard).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { sqlRows } from "../lib/audit.js";

const ROLES = ["postgres", "dashboard_user", "supabase_admin", "supabase_auth_admin", "supabase_read_only_user", "service_role", "authenticator", "anon", "authenticated", "pgbouncer"];
const PRIVS = ["select", "insert", "update", "delete", "truncate"];

const mod: TestModule = {
  id: "A01",
  title: "privilege map and logging defaults for auth.audit_log_entries on a fresh project",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];

    // A01a - shape
    const shape = await sqlRows(
      ctx,
      `select
         (select pg_get_userbyid(relowner) from pg_class where oid = 'auth.audit_log_entries'::regclass) as owner,
         (select relacl::text from pg_class where oid = 'auth.audit_log_entries'::regclass) as acl,
         (select string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position)
            from information_schema.columns where table_schema = 'auth' and table_name = 'audit_log_entries') as columns,
         (select string_agg(conname || ':' || contype::text, ', ') from pg_constraint
            where conrelid = 'auth.audit_log_entries'::regclass) as constraints,
         (select count(*)::int from pg_constraint
            where conrelid = 'auth.audit_log_entries'::regclass and contype = 'f') as fk_count,
         (select count(*)::int from pg_trigger
            where tgrelid = 'auth.audit_log_entries'::regclass and not tgisinternal) as user_triggers,
         (select count(*)::int from auth.audit_log_entries) as rows_now`,
    );
    const s = (shape[0] ?? {}) as Record<string, unknown>;
    out.push({
      id: "A01a",
      title: "auth.audit_log_entries: owner, ACL and shape",
      status: "info",
      detail: `owner=${String(s.owner)}; acl=${String(s.acl)}; columns: ${String(s.columns)}; constraints: ${String(s.constraints)} (${String(s.fk_count)} foreign keys, ${String(s.user_triggers)} user triggers); ${String(s.rows_now)} rows at first read.`,
      measurements: {
        owner: String(s.owner),
        fk_count: Number(s.fk_count),
        user_triggers: Number(s.user_triggers),
        rows_at_start: Number(s.rows_now),
        acl: String(s.acl),
      },
      evidence: `columns: ${String(s.columns)}\nacl: ${String(s.acl)}`,
    });

    // A01b - privilege matrix
    const cols = ROLES.flatMap((r) => PRIVS.map((p) => `has_table_privilege('${r}', 'auth.audit_log_entries', '${p}') as "${r}.${p}"`));
    const priv = (await sqlRows(ctx, `select ${cols.join(", ")}`))[0] as Record<string, boolean>;
    const writers = ROLES.filter((r) => priv[`${r}.delete`] === true);
    const readers = ROLES.filter((r) => priv[`${r}.select`] === true);
    const grid = ROLES.map((r) => `${r}: ${PRIVS.filter((p) => priv[`${r}.${p}`]).join("/") || "none"}`).join("\n");
    out.push({
      id: "A01b",
      title: "which roles hold delete/truncate on the audit table",
      status: "info",
      detail: `${writers.length} of ${ROLES.length} roles can delete rows: ${writers.join(", ")}. ${readers.length} can read: ${readers.join(", ")}. The three API roles (anon, authenticated, service_role) hold: ${ROLES.filter((r) => ["anon", "authenticated", "service_role"].includes(r)).map((r) => `${r}=${PRIVS.filter((p) => priv[`${r}.${p}`]).join("/") || "none"}`).join(", ")}.`,
      measurements: {
        roles_probed: ROLES.length,
        roles_with_delete: writers.length,
        roles_with_select: readers.length,
        service_role_select: String(priv["service_role.select"] === true),
        service_role_delete: String(priv["service_role.delete"] === true),
        read_only_user_select: String(priv["supabase_read_only_user.select"] === true),
        read_only_user_delete: String(priv["supabase_read_only_user.delete"] === true),
        postgres_delete: String(priv["postgres.delete"] === true),
        postgres_truncate: String(priv["postgres.truncate"] === true),
      },
      evidence: grid,
    });

    // A01c - role attributes
    const attrs = await sqlRows(
      ctx,
      `select rolname, rolsuper, rolcanlogin, rolbypassrls,
              coalesce((select string_agg(g.rolname, ',' order by g.rolname) from pg_auth_members m
                          join pg_roles g on g.oid = m.roleid where m.member = r.oid), '') as member_of
         from pg_roles r where rolname = any(array[${ROLES.map((r) => `'${r}'`).join(",")}]) order by rolname`,
    );
    const roUser = attrs.find((a) => a.rolname === "supabase_read_only_user");
    out.push({
      id: "A01c",
      title: "role attributes: who can log in, who bypasses RLS, who inherits what",
      status: "info",
      detail: `${attrs.length} of ${ROLES.length} roles exist. supabase_read_only_user ${roUser ? `exists (login=${String(roUser.rolcanlogin)}, member_of=${String(roUser.member_of) || "none"})` : "does not exist on this project"}. dashboard_user login=${String(attrs.find((a) => a.rolname === "dashboard_user")?.rolcanlogin)}.`,
      measurements: {
        roles_present: attrs.length,
        read_only_user_present: String(Boolean(roUser)),
        read_only_user_memberships: String(roUser?.member_of ?? ""),
      },
      evidence: attrs.map((a) => `${String(a.rolname)}: super=${String(a.rolsuper)} login=${String(a.rolcanlogin)} bypassrls=${String(a.rolbypassrls)} member_of=${String(a.member_of) || "-"}`).join("\n"),
    });

    // A01d - logging defaults
    const gucs = await sqlRows(
      ctx,
      `select name, setting from pg_settings
         where name in ('log_statement','log_min_duration_statement','log_connections','log_disconnections','log_duration','pgaudit.log')
       union all select 'pgaudit_installed', coalesce((select extversion from pg_extension where extname = 'pgaudit'), 'no')
       union all select 'pgaudit_available', coalesce((select default_version from pg_available_extensions where name = 'pgaudit'), 'no')
       order by name`,
    );
    const g = Object.fromEntries(gucs.map((r) => [String(r.name), String(r.setting)]));
    out.push({
      id: "A01d",
      title: "platform logging defaults on a fresh project",
      status: "info",
      detail: `log_statement=${g.log_statement}, log_min_duration_statement=${g.log_min_duration_statement}, log_connections=${g.log_connections}, log_disconnections=${g.log_disconnections}, pgaudit installed=${g.pgaudit_installed} (available ${g.pgaudit_available}), pgaudit.log=${g["pgaudit.log"]}. With log_statement=ddl and no pgaudit, a DELETE is not a logged statement class - A03 runs one.`,
      measurements: {
        log_statement: g.log_statement ?? "",
        log_min_duration_statement: g.log_min_duration_statement ?? "",
        log_connections: g.log_connections ?? "",
        pgaudit_installed: g.pgaudit_installed ?? "",
        pgaudit_available: g.pgaudit_available ?? "",
        pgaudit_log: g["pgaudit.log"] ?? "",
      },
    });

    return out;
  },
};
export default mod;
