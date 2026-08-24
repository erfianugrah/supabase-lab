/**
 * S11 - backup schedule entitlement boundary
 *
 * `backup.schedule: false` (declared). Provision one project:
 *
 *   S11a  control: healthy create.
 *   S11b  read schedule: `GET /projects/{ref}/database/backups/schedule`.
 *         Record `schedule_status` (number) AND whether the body carries a
 *         structured entitlement error: `entitlement_error` (1|0) and the
 *         `feature` key string verbatim if present. The finding is the exact
 *         rejection shape. `info`.
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
  id: "S11",
  title: "Backup schedule entitlement boundary",
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
        name: `s11-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        results.push({
          id: "S11a",
          title: "S11a: control",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
      } else {
        ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
        if (!ref) {
          results.push({
            id: "S11a",
            title: "S11a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          const provisionS = Math.round((Date.now() - t0) / 1000);
          results.push({
            id: "S11a",
            title: "S11a: control",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: status === "ACTIVE_HEALTHY" ? undefined : `not healthy (status=${status})`,
            measurements: { provision_s: provisionS },
          });

          // --- S11b: read schedule ---
          const schedule = await mgmt(ctx, "GET", `/projects/${ref}/database/backups/schedule`);
          const errBody = (schedule.json as { error?: { code?: string; feature?: string } } | undefined)?.error;
          const feature = errBody?.feature ?? "";
          const code = errBody?.code ?? "";

          results.push({
            id: "S11b",
            title: "S11b: read schedule",
            status: "info",
            detail:
              schedule.status >= 200 && schedule.status < 300
                ? "SCHEDULE_READ_SUCCESSFUL"
                : `SCHEDULE_READ_REJECTED (${code} ${feature})`,
            measurements: {
              schedule_status: schedule.status,
              entitlement_error: code === "entitlement_required" ? 1 : 0,
              feature: feature,
            },
            evidence: schedule.text.slice(0, 300),
          });
        }
      }

      for (const id of ["S11a", "S11b"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "skip", detail: "row never produced" });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S11a", "S11b"] as const) {
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
