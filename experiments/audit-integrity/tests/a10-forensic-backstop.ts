/**
 * A10 - if the audit rows are gone from the table, what is left to reconstruct
 * them from? The physical copies: daily backups and PITR.
 *
 * PAT only, read-only. The restore itself is deliberately NOT run: a restore
 * is a project-level operation with a real recovery time, and what a reader
 * needs from this module is whether the evidence exists and how far back, not
 * a stopwatch on a restore.
 *
 *   A10a  GET database/backups: what physical copies exist, PITR enabled or
 *         not, and the oldest recoverable point
 *   A10b  the restore levers that exist on /v1 (restore, restore-pitr,
 *         restore-point, undo) - the paths a tenant would use, and who can
 *         call them
 *
 * Not settled by this module: an actual restore-and-diff to recover deleted
 * audit rows. That is the forensic procedure and it costs a project restore;
 * flagged rather than measured.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const SPEC_URL = "https://api.supabase.com/api/v1-json";

const mod: TestModule = {
  id: "A10",
  title: "backups and PITR as the forensic backstop for deleted audit rows",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const b = await mgmt(ctx, "GET", `/projects/${ctx.ref}/database/backups`);
    const j = (b.json ?? {}) as { region?: string; walg_enabled?: boolean; pitr_enabled?: boolean; backups?: unknown[]; physical_backup_data?: { earliest_physical_backup_date_unix?: number; latest_physical_backup_date_unix?: number } };
    const earliest = j.physical_backup_data?.earliest_physical_backup_date_unix;
    const latest = j.physical_backup_data?.latest_physical_backup_date_unix;
    out.push({
      id: "A10a",
      title: "physical copies available on this project",
      status: b.status < 300 ? "info" : "fail",
      detail: `GET database/backups -> HTTP ${b.status}: pitr_enabled=${String(j.pitr_enabled)}, walg_enabled=${String(j.walg_enabled)}, ${Array.isArray(j.backups) ? j.backups.length : 0} logical backups listed, physical window ${earliest ? new Date(earliest * 1000).toISOString() : "none"} .. ${latest ? new Date(Number(latest) * 1000).toISOString() : "none"}. A fresh project has no history yet, which is itself the finding: the backstop only exists after the plan's first backup, and PITR is an add-on rather than a default.`,
      measurements: {
        http: b.status,
        pitr_enabled: String(j.pitr_enabled),
        walg_enabled: String(j.walg_enabled),
        logical_backups: Array.isArray(j.backups) ? j.backups.length : 0,
        physical_window_present: String(Boolean(earliest)),
      },
      evidence: b.text.slice(0, 400),
    });

    const spec = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
    const doc = (await spec.json()) as { paths?: Record<string, unknown> };
    const restore = Object.keys(doc.paths ?? {}).filter((p) => /backups/.test(p));
    out.push({
      id: "A10b",
      title: "restore levers on the Management API",
      status: "info",
      detail: `${restore.length} backup paths: ${restore.map((p) => p.replace("/v1/projects/{ref}/database/", "")).join(", ")}. Any of them is reachable with the same PAT that can delete the audit rows, so the backstop is not protected from the actor it protects against - unless the restore lands in a DIFFERENT project (backup.restore_to_new_project in the entitlements A07 reads).`,
      measurements: { backup_paths: restore.length },
    });

    return out;
  },
};
export default mod;
