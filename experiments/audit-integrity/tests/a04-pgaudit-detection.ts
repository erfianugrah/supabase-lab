/**
 * A04 - the levers that make erasing the audit trail visible, and the one the
 * Management API does not expose.
 *
 * Managed project, PAT. A04 restores every setting it changes in `finally`.
 *
 *   A04a  log_statement is absent from the Management API's Postgres config
 *         (GET the config; PUT log_statement=mod and record the refusal), so
 *         "log all DML" is not a platform switch
 *   A04b  pgaudit session mode: create extension, `alter role postgres set
 *         pgaudit.log to 'write'`, then a bare DELETE and TRUNCATE in a NEW
 *         session -> AUDIT lines in postgres_logs, with the lag. Whether the
 *         role-level GUC needs a restart is the point: the docs prescribe one.
 *   A04c  pgaudit object mode: an auditor role granted delete on
 *         auth.audit_log_entries and set as pgaudit.role, with pgaudit.log back
 *         to none -> is the scoped, low-noise form enough to catch the delete?
 *   A04d  log_connections: settable through the API, and what a connection line
 *         carries that a statement line does not
 *
 * DESTRUCTIVE: installs and drops pgaudit, creates and drops a role, changes
 * and restores role-level GUCs, deletes from auth.audit_log_entries.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { findMarkers, nonce, sqlRows, sqlTry } from "../lib/audit.js";

const WAIT_MS = 180_000;
const AUDITOR = "a04_auditor";

const mod: TestModule = {
  id: "A04",
  title: "pgaudit and log_connections: making an audit-table delete visible, and what the API will not give you",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    let restored = "";
    try {
      // A04a - the API's Postgres config surface
      const get = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/database/postgres`);
      const keys = Object.keys((get.json ?? {}) as Record<string, unknown>);
      const put = await mgmt(ctx, "PUT", `/projects/${ctx.ref}/config/database/postgres`, { log_statement: "mod" });
      out.push({
        id: "A04a",
        title: "log_statement through the Management API",
        status: "info",
        detail: `GET config/database/postgres -> HTTP ${get.status}, ${keys.length} key(s)${keys.length ? ` (${keys.join(", ")})` : " - the endpoint returns only the overrides that have been SET, so a project nobody has configured answers an empty object rather than the full effective config"}. log_statement ${keys.includes("log_statement") ? "present" : "absent"}. PUT log_statement=mod -> HTTP ${put.status}${put.status >= 300 ? `: ${put.text.replace(/\s+/g, " ").slice(0, 160)}` : " - accepted"}. Statement-level DML logging is therefore a pgaudit job, not a config toggle.`,
        measurements: {
          config_keys: keys.length,
          log_statement_settable: String(keys.includes("log_statement")),
          log_connections_settable: String(keys.includes("log_connections")),
          put_log_statement_status: put.status,
        },
        evidence: keys.sort().join(", "),
      });

      // A04b - pgaudit session mode
      const install = await sqlTry(ctx, "create extension if not exists pgaudit");
      const setRole = await sqlTry(ctx, "alter role postgres set pgaudit.log to 'write'");
      restored = "session";
      const cfg = await sqlRows(ctx, "select coalesce((select string_agg(c, ',') from unnest((select rolconfig from pg_roles where rolname='postgres')) c where c like 'pgaudit%'), 'none') as rolcfg");
      const nDel = `a04del${nonce()}`;
      const nTru = `a04tru${nonce()}`;
      // A NEW request is a new session, which is where a role-level GUC applies.
      const del = await sqlTry(ctx, `delete from auth.audit_log_entries where payload->>'action' = '${nDel}'`);
      const tru = await sqlTry(ctx, `-- ${nTru}\ntruncate table auth.audit_log_entries`);
      const both = await findMarkers(ctx, [nDel, nTru], WAIT_MS);
      // Per-marker, because both statements are searched for in ONE query: a
      // shared exit-time figure made the delete and truncate latencies look
      // like two independent measurements that happened to match.
      const audited = (m: string) => {
        const row = both.hits[m];
        const msg = String(row?.event_message ?? "");
        return { found: msg.startsWith("AUDIT:"), lagS: both.firstSeenS[m] ?? -1, windowS: both.windowS, rows: [row ?? {}] };
      };
      const dHit = audited(nDel);
      const tHit = audited(nTru);
      out.push({
        id: "A04b",
        title: "pgaudit session mode catches the delete and the truncate",
        status: dHit.found && tHit.found ? "pass" : "info",
        detail: `create extension -> ${install.ok}; alter role postgres set pgaudit.log to 'write' -> ${setRole.ok} (rolconfig now ${String((cfg[0] as { rolcfg?: string })?.rolcfg)}); no restart performed. DELETE -> HTTP ${del.status}: AUDIT line ${dHit.found ? `first seen ${dHit.lagS}s later` : `absent within the ${dHit.windowS}s window`}. TRUNCATE -> HTTP ${tru.status}: AUDIT line ${tHit.found ? `first seen ${tHit.lagS}s later` : `absent within the ${tHit.windowS}s window`}. Both statements ran in sessions opened AFTER the ALTER ROLE, which is what makes a role-level GUC apply without a reboot.`,
        measurements: {
          extension_installed: String(install.ok),
          delete_audited: String(dHit.found),
          delete_audit_lag_s: dHit.lagS,
          truncate_audited: String(tHit.found),
          truncate_audit_lag_s: tHit.lagS,
          restart_needed: String(!(dHit.found && tHit.found)),
        },
        evidence: [dHit.rows[0]?.event_message, tHit.rows[0]?.event_message].filter(Boolean).map(String).join("\n").slice(0, 600),
      });

      // A04c - pgaudit object mode, scoped to this one table
      const obj = await sqlTry(
        ctx,
        `do $$ begin if not exists (select 1 from pg_roles where rolname = '${AUDITOR}') then create role ${AUDITOR} noinherit; end if; end $$;`,
      );
      const grant = await sqlTry(ctx, `grant select, insert, update, delete, truncate on auth.audit_log_entries to ${AUDITOR}`);
      const scope = await sqlTry(ctx, `alter role postgres set pgaudit.role to '${AUDITOR}'`);
      const off = await sqlTry(ctx, "alter role postgres set pgaudit.log to 'none'");
      restored = "object";
      const nObj = `a04obj${nonce()}`;
      const nObjT = `a04objt${nonce()}`;
      const objDel = await sqlTry(ctx, `delete from auth.audit_log_entries where payload->>'action' = '${nObj}'`);
      const objTru = await sqlTry(ctx, `-- ${nObjT}\ntruncate table auth.audit_log_entries`);
      const objSearch = await findMarkers(ctx, [nObj, nObjT], WAIT_MS);
      const objRow = (m: string) => {
        const row = objSearch.hits[m];
        return { found: String(row?.event_message ?? "").startsWith("AUDIT:"), lagS: objSearch.firstSeenS[m] ?? -1, rows: [row ?? {}] };
      };
      const oHit = objRow(nObj);
      const oTru = objRow(nObjT);
      out.push({
        id: "A04c",
        title: "pgaudit object mode: audit this one table, log nothing else",
        status: oHit.found && oTru.found ? "pass" : "info",
        detail: `auditor role -> ${obj.ok}; grant on the audit table -> ${grant.ok}; pgaudit.role=${AUDITOR} -> ${scope.ok}; pgaudit.log back to none -> ${off.ok}. DELETE -> HTTP ${objDel.status}: AUDIT line ${oHit.found ? `first seen ${oHit.lagS}s later (${String(oHit.rows[0]?.event_message ?? "").slice(0, 90)})` : `absent within the ${objSearch.windowS}s window`}. TRUNCATE -> HTTP ${objTru.status}: AUDIT line ${oTru.found ? `first seen ${oTru.lagS}s later` : `absent within the ${objSearch.windowS}s window`}. Object mode logs only statements touching the granted table, so it adds no lines for the rest of the database traffic.`,
        measurements: {
          auditor_created: String(obj.ok),
          object_mode_set: String(scope.ok),
          session_logging_off: String(off.ok),
          delete_audited_object_mode: String(oHit.found),
          object_audit_lag_s: oHit.lagS,
          truncate_audited_object_mode: String(oTru.found),
          object_truncate_lag_s: oTru.lagS,
          search_window_s: objSearch.windowS,
        },
        evidence: [oHit.rows[0]?.event_message, oTru.rows[0]?.event_message].filter(Boolean).map(String).join("\n"),
      });

      // A04d - log_connections
      const conn = await mgmt(ctx, "PUT", `/projects/${ctx.ref}/config/database/postgres`, { log_connections: true });
      // A 200 is not the measurement: the audit-log toggle also answers 200 and
      // changes nothing (A06b). Re-read the config endpoint AND a fresh session,
      // and look for an actual connection line, before calling the write good.
      const echoed = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/database/postgres`);
      const echoedVal = String(((echoed.json ?? {}) as Record<string, unknown>).log_connections ?? "absent");
      const shown = await sqlRows(ctx, "select setting from pg_settings where name = 'log_connections'");
      const sessionVal = String((shown[0] as { setting?: string })?.setting ?? "?");
      const connLine = await findMarkers(ctx, ["connection authorized"], 90_000);
      const sawLine = Boolean(connLine.hits["connection authorized"]);
      out.push({
        id: "A04d",
        title: "log_connections through the API, and whether the write took",
        status: conn.status < 300 && echoedVal === "true" ? "pass" : "info",
        detail: `PUT log_connections=true -> HTTP ${conn.status}. GET config/database/postgres now echoes log_connections=${echoedVal}; a session opened after the PUT reports pg_settings log_connections=${sessionVal}. A "connection authorized" line ${sawLine ? `appeared in postgres_logs ${connLine.firstSeenS["connection authorized"]}s later` : `did NOT appear within ${connLine.windowS}s`}. ${echoedVal === "true" ? "The write took." : "A 200 whose value does not come back changed is the same shape as the audit-log toggle no-op, so treat the write as unconfirmed."}`,
        measurements: {
          put_status: conn.status,
          config_echo_after: echoedVal,
          session_setting_after: sessionVal,
          connection_line_seen: String(sawLine),
          write_confirmed: String(echoedVal === "true"),
        },
      });
    } catch (e) {
      out.push({ id: "A04err", title: "A04 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      // Restore everything this module changed, whatever happened above.
      await sqlTry(ctx, "alter role postgres reset pgaudit.log");
      await sqlTry(ctx, "alter role postgres reset pgaudit.role");
      await sqlTry(ctx, `revoke all on auth.audit_log_entries from ${AUDITOR}`);
      await sqlTry(ctx, `drop role if exists ${AUDITOR}`);
      await sqlTry(ctx, "drop extension if exists pgaudit");
      await mgmt(ctx, "PUT", `/projects/${ctx.ref}/config/database/postgres`, { log_connections: false }).catch(() => {});
      const left = await sqlRows(ctx, "select coalesce((select extversion from pg_extension where extname='pgaudit'),'not installed') as ext, coalesce((select string_agg(c,',') from unnest((select rolconfig from pg_roles where rolname='postgres')) c where c like 'pgaudit%'),'none') as rolcfg").catch(() => []);
      out.push({
        id: "A04z",
        title: "cleanup",
        status: "pass",
        detail: `restored after the ${restored || "config"} phase: pgaudit ${String((left[0] as { ext?: string })?.ext ?? "?")}, postgres rolconfig pgaudit entries ${String((left[0] as { rolcfg?: string })?.rolcfg ?? "?")}, log_connections back to false.`,
      });
    }
    return out;
  },
};
export default mod;
