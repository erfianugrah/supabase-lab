/**
 * L23 - the control plane stays public and operational under full lockdown.
 *
 * PrivateLink + restrict-all + Data API off take the project's DATA surfaces
 * private. They do nothing to api.supabase.com: the Management API keeps
 * reading the project, mutating its config, and minting keys. That is the
 * scope boundary of any "private by default" claim - the project can be
 * private, the control plane cannot, and a design review that forgets it has
 * left an ungated admin surface.
 *
 * Read-only probes plus one write-and-revert (PATCH max_rows, PATCH back), so
 * the finding is "readable AND operational", not merely reachable. Runs
 * standalone (the plane behaves the same locked or not); under Phase C it runs
 * while L20 has the data path locked.
 *
 * DESTRUCTIVE: one PATCH of a config value, reverted in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const mod: TestModule = {
  id: "L23",
  title: "control plane stays public and operational under full lockdown",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];

    const proj = await mgmt(ctx, "GET", `/projects/${ctx.ref}`);
    results.push({
      id: "L23a",
      title: "Management API reads the project while its data surfaces are locked",
      status: proj.status === 200 ? "pass" : "fail",
      detail: `GET /v1/projects/${ctx.ref} -> ${proj.status}. api.supabase.com is a separate, always-public surface; PrivateLink and network restrictions never touch it.`,
      measurements: { project_get: proj.status },
    });

    const pg = await mgmt(ctx, "GET", `/projects/${ctx.ref}/postgrest`);
    const cfg = (pg.json ?? {}) as Record<string, unknown>;
    const originalMaxRows = Number(cfg.max_rows ?? 1000);
    let mutated = false;
    try {
      const desired = originalMaxRows === 999 ? 998 : 999;
      const patch = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/postgrest`, { max_rows: desired });
      const after = await mgmt(ctx, "GET", `/projects/${ctx.ref}/postgrest`);
      const now = Number((after.json as Record<string, unknown>)?.max_rows ?? -1);
      mutated = patch.status < 300 && now === desired;
      results.push({
        id: "L23b",
        title: "the plane is operational, not just readable: config mutates under lockdown",
        status: mutated ? "pass" : "fail",
        detail: `PATCH postgrest max_rows ${originalMaxRows} -> ${desired}: HTTP ${patch.status}, read back ${now}. The admin surface stays fully operational while the data surfaces are private.`,
        measurements: { patch_status: patch.status, read_back: now },
      });
    } catch (e) {
      results.push({ id: "L23err", title: "L23 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (mutated) {
        const back = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/postgrest`, { max_rows: originalMaxRows });
        results.push({ id: "L23z", title: "restore max_rows", status: back.status < 300 ? "pass" : "fail", detail: back.status < 300 ? `restored to ${originalMaxRows}` : `restore HTTP ${back.status}` });
      }
    }
    return results;
  },
};
export default mod;
