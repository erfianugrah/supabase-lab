/**
 * S06 - the `platform` plan entitlements and whether they are enforced
 *
 * An SfP org's Management-API /organizations/{slug}/entitlements response is
 * the ground truth for what the platform plan actually grants - the delta
 * against normal Pro/Team that no normal-org probe could ever measure. This
 * module records that delta AND verifies that the starkest differentiators
 * are enforced at the data plane, not merely declared:
 *
 *   S06a  control: healthy create.
 *   S06b  entitlements snapshot: read the entitlements response and record the
 *         load-bearing differentiators as numeric measurements (realtime
 *         ceiling, branching/function/provider limits, audit-log retention,
 *         compute catalogue, plus the boolean gates: pausing, cloning,
 *         scoped roles, PITR, private link, HA). Every value is verbatim.
 *   S06c  project_pausing enforcement: POST /projects/{ref}/pause. A normal
 *         paid org answers 400 "not free-tier"; the platform plan declares
 *         project_pausing:true, so a 2xx here PROVES the entitlement is
 *         enforced. Record the status code and the observed status sequence.
 *   S06d  restore + delete: prove the pause is reversible (restore -> healthy,
 *         then delete succeeds). A paused project that cannot be deleted
 *         (400) until restored is itself a finding; record it.
 *
 * Every project is deleted in `finally` (after restore if paused). A measured
 * 4xx is data (info), never an exception.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
  id?: string;
}
interface ProjectStatusResponse {
  status?: string;
}

async function waitStatus(ctx: Ctx, ref: string, want: string, maxIters = 90): Promise<string> {
  let status = "";
  for (let i = 0; i < maxIters && status !== want; i++) {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
  }
  return status;
}

interface Entitlement {
  feature?: { key?: string; type?: string };
  hasAccess?: boolean;
  config?: { enabled?: boolean; value?: number; unlimited?: boolean; set?: string[] };
}
interface EntitlementsResponse {
  entitlements?: Entitlement[];
}

/** Find one entitlement by key and return its config; undefined if absent. */
function ent(
  json: unknown,
  key: string,
): { hasAccess: boolean; config: Entitlement["config"] } | undefined {
  const list = (json as EntitlementsResponse | undefined)?.entitlements ?? [];
  const e = list.find((x) => x?.feature?.key === key);
  if (!e) return undefined;
  return { hasAccess: e.hasAccess === true, config: e.config };
}

const mod: TestModule = {
  id: "S06",
  title: "Platform-plan entitlements + pausing enforcement",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    let ref = "";
    const ensure = (id: string) => results.some((r) => r.id === id);

    try {
      // --- S06b: entitlements snapshot (independent of project state) ---
      const ents = await mgmt(ctx, "GET", `/organizations/${org}/entitlements`);
      if (ents.status >= 200 && ents.status < 300) {
        const pick = (key: string, n: (c: Entitlement["config"]) => number) => {
          const e = ent(ents.json, key);
          return e ? n(e.config) : -1;
        };
        const has = (key: string) => ent(ents.json, key)?.hasAccess === true;
        const compute = ent(ents.json, "instances.compute_update_available_sizes")?.config?.set ?? [];
        results.push({
          id: "S06b",
          title: "S06b: entitlements snapshot",
          status: "info",
          detail: `platform-plan entitlements captured (${compute.length} compute sizes)`,
          measurements: {
            realtime_max_concurrent_users: pick(
              "realtime.max_concurrent_users",
              (c) => c?.value ?? -1,
            ),
            branching_unlimited: has("branching_limit") &&
              ent(ents.json, "branching_limit")?.config?.unlimited === true
              ? 1
              : 0,
            function_max_count_unlimited: ent(ents.json, "function.max_count")?.config?.unlimited === true
              ? 1
              : 0,
            audit_logs_days: pick("security.audit_logs_days", (c) => c?.value ?? -1),
            compute_sizes: compute.length,
            compute_ci_nano: compute.includes("ci_nano") ? 1 : 0,
            compute_ci_16xlarge: compute.includes("ci_16xlarge") ? 1 : 0,
            project_pausing: has("project_pausing") ? 1 : 0,
            project_cloning: has("project_cloning") ? 1 : 0,
            project_scoped_roles: has("project_scoped_roles") ? 1 : 0,
            pitr_available: has("pitr.available_variants") ? 1 : 0,
            private_link: has("security.private_link") ? 1 : 0,
            high_availability: has("instances.high_availability") ? 1 : 0,
            read_replicas: has("instances.read_replicas") ? 1 : 0,
            disk_modifications: has("instances.disk_modifications") ? 1 : 0,
          },
        });
      } else {
        results.push({
          id: "S06b",
          title: "S06b: entitlements snapshot",
          status: "fail",
          detail: `entitlements endpoint HTTP ${ents.status}`,
        });
      }

      // --- S06a: control ---
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `s06-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });
      if (create.status !== 201) {
        results.push({
          id: "S06a",
          title: "S06a: control",
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
            id: "S06a",
            title: "S06a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const healthy = await waitStatus(ctx, ref, "ACTIVE_HEALTHY");
          results.push({
            id: "S06a",
            title: "S06a: control",
            status: healthy === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: healthy === "ACTIVE_HEALTHY" ? undefined : `not healthy (status=${healthy})`,
            measurements: { provision_s: Math.round((Date.now() - t0) / 1000) },
          });

          // --- S06c: pausing enforcement ---
          const pause = await mgmt(ctx, "POST", `/projects/${ref}/pause`, {});
          const pausedStatus = await waitStatus(ctx, ref, "INACTIVE", 24);
          results.push({
            id: "S06c",
            title: "S06c: project_pausing enforcement",
            status: "info",
            detail:
              pause.status >= 200 && pause.status < 300
                ? `PAUSE_ACCEPTED -> ${pausedStatus}`
                : `pause rejected: HTTP ${pause.status} (${pause.text.slice(0, 120)})`,
            measurements: {
              pause_status: pause.status,
              reached_inactive: pausedStatus === "INACTIVE" ? 1 : 0,
            },
          });

          // --- S06d: restore + delete (reversibility) ---
          let deleteStatus = 0;
          if (pausedStatus === "INACTIVE") {
            const restore = await mgmt(ctx, "POST", `/projects/${ref}/restore`, {});
            const restored = await waitStatus(ctx, ref, "ACTIVE_HEALTHY");
            const del = await mgmt(ctx, "DELETE", `/projects/${ref}`);
            deleteStatus = del.status;
            results.push({
              id: "S06d",
              title: "S06d: restore + delete",
              status: "info",
              detail:
                restore.status >= 200 && restore.status < 300
                  ? `restore -> ${restored}, delete=${del.status}`
                  : `restore rejected: HTTP ${restore.status}`,
              measurements: {
                restore_status: restore.status,
                restored_healthy: restored === "ACTIVE_HEALTHY" ? 1 : 0,
                delete_after_restore: del.status,
              },
            });
          } else {
            results.push({
              id: "S06d",
              title: "S06d: restore + delete",
              status: "skip",
              detail: "project never reached INACTIVE (see S06c), nothing to restore",
            });
          }
        }
      }

      for (const id of ["S06a", "S06b", "S06c", "S06d"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "skip", detail: "row never produced" });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S06a", "S06b", "S06c", "S06d"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
        }
      }
    } finally {
      if (ref) {
        // If still paused/inactive, restore first so DELETE can succeed.
        const st = (await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => null)) as
          | { json?: ProjectStatusResponse }
          | null;
        const status = st?.json?.status ?? "";
        if (status === "INACTIVE" || status === "PAUSING") {
          await mgmt(ctx, "POST", `/projects/${ref}/restore`, {}).catch(() => null);
        }
        await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
      }
    }

    return results;
  },
};
export default mod;
