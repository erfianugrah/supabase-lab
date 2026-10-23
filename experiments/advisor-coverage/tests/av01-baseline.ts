/**
 * AV01 - the community audit (audit.sql, pinned) and the built-in advisors on
 * a FRESH project, before anything is seeded. What either side reports here
 * is about platform-owned objects or project defaults, not the user's schema:
 * the false-positive floor a new user meets on day one.
 *
 *   AV01a  audit.sql as postgres inside BEGIN TRANSACTION READ ONLY over a
 *          session-mode pooler connection: error or not, row count, every row
 *   AV01b  GET /v1/projects/{ref}/advisors/security and /performance: status,
 *          lint count by name, every lint's level/name/detail
 *   AV01c  context the matrix depends on: Postgres version,
 *          current_setting('pgrst.db_schemas') as postgres, the
 *          pgrst.db_schemas entry (only that one) of authenticator's role
 *          settings, pg_default_acl rows for functions in public
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { brief, currentProject, ensureProject, redact, skipWithoutPro, sql, type DdProject } from "../../data-api-defaults/lib/project.js";
import { AUDIT_COMMIT } from "../lib/audit.js";
import { auditLines, auditOnce, fetchAdvisors, lintLines, tally } from "../lib/run.js";

const mod: TestModule = {
  id: "AV01",
  title: "Fresh project: audit.sql and the advisors before seeding",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "AV01");
    if (skip) return skip;
    let p: DdProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "AV01", title: "AV01", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const red = (s: string, n = 4000) => brief(currentProject(), s, n);
    const results: TestResult[] = [];

    // ---- AV01c context ----
    const c = await sql(
      ctx,
      p.ref,
      `select current_setting('server_version') as pg,
              current_setting('pgrst.db_schemas', true) as db_schemas_postgres,
              (select string_agg(x, ' | ')
                 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) x
                where r.rolname = 'authenticator' and x like 'pgrst.db_schemas=%') as authenticator_db_schemas,
              (select string_agg(pg_get_userbyid(d.defaclrole) || ':' || array_to_string(d.defaclacl, ','), ' | ')
                 from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
                where n.nspname = 'public' and d.defaclobjtype = 'f') as public_function_default_acl`,
    );
    const row = c.rows?.[0] ?? {};
    results.push({
      id: "AV01c",
      title: "AV01c: Postgres version, exposed-schema settings, function default privileges in public",
      status: c.error ? "fail" : "info",
      detail: c.error ? red(c.error, 300) : `pg ${row.pg}; pgrst.db_schemas as postgres: ${row.db_schemas_postgres ?? "(unset)"}`,
      measurements: {
        server_version: String(row.pg ?? ""),
        pgrst_db_schemas_as_postgres: String(row.db_schemas_postgres ?? "(unset)"),
        authenticator_pgrst_db_schemas: String(row.authenticator_db_schemas ?? "(not set on the role)"),
        public_function_default_acl: red(String(row.public_function_default_acl ?? "(none)"), 600),
      },
    });

    // ---- AV01a audit ----
    let a;
    try {
      a = await auditOnce(p);
    } catch (e) {
      a = { rows: [], readOnly: false, error: e instanceof Error ? e.message : String(e), ms: 0 };
    }
    const byCheck = tally(a.rows.map((r) => r.check));
    results.push({
      id: "AV01a",
      title: "AV01a: audit.sql on the fresh project (read-only transaction)",
      status: a.error ? "fail" : "info",
      detail: a.error ? red(a.error, 300) : `${a.rows.length} rows; read-only txn ${a.readOnly}; ${a.ms} ms`,
      measurements: {
        audit_commit: AUDIT_COMMIT.slice(0, 7),
        read_only_txn: a.readOnly ? "yes" : "no",
        rows: a.rows.length,
        ...Object.fromEntries(Object.entries(byCheck).map(([k, v]) => [`check: ${k}`, v])),
      },
      evidence: redact(currentProject(), auditLines(a) || "(no rows)"),
    });

    // ---- AV01b advisors ----
    const adv = await fetchAdvisors(ctx, p.ref);
    const byLint = tally(adv.lints.map((l) => `${l.level} ${l.name}`));
    results.push({
      id: "AV01b",
      title: "AV01b: advisors (security + performance) on the fresh project",
      status: adv.securityStatus === 200 && adv.performanceStatus === 200 ? "info" : "fail",
      detail: `security ${adv.securityStatus}, performance ${adv.performanceStatus}; ${adv.lints.length} lints`,
      measurements: {
        security_status: adv.securityStatus,
        performance_status: adv.performanceStatus,
        lints: adv.lints.length,
        ...Object.fromEntries(Object.entries(byLint).map(([k, v]) => [`lint: ${k}`, v])),
      },
      evidence: redact(currentProject(), lintLines(adv.lints) || "(no lints)"),
    });
    return results;
  },
};
export default mod;
