/**
 * S07 - read replicas
 *
 * Provision one project:
 * - S07a control: healthy create. pass only when healthy.
 * - S07b setup: POST /projects/{ref}/read-replicas/setup with {"read_replica_region": "ap-southeast-1"}.
 *   Record setup_status (number). info either way.
 * - S07c remove: only runnable when S07b landed (2xx). POST /projects/{ref}/read-replicas/remove.
 *   Record remove_status. If S07b did not land, S07c is a skip.
 *
 * Gate hunt (added 2026-08-25). The documented prerequisites
 * (https://supabase.com/docs/guides/platform/read-replicas/getting-started)
 * are: AWS, at least a Small compute add-on, Postgres 15+, physical backups
 * (auto-enabled with PITR). A nano-default platform project misses the
 * compute floor and runs logical backups, so the S07b 400 may be infra, not
 * entitlement. The ladder identifies which prerequisite the 400 maps to:
 * - S07d: PATCH billing/addons to ci_small, wait healthy, retry setup.
 *   Record setup_small_status. A 4xx at any rung is data.
 * - S07e: only if S07d still refused - PATCH billing/addons to pitr_7
 *   (flips backups physical), wait healthy, retry setup.
 *   Record setup_pitr_status.
 * If a rung lands a replica, remove it before the finally-delete.
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

            // --- S07d: gate hunt rung 1 - compute floor (ci_small) ---
            if (setup.status >= 200 && setup.status < 300) {
              results.push({
                id: "S07d",
                title: "S07d: setup after compute upgrade",
                status: "skip",
                detail: "S07b already landed - no gate to hunt",
              });
              results.push({
                id: "S07e",
                title: "S07e: setup after PITR enable",
                status: "skip",
                detail: "S07b already landed - no gate to hunt",
              });
            } else {
              const up = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, {
                addon_type: "compute_instance",
                addon_variant: "ci_small",
              });
              if (up.status < 200 || up.status >= 300) {
                results.push({
                  id: "S07d",
                  title: "S07d: setup after compute upgrade",
                  status: "skip",
                  detail: `compute upgrade refused: HTTP ${up.status}: ${up.text.slice(0, 200)}`,
                });
              } else {
                await waitHealthy(ctx, ref);
                const setup2 = await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/setup`, {
                  read_replica_region: "ap-southeast-1",
                });
                results.push({
                  id: "S07d",
                  title: "S07d: setup after compute upgrade",
                  status: "info",
                  detail:
                    setup2.status >= 200 && setup2.status < 300
                      ? "REPLICA_ACCEPTED after ci_small"
                      : `still refused after ci_small: HTTP ${setup2.status}`,
                  measurements: { setup_small_status: setup2.status },
                  evidence: setup2.text.slice(0, 300),
                });
                if (setup2.status >= 200 && setup2.status < 300) {
                  await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/remove`).catch(() => null);
                  results.push({
                    id: "S07e",
                    title: "S07e: setup after PITR enable",
                    status: "skip",
                    detail: "S07d landed - compute floor was the gate",
                  });
                } else {
                  // --- S07e: gate hunt rung 2 - physical backups via PITR ---
                  // The addons endpoint answers 429 "still processing addon
                  // changes, try again in N minute(s)" right after the
                  // compute change - retry with backoff instead of recording
                  // the throttle as the finding.
                  let pitr = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, {
                    addon_type: "pitr",
                    addon_variant: "pitr_7",
                  });
                  for (let attempt = 0; pitr.status === 429 && attempt < 3; attempt++) {
                    const m = /try again in (\d+) minute/.exec(pitr.text);
                    const waitS = m ? Number(m[1]) * 60 + 15 : 195;
                    await sleep(waitS * 1000);
                    pitr = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, {
                      addon_type: "pitr",
                      addon_variant: "pitr_7",
                    });
                  }
                  if (pitr.status < 200 || pitr.status >= 300) {
                    results.push({
                      id: "S07e",
                      title: "S07e: setup after PITR enable",
                      status: "skip",
                      detail: `pitr enable refused: HTTP ${pitr.status}: ${pitr.text.slice(0, 200)}`,
                    });
                  } else {
                    await waitHealthy(ctx, ref);
                    const setup3 = await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/setup`, {
                      read_replica_region: "ap-southeast-1",
                    });
                    results.push({
                      id: "S07e",
                      title: "S07e: setup after PITR enable",
                      status: "info",
                      detail:
                        setup3.status >= 200 && setup3.status < 300
                          ? "REPLICA_ACCEPTED after pitr_7"
                          : `still refused after pitr_7: HTTP ${setup3.status}`,
                      measurements: { setup_pitr_status: setup3.status },
                      evidence: setup3.text.slice(0, 300),
                    });
                    if (setup3.status >= 200 && setup3.status < 300) {
                      await mgmt(ctx, "POST", `/projects/${ref}/read-replicas/remove`).catch(
                        () => null,
                      );
                    }
                  }
                }
              }
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
      for (const id of ["S07a", "S07b", "S07c", "S07d", "S07e"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
        }
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }

    // Final pass to ensure no missing rows
    for (const id of ["S07a", "S07b", "S07c", "S07d", "S07e"] as const) {
      if (!ensure(id)) {
        results.push({ id, title: id, status: "skip", detail: "row never produced" });
      }
    }

    return results;
  },
};
export default mod;
