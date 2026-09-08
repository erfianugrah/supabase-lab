/**
 * A11 - which database identity does the Dashboard SQL Editor connect as?
 *
 * The ACL grants both `postgres` and `dashboard_user` full write on the audit
 * table, and the Management API path measures as `postgres` with
 * application_name=mgmt-api. Which one a Dashboard session uses changes what an
 * investigator greps for, and it cannot be driven from here: the SQL Editor is
 * behind a browser session, not the PAT.
 *
 * So this module reads rather than acts. It looks for a logged statement in
 * postgres_logs that did NOT come from mgmt-api and reports the identity it
 * carries. An OPERATOR STEP makes one appear:
 *
 *   In the project's SQL Editor, run:
 *     create temp table who_am_i as
 *       select current_user, session_user, current_setting('application_name');
 *     select * from who_am_i;
 *   then re-run this module. (The temp table is deliberate: log_statement=ddl
 *   means a bare SELECT is never logged.)
 *
 *   A11a  statements in the last hour grouped by role and application_name
 *   A11b  the non-mgmt-api session, if the operator step has been run
 *
 * Read-only.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { stream } from "../lib/audit.js";

const mod: TestModule = {
  id: "A11",
  title: "the Dashboard SQL Editor's database identity (operator step required)",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const g = await stream(
      ctx,
      `select log_attributes['parsed.user_name'] as usr, log_attributes['parsed.application_name'] as app, count() as n
         from logs where source = 'postgres_logs' and event_message like 'statement:%'
        group by usr, app order by n desc limit 20`,
      1,
    );
    const rows = g.rows as { usr?: string; app?: string; n?: unknown }[];
    const apps = rows.map((r) => `${String(r.usr || "-")}/${String(r.app || "-")} x${String(r.n)}`);
    out.push({
      id: "A11a",
      title: "logged statements in the last hour, by role and application_name",
      status: rows.length ? "info" : "skip",
      detail: rows.length ? `${apps.join(", ")}. Every path this harness uses arrives as one role, so a per-person question cannot be answered from Postgres alone.` : `no logged statements in the window${g.error ? ` (${g.error})` : ""}`,
      measurements: { groups: rows.length, apps: apps.join(" | ").slice(0, 200) },
      evidence: apps.join("\n"),
    });

    const other = rows.filter((r) => String(r.app || "") !== "mgmt-api");
    const who = await stream(
      ctx,
      `select timestamp, log_attributes['parsed.user_name'] as usr, log_attributes['parsed.application_name'] as app, event_message
         from logs where source = 'postgres_logs' and event_message like '%who_am_i%' order by timestamp desc limit 3`,
      1,
    );
    out.push({
      id: "A11b",
      title: "a Dashboard SQL Editor session, if the operator step has been run",
      status: who.rows.length ? "pass" : "skip",
      detail: who.rows.length
        ? `found the operator statement: role=${String((who.rows[0] as { usr?: string }).usr)}, application_name=${String((who.rows[0] as { app?: string }).app)}. That is the identity a Dashboard member's SQL runs as.`
        : `no who_am_i statement in the last hour. ${other.length} non-mgmt-api statement group(s) present${other.length ? `: ${other.map((r) => `${String(r.usr)}/${String(r.app)}`).join(", ")}` : ""}. Run the operator step in the module header, then re-run A11.`,
      measurements: { operator_step_found: String(who.rows.length > 0), non_mgmt_groups: other.length },
      evidence: who.rows.map((r) => String((r as { event_message?: string }).event_message ?? "").replace(/[a-f0-9-]{36}/g, "<id>").slice(0, 300)).join("\n"),
    });

    return out;
  },
};
export default mod;
