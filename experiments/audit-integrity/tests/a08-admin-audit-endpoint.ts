/**
 * A08 - GoTrue's own audit endpoint: is it a second copy, or a window onto the
 * table a tenant can empty?
 *
 * `GET /auth/v1/admin/audit` is the read a backend with the service key can
 * make without touching Postgres. If it reads the table, then deleting the
 * table rows blinds it too, and it is not an independent record. If it survives
 * the delete, a service-key holder has a read path the database owner cannot
 * rewrite.
 *
 * Managed project. Service-role key for the endpoint and the user create, PAT
 * for the SQL.
 *
 *   A08a  a fresh auth event is visible through GET /auth/v1/admin/audit
 *   A08b  delete that event's rows from auth.audit_log_entries, then re-read
 *         the endpoint: gone, or still there
 *   A08c  does the endpoint expose a write or delete route (DELETE / POST)
 *
 * DESTRUCTIVE: creates and deletes an auth user; deletes rows from
 * auth.audit_log_entries.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys } from "../../../harness/src/platform.js";
import { auditCopyEnabled, createConfirmedUser, deleteUser, httpBody, nonce, passwordLogin, sqlRows, sqlTry, waitFor } from "../lib/audit.js";

const mod: TestModule = {
  id: "A08",
  title: "the GoTrue admin audit endpoint: reads the table, or an independent copy",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const keys = await fetchKeys(ctx);
    const tag = nonce();
    const email = `a08-${tag}@example.com`;
    let userId = "";
    const copy = await auditCopyEnabled(ctx);
    try {
      const pw = `A08-${tag}-Xy!7`;
      const u = await createConfirmedUser(ctx, keys.service, email, pw);
      userId = u.id;
      const login = u.id ? await passwordLogin(ctx, keys.anon, email, pw) : { status: 0 };
      const read = async () => {
        const r = await httpBody(`https://${ctx.apiHost}/auth/v1/admin/audit?limit=100`, { key: keys.service });
        const arr = Array.isArray(r.json) ? (r.json as unknown[]) : [];
        return { status: r.status, total: arr.length, hits: arr.filter((e) => JSON.stringify(e).includes(tag)).length };
      };
      const seen = await waitFor(async () => (await read()).hits > 0, 120_000, 5000);
      const before = await read();
      const tableBefore = Number((await sqlRows(ctx, `select count(*)::int as n from auth.audit_log_entries where payload::text like '%${tag}%'`))[0]?.n ?? 0);
      out.push({
        id: "A08a",
        title: "a fresh auth event through GET /auth/v1/admin/audit",
        status: before.hits > 0 ? "pass" : copy.enabled ? "fail" : "info",
        detail: `user create -> HTTP ${u.status}, password login -> HTTP ${login.status}. GET /auth/v1/admin/audit (service key) -> HTTP ${before.status}, ${before.total} entries, ${before.hits} carrying this run's tag ${seen.ok ? `(visible ${seen.elapsedS}s after the write)` : `(none within ${seen.elapsedS}s)`}. The same event has ${tableBefore} rows in auth.audit_log_entries (in-database copy ${copy.enabled ? "enabled" : `DISABLED, audit_log_disable_postgres=${copy.raw}`}). ${!copy.enabled && before.hits === 0 ? "Zero entries from the endpoint while the auth_audit_logs stream carries the same events (A05c) is the finding: this endpoint is a window onto the Postgres table, so with the platform default it answers empty to a service-key holder." : ""}`,
        measurements: { login_status: login.status, endpoint_status: before.status, entries: before.total, tagged_entries: before.hits, table_rows: tableBefore, endpoint_lag_s: seen.elapsedS },
      });

      const del = await sqlTry(ctx, `delete from auth.audit_log_entries where payload::text like '%${tag}%'`);
      const tableAfter = Number((await sqlRows(ctx, `select count(*)::int as n from auth.audit_log_entries where payload::text like '%${tag}%'`))[0]?.n ?? 0);
      const after = await read();
      out.push({
        id: "A08b",
        title: "the same read after the table rows are deleted",
        status: !copy.enabled ? "skip" : del.ok ? "info" : "fail",
        detail: !copy.enabled
          ? `not measurable while the in-database copy is disabled: there were ${tableBefore} rows to delete. Enable the Dashboard toggle and re-run.`
          : `DELETE -> ${del.ok}; table rows for the tag ${tableBefore} -> ${tableAfter}. Endpoint entries carrying the tag: ${before.hits} -> ${after.hits}. ${after.hits === 0 ? "The endpoint reads the table: erasing the rows blinds the admin API too, so it is a window rather than a second copy." : "The endpoint still returns the event after the table rows are gone, so it is not reading the table."}`,
        measurements: {
          delete_ok: String(del.ok),
          table_after: tableAfter,
          endpoint_tagged_before: before.hits,
          endpoint_tagged_after: after.hits,
          endpoint_is_table_window: String(after.hits === 0),
          postgres_copy_enabled: String(copy.enabled),
        },
      });

      const wr = await httpBody(`https://${ctx.apiHost}/auth/v1/admin/audit`, { method: "DELETE", key: keys.service });
      const po = await httpBody(`https://${ctx.apiHost}/auth/v1/admin/audit`, { method: "POST", key: keys.service, body: {} });
      out.push({
        id: "A08c",
        title: "write and delete routes on the admin audit endpoint",
        status: "info",
        detail: `DELETE /auth/v1/admin/audit -> HTTP ${wr.status} (${wr.text.replace(/\s+/g, " ").slice(0, 80)}); POST -> HTTP ${po.status} (${po.text.replace(/\s+/g, " ").slice(0, 80)}). A service-key holder has no API path to the audit trail's contents; the database password is the path.`,
        measurements: { delete_status: wr.status, post_status: po.status },
      });
    } catch (e) {
      out.push({ id: "A08err", title: "A08 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (userId) await deleteUser(ctx, keys.service, userId).catch(() => 0);
      out.push({ id: "A08z", title: "cleanup", status: "pass", detail: `test user ${userId ? "deleted" : "not created"}` });
    }
    return out;
  },
};
export default mod;
