/**
 * A03 - what trace does erasing the audit trail leave under platform defaults?
 *
 * Managed project, PAT. Each statement carries a nonce so the search for it in
 * the log stream cannot match anything else. The DDL row is the POSITIVE
 * CONTROL: without it, "not found" is indistinguishable from ingestion lag or a
 * query that never could have matched.
 *
 *   A03a  a DDL statement with a nonce -> found in postgres_logs (control),
 *         with the ingestion lag
 *   A03b  a bare DELETE on auth.audit_log_entries with a nonce -> found?
 *   A03c  a bare TRUNCATE with a nonce in a leading comment -> found?
 *   A03d  what the logged control line actually carries: role, application_name
 *         and whatever provenance the platform appends to a statement it runs
 *
 * DESTRUCTIVE: deletes and truncates auth.audit_log_entries; creates and drops
 * one scratch table.
 *
 * Not settled by this module: whether a direct psql session (rather than the
 * Management API) is logged differently - that needs a connection from this
 * machine through the pooler, and log_connections is off by default (A04 pairs
 * the levers).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { findMarkers, nonce, sqlTry } from "../lib/audit.js";

const WAIT_MS = 180_000;
const POLL_S = 30;

const mod: TestModule = {
  id: "A03",
  title: "under platform defaults, a DELETE and a TRUNCATE on the audit table leave no statement in the logs",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const nDdl = `a03ddl${nonce()}`;
    const nDel = `a03del${nonce()}`;
    const nTru = `a03tru${nonce()}`;

    // Fire all three first, then search. Searching between them would let the
    // control's own ingestion lag pad the wait for the other two.
    const ddl = await sqlTry(ctx, `create table public.${nDdl}(a int); drop table public.${nDdl}`);
    const del = await sqlTry(ctx, `delete from auth.audit_log_entries where payload->>'action' = '${nDel}'`);
    const tru = await sqlTry(ctx, `-- ${nTru}\ntruncate table auth.audit_log_entries`);

    // One OR'd query per poll for all three markers: the logs endpoint is rate
    // limited, and three separate polling loops spend that budget three times.
    const search = await findMarkers(ctx, [nDdl, nDel, nTru], WAIT_MS);
    // The control's own first-seen time, NOT the loop exit: the loop runs to
    // the timeout because the delete and truncate markers never arrive, so the
    // exit time is a search-window bound and says nothing about ingestion.
    const ctl = { found: Boolean(search.hits[nDdl]), firstSeenS: search.firstSeenS[nDdl], windowS: search.windowS, error: search.error, rows: [search.hits[nDdl] ?? {}] };
    out.push({
      id: "A03a",
      title: "control: a DDL statement is findable in postgres_logs by its nonce",
      status: ctl.found ? "pass" : "fail",
      detail: ctl.found
        ? `create/drop table -> HTTP ${ddl.status}; the statement text was first seen in postgres_logs ${ctl.firstSeenS}s after the fire, on a ${ctl.windowS}s search at a ${POLL_S}s poll interval. The search works and ingestion is live, so a miss below is a miss.`
        : `the control statement did NOT appear within ${ctl.windowS}s over ${search.polls} polls (${ctl.error || "no endpoint error"}). Nothing below can be interpreted.`,
      measurements: {
        control_found: String(ctl.found),
        control_first_seen_s: ctl.firstSeenS ?? -1,
        search_window_s: ctl.windowS,
        poll_interval_s: POLL_S,
        ddl_status: ddl.status,
      },
    });

    const d = { found: Boolean(search.hits[nDel]), windowS: search.windowS };
    out.push({
      id: "A03b",
      title: "a bare DELETE on the audit table in postgres_logs",
      status: ctl.found ? "info" : "skip",
      detail: ctl.found
        ? `delete -> HTTP ${del.status}; searched postgres_logs for its nonce across the full ${d.windowS}s window: ${d.found ? "FOUND - a delete is logged by default after all" : "not found. log_statement=ddl does not cover DML, so the erasure of an audit row is not itself a logged statement"}.`
        : "control failed; not interpretable",
      measurements: { delete_status: del.status, delete_logged: String(d.found), searched_s: d.windowS },
    });

    const t = { found: Boolean(search.hits[nTru]), windowS: search.windowS };
    out.push({
      id: "A03c",
      title: "a bare TRUNCATE on the audit table in postgres_logs",
      status: ctl.found ? "info" : "skip",
      detail: ctl.found
        ? `truncate -> HTTP ${tru.status}; searched across the full ${t.windowS}s window: ${t.found ? "FOUND" : "not found. log_statement groups TRUNCATE under mod with the data-modifying statements, not under ddl, so emptying the table in one statement is unlogged too"}.`
        : "control failed; not interpretable",
      measurements: { truncate_status: tru.status, truncate_logged: String(t.found), searched_s: t.windowS },
    });

    // A03d - what the one logged line carries
    const row = (ctl.rows[0] ?? {}) as Record<string, unknown>;
    const msg = String(row.event_message ?? "");
    const footer = msg.match(/--\s*source:.*$/ms)?.[0] ?? "";
    out.push({
      id: "A03d",
      title: "provenance on a statement the platform ran for you",
      status: ctl.found ? "info" : "skip",
      detail: ctl.found
        ? `the control line is attributed to role=${String(row.usr ?? "?")}, application_name=${String(row.app ?? "?")}${footer ? `, and the platform appended a provenance comment naming the calling route and the acting identity (${footer.split("\n").length} lines: ${footer.replace(/[a-f0-9-]{36}/g, "<id>").replace(/\s+/g, " ").slice(0, 120)})` : ", with no provenance comment appended"}. Every tenant path - Dashboard, Management API, MCP - arrives as this one database role, so per-person attribution is not in Postgres.`
        : "control failed; not interpretable",
      measurements: {
        logged_role: String(row.usr ?? ""),
        logged_application: String(row.app ?? ""),
        provenance_comment: String(Boolean(footer)),
      },
      evidence: msg.replace(/[a-f0-9-]{36}/g, "<id>").slice(0, 600),
    });

    return out;
  },
};
export default mod;
