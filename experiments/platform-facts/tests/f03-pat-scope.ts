/**
 * F03 - is a Personal Access Token still unscoped?
 *
 * The consolidation guide's security section rests on this: a PAT reads and
 * writes every organization and every project the account can reach, and
 * there is no scoping surface to reach for. The evidence was a probe of every
 * plausible scope/permission endpoint - all 404, while ordinary endpoints
 * returned 200 on the same token.
 *
 * That is a claim with a short half-life, in the direction that matters: if
 * Supabase ships token scoping, the guide's "mitigations are operational
 * rather than technical" advice becomes wrong, and the failure is silent.
 * This turns "we probed it once in August" into a rerunnable check.
 *
 * A control is required and is the whole reason this is a test rather than a
 * list of 404s: 404 on every path also describes a dead token, a wrong base
 * URL, and an outage. The positive endpoints have to answer 200 in the SAME
 * run for the negative result to mean anything.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

/** Absence here is the finding. */
const SCOPE_CANDIDATES = [
  "/oauth/apps",
  "/profile/permissions",
  "/tokens",
  "/profile/access-tokens",
  "/scopes",
  "/profile/scopes",
];

/** Presence here is the control. */
const CONTROL = ["/organizations", "/profile"];

const mod: TestModule = {
  id: "F03",
  title: "PAT scoping surface (expected: none)",
  where: "local",
  requires: ["pat"],
  async run(ctx) {
    const results: TestResult[] = [];
    const controlStatuses: Record<string, number> = {};
    for (const path of CONTROL) {
      const r = await mgmt(ctx, "GET", path);
      controlStatuses[path] = r.status;
    }
    const controlOk = Object.values(controlStatuses).every((s) => s === 200);

    const scopeStatuses: Record<string, number> = {};
    for (const path of SCOPE_CANDIDATES) {
      const r = await mgmt(ctx, "GET", path);
      scopeStatuses[path] = r.status;
    }

    results.push({
      id: "F03a",
      title: "Control: ordinary endpoints answer on this token",
      status: controlOk ? "pass" : "fail",
      detail: controlOk
        ? "token is live"
        : "control endpoints did not all return 200 - the F03b result below is uninterpretable",
      measurements: Object.fromEntries(
        Object.entries(controlStatuses).map(([k, v]) => [k, v]),
      ),
    });

    const reachable = Object.entries(scopeStatuses).filter(([, s]) => s !== 404);

    results.push({
      id: "F03b",
      title: "No scope/permission surface is reachable with a PAT",
      // Only meaningful when the control passed. Without it this is a skip,
      // not a pass - see the module comment.
      status: !controlOk ? "skip" : reachable.length === 0 ? "pass" : "fail",
      detail: !controlOk
        ? "control failed; not interpretable"
        : reachable.length === 0
          ? "all candidates 404 while control endpoints return 200"
          : `now reachable: ${reachable.map(([p, s]) => `${p}=${s}`).join(", ")} - the guide's "no scoping surface" claim needs revisiting`,
      measurements: Object.fromEntries(
        Object.entries(scopeStatuses).map(([k, v]) => [k, v]),
      ),
    });

    return results;
  },
};
export default mod;
