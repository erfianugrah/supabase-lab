/**
 * BA01 - the platform facts a customer-side attribution pattern rests on
 * (read-only).
 *
 * A platform customer that wants deterministic per-business-unit cost
 * attribution inside ONE organization has to build it on its own control
 * plane: Supabase has no project tags and the usage export carries no
 * attribution field. This module reads what the platform does give, so the
 * pattern is written against measured behaviour rather than assumption.
 *
 *   BA01-control  GET /organizations/{slug} answers; record the plan label.
 *   BA01a         entitlements that decide whether the dashboard can be
 *                 locked down per unit: project_scoped_roles,
 *                 security.member_roles, security.audit_logs_days.
 *   BA01b         Management API rate budget on this org's control plane:
 *                 x-ratelimit-limit / -remaining off one cheap read. One
 *                 automation user shares this budget across all its PATs
 *                 (rate-limits L01b), so it caps on-demand project creation.
 *
 * The project key-set check (no creator/tag field) lives in BA02f, which
 * has a live project to inspect; the org under test may be empty.
 *
 * No writes.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt, mgmtBase } from "../../../harness/src/mgmt.js";

interface Entitlement {
  feature?: { key?: string; type?: string };
  hasAccess?: boolean;
  config?: Record<string, unknown>;
}


const mod: TestModule = {
  id: "BA01",
  title: "Platform facts for customer-side attribution (read-only)",
  where: "local",
  requires: ["pat", "org"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";

    // ---- BA01-control ----
    const o = await mgmt(ctx, "GET", `/organizations/${org}`);
    const plan = String((o.json as { plan?: string } | undefined)?.plan ?? "");
    results.push({
      id: "BA01-control",
      title: "BA01-control: organization readable",
      status: o.status === 200 ? "pass" : "fail",
      detail: o.status === 200 ? `plan=${plan}` : `HTTP ${o.status}: ${o.text.slice(0, 200)}`,
      measurements: { org_status: o.status, plan },
    });
    if (o.status !== 200) return results;

    // ---- BA01a: entitlements ----
    const ents = await mgmt(ctx, "GET", `/organizations/${org}/entitlements`);
    const list = ((ents.json as { entitlements?: Entitlement[] } | undefined)?.entitlements ?? []) as Entitlement[];
    const find = (key: string) => list.find((e) => e?.feature?.key === key);
    const fmt = (key: string): string => {
      const e = find(key);
      if (!e) return "absent";
      const cfg = e.config && Object.keys(e.config).length ? ` ${JSON.stringify(e.config)}` : "";
      return `${e.hasAccess === true}${cfg}`;
    };
    results.push({
      id: "BA01a",
      title: "BA01a: access-control and audit entitlements",
      status: ents.status === 200 ? "info" : "fail",
      detail: ents.status === 200 ? `${list.length} entitlements` : `HTTP ${ents.status}`,
      measurements: {
        project_scoped_roles: fmt("project_scoped_roles"),
        member_roles: fmt("security.member_roles"),
        audit_logs_days: fmt("security.audit_logs_days"),
        api_members_roles: fmt("api.members.roles"),
      },
    });

    // ---- BA01b: rate budget headers (mgmt() does not surface headers) ----
    const res = await fetch(`${mgmtBase(ctx)}/organizations/${org}`, {
      headers: { Authorization: `Bearer ${ctx.pat}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    await res.text();
    results.push({
      id: "BA01b",
      title: "BA01b: Management API rate budget on this control plane",
      status: "info",
      measurements: {
        ratelimit_limit: res.headers.get("x-ratelimit-limit") ?? "absent",
        ratelimit_remaining: res.headers.get("x-ratelimit-remaining") ?? "absent",
        ratelimit_reset: res.headers.get("x-ratelimit-reset") ?? "absent",
      },
    });

    return results;
  },
};
export default mod;
