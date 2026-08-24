/**
 * S15 - JIT database access invitations
 *
 * Provision one project:
 *
 *   S15a  control: healthy create.
 *   S15b  invite: `POST /projects/{ref}/database/jit/invite` with
 *         `{"email":"probe@example.com","roles":[{"role":"postgres","expires_at":<now+3600>,"allowed_networks":{"allowed_cidrs":[{"cidr":"1.2.3.4/32"}]}}]}`.
 *         Record `invite_status` (number) and whether the response carries an
 *         `invite_id` / `id` (1|0). `info` either way.
 *   S15c  delete invite: only if S15b returned an invite id.
 *         `DELETE /projects/{ref}/database/jit/invite/{invite_id}`.
 *         Record `delete_status`. If no id, S15c is a `skip`.
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
  id: "S15",
  title: "JIT database access invitations",
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
        name: `s15-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        results.push({
          id: "S15a",
          title: "S15a: control",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
      } else {
        ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
        if (!ref) {
          results.push({
            id: "S15a",
            title: "S15a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          const provisionS = Math.round((Date.now() - t0) / 1000);
          results.push({
            id: "S15a",
            title: "S15a: control",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: status === "ACTIVE_HEALTHY" ? undefined : `not healthy (status=${status})`,
            measurements: { provision_s: provisionS },
          });

          // --- S15b: invite ---
          const invite = await mgmt(ctx, "POST", `/projects/${ref}/database/jit/invite`, {
            email: "probe@example.com",
            roles: [
              {
                role: "postgres",
                expires_at: Math.floor(Date.now() / 1000) + 3600,
                allowed_networks: {
                  allowed_cidrs: [{ cidr: "1.2.3.4/32" }],
                },
              },
            ],
          });
          const invite_id = (invite.json as any)?.id || (invite.json as any)?.invite_id;
          const has_id = invite_id ? 1 : 0;

          results.push({
            id: "S15b",
            title: "S15b: invite",
            status: "info",
            detail: invite.status >= 200 && invite.status < 300 ? "INVITE_ACCEPTED" : "INVITE_REJECTED",
            measurements: {
              invite_status: invite.status,
              has_id: has_id,
            },
            evidence: invite.text.slice(0, 300),
          });

          // --- S15c: delete invite ---
          if (invite_id) {
            const del = await mgmt(ctx, "DELETE", `/projects/${ref}/database/jit/invite/${invite_id}`);
            results.push({
              id: "S15c",
              title: "S15c: delete invite",
              status: "info",
              detail: del.status >= 200 && del.status < 300 ? "DELETE_ACCEPTED" : "DELETE_REJECTED",
              measurements: { delete_status: del.status },
              evidence: del.text.slice(0, 300),
            });
          } else {
            results.push({
              id: "S15c",
              title: "S15c: delete invite",
              status: "skip",
              detail: "no invite_id returned (see S15b), so nothing to delete",
            });
          }
        }
      }

      for (const id of ["S15a", "S15b", "S15c"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "skip", detail: "row never produced" });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S15a", "S15b", "S15c"] as const) {
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
