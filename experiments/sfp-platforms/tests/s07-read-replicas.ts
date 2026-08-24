/**
 * S07 - read replicas
 *
 * Provision one project:
 * - S07a control: healthy create. pass only when healthy.
 * - S07b setup: POST /projects/{ref}/read-replicas/setup with {"read_replica_region": "ap-southeast-1"}.
 *   Record setup_status (number). info either way.
 * - S07c remove: only runnable when S07b landed (2xx). POST /projects/{ref}/read-replicas/remove.
 *   Record remove_status. If S07b did not land, S07c is a skip.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  id?: string;
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
  id: "S07",
  title: "S07 - read replicas",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    let ref = "";
    const ensure = (id: string) => results.some((r) => r.id === id);

    try {
      // --- S07a: control ---
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `s07-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        results.push({
          id: "S07a",
          title: "S07a: control",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
      } else {
        ref =
          (create.json as ProjectCreateResponse | undefined)?.ref ??
          (create.json as ProjectCreateResponse | undefined)?.id ??
          "";
        if (!ref) {
          results.push({
            id: "S07a",
            title: "S07a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          results.push({
            id: "S07a",
            title: "S07a: control",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: status === "ACTIVE_HEALTHY" ? "healthy create" : `not healthy: ${status}`,
          });

          if (status === "ACTIVE_HEALTHY") {
            // --- S07b: setup ---
            const setup = await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/setup`, {
              read_replica_region: "ap-southeast-1",
            });
            results.push({
              id: "S07b",
              title: "S07b: setup",
              status: "info",
              detail: `setup: HTTP ${setup.status}`,
              measurements: { setup_status: setup.status },
              evidence: setup.text.slice(0, 300),
            });

            // --- S07c: remove ---
            if (setup.status >= 200 && setup.status < 300) {
              const remove = await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/remove`);
              results.push({
                id: "S07c",
                title: "S07c: remove",
                status: "info",
                detail: `remove: HTTP ${remove.status}`,
                measurements: { remove_status: remove.status },
                evidence: remove.text.slice(0, 300),
              });
            } else {
              results.push({
                id: "S07c",
                title: "S07c: remove",
                status: "skip",
                detail: "S07b did not land (2xx)",
              });
            }
          } else {
            results.push({
              id: "S07b",
              title: "S07b: setup",
              status: "skip",
              detail: "S07a was not healthy",
            });
            results.push({
              id: "S07c",
              title: "S07c: remove",
              status: "skip",
              detail: "S07b did not land (S07a failed)",
            });
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S07a", "S07b", "S07c"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
        }
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }

    // Final pass to ensure no missing rows
    for (const id of ["S07a", "S07b", "S07c"] as const) {
      if (!ensure(id)) {
        results.push({ id, title: id, status: "skip", detail: "row never produced" });
      }
    }

    return results;
  },
};
export default mod;
