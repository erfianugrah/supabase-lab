/**
 * BA04 - a project transferred INTO the org arrives without a create.
 *
 * The claim-token pair moves a project between organizations keeping its ref
 * (org-consolidation guide, measured Team/Pro/Free on 2026-08-03). A
 * create-time map never sees such a project, so the sweep is the only thing
 * that catches it. This module measures the transfer into the org under
 * test (a `platform`-plan org was never a measured destination) and whether
 * the sweep sees it.
 *
 *   BA04a  dry-run preview: plan pair, valid, warning/error keys.
 *   BA04b  transfer status and duration; ref unchanged afterwards.
 *   BA04c  the transferred ref appears in GET /organizations/{target}/projects.
 *
 * Needs two orgs on the same control plane under one token:
 * PVLAB_ORG_SOURCE (where the throwaway project is created) and the org
 * under test as PVLAB_ORG_SLUGS. Skips with a reason when no source is
 * supplied. Deletes the project in `finally`, wherever it ended up.
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

interface Preview {
  source_subscription_plan?: string;
  target_subscription_plan?: string;
  valid?: boolean;
  errors?: Array<{ key?: string }>;
  warnings?: Array<{ key?: string }>;
}

const mod: TestModule = {
  id: "BA04",
  title: "Transfer-in: ref arrives without a create",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const target = ctx.orgSlugs[0] ?? "";
    const source = ctx.orgs.source ?? "";
    const ids = ["BA04a", "BA04b", "BA04c"] as const;
    const has = (id: string) => results.some((r) => r.id === id);
    if (!source || source === target) {
      return ids.map((id) => ({ id, title: id, status: "skip" as const, detail: "PVLAB_ORG_SOURCE not set (or equals the target org)" }));
    }
    let ref = "";
    let token = "";

    try {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: source,
        name: `bu-alpha-ba04-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });
      ref = (create.json as { ref?: string } | undefined)?.ref ?? "";
      if (!ref) {
        results.push({ id: "BA04a", title: "BA04a: dry-run preview", status: "fail", detail: `source create HTTP ${create.status}: ${create.text.slice(0, 300)}` });
        return results;
      }
      const health = await waitHealthy(ctx, ref);
      if (health !== "ACTIVE_HEALTHY") {
        results.push({ id: "BA04a", title: "BA04a: dry-run preview", status: "fail", detail: `source project not healthy (status=${health})` });
        return results;
      }

      // ---- BA04a: token + preview ----
      const tok = await mgmt(ctx, "POST", `/projects/${ref}/claim-token`);
      token = String((tok.json as { token?: string } | undefined)?.token ?? "");
      if (!token) {
        results.push({ id: "BA04a", title: "BA04a: dry-run preview", status: "info", detail: `claim-token HTTP ${tok.status}: ${tok.text.slice(0, 300)}` });
        return results;
      }
      const pv = await mgmt(ctx, "GET", `/organizations/${target}/project-claim/${token}`);
      const p = ((pv.json as { preview?: Preview } | undefined)?.preview ?? {}) as Preview;
      results.push({
        id: "BA04a",
        title: "BA04a: dry-run preview into the org under test",
        status: "info",
        detail: `${p.source_subscription_plan ?? "?"} -> ${p.target_subscription_plan ?? "?"} valid=${p.valid}`,
        measurements: { preview_status: pv.status },
        evidence: `errors=${(p.errors ?? []).map((e) => e.key).join(",")} warnings=${(p.warnings ?? []).map((w) => w.key).join(",")}`,
      });
      if (p.valid !== true) return results;

      // ---- BA04b: transfer ----
      const ts = Date.now();
      const claim = await mgmt(ctx, "POST", `/organizations/${target}/project-claim/${token}`);
      const transferMs = Date.now() - ts;
      token = "";
      const after = await mgmt(ctx, "GET", `/projects/${ref}`);
      const a = (after.json as { ref?: string; id?: string; organization_slug?: string; organization_id?: string } | undefined) ?? {};
      results.push({
        id: "BA04b",
        title: "BA04b: transfer keeps the ref",
        status: claim.status >= 200 && claim.status < 300 && (a.ref ?? a.id) === ref ? "pass" : "fail",
        detail: `claim HTTP ${claim.status}`,
        measurements: { claim_status: claim.status, transfer_ms: transferMs },
      });

      // ---- BA04c: visible in the target org listing ----
      let seen = -1;
      for (let i = 0; i < 60 && seen < 0; i++) {
        const l = await mgmt(ctx, "GET", `/organizations/${target}/projects`);
        const arr = Array.isArray(l.json) ? l.json : ((l.json as { projects?: unknown[] } | undefined)?.projects ?? []);
        if ((arr as Array<{ ref?: string; id?: string }>).some((x) => (x.ref ?? x.id) === ref)) seen = Date.now() - ts;
        else await sleep(2000);
      }
      results.push({
        id: "BA04c",
        title: "BA04c: transferred ref visible to the target-org sweep",
        status: seen >= 0 ? "pass" : "fail",
        measurements: { visible_ms: seen },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ids) if (!has(id)) results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
    } finally {
      if (token && ref) await mgmt(ctx, "DELETE", `/projects/${ref}/claim-token`).catch(() => null);
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    for (const id of ids) if (!has(id)) results.push({ id, title: id, status: "skip", detail: "row never produced" });
    return results;
  },
};
export default mod;
