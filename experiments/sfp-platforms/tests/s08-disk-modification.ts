/**
 * S08 - disk modification
 *
 * Provision one project:
 * - S08a control: healthy create.
 * - S08b read baseline: GET /projects/{ref}/config/disk. Record size_gb, iops, throughput_mibps, and type.
 * - S08c grow disk: POST /projects/{ref}/config/disk with {"attributes": {"size_gb": 4}}.
 *   Record grow_status and size_gb_after.
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
  id: "S08",
  title: "S08 - disk modification",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    let ref = "";
    const ensure = (id: string) => results.some((r) => r.id === id);

    try {
      // --- S08a: control ---
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `s08-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        results.push({
          id: "S08a",
          title: "S08a: control",
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
            id: "S08a",
            title: "S08a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          results.push({
            id: "S08a",
            title: "S08a: control",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: status === "ACTIVE_HEALTHY" ? "healthy create" : `not healthy: ${status}`,
          });

          if (status === "ACTIVE_HEALTHY") {
            // --- S08b: read baseline ---
            const baseline = await mgmt(ctx, "GET", `/projects/${ref}/config/disk`);
            if (baseline.status >= 200 && baseline.status < 300) {
              const attrs = (baseline.json as { attributes?: Record<string, unknown> } | undefined)?.attributes ?? {};
              results.push({
                id: "S08b",
                title: "S08b: read baseline",
                status: "info",
                detail: "baseline read successful",
                measurements: {
                  size_gb: Number(attrs.size_gb ?? 0),
                  iops: Number(attrs.iops ?? 0),
                  throughput_mibps: Number(attrs.throughput_mibps ?? 0),
                  type: String(attrs.type ?? "unknown"),
                },
              });

              // --- S08c: grow disk (async 201, reflects ~15s later) ---
              // gp3 IOPS floor is 3000 and max is min(500*size_gb, 16000), so a
              // 2GB->4GB grow is impossible (3000 > 2000); jump to 8GB.
              const grow = await mgmt(ctx, "POST", `/projects/${ref}/config/disk`, {
                attributes: { size_gb: 8, type: "gp3", iops: 3000, throughput_mibps: 125 },
              });
              let sizeGbAfter = 0;
              if (grow.status >= 200 && grow.status < 300) {
                // grow is async - poll the disk size until it moves or times out
                for (let i = 0; i < 12; i++) {
                  await sleep(5_000);
                  const post = await mgmt(ctx, "GET", `/projects/${ref}/config/disk`);
                  const pa = (post.json as { attributes?: Record<string, unknown> } | undefined)?.attributes ?? {};
                  sizeGbAfter = Number(pa.size_gb ?? 0);
                  if (sizeGbAfter >= 8) break;
                }
              }
              results.push({
                id: "S08c",
                title: "S08c: grow disk",
                status: "info",
                detail:
                  grow.status >= 200 && grow.status < 300
                    ? `grow accepted (HTTP ${grow.status}), size after poll=${sizeGbAfter}GB`
                    : `grow rejected: HTTP ${grow.status}: ${grow.text.slice(0, 200)}`,
                measurements: {
                  grow_status: grow.status,
                  size_gb_after: sizeGbAfter,
                  grew_to_8: sizeGbAfter >= 8 ? 1 : 0,
                },
              });
            } else {
              results.push({
                id: "S08b",
                title: "S08b: read baseline",
                status: "fail",
                detail: `baseline read failed: HTTP ${baseline.status}`,
              });
              results.push({
                id: "S08c",
                title: "S08c: grow disk",
                status: "skip",
                detail: "S08b failed",
              });
            }
          } else {
            results.push({
              id: "S08b",
              title: "S08b: read baseline",
              status: "skip",
              detail: "S08a was not healthy",
            });
            results.push({
              id: "S08c",
              title: "S08c: grow disk",
              status: "skip",
              detail: "S08a was not healthy",
            });
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S08a", "S08b", "S08c"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
        }
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }

    // Final pass to ensure no missing rows
    for (const id of ["S08a", "S08b", "S08c"] as const) {
      if (!ensure(id)) {
        results.push({ id, title: id, status: "skip", detail: "row never produced" });
      }
    }

    return results;
  },
};
export default mod;
