/**
 * F06 - can a project's upgrade be measured, and what does the platform itself
 * estimate it will cost?
 *
 * Context: in-place major upgrades are widely described as taking HOURS, and
 * that figure is unquantified folklore in exactly the way the restart number
 * was before platform-downtime measured it. This module is what happened when
 * that measurement was attempted, and the answer is that it CANNOT be taken on
 * a throwaway project - which is a finding about the platform, not a gap in
 * the lab.
 *
 * Two facts, both read-only:
 *
 * F06a - a freshly created project is already at the latest app version, so it
 * has nothing to upgrade to. Combined with the fact that project creation can
 * no longer select a version (`postgres_engine` and `release_channel` are both
 * deprecated and typed null in the create body), the conditions for an upgrade
 * cannot be manufactured on demand. Anyone wanting the real client-visible
 * window must upgrade a project that has aged past the current version, and
 * must therefore be willing to upgrade something real.
 *
 * F06b - the eligibility payload carries `duration_estimate_hours`, the
 * platform's OWN estimate. That is a published claim rather than a measured
 * outage, and platform-downtime showed those are different things: an
 * operation's duration and its client-visible window differ per connection
 * path, sometimes by 2x. Record the estimate; do not report it as downtime.
 *
 * This module never upgrades anything. `POST /v1/projects/{ref}/upgrade`
 * exists and is deliberately not called: the only projects on which it would
 * do anything are real ones.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

interface Eligibility {
  eligible?: boolean | null;
  current_app_version?: string;
  latest_app_version?: string;
  current_app_version_release_channel?: string;
  duration_estimate_hours?: number;
  target_upgrade_versions?: unknown[];
  validation_errors?: unknown[];
  warnings?: unknown[];
}

const mod: TestModule = {
  id: "F06",
  title: "Upgrade surface: is the window measurable, and what does the platform estimate?",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/upgrade/eligibility`);
    if (r.throttled) {
      return [
        {
          id: "F06a",
          title: "Upgrade eligibility of the project under test",
          status: "skip",
          detail: "throttled (HTML interstitial) - re-run",
        },
      ];
    }
    if (r.status !== 200 || !r.json) {
      return [
        {
          id: "F06a",
          title: "Upgrade eligibility of the project under test",
          status: "fail",
          detail: `HTTP ${r.status} from the eligibility endpoint`,
          measurements: { status: r.status ?? 0 },
        },
      ];
    }

    const e = r.json as Eligibility;
    const current = e.current_app_version ?? "unknown";
    const latest = e.latest_app_version ?? "unknown";
    const targets = Array.isArray(e.target_upgrade_versions) ? e.target_upgrade_versions.length : 0;
    const atLatest = current === latest;

    const measurements: Record<string, string | number> = {
      eligible: e.eligible === null || e.eligible === undefined ? "null" : String(e.eligible),
      current_app_version: current,
      latest_app_version: latest,
      release_channel: e.current_app_version_release_channel ?? "unknown",
      duration_estimate_hours: e.duration_estimate_hours ?? "n/a",
      target_versions: targets,
      validation_errors: Array.isArray(e.validation_errors) ? e.validation_errors.length : 0,
      at_latest: atLatest ? "yes" : "no",
    };

    const results: TestResult[] = [
      {
        id: "F06a",
        title: "Upgrade eligibility of the project under test",
        // info: this records the platform's state, and a fresh project being
        // at latest is the expected, correct answer - not a failure.
        status: "info",
        detail: atLatest
          ? `already at ${current} with ${targets} target(s) - a newly created project cannot be upgraded, so the upgrade window is NOT measurable on a throwaway`
          : `${current} -> ${latest}, ${targets} target(s) available`,
        measurements,
      },
    ];

    // The version selectors are gone from the create body, so the state above
    // cannot be arranged deliberately. Recorded as its own row because it is
    // the reason F06a's answer is structural rather than incidental.
    results.push({
      id: "F06b",
      title: "Can an upgradeable project be created on purpose?",
      status: "info",
      detail:
        "no: `postgres_engine` and `release_channel` on POST /v1/projects are both deprecated " +
        "and typed null, so a created project takes the current default version. Measuring a " +
        "real upgrade window requires a project that has aged past the current version.",
      measurements: {
        create_version_selector: "deprecated (null)",
        upgrade_endpoint: "POST /v1/projects/{ref}/upgrade (never called by this module)",
      },
    });

    return results;
  },
};
export default mod;
