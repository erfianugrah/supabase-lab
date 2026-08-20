/**
 * R02 - a smart group code is not a value for the `region` field.
 *
 * The residency doc claims (measured ad hoc 2026-08-10, uncommitted):
 * POST /v1/projects with "region": "emea" -> 400 "Need to use one of
 * available regions", and the documented place for a smart group is the
 * sibling region_selection object (I02 covers that acceptance half on a Pro
 * org with apac). This module re-measures the rejection half on the record.
 *
 * Destructive in intent only: the expected outcome is a 400 before anything
 * provisions. If the platform ACCEPTS the create, that is the finding - the
 * project is deleted immediately and the test fails.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const TEAM_ORG = "kqiknhvnmyxpyhudlyxh"; // same Team org as d04/secrets.tfvars

const mod: TestModule = {
  id: "R02",
  title: "Smart group code rejected in the region field",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult> {
    const create = await mgmt(ctx, "POST", "/projects", {
      organization_slug: TEAM_ORG,
      name: `r02-smart-reject-${Date.now()}`,
      db_pass: `${crypto.randomUUID()}Aa1!`,
      region: "emea",
    });

    const measurements: Record<string, string | number> = {
      create_status: create.status,
    };

    if (create.throttled) {
      return { id: "R02a", title: this.title, status: "skip", detail: "throttled - re-run", measurements };
    }

    if (create.status === 201 || create.status === 200) {
      // Accepted: clean up immediately, then report the doc claim as wrong.
      const ref = ((create.json ?? {}) as Record<string, unknown>).ref;
      let deleted = "n/a";
      if (typeof ref === "string" && ref) {
        const d = await mgmt(ctx, "DELETE", `/projects/${ref}`);
        deleted = String(d.status);
      }
      measurements.cleanup_status = deleted;
      return {
        id: "R02a",
        title: this.title,
        status: "fail",
        detail: `smart group "emea" ACCEPTED in the region field (HTTP ${create.status}) - the doc claim is wrong; project deleted (HTTP ${deleted})`,
        measurements,
        evidence: create.text.slice(0, 300),
      };
    }

    const msg = create.text.slice(0, 200);
    const expected = create.status === 400 && /available regions/i.test(create.text);
    return {
      id: "R02a",
      title: this.title,
      status: expected ? "pass" : "info",
      detail: expected
        ? `rejected as the doc claims: HTTP 400 "${msg}"`
        : `rejected but not as documented: HTTP ${create.status} "${msg}"`,
      measurements,
      evidence: msg,
    };
  },
};
export default mod;
