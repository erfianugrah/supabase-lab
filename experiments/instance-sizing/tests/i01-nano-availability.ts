/**
 * I01 - is the Nano compute tier reachable on a normal paid (Pro) org?
 *
 * The public docs describe scale-to-zero pricing as Nano-only and gated, and
 * the Supabase-for-Platforms guide says not to pass `desired_instance_size`
 * on creation because ">= Micro instances are not able to scale to zero".
 * None of that says what a NORMAL paid org's API surface does with Nano.
 * This module measures it, on a Pro org (not a Supabase-for-Platforms org):
 *
 *   I01a  CONTROL: create WITHOUT `desired_instance_size`, read the compute
 *         back, and check whether `ci_nano` even appears in the project's
 *         `available_addons` entitlement list.
 *   I01b  create WITH `desired_instance_size: "nano"` - whatever the platform
 *         answers is the finding, recorded verbatim.
 *   I01c  PATCH the control project's billing/addons with `ci_nano` -
 *         whatever the platform answers is the finding, recorded verbatim.
 *
 * Every project created here is deleted in `finally`. A measured 4xx is data
 * (info), never an exception.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const PRO_ORG = "gfqyoavfwjduavsvhbni"; // same Pro org as w21-spend-cap.ts
const REGION = "ap-southeast-1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}
interface AddonsResponse {
  available_addons?: Array<{ addon_type?: string; addon_variant?: string }>;
  selected_addons?: Array<{ addon_type?: string; addon_variant?: string }>;
}

/** Bounded poll to ACTIVE_HEALTHY; returns the last observed status. */
async function waitHealthy(ctx: Ctx, ref: string): Promise<string> {
  let status = "";
  for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
  }
  return status;
}

/** Current compute variant from the addons surface; absent = micro default. */
function selectedCompute(json: unknown): string {
  const data = json as AddonsResponse | undefined;
  const selected = Array.isArray(data?.selected_addons) ? data.selected_addons : [];
  return (
    selected.find((a) => a?.addon_type === "compute_instance")?.addon_variant ??
    "none(micro)"
  );
}

const mod: TestModule = {
  id: "I01",
  title: "Nano instance availability on a normal paid org",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions and deletes its own projects
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    let refA = "";
    let refB = "";

    try {
      // --- I01a: control. Create with NO desired_instance_size. ---
      const t0 = Date.now();
      const createA = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `i01a-control-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });

      if (createA.status !== 201) {
        results.push({
          id: "I01a",
          title: "I01a: control (default size)",
          status: "fail",
          detail: `project create: HTTP ${createA.status}: ${createA.text.slice(0, 300)}`,
        });
      } else {
        refA = (createA.json as ProjectCreateResponse | undefined)?.ref ?? "";
        if (!refA) {
          results.push({
            id: "I01a",
            title: "I01a: control (default size)",
            status: "fail",
            detail: `project create returned no ref: ${createA.text.slice(0, 300)}`,
          });
        } else {
          const statusA = await waitHealthy(ctx, refA);
          const provisionS = Math.round((Date.now() - t0) / 1000);

          // --- I01c: patch the control project to ci_nano (needs refA alive;
          // runs before the read-back so the read also catches a successful
          // patch). Whatever it answers is the finding. ---
          const patch = await mgmt(ctx, "PATCH", `/projects/${refA}/billing/addons`, {
            addon_type: "compute_instance",
            addon_variant: "ci_nano",
          });
          results.push({
            id: "I01c",
            title: "I01c: patch control project to ci_nano",
            status: "info",
            detail:
              patch.status >= 200 && patch.status < 300
                ? "ci_nano addon patch ACCEPTED - Nano is purchasable on this org"
                : `ci_nano addon patch rejected: HTTP ${patch.status}`,
            measurements: { patch_nano_status: patch.status },
            evidence: patch.text.slice(0, 300),
          });

          // Read the addons surface back: current compute + whether ci_nano
          // is even in this org's entitlement catalogue.
          const addonsA = await mgmt(ctx, "GET", `/projects/${refA}/billing/addons`);
          if (addonsA.status !== 200) {
            results.push({
              id: "I01a",
              title: "I01a: control (default size)",
              status: "fail",
              detail: `addons read: HTTP ${addonsA.status}: ${addonsA.text.slice(0, 300)}`,
            });
          } else {
            const data = addonsA.json as AddonsResponse | undefined;
            const available = Array.isArray(data?.available_addons) ? data.available_addons : [];
            const nanoAvailable = available.some(
              (a) => a?.addon_type === "compute_instance" && a?.addon_variant === "ci_nano",
            );
            const measurements: Record<string, number | string> = {
              provision_s: provisionS,
              compute: selectedCompute(addonsA.json),
              ci_nano_available: nanoAvailable ? 1 : 0,
            };
            results.push({
              id: "I01a",
              title: "I01a: control (default size)",
              status: statusA === "ACTIVE_HEALTHY" ? "pass" : "fail",
              detail:
                statusA === "ACTIVE_HEALTHY"
                  ? undefined
                  : `project not healthy after 15 min (status=${statusA})`,
              measurements,
            });
          }
        }
      }

      // --- I01b: explicit nano create. Independent of the control - a broken
      // control does not excuse skipping the finding. ---
      const t1 = Date.now();
      const createB = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `i01b-nano-${t1}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
        desired_instance_size: "nano",
      });

      if (createB.status >= 200 && createB.status < 300) {
        refB = (createB.json as ProjectCreateResponse | undefined)?.ref ?? "";
        if (refB) {
          const statusB = await waitHealthy(ctx, refB);
          const addonsB = await mgmt(ctx, "GET", `/projects/${refB}/billing/addons`);
          results.push({
            id: "I01b",
            title: "I01b: explicit nano create",
            status: "info",
            detail:
              statusB === "ACTIVE_HEALTHY"
                ? "nano create ACCEPTED - the docs' gating claim has changed, update the docs"
                : `nano project created but not healthy after 15 min (status=${statusB})`,
            measurements: {
              create_nano_status: createB.status,
              provision_s: Math.round((Date.now() - t1) / 1000),
              compute: addonsB.status === 200 ? selectedCompute(addonsB.json) : "unread",
            },
          });
        } else {
          // 2xx without a ref is the platform answering oddly, not a harness
          // assertion failing - record it as data.
          results.push({
            id: "I01b",
            title: "I01b: explicit nano create",
            status: "info",
            detail: `nano create returned HTTP ${createB.status} with no ref: ${createB.text.slice(0, 300)}`,
            measurements: { create_nano_status: createB.status },
          });
        }
      } else {
        results.push({
          id: "I01b",
          title: "I01b: explicit nano create",
          status: "info",
          detail: `nano create rejected: HTTP ${createB.status}`,
          measurements: { create_nano_status: createB.status },
          evidence: createB.text.slice(0, 300),
        });
      }
      // Every row must appear exactly once, whatever path we took. Rows
      // that could not run on a measured-failure path are skips with the
      // reason; rows missing because something threw are fails (catch below).
      for (const id of ["I01a", "I01b", "I01c"] as const) {
        if (!results.some((r) => r.id === id)) {
          results.push({
            id,
            title: id,
            status: "skip",
            detail: "not runnable: the control project never came up (see I01a)",
          });
        }
      }
    } catch (e) {
      // A thrown error is a harness/test bug, distinct from a measured
      // failure. Mark every row that never got its finding.
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["I01a", "I01b", "I01c"] as const) {
        if (!results.some((r) => r.id === id)) {
          results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
        }
      }
    } finally {
      if (refB) await mgmt(ctx, "DELETE", `/projects/${refB}`).catch(() => null);
      if (refA) await mgmt(ctx, "DELETE", `/projects/${refA}`).catch(() => null);
    }

    return results;
  },
};
export default mod;
