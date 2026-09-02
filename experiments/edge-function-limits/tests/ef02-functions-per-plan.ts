/**
 * EF02 - functions per project is plan-gated, and it is an ENTITLEMENT.
 *
 * For every org slug supplied: read the plan from GET /organizations/{slug},
 * read `function.max_count` and `function.size_limit_mb` from the org's
 * entitlements, and compare the count to the docs table.
 *
 *   pass  the entitlement matches the documented figure for that plan
 *   info  it differs - that is an override, which is the lever (the count can
 *         be raised without a plan change), not a failure
 *   fail  the plan is unknown to the docs table, or the row is absent
 *
 * Also recorded: `function.size_limit_mb`. If its value is the same on every
 * plan, that is one half of the argument that function size is a
 * bundling-path property and not a plan lever (EF04 is the other half).
 *
 * Note the entitlements payload is `{ entitlements: [ { feature: { key, type },
 * hasAccess, config: { value | unlimited | enabled | unit | set } } ] }` - a
 * flat list keyed by feature, not the nested object an older module assumed.
 *
 * Read-only. Supply PVLAB_ORG_SLUGS=free-slug,pro-slug,team-slug for one row
 * per plan; the interesting rows are the ones that differ.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { DOCS_READ_AT, FUNCTIONS_PER_PROJECT, FUNCTION_SIZE_MB, normalisePlan, planForFunctionCap } from "../lib/docs";

interface Entitlement {
  feature?: { key?: string; type?: string };
  type?: string;
  hasAccess?: boolean;
  config?: { value?: number; unlimited?: boolean; enabled?: boolean; unit?: string };
}

function row(list: Entitlement[], key: string): Entitlement | undefined {
  return list.find((e) => e.feature?.key === key);
}

const mod: TestModule = {
  id: "EF02",
  title: "Functions per project: entitlement vs docs, per organization plan",
  where: "local",
  requires: ["pat", "org"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    for (const slug of ctx.orgSlugs) {
      const org = await mgmt(ctx, "GET", `/organizations/${slug}`);
      const ent = await mgmt(ctx, "GET", `/organizations/${slug}/entitlements`);
      const id = `EF02-${slug}`;
      const title = `functions per project: ${slug}`;
      if (org.throttled || ent.throttled) {
        out.push({ id, title, status: "skip", detail: "throttled (HTML interstitial) - re-run" });
        continue;
      }
      if (org.status !== 200 || ent.status !== 200) {
        out.push({
          id,
          title,
          status: "fail",
          detail: `org HTTP ${org.status}, entitlements HTTP ${ent.status}`,
          evidence: `${org.text.slice(0, 200)}\n${ent.text.slice(0, 200)}`,
        });
        continue;
      }
      const rawPlan = (org.json as Record<string, unknown> | undefined)?.plan;
      const plan = normalisePlan(rawPlan);
      const list = ((ent.json as Record<string, unknown> | undefined)?.entitlements ?? []) as Entitlement[];
      const count = row(list, "function.max_count");
      const size = row(list, "function.size_limit_mb");
      const runtime = count?.config?.unlimited ? "unlimited" : count?.config?.value;
      const documented = plan ? FUNCTIONS_PER_PROJECT[plan] : undefined;

      let status: TestResult["status"];
      let detail: string;
      if (!count || runtime === undefined) {
        status = "fail";
        detail = "function.max_count row absent from entitlements";
      } else if (!plan) {
        status = "fail";
        detail = `plan "${String(rawPlan)}" is not in the docs table (free/pro/team/enterprise)`;
      } else if (runtime === documented) {
        status = "pass";
        detail = `${plan}: entitlement ${runtime} == docs ${documented}`;
      } else {
        status = "info";
        detail = `${plan}: entitlement ${runtime} != docs ${documented} - an OVERRIDE is in place; function.max_count is a lever, not a fixed ceiling`;
      }
      if (typeof runtime === "number") {
        const identified = planForFunctionCap(runtime);
        if (identified) detail += `; a reported cap of exactly ${runtime} identifies ${identified}`;
      }

      out.push({
        id,
        title,
        status,
        detail,
        measurements: {
          plan: plan ?? String(rawPlan ?? "unknown"),
          max_count_entitlement: runtime ?? "absent",
          max_count_docs: documented ?? "n/a",
          override: status === "info" ? 1 : 0,
          size_limit_mb_entitlement: size?.config?.unlimited ? "unlimited" : (size?.config?.value ?? "absent"),
          size_limit_mb_docs_cli: FUNCTION_SIZE_MB.cli,
          size_limit_mb_docs_api: FUNCTION_SIZE_MB.api,
          docs_read_at: DOCS_READ_AT,
        },
        evidence: JSON.stringify({ count, size }, null, 2),
      });
    }

    // The cross-plan observation about size only exists once several plans were read.
    const sizes = out
      .map((r) => r.measurements?.size_limit_mb_entitlement)
      .filter((v): v is string | number => v !== undefined && v !== "absent");
    if (sizes.length >= 2) {
      const distinct = new Set(sizes.map(String)).size;
      out.push({
        id: "EF02-size",
        title: "function.size_limit_mb across plans",
        status: "info",
        detail:
          distinct === 1
            ? `size_limit_mb is ${sizes[0]} on every plan read - function size is not a plan lever; the ${FUNCTION_SIZE_MB.api} MB figure belongs to the server-side bundling path (EF04)`
            : `size_limit_mb differs across plans: ${sizes.join(",")} - the docs' single per-path figure is incomplete`,
        measurements: { plans_read: sizes.length, distinct_size_values: distinct },
      });
    }
    return out;
  },
};
export default mod;
