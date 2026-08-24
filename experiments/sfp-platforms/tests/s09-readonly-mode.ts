/**
 * S09 - read-only mode
 *
 * `readonly` GET returns `{enabled, override_enabled, override_active_until}`;
 * `readonly/temporary-disable` POST accepts a 15-minute override (201). Both
 * are Management API surfaces that normal paid orgs never exercised. This
 * module records the status shape and the temporary-disable behavior.
 *
 *   S09a  control: healthy create.
 *   S09b  read status: GET /projects/{ref}/readonly.
 *   S09c  temporary disable: POST /projects/{ref}/readonly/temporary-disable,
 *         then re-read to observe the override flag.
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
interface ReadonlyResponse {
  enabled?: boolean;
  override_enabled?: boolean;
  override_active_until?: string;
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
  id: "S09",
  title: "S09 - read-only mode",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    let ref = "";
    const ensure = (id: string) => results.some((r) => r.id === id);

    try {
      // --- S09a: control ---
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `s09-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        results.push({
          id: "S09a",
          title: "S09a: control",
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
            id: "S09a",
            title: "S09a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          results.push({
            id: "S09a",
            title: "S09a: control",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: status === "ACTIVE_HEALTHY" ? undefined : `not healthy (status=${status})`,
            measurements: { provision_s: Math.round((Date.now() - t0) / 1000) },
          });

          if (status === "ACTIVE_HEALTHY") {
            // --- S09b: read status ---
            const read = await mgmt(ctx, "GET", `/projects/${ref}/readonly`);
            const ro = (read.json as ReadonlyResponse | undefined) ?? {};
            results.push({
              id: "S09b",
              title: "S09b: read status",
              status: "info",
              detail:
                read.status >= 200 && read.status < 300
                  ? `enabled=${ro.enabled}, override=${ro.override_enabled}`
                  : `readonly GET rejected: HTTP ${read.status}`,
              measurements: {
                readonly_status: read.status,
                readonly_enabled: ro.enabled ? 1 : 0,
                override_enabled: ro.override_enabled ? 1 : 0,
              },
            });

            // --- S09c: temporary disable ---
            const disable = await mgmt(ctx, "POST", `/projects/${ref}/readonly/temporary-disable`, {});
            let overrideAfter = 0;
            if (disable.status >= 200 && disable.status < 300) {
              const re = await mgmt(ctx, "GET", `/projects/${ref}/readonly`);
              const ro2 = (re.json as ReadonlyResponse | undefined) ?? {};
              overrideAfter = ro2.override_enabled ? 1 : 0;
            }
            results.push({
              id: "S09c",
              title: "S09c: temporary disable",
              status: "info",
              detail:
                disable.status >= 200 && disable.status < 300
                  ? `temporary-disable accepted (HTTP ${disable.status}), override_enabled_after=${overrideAfter}`
                  : `temporary-disable rejected: HTTP ${disable.status}: ${disable.text.slice(0, 200)}`,
              measurements: {
                disable_status: disable.status,
                override_enabled_after: overrideAfter,
              },
            });
          } else {
            results.push({ id: "S09b", title: "S09b: read status", status: "skip", detail: "S09a not healthy" });
            results.push({ id: "S09c", title: "S09c: temporary disable", status: "skip", detail: "S09a not healthy" });
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S09a", "S09b", "S09c"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
        }
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }

    for (const id of ["S09a", "S09b", "S09c"] as const) {
      if (!ensure(id)) {
        results.push({ id, title: id, status: "skip", detail: "row never produced" });
      }
    }

    return results;
  },
};
export default mod;
