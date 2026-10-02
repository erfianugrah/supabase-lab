/**
 * BA03 - preview branches as a second source of billable refs.
 *
 * A branch is billed as its own ref (branching compute; M07 saw one ref
 * under two invoice sections), and it is created through
 * POST /projects/{ref}/branches, not POST /projects. A create-time map that
 * only hooks project creation misses it. This module measures whether the
 * sweep can still attribute a branch deterministically through its parent.
 *
 *   BA03a  branch create returns a branch id and the branch's own project ref.
 *   BA03b  the branch ref appears (or not) in GET /projects and in
 *          GET /organizations/{slug}/projects - is the sweep able to see it.
 *   BA03c  parent linkage: where can a sweep read branch -> parent?
 *          First run: GET /branches/{id} returns connection config (ref,
 *          db_host, db_pass, jwt_secret ...) with NO parent field. So this
 *          row reads (1) the parent's GET /projects/{ref}/branches entry for
 *          the branch (parent_project_ref + project_ref) and (2) the branch
 *          ref's own GET /projects/{branchRef} detail, recording whether
 *          either carries the parent. Only key names are recorded, never
 *          values - the branch config carries credentials.
 *
 * Creates one parent project and one branch; deletes both in `finally`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(ctx: Ctx, ref: string, maxIters = 90): Promise<string> {
  let status = "";
  for (let i = 0; i < maxIters && status !== "ACTIVE_HEALTHY"; i++) {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = (p.json as { status?: string } | undefined)?.status ?? "";
  }
  return status;
}

function hasRef(json: unknown, ref: string): boolean {
  const arr = Array.isArray(json) ? json : ((json as { projects?: unknown[] } | undefined)?.projects ?? []);
  return (arr as Array<{ ref?: string; id?: string }>).some((p) => (p.ref ?? p.id) === ref);
}

const mod: TestModule = {
  id: "BA03",
  title: "Branch refs: sweep visibility and parent linkage",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    const ids = ["BA03a", "BA03b", "BA03c"] as const;
    const has = (id: string) => results.some((r) => r.id === id);
    let ref = "";
    let branchId = "";

    try {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `bu-alpha-ba03-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });
      ref = (create.json as { ref?: string } | undefined)?.ref ?? "";
      if (!ref) {
        results.push({ id: "BA03a", title: "BA03a: branch create", status: "fail", detail: `parent create HTTP ${create.status}: ${create.text.slice(0, 300)}` });
        return results;
      }
      const health = await waitHealthy(ctx, ref);
      if (health !== "ACTIVE_HEALTHY") {
        results.push({ id: "BA03a", title: "BA03a: branch create", status: "fail", detail: `parent not healthy (status=${health})` });
        return results;
      }

      // ---- BA03a ----
      const branch = await mgmt(ctx, "POST", `/projects/${ref}/branches`, {
        branch_name: `ba03-${t0}`,
        region: "ap-southeast-1",
        with_data: false,
      });
      const b = (branch.json as { id?: string; project_ref?: string; parent_project_ref?: string } | undefined) ?? {};
      branchId = b.id ?? "";
      const branchRef = b.project_ref ?? "";
      results.push({
        id: "BA03a",
        title: "BA03a: branch create returns id and its own ref",
        status: branchId && branchRef ? "pass" : branch.status >= 400 ? "info" : "fail",
        detail: branchRef ? `branch ref differs from parent: ${branchRef !== ref}` : `HTTP ${branch.status}: ${branch.text.slice(0, 300)}`,
        measurements: { branch_status: branch.status },
      });
      if (!branchId || !branchRef) return results;

      // ---- BA03b: sweep visibility (poll up to 120 s) ----
      let inAll = false;
      let inOrg = false;
      for (let i = 0; i < 60 && !(inAll && inOrg); i++) {
        const [all, byOrg] = await Promise.all([
          mgmt(ctx, "GET", "/projects"),
          mgmt(ctx, "GET", `/organizations/${org}/projects`),
        ]);
        inAll = inAll || hasRef(all.json, branchRef);
        inOrg = inOrg || hasRef(byOrg.json, branchRef);
        if (!(inAll && inOrg)) await sleep(2000);
      }
      results.push({
        id: "BA03b",
        title: "BA03b: branch ref visible to the sweep",
        status: "info",
        detail: inAll || inOrg ? "listed - sweep sees branches" : "NOT listed - sweep must also walk /projects/{ref}/branches per parent",
        measurements: { in_projects: inAll ? 1 : 0, in_org_projects: inOrg ? 1 : 0 },
      });

      // ---- BA03c: parent linkage ----
      const list = await mgmt(ctx, "GET", `/projects/${ref}/branches`);
      const entry = ((Array.isArray(list.json) ? list.json : []) as Array<Record<string, unknown>>).find(
        (x) => x.id === branchId || x.project_ref === branchRef,
      );
      const listParent = String(entry?.parent_project_ref ?? "");
      const detail = await mgmt(ctx, "GET", `/projects/${branchRef}`);
      const d = (detail.json as Record<string, unknown> | undefined) ?? {};
      const detailParentKeys = Object.keys(d).filter((k) => /parent|branch|main/i.test(k));
      results.push({
        id: "BA03c",
        title: "BA03c: where branch -> parent is readable",
        status: listParent === ref ? "pass" : "fail",
        detail: `parent-side list: ${listParent ? `parent matches=${listParent === ref}` : "no parent_project_ref"}; branch-ref detail HTTP ${detail.status}, parent-ish keys: ${detailParentKeys.join(",") || "none"}`,
        measurements: { list_status: list.status, branch_detail_status: detail.status, list_has_parent: listParent === ref ? 1 : 0 },
        evidence: `list entry keys: ${Object.keys(entry ?? {}).join(",")} | branch-ref detail keys: ${Object.keys(d).join(",")}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ids) if (!has(id)) results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
    } finally {
      if (branchId) await mgmt(ctx, "DELETE", `/branches/${branchId}`).catch(() => null);
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    for (const id of ids) if (!has(id)) results.push({ id, title: id, status: "skip", detail: "row never produced" });
    return results;
  },
};
export default mod;
