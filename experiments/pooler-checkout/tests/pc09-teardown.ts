/**
 * PC09 - delete the project PC01..PC04 shared, then confirm it is gone from
 * GET /projects. Last by id so it runs after them; `make sweep` is the
 * fallback when the process died before this module ran.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { PREFIX, releaseProject, sleep } from "../lib/project";

const mod: TestModule = {
  id: "PC09",
  title: "Teardown: delete the shared project, confirm it left the project list",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const rel = await releaseProject(ctx);
    if (!rel.ref) return [{ id: "PC09", title: mod.title, status: "skip", detail: "no project was created or adopted in this process" }];
    if (!rel.deleted) return [{ id: "PC09", title: mod.title, status: "info", detail: `project not deleted by this module (adopted: ${rel.status === 0}); delete: HTTP ${rel.status}` }];
    let gone = false;
    let remaining = -1;
    for (let i = 0; i < 24 && !gone; i++) {
      await sleep(5000);
      const r = await mgmt(ctx, "GET", "/projects");
      const arr = (Array.isArray(r.json) ? r.json : []) as { ref?: string; id?: string; name?: string }[];
      gone = !arr.some((p) => (p.ref ?? p.id) === rel.ref);
      remaining = arr.filter((p) => (p.name ?? "").startsWith(PREFIX)).length;
    }
    return [
      {
        id: "PC09",
        title: mod.title,
        status: gone ? "pass" : "fail",
        detail: `DELETE HTTP ${rel.status}; project ${gone ? "absent from" : "still in"} GET /projects; ${remaining} project(s) with prefix ${PREFIX}`,
        measurements: { delete_status: rel.status, gone: gone ? "yes" : "no", projects_with_prefix: remaining },
      },
    ];
  },
};

export default mod;
