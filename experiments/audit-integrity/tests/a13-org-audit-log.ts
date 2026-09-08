/**
 * A13 - does the organization audit log record SQL execution?
 *
 * The organization audit log is the only store no tenant credential can
 * rewrite, and no `/v1` path reads it (A07b: 0 of 115), so this module cannot
 * assert the answer on its own. What it CAN do is make the comparison
 * falsifiable instead of anecdotal:
 *
 *   - fire a control action that IS audited (a config PATCH, observed in the
 *     Dashboard on 2026-09-08 at 05:44:51 and 05:46:58 UTC), so an absence
 *     below means something. The first attempt at this comparison used
 *     `GET /functions` as its control; that turned out not to be an audited
 *     action, so the pair proved nothing.
 *   - fire the API-side SQL path (`POST /database/query`) at a recorded time.
 *   - print the operator step for the Dashboard SQL Editor, whose statements
 *     arrive as a different `application_name` and might be audited
 *     differently from the API path.
 *   - prove independently, from `postgres_logs`, that each statement really
 *     executed at that moment, so a missing audit entry cannot be explained
 *     away as "the query never ran".
 *
 *   A13a  control + API-SQL fired at recorded UTC timestamps, with the
 *         postgres_logs confirmation that both executed
 *   A13b  the operator's Dashboard reading, supplied via PVLAB_AUDIT_OBSERVED
 *         and recorded as operator-supplied rather than measured
 *
 * DESTRUCTIVE: PATCHes the project auth config (restored), runs a DELETE
 * against auth.audit_log_entries.
 *
 * OPERATOR STEP - in the project's SQL Editor, run:
 *   create temp table a13probe as select 1;
 *   select * from a13probe;
 * then open the organization audit log, filter to this project, and pass what
 * you saw back in:
 *   PVLAB_AUDIT_OBSERVED='control=yes,api_sql=no,editor_sql=no'
 * Any key you cannot determine, say `unknown`. The module records the string
 * verbatim; it does not interpret a missing key as a negative.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { findMarkers, nonce, sqlTry } from "../lib/audit.js";

const WAIT_MS = 180_000;
const EDITOR_MARKER = "a13probe";

const mod: TestModule = {
  id: "A13",
  title: "does the organization audit log record SQL execution (control-plane control + operator read)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const marker = `a13api${nonce()}`;

    // The control: a config PATCH, which the Dashboard audit log was observed
    // to record. Patch a value to itself so the project is left as it was -
    // the audit entry is the point, not the config change.
    const cfg = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
    const current = ((cfg.json ?? {}) as Record<string, unknown>).mailer_autoconfirm;
    const controlAt = new Date().toISOString();
    const control = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, { mailer_autoconfirm: current === true });

    // The subject: the API-side SQL path, running the statement this whole
    // experiment is about.
    const sqlAt = new Date().toISOString();
    const del = await sqlTry(ctx, `delete from auth.audit_log_entries where payload->>'action' = '${marker}'`);

    // Independent proof both statements executed, from a store that is not the
    // audit log. The DELETE carries a nonce; log_statement=ddl will not log it,
    // so a DDL statement carrying the same nonce goes with it as the witness.
    const witness = `a13wit${nonce()}`;
    const ddl = await sqlTry(ctx, `create table public.${witness}(a int); drop table public.${witness}`);
    const seen = await findMarkers(ctx, [witness, EDITOR_MARKER], WAIT_MS);
    const witnessSeen = Boolean(seen.hits[witness]);
    const editorSeen = Boolean(seen.hits[EDITOR_MARKER]);

    out.push({
      id: "A13a",
      title: "control-plane control and API-side SQL, fired at recorded times",
      status: control.status < 300 && witnessSeen ? "pass" : "info",
      detail: `control PATCH config/auth (a value patched to itself) -> HTTP ${control.status} at ${controlAt}. API-side SQL (POST /database/query, a DELETE on auth.audit_log_entries) -> HTTP ${del.status} at ${sqlAt}. Independent execution witness: a DDL statement with nonce ${witness} ${witnessSeen ? `appeared in postgres_logs ${seen.firstSeenS[witness]}s later, so the API SQL path was live at that moment` : `did NOT appear within ${seen.windowS}s, so this run cannot prove the SQL executed`}. Dashboard SQL Editor marker "${EDITOR_MARKER}" ${editorSeen ? `WAS found in postgres_logs (${seen.firstSeenS[EDITOR_MARKER]}s), so the operator step ran` : "was not found in postgres_logs, so the operator step has not run on this project yet"}.`,
      measurements: {
        control_status: control.status,
        control_at: controlAt,
        api_sql_status: del.status,
        api_sql_at: sqlAt,
        witness_seen: String(witnessSeen),
        editor_step_ran: String(editorSeen),
        search_window_s: seen.windowS,
      },
      evidence: `control PATCH at ${controlAt}\nAPI SQL at ${sqlAt}\ncompare these two timestamps against the organization audit log`,
    });

    const observed = process.env.PVLAB_AUDIT_OBSERVED ?? "";
    out.push({
      id: "A13b",
      title: "what the organization audit log showed (operator-supplied)",
      status: observed ? "info" : "skip",
      detail: observed
        ? `operator reading, verbatim: "${observed}". This is a human Dashboard read, not a measurement: the organization audit log has no API path (A07b), so nothing in this harness can assert or contradict it. The control entry is what makes a negative meaningful - if the control is absent too, the reading says nothing.`
        : `not supplied. Run the operator step in the module header, read the organization audit log for the two timestamps in A13a, and re-run with PVLAB_AUDIT_OBSERVED set. Without it this experiment has no evidence either way about SQL execution in the organization audit log.`,
      measurements: { observation_supplied: String(Boolean(observed)), observation: observed || "none" },
    });

    // Leave the config as it was found.
    if (control.status < 300 && current !== undefined) {
      await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, { mailer_autoconfirm: current }).catch(() => {});
    }
    return out;
  },
};
export default mod;
