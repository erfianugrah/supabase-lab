/**
 * S09 - audit logging availability, and the backup/PITR surface.
 *
 *   S09a - pgaudit: whether the extension can be enabled, so statement-level
 *          audit logging is available (it writes to the Postgres log, read
 *          through the Management API logs, not a table).
 *   S09b - the backup/PITR surface: what GET /database/backups reports, so a
 *          "can we recover" question has an answer.
 *
 * DESTRUCTIVE only in that it may create the pgaudit extension.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

async function rows(ctx: Ctx, q: string): Promise<Record<string, unknown>[]> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query: q });
  return Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
}

const mod: TestModule = {
  id: "S09",
  title: "audit logging (pgaudit) availability + the backup/PITR surface",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];

    try {
      await rows(ctx, "create extension if not exists pgaudit;");
      const ext = await rows(ctx, "select extname from pg_extension where extname = 'pgaudit';");
      results.push({
        id: "S09a",
        title: "pgaudit statement auditing is available",
        status: ext.length ? "pass" : "info",
        detail: ext.length
          ? "pgaudit enabled - set pgaudit.log ('read,write,ddl,...') on a role to audit statements; output goes to the Postgres log, read via the Management API logs, not a queryable table."
          : "pgaudit not available on this project",
      });
    } catch (e) {
      results.push({ id: "S09a", title: "pgaudit", status: "info", detail: `pgaudit probe: ${e instanceof Error ? e.message : e}` });
    }

    const backups = await mgmt(ctx, "GET", `/projects/${ctx.ref}/database/backups`);
    const b = backups.json as { pitr_enabled?: boolean; region?: string; walg_enabled?: boolean; backups?: unknown[] } | undefined;
    results.push({
      id: "S09b",
      title: "backup / PITR surface",
      status: backups.status === 200 ? "info" : "fail",
      detail: backups.status === 200
        ? `GET /database/backups: pitr_enabled=${b?.pitr_enabled}, walg_enabled=${b?.walg_enabled}, region=${b?.region}, scheduled backups=${Array.isArray(b?.backups) ? b?.backups.length : "?"}. PITR is a paid add-on; on a fresh project it is off, so recovery is daily backups only until enabled.`
        : `GET /database/backups -> ${backups.status}`,
      measurements: { backups_status: backups.status, pitr_enabled: String(b?.pitr_enabled) },
    });

    return results;
  },
};
export default mod;
