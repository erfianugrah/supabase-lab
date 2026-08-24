/**
 * S10 - organization members
 *
 * Org-level, no project needed:
 *
 *   S10a  list: `GET /organizations/{slug}/members`. Record
 *         `member_count` (number) and `roles` (comma-joined distinct `role_name` values).
 *         A 2xx with an array body is the finding (member listing is populated, not
 *         a stub). `info`. If the endpoint 4xx/errors, record `member_status`
 *         and mark `info` (that is the finding).
 *
 * Every module is a pvlab `TestModule` (default export, see `harness/src/types.ts`),
 * self-provisioning (creates its 0-project test, but uses the provided org slug),
 * `where:"local"`, `requires:["pat","org"]`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

interface MemberResponse {
  role_name?: string;
}

const mod: TestModule = {
  id: "S10",
  title: "Organization members",
  where: "local",
  requires: ["pat", "org"],
  destructive: false,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    const ensure = (id: string) => results.some((r) => r.id === id);

    try {
      const list = await mgmt(ctx, "GET", `/organizations/${org}/members`);
      if (list.status >= 200 && list.status < 300) {
        const members = Array.isArray(list.json) ? (list.json as MemberResponse[]) : [];
        const roles = Array.from(new Set(members.map((m) => m.role_name).filter(Boolean))).join(",");

        results.push({
          id: "S10a",
          title: "S10a: list members",
          status: "pass",
          detail: "member listing read successful",
          measurements: {
            member_count: members.length,
            roles: roles,
          },
        });
      } else {
        results.push({
          id: "S10a",
          title: "S10a: list members",
          status: "info",
          detail: `member listing returned error: HTTP ${list.status}`,
          measurements: { member_status: list.status },
          evidence: list.text.slice(0, 300),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        id: "S10a",
        title: "S10a: list members",
        status: "fail",
        detail: `test threw: ${msg}`,
      });
    }

    if (!ensure("S10a")) {
      results.push({ id: "s10a", title: "S10a: list members", status: "skip", detail: "row never produced" });
    }

    return results;
  },
};
export default mod;
