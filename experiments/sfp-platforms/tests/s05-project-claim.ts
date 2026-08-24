/**
 * S05 - project claim/transfer surface
 *
 * Provisions one project, then:
 *
 *   S05a  control: healthy create.
 *   S05b  claim surface: `POST /projects/{ref}/claim` (and, if 404, the
 *         documented transfer path) with a benign/empty body. Record
 *         `claim_status` (number) verbatim. `info` either way - the finding
 *         is the status code and message, NOT a successful transfer.
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
  id: "S05",
  title: "Project claim/transfer surface",
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
        name: `s05-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        results.push({
          id: "S05a",
          title: "S05a: control",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
      } else {
        ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
        if (!ref) {
          results.push({
            id: "S05a",
            title: "S05a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          const provisionS = Math.round((Date.now() - t0) / 1000);
          results.push({
            id: "S05a",
            title: "S05a: control",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: status === "ACTIVE_HEALTHY" ? undefined : `not healthy (status=${status})`,
            measurements: { provision_s: provisionS },
          });

          // --- S05b: claim surface ---
          const claim = await mgmt(ctx, "POST", `/projects/${ref}/claim`, {});
          // If the claim endpoint is absent (404), try the documented transfer
          // path. Record BOTH statuses in the same row so `claim_status` stays
          // the probe's required measurement and the fallback is not a new row.
          let transferStatus: number | undefined;
          let transferEvidence: string | undefined;
          if (claim.status === 404) {
            const transfer = await mgmt(ctx, "POST", `/projects/${ref}/transfer`, {});
            transferStatus = transfer.status;
            transferEvidence = transfer.text.slice(0, 300);
          }
          results.push({
            id: "S05b",
            title: "S05b: claim surface",
            status: "info",
            detail:
              claim.status >= 200 && claim.status < 300
                ? "CLAIM_ACCEPTED"
                : claim.status === 404
                  ? `CLAIM_404 transfer_status=${transferStatus ?? "n/a"}`
                  : "CLAIM_REJECTED",
            measurements: {
              claim_status: claim.status,
              ...(transferStatus !== undefined ? { transfer_status: transferStatus } : {}),
            },
            evidence: (claim.text + (transferEvidence ? ` | transfer: ${transferEvidence}` : "")).slice(0, 500),
          });
        }
      }

      for (const id of ["S05a", "S05b"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "skip", detail: "row never produced" });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S05a", "S05b"] as const) {
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
