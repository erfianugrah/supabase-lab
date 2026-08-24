/**
 * S13 - branch lifecycle
 *
 * Provision one project:
 *
 *   S13a  control: healthy create.
 *   S013b  create branch: `POST /projects/{ref}/branches` with
 *         `{"branch_name": "sfp-probe", "region": "ap-southeast-1"}` (or a valid
 *         region; `with_data: false`). Record `branch_create_status` and the branch
 *         ref/id if returned. `info` either way (a 4xx is the branch-gating finding).
 *   S13c  list + delete: only if S13b landed.
 *         `GET /projects/{ref}/branches` to record `branch_count`; then
 *         `DELETE /projects/{ref}/branches/{name}` (or the branch id path) to
 *         record `branch_delete_status`. If S13b did not land, S13c is a `skip`.
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
  id: "S13",
  title: "Branch lifecycle",
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
        name: `s13-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        results.push({
          id: "S13a",
          title: "S13a: control",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
      } else {
        ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
        if (!ref) {
          results.push({
            id: "S13a",
            title: "S13a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          const provisionS = Math.round((Date.now() - t0) / 1000);
          results.push({
            id: "S13a",
            title: "S13a: control",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: status === "ACTIVE_HEALTHY" ? undefined : `not healthy (status=${status})`,
            measurements: { provision_s: provisionS },
          });

          // --- S13b: create branch ---
          const branchName = "sfp-probe";
          const branch = await mgmt(ctx, "POST", `/projects/${ref}/branches`, {
            branch_name: branchName,
            region: "ap-southeast-1",
            with_data: false,
          });
          results.push({
            id: "S13b",
            title: "S13b: create branch",
            status: "info",
            detail: branch.status >= 200 && branch.status < 300 ? "BRANCH_CREATED" : "BRANCH_REJECTED",
            measurements: { branch_create_status: branch.status },
            evidence: branch.text.slice(0, 300),
          });

          // --- S13c: list + delete ---
          if (branch.status >= 200 && branch.status < 300) {
            const branches = await mgmt(ctx, "GET", `/projects/${ref}/branches`);
            const branchesList = Array.isArray(branches.json) ? (branches.json as any[]) : [];
            const deleteRes = await mgmt(ctx, "DELETE", `/projects/${ref}/branches/${branchName}`);
            results.push({
              id: "S13c",
              title: "S13c: list + delete",
              status: "info",
              detail:
                deleteRes.status >= 200 && deleteRes.status < 300
                  ? `branch listing=${branchesList.length}, delete=OK`
                  : `branch listing=${branchesList.length}, delete rejected (HTTP ${deleteRes.status})`,
              measurements: {
                branch_count: branchesList.length,
                branch_delete_status: deleteRes.status,
              },
              evidence: deleteRes.text.slice(0, 300),
            });
          } else {
            results.push({
              id: "S13c",
              title: "S13c: list + delete",
              status: "skip",
              detail: "branch creation did not land (see S13b), so nothing to list/delete",
            });
          }
        }
      }

      for (const id of ["S13a", "S13b", "S13c"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "skip", detail: "row never produced" });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S13a", "S13b", "S13c"] as const) {
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
