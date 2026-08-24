/**
 * S03 - restore points + undo semantics
 *
 * Provisions one project, then:
 *
 *   S03a  control: create project on the org path, confirm `ACTIVE_HEALTHY`.
 *         status `pass` only when healthy.
 *   S03b  restore point: `POST /projects/{ref}/database/backups/restore-point`
 *         with a name. Record `restore_point_status` (number). `info` either way.
 *   S03c  undo: only runnable when S03b landed (2xx). Mutate the DB (create a
 *         table that postdates the restore point), then
 *         `POST /projects/{ref}/database/backups/undo` with the same name, then
 *         verify via `database/query/read-only` whether the post-point table still
 *         exists. Record `undo_status` (number) and `table_after_undo`
 *         (`present`|`gone`|`unread:<code_error>`).
 *
 * Every project created here is deleted in `finally`. A measured 4xx on any
 * gated surface is data (info), never an exception.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}

async function waitHealthy(ctx: Ctx, ref: string, maxIters = 90): Promise<string> {
  let status = "";
  for (let i = 0; i < maxIters && status !== "ACTIVE_HEALTHY"; i++) {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
  }
  return status;
}

const mod: TestModule = {
  id: "S03",
  title: "Restore points + undo semantics",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    let ref = "";
    const ensure = (id: string) => results.some((r) => r.id === id);

    try {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `s03-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        results.push({
          id: "S03a",
          title: "S03a: control",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
      } else {
        ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
        if (!ref) {
          results.push({
            id: "S03a",
            title: "S03a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          const provisionS = Math.round((Date.now() - t0) / 1000);
          results.push({
            id: "S03a",
            title: "S03a: control",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: status === "ACTIVE_HEALTHY" ? undefined : `not healthy (status=${status})`,
            measurements: { provision_s: provisionS },
          });

          // --- S03b: restore point ---
          const rp = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/restore-point`, {
            name: "s03",
          });
          results.push({
            id: "S03b",
            title: "S03b: restore point",
            status: "info",
            detail: rp.status >= 200 && rp.status < 300 ? "RESTORE_POINT_ACCEPTED" : "RESTORE_POINT_REJECTED",
            measurements: { restore_point_status: rp.status },
            evidence: rp.text.slice(0, 300),
          });

          // --- S03c: undo ---
          if (rp.status >= 200 && rp.status < 300) {
            // Mutate: create table
            await mgmt(ctx, "POST", `/projects/${ref}/database/query`, {
              query: "create table public.s03_temp (id int primary key)",
            });
            const undo = await mgmt(ctx, "POST", `/projects/${ref}/database/backups/undo`, {
              name: "s03",
            });

            // Verify: check if table exists via information_schema (a query that
            // always 200s, so we never rely on status-code heuristics for
            // "table gone" - the find is the boolean, not the HTTP code).
            const check = await mgmt(ctx, "POST", `/projects/${ref}/database/query/read-only`, {
              query:
                "select exists (select 1 from information_schema.tables where table_schema='public' and table_name='s03_temp') as present",
            });

            let tableAfterUndo: string;
            const row0 = Array.isArray(check.json) ? (check.json[0] as { present?: boolean }) : undefined;
            if (check.status >= 200 && check.status < 300 && row0 && typeof row0.present === "boolean") {
              tableAfterUndo = row0.present ? "present" : "gone";
            } else {
              tableAfterUndo = `unread:${check.status}`;
            }

            results.push({
              id: "S03c",
              title: "S03c: undo",
              status: "info",
              detail: undo.status >= 200 && undo.status < 300 ? "UNDO_ACCEPTED" : "UNDO_REJECTED",
              measurements: { undo_status: undo.status, table_after_undo: tableAfterUndo },
              evidence: undo.text.slice(0, 300),
            });
          } else {
            results.push({
              id: "S03c",
              title: "S03c: undo",
              status: "skip",
              detail: "restore point did not land (see S03b), so nothing to undo",
            });
          }
        }
      }

      for (const id of ["S03a", "S03b", "S03c"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "skip", detail: "row never produced" });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S03a", "S03b", "S03c"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
        }
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }

    return results;
  },
};
export default mod;
