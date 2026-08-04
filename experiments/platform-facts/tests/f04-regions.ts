/**
 * F04 - can you discover the set of creatable regions from the API?
 *
 * Region choice is where data-residency decisions get made, and platform
 * builders ask for programmatic per-customer region selection. Both rest on an
 * unstated assumption: that the valid region set is machine-readable. It is
 * not. `region` is accepted on project creation, but there is no catalogue
 * endpoint to enumerate what may be passed - the list exists only in
 * documentation, which is exactly the class of claim this experiment exists to
 * re-measure.
 *
 * A CONTROL is mandatory and is the whole reason this is a test rather than a
 * pair of 404s: 404 everywhere also describes a dead token, a wrong base URL,
 * and an outage. The positive endpoints must answer 200 in the SAME run.
 *
 * Read-only GETs, no project of its own - it reads the account. Runs without
 * --destructive and is safe on a schedule.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

/** Absence here is the finding. */
const CATALOGUE_CANDIDATES = ["/regions", "/platform/regions", "/projects/regions"];

/** Must be 200, or the negative result above means nothing. */
const CONTROLS = ["/projects", "/organizations"];

async function catalogueAbsent(ctx: Ctx): Promise<TestResult> {
  const measurements: Record<string, string | number> = {};
  let anyPresent = false;
  let throttled = false;

  for (const path of CATALOGUE_CANDIDATES) {
    const r = await mgmt(ctx, "GET", path);
    measurements[`probe${path.replace(/\//g, "_")}`] = r.status;
    if (r.throttled) throttled = true;
    if (r.status === 200) anyPresent = true;
  }

  let controlsOk = true;
  for (const path of CONTROLS) {
    const r = await mgmt(ctx, "GET", path);
    measurements[`control${path.replace(/\//g, "_")}`] = r.status;
    if (r.throttled) throttled = true;
    if (r.status !== 200) controlsOk = false;
  }

  measurements.catalogue_endpoint = anyPresent ? "present" : "absent";
  measurements.control_ok = controlsOk ? "yes" : "no";

  if (throttled) {
    return {
      id: "F04a",
      title: "Region catalogue endpoint",
      status: "skip",
      detail: "throttled (HTML interstitial) - re-run, the negative is not trustworthy",
      measurements,
    };
  }
  if (!controlsOk) {
    return {
      id: "F04a",
      title: "Region catalogue endpoint",
      status: "fail",
      detail: "control endpoints did not answer 200 - the 404s above mean nothing",
      measurements,
    };
  }

  return {
    id: "F04a",
    title: "Region catalogue endpoint",
    status: "info",
    detail: anyPresent
      ? "a region catalogue endpoint EXISTS - the documented-only claim has changed, update the docs"
      : "no region catalogue endpoint; the creatable-region set is documentation-only, " +
        "while the controls answered 200 in the same run",
    measurements,
  };
}

/**
 * Which regions this account's projects actually sit in. Aggregate counts only
 * - a project ref does not belong in committed evidence.
 */
async function observedRegions(ctx: Ctx): Promise<TestResult> {
  const r = await mgmt(ctx, "GET", "/projects");
  if (r.status !== 200 || !Array.isArray(r.json)) {
    return {
      id: "F04b",
      title: "Regions observed across the account",
      status: "fail",
      detail: r.throttled ? "throttled (HTML interstitial)" : `HTTP ${r.status}`,
      measurements: { status: r.status },
    };
  }

  const counts = new Map<string, number>();
  for (const p of r.json as Record<string, unknown>[]) {
    const region = typeof p.region === "string" ? p.region : "unknown";
    counts.set(region, (counts.get(region) ?? 0) + 1);
  }

  const measurements: Record<string, string | number> = {
    status: r.status,
    projects: (r.json as unknown[]).length,
    distinct_regions: counts.size,
  };
  for (const [region, n] of [...counts.entries()].sort()) {
    measurements[`region_${region.replace(/-/g, "_")}`] = n;
  }

  return {
    id: "F04b",
    title: "Regions observed across the account",
    status: "info",
    detail: `${counts.size} distinct region(s) across ${(r.json as unknown[]).length} project(s)`,
    measurements,
  };
}

const mod: TestModule = {
  id: "F04",
  title: "Region discoverability",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx) {
    return [await catalogueAbsent(ctx), await observedRegions(ctx)];
  },
};
export default mod;
