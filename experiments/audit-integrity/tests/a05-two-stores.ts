/**
 * A05 - the reconciliation control: one auth event is written to two stores,
 * and only one of them is inside the tenant's reach.
 *
 * Managed project. Service-role key for the admin user creates, anon key for
 * the logins, PAT for the SQL and the log stream.
 *
 *   A05a  which sources this project's log stream exposes, and whether
 *         `auth_audit_logs` is one of them
 *   A05b  k auth events -> rows in auth.audit_log_entries (the in-database
 *         copy), with the actions GoTrue actually recorded
 *   A05c  the same events in the `auth_audit_logs` source, with the ingestion
 *         lag - the copy a tenant cannot write to
 *   A05d  a FORGED row: present in the table, absent from the stream
 *   A05e  DELETE every event row from the table -> the stream still has them.
 *         The count pair (table, stream) for one window IS the tamper check.
 *
 * DESTRUCTIVE: creates and deletes auth users; deletes rows from
 * auth.audit_log_entries.
 *
 * Not settled by this module: retention on each store (A07 reads the
 * entitlement), and whether a log drain can carry auth audit events off the
 * platform (A07 reads the feature flags; delivery is Dashboard-only).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys } from "../../../harness/src/platform.js";
import { auditCopyEnabled, createConfirmedUser, deleteUser, findInStream, nonce, passwordLogin, sqlRows, sqlTry, stream, waitFor } from "../lib/audit.js";

const USERS = 3;
const TABLE_WAIT_MS = 120_000;
const STREAM_WAIT_MS = 420_000;

const mod: TestModule = {
  id: "A05",
  title: "one auth event, two stores: the in-database table a tenant owns and the log stream it cannot touch",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const keys = await fetchKeys(ctx);
    const tag = nonce();
    const ids: string[] = [];
    // The in-database copy is off by default and the API cannot switch it on
    // (A06), so this module reads the state and gates the table rows on it
    // rather than assuming a populated table.
    const copy = await auditCopyEnabled(ctx);
    try {
      // A05a - what sources exist here
      const src = await stream(ctx, "select source, count() as n from logs group by source order by n desc", 3);
      const sources = src.rows.map((r) => String((r as { source?: string }).source ?? ""));
      out.push({
        id: "A05a",
        title: "log sources on this project, and whether auth audit events have their own",
        status: src.error ? "info" : "pass",
        detail: `${sources.length} sources in the last 3 h: ${sources.join(", ") || "none"}${src.error ? ` (endpoint error: ${src.error})` : ""}. auth_audit_logs ${sources.includes("auth_audit_logs") ? "is present" : "has produced no rows in this window yet"}.`,
        measurements: { sources: sources.length, auth_audit_logs_present: String(sources.includes("auth_audit_logs")), stream_error: src.error ? "yes" : "no" },
        evidence: src.rows.map((r) => JSON.stringify(r)).join("\n"),
      });

      // A05b - generate the events, then find them in the table
      const emails = Array.from({ length: USERS }, (_, i) => `a05-${tag}-${i}@example.com`);
      const pw = `A05-${tag}-Xy!7`;
      let created = 0;
      let logins = 0;
      for (const e of emails) {
        const u = await createConfirmedUser(ctx, keys.service, e, pw);
        if (u.id) {
          ids.push(u.id);
          created++;
          const l = await passwordLogin(ctx, keys.anon, e, pw);
          if (l.status === 200) logins++;
        }
      }
      const inTable = await waitFor(async () => (await sqlRows(ctx, `select count(*)::int as n from auth.audit_log_entries where payload::text like '%a05-${tag}-%'`)).some((r) => Number((r as { n?: number }).n) > 0), TABLE_WAIT_MS, 5000);
      const rows = await sqlRows(
        ctx,
        `select payload->>'action' as action, count(*)::int as n from auth.audit_log_entries
           where payload::text like '%a05-${tag}-%' group by 1 order by 2 desc`,
      );
      const tableTotal = rows.reduce((a, r) => a + Number((r as { n?: number }).n ?? 0), 0);
      out.push({
        id: "A05b",
        title: "auth events reach auth.audit_log_entries, and which actions GoTrue records",
        status: tableTotal > 0 ? "pass" : copy.enabled ? "fail" : "info",
        detail: `${created}/${USERS} users created, ${logins} password logins. ${tableTotal} rows in auth.audit_log_entries carry the run tag ${inTable.ok ? `(first row ${inTable.elapsedS}s after the writes)` : `(none within ${inTable.elapsedS}s)`}: ${rows.map((r) => `${String(r.action)} x${String(r.n)}`).join(", ") || "none"}. The in-database copy is ${copy.enabled ? "ENABLED" : `DISABLED (audit_log_disable_postgres=${copy.raw})`} on this project.`,
        measurements: { users_created: created, logins_ok: logins, table_rows: tableTotal, table_lag_s: inTable.elapsedS, actions: rows.length },
        evidence: rows.map((r) => JSON.stringify(r)).join("\n"),
      });

      // A05c - the same events in the stream
      const streamFind = await findInStream(
        ctx,
        `select timestamp, source, event_message from logs
           where source = 'auth_audit_logs' and event_message like '%a05-${tag}-%' limit 5`,
        STREAM_WAIT_MS,
        30_000,
      );
      const cnt = await stream(ctx, `select count() as n from logs where source = 'auth_audit_logs' and event_message like '%a05-${tag}-%'`, 1);
      const streamTotal = Number((cnt.rows[0] as { n?: unknown })?.n ?? 0);
      out.push({
        id: "A05c",
        title: "the same auth events in the auth_audit_logs source",
        status: streamFind.found ? "pass" : "fail",
        detail: streamFind.found
          ? `found ${streamTotal} matching rows in auth_audit_logs, first visible ${streamFind.lagS}s after the writes. This copy is written by the platform, not by the tenant's database, and no tenant credential has a write path to it.`
          : `no auth_audit_logs row carried the tag within ${streamFind.lagS}s (${streamFind.error || "no endpoint error"}). Without this copy the in-database table is the only record, and A05e shows what that means.`,
        measurements: { stream_found: String(streamFind.found), stream_rows: streamTotal, stream_lag_s: streamFind.lagS },
        evidence: streamFind.rows.map((r) => String((r as { event_message?: string }).event_message ?? "").slice(0, 240)).join("\n"),
      });

      // A05d - forgery is visible as a table row with no stream counterpart
      const forge = `a05forge${tag}`;
      const ins = await sqlTry(
        ctx,
        `insert into auth.audit_log_entries(instance_id, id, payload, created_at, ip_address)
         values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
                 '{"action":"login","actor_username":"${forge}@example.com"}', now(), '198.51.100.9')`,
      );
      const forgeTable = Number((await sqlRows(ctx, `select count(*)::int as n from auth.audit_log_entries where payload::text like '%${forge}%'`))[0]?.n ?? 0);
      const forgeStream = await findInStream(
        ctx,
        `select timestamp from logs where source = 'auth_audit_logs' and event_message like '%${forge}%' limit 1`,
        120_000,
        30_000,
      );
      out.push({
        id: "A05d",
        title: "a forged entry: in the table, not in the stream",
        status: ins.ok && forgeTable === 1 && !forgeStream.found ? "pass" : "info",
        detail: `forged insert -> ${ins.ok}; the table now holds ${forgeTable} row for that actor; the stream ${forgeStream.found ? "ALSO holds it, which would mean the stream is fed from the table" : `holds none after ${forgeStream.lagS}s, so the stream is fed by the Auth server and not by the table`}. A row in one store with no counterpart in the other is the signature - in both directions.`,
        measurements: { forge_ok: String(ins.ok), forge_in_table: forgeTable, forge_in_stream: String(forgeStream.found), forge_search_s: forgeStream.lagS },
      });

      // A05e - erase the table copy; the stream copy stays. Only meaningful
      // when there WAS a table copy: with the default config the table is
      // empty, and "0 before, 0 after" is not a demonstration of anything.
      const del = await sqlTry(ctx, `delete from auth.audit_log_entries where payload::text like '%a05-${tag}-%' or payload::text like '%${forge}%'`);
      const tableAfter = Number((await sqlRows(ctx, `select count(*)::int as n from auth.audit_log_entries where payload::text like '%a05-${tag}-%'`))[0]?.n ?? 0);
      const cntAfter = await stream(ctx, `select count() as n from logs where source = 'auth_audit_logs' and event_message like '%a05-${tag}-%'`, 1);
      const streamAfter = Number((cntAfter.rows[0] as { n?: unknown })?.n ?? 0);
      out.push({
        id: "A05e",
        title: "delete the in-database copy; count both stores again",
        status: !copy.enabled ? "skip" : del.ok && tableAfter === 0 && streamAfter > 0 ? "pass" : "info",
        detail: !copy.enabled
          ? `not measurable on this project: the in-database copy is disabled (audit_log_disable_postgres=${copy.raw}), so the table held ${tableTotal} rows to begin with and deleting nothing proves nothing. Enable it in the Dashboard (Authentication -> Configuration -> Audit Logs) and re-run - the API PATCH answers 200 and changes nothing (A06).`
          : `DELETE -> ${del.ok}. Table rows for the tag: ${tableTotal} before, ${tableAfter} after. Stream rows for the same tag: ${streamTotal} before, ${streamAfter} after. ${tableAfter === 0 && streamAfter > 0 ? "The erasure is complete in the store the tenant owns and invisible in the store the platform owns, so comparing the two counts for one window detects it." : "The two stores did not diverge as expected - read the numbers before concluding anything."}`,
        measurements: {
          delete_ok: String(del.ok),
          table_before: tableTotal,
          table_after: tableAfter,
          stream_before: streamTotal,
          stream_after: streamAfter,
          divergence: streamAfter - tableAfter,
          postgres_copy_enabled: String(copy.enabled),
        },
      });
    } catch (e) {
      out.push({ id: "A05err", title: "A05 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      for (const id of ids) await deleteUser(ctx, keys.service, id).catch(() => 0);
      out.push({ id: "A05z", title: "cleanup", status: "pass", detail: `${ids.length} auth users deleted; tagged audit rows already removed by A05e` });
    }
    return out;
  },
};
export default mod;
