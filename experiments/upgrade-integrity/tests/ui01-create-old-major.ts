/**
 * UI01 - Can a fresh project be created on an older Postgres major, and is it
 * then eligible for an in-place major upgrade?
 *
 * Source claims: the OpenAPI document (read 2026-10-23) types
 * `postgres_engine` and `release_channel` on POST /v1/projects as deprecated
 * and `null`; platform-facts F06 concluded from that and from a fresh project
 * sitting at the latest version that an upgrade cannot be arranged on a
 * throwaway. orioledb OR01 showed the field is still applied for
 * `"17-oriole"`; an older major was never requested.
 *
 *   UI01a  POST /v1/projects with `postgres_engine: "15"` (PVLAB_UI_ENGINE),
 *          Micro (PVLAB_UI_SIZE), ap-southeast-1: create status, the
 *          `database` block of GET /projects/{ref}, server_version.
 *   UI01b  GET /upgrade/eligibility on the fresh project, verbatim.
 *
 * DESTRUCTIVE: creates the shared project (lib/ui.ts); UI99 deletes it.
 */
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ENGINE, SIZE, REGION, ensureProject, errText, redact, skipWithoutPro } from "../lib/ui.js";

const mod: TestModule = {
  id: "UI01",
  title: "Create a project on an older Postgres major and read its upgrade eligibility",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "UI01");
    if (skip) return skip;
    let p;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "UI01a", title: "UI01a: create on an older major", status: "fail", detail: redact(errText(e)) }];
    }
    const db = p.database;
    const out: TestResult[] = [
      {
        id: "UI01a",
        title: `UI01a: POST /v1/projects with postgres_engine "${ENGINE}" (${SIZE}, ${REGION})`,
        status: p.reused ? "info" : String(db.postgres_engine ?? "") === ENGINE && p.version.startsWith(ENGINE) ? "pass" : "fail",
        detail: p.reused
          ? `reused project (PVLAB_UI_REF); server_version ${p.version}`
          : `create ${p.createStatus}; healthy and answering after ${Math.round(p.createMs / 1000)} s; database.version ${String(db.version ?? "")}, postgres_engine ${String(db.postgres_engine ?? "")}, server_version ${p.version}`,
        measurements: {
          create_status: p.createStatus,
          create_to_ready_s: Math.round(p.createMs / 1000),
          app_version: String(db.version ?? ""),
          postgres_engine: String(db.postgres_engine ?? ""),
          release_channel: String(db.release_channel ?? ""),
          server_version: p.version,
        },
        evidence: `create response: ${p.createBody}\nGET /projects/{ref} database: ${redact(JSON.stringify(db))}`,
      },
    ];
    const e = await mgmt(ctx, "GET", `/projects/${p.ref}/upgrade/eligibility`);
    const j = (e.json ?? {}) as { eligible?: boolean | null; current_app_version?: string; target_upgrade_versions?: { postgres_version?: string; app_version?: string }[]; duration_estimate_hours?: number };
    const targets = (j.target_upgrade_versions ?? []).map((t) => `${t.postgres_version}:${t.app_version}`).join(", ");
    out.push({
      id: "UI01b",
      title: "UI01b: upgrade eligibility of the fresh project",
      status: e.status === 200 ? "info" : "fail",
      detail: `HTTP ${e.status}; eligible ${String(j.eligible)}; current ${j.current_app_version ?? "?"}; targets ${targets || "none"}; estimate ${j.duration_estimate_hours ?? "?"} h`,
      measurements: { status: e.status, eligible: String(j.eligible), targets: targets || "none", duration_estimate_hours: j.duration_estimate_hours ?? "n/a" },
      evidence: redact(e.text.slice(0, 3000)),
    });
    return out;
  },
};
export default mod;
