/**
 * UI07 - roles postgres created on PostgreSQL 15, after an in-place upgrade
 * to 17 (work-supabase-lab#328).
 *
 * PostgreSQL 16 changed CREATEROLE: a non-superuser with CREATEROLE manages
 * only roles it holds ADMIN OPTION on, and a role it creates gets that grant
 * automatically (security-lockdown S27 on 17). Roles created on 15 were made
 * under the old rule, with no membership row for their creator. What can
 * `postgres` still do to them once the project is on 17?
 *
 *   UI07a  on 15, as postgres: create ui07_app (NOLOGIN) and ui07_svc (LOGIN),
 *          grant ui07_app to ui07_svc; postgres's pg_auth_members rows for
 *          both, and an ALTER ROLE ... PASSWORD as the control
 *   UI07b  POST /upgrade to the first eligible target, polled to
 *          ACTIVE_HEALTHY on the new major
 *   UI07c  on 17: postgres's rows for both roles, then ALTER ROLE ui07_svc
 *          PASSWORD, GRANT ui07_app to a role created on 17, REVOKE ui07_app
 *          FROM ui07_svc, DROP ROLE ui07_app; CREATE ROLE, ALTER ROLE ...
 *          NOLOGIN and DROP ROLE on a role created on 17 as the control
 *   UI07d  the remedy, set up on 15: ui07_pre granted to postgres WITH ADMIN
 *          OPTION before the upgrade; on 17, grant, revoke and drop it
 *
 * Runs on the module's shared PG15 project (ensureProject); UI99 deletes it.
 * Statements go through the Management API query route, which runs as postgres.
 */
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, projectStatus, skipWithoutPro, sleep, sql } from "../lib/ui.js";

const TIMEOUT_MS = 75 * 60_000;
const pw = () => `${crypto.randomUUID().replaceAll("-", "")}Xy9`;

async function step(ctx: Ctx, ref: string, q: string): Promise<string> {
  const r = await sql(ctx, ref, q);
  return r.error ? r.error.replace(/\s+/g, " ").slice(0, 100) : "ok";
}

async function membership(ctx: Ctx, ref: string): Promise<string> {
  const r = await sql(ctx, ref, `
select r.rolname as role, m.admin_option, m.inherit_option, m.set_option, g.rolname as grantor
from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member join pg_roles g on g.oid = m.grantor
where u.rolname = 'postgres' and r.rolname like 'ui07_%' order by 1, 5`);
  if (r.error) {
    // PostgreSQL 15 has no inherit_option / set_option columns.
    const r15 = await sql(ctx, ref, `
select r.rolname as role, m.admin_option, g.rolname as grantor
from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member join pg_roles g on g.oid = m.grantor
where u.rolname = 'postgres' and r.rolname like 'ui07_%' order by 1, 3`);
    if (r15.error) return `unreadable: ${r15.error.slice(0, 80)}`;
    return (r15.rows ?? []).map((x) => `${String(x.role)}(admin ${String(x.admin_option)}, grantor ${String(x.grantor)})`).join(", ") || "none";
  }
  return (r.rows ?? []).map((x) => `${String(x.role)}(admin ${String(x.admin_option)}, inherit ${String(x.inherit_option)}, set ${String(x.set_option)}, grantor ${String(x.grantor)})`).join(", ") || "none";
}

const mod: TestModule = {
  id: "UI07",
  title: "roles postgres created on 15, after the in-place upgrade to 17",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 100 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "UI07");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      const ref = p.ref;
      // ---------------- UI07a: on 15
      const made = await step(ctx, ref, `create role ui07_app nologin; create role ui07_svc login password '${pw()}'; grant ui07_app to ui07_svc;`);
      const pre = await step(ctx, ref, "create role ui07_pre nologin; grant ui07_pre to postgres with admin option;");
      const mem15 = await membership(ctx, ref);
      const alter15 = await step(ctx, ref, `alter role ui07_svc password '${pw()}'`);
      out.push({
        id: "UI07a",
        title: "on the old major: roles created by postgres",
        status: made === "ok" ? "info" : "fail",
        detail: `server_version ${p.version}. create ui07_app, ui07_svc, grant ui07_app to ui07_svc -> ${made}. Remedy set-up: create ui07_pre, grant ui07_pre to postgres with admin option -> ${pre}. postgres's membership rows in ui07_*: ${mem15}. alter role ui07_svc password -> ${alter15}.`,
        measurements: { version_before: p.version, create: made, remedy_grant: pre, postgres_rows_before: mem15.slice(0, 200), alter_password_before: alter15 },
      });
      if (made !== "ok") return out;

      // ---------------- UI07b: upgrade
      const e = await mgmt(ctx, "GET", `/projects/${ref}/upgrade/eligibility`);
      const ej = (e.json ?? {}) as { eligible?: boolean | null; target_upgrade_versions?: { postgres_version?: string; release_channel?: string; app_version?: string }[] };
      const target = ej.target_upgrade_versions?.[0];
      if (!target || ej.eligible !== true) {
        out.push({ id: "UI07b", title: "upgrade", status: "fail", detail: `eligibility HTTP ${e.status}, eligible ${String(ej.eligible)}, target ${JSON.stringify(target ?? null)}` });
        return out;
      }
      const targetMajor = String(target.postgres_version ?? "");
      const postAt = Date.now();
      const post = await mgmt(ctx, "POST", `/projects/${ref}/upgrade`, { target_version: targetMajor, release_channel: target.release_channel ?? "ga" });
      let version = "";
      let lastStatus = "";
      while (post.status < 300 && Date.now() - postAt < TIMEOUT_MS) {
        await sleep(20_000);
        const st = await projectStatus(ctx, ref).catch(() => ({ status: "?", database: {} }));
        lastStatus = st.status;
        if (st.status !== "ACTIVE_HEALTHY") continue;
        const v = await sql(ctx, ref, "select current_setting('server_version') as v");
        version = String(v.rows?.[0]?.v ?? "");
        if (version.startsWith(targetMajor)) break;
      }
      const upS = Math.round((Date.now() - postAt) / 1000);
      out.push({
        id: "UI07b",
        title: "in-place upgrade to the first eligible target",
        status: version.startsWith(targetMajor) ? "info" : "fail",
        detail: `target ${targetMajor} (${target.app_version ?? "?"}); POST /upgrade -> ${post.status}; on ${version || "?"} and ACTIVE_HEALTHY after ${upS} s (20 s poll; last status ${lastStatus}).`,
        measurements: { target: targetMajor, app_version: target.app_version ?? "?", post_status: post.status, version_after: version, upgrade_s: upS },
      });
      if (!version.startsWith(targetMajor)) return out;

      // ---------------- UI07c: on the new major
      const mem17 = await membership(ctx, ref);
      const steps: Record<string, string> = {};
      steps.alter_password = await step(ctx, ref, `alter role ui07_svc password '${pw()}'`);
      steps.create_new = await step(ctx, ref, "create role ui07_new nologin");
      steps.grant_to_new = await step(ctx, ref, "grant ui07_app to ui07_new");
      steps.revoke_from_svc = await step(ctx, ref, "revoke ui07_app from ui07_svc");
      steps.drop_app = await step(ctx, ref, "drop role ui07_app");
      steps.ctl_alter_new = await step(ctx, ref, "alter role ui07_new nologin");
      const r: Record<string, string> = {};
      r.pre_grant_to_new = await step(ctx, ref, "grant ui07_pre to ui07_new");
      r.pre_revoke = await step(ctx, ref, "revoke ui07_pre from ui07_new");
      r.pre_drop = await step(ctx, ref, "drop role ui07_pre");
      steps.ctl_drop_new = await step(ctx, ref, "drop role ui07_new");
      out.push({
        id: "UI07c",
        title: "on the new major: what postgres can still do to roles it created on 15",
        status: "info",
        detail: `postgres's membership rows in ui07_* after the upgrade: ${mem17}. On roles created on 15: alter role ui07_svc password -> ${steps.alter_password}; grant ui07_app to ui07_new -> ${steps.grant_to_new}; revoke ui07_app from ui07_svc -> ${steps.revoke_from_svc}; drop role ui07_app -> ${steps.drop_app}. Control, a role created on ${targetMajor}: create -> ${steps.create_new}, alter -> ${steps.ctl_alter_new}, drop -> ${steps.ctl_drop_new}.`,
        measurements: { postgres_rows_after: mem17.slice(0, 200), ...steps },
      });
      out.push({
        id: "UI07d",
        title: "the remedy: a role granted to postgres WITH ADMIN OPTION before the upgrade",
        status: pre === "ok" ? "info" : "fail",
        detail: `On 15: grant ui07_pre to postgres with admin option -> ${pre}. On ${targetMajor}: grant ui07_pre to ui07_new -> ${r.pre_grant_to_new}; revoke -> ${r.pre_revoke}; drop role ui07_pre -> ${r.pre_drop}.`,
        measurements: { remedy_grant_on_15: pre, ...r },
      });
    } catch (e) {
      out.push({ id: "UI07x", title: "UI07 aborted", status: "fail", detail: errText(e) });
    }
    return out;
  },
};
export default mod;
