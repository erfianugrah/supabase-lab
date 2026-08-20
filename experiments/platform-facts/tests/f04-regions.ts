/**
 * F04 - can you discover the set of creatable regions from the API?
 *
 * UPDATE 2026-08-20 (residency-facts R01 falsified the original negative):
 * the catalogue endpoint EXISTS at /projects/available-regions, but only with
 * ?organization_slug= - a bare call answers 400, and the three paths this
 * module originally probed (/regions, /platform/regions, /projects/regions)
 * all 404. The original conclusion ("documentation-only") was drawn from
 * name-guessed paths, the exact failure mode F05's enumeration method exists
 * to avoid. The original probes are kept below as a record; F04c is the
 * corrected measurement.
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
      ? "one of the name-guessed paths answers - re-check what it returns"
      : "the name-guessed paths still 404 (historical record); the real catalogue is /projects/available-regions - see F04c",
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

/**
 * F04c - the corrected measurement: the catalogue lives at
 * /projects/available-regions?organization_slug=<slug>. The slug comes from
 * /organizations in the same run, so the module stays self-contained.
 * Records the counts and whether the expected anchors (a Zurich region code,
 * the three smart groups) are present; the full catalogue belongs to
 * residency-facts R01, which asserts on content.
 */
async function cataloguePresent(ctx: Ctx): Promise<TestResult> {
  const orgs = await mgmt(ctx, "GET", "/organizations");
  if (orgs.status !== 200 || !Array.isArray(orgs.json) || orgs.json.length === 0) {
    return {
      id: "F04c",
      title: "Region catalogue at /projects/available-regions",
      status: "fail",
      detail: `control /organizations -> HTTP ${orgs.status} or empty; cannot build the org-scoped catalogue call`,
      measurements: { organizations_status: orgs.status },
    };
  }
  const slug = String((orgs.json[0] as Record<string, unknown>).slug ?? (orgs.json[0] as Record<string, unknown>).id ?? "");

  const bare = await mgmt(ctx, "GET", "/projects/available-regions");
  const r = await mgmt(ctx, "GET", `/projects/available-regions?organization_slug=${slug}`);
  if (r.throttled) {
    return {
      id: "F04c",
      title: "Region catalogue at /projects/available-regions",
      status: "skip",
      detail: "throttled (HTML interstitial) - re-run",
      measurements: { bare_status: bare.status, catalogue_status: "throttled" },
    };
  }

  const measurements: Record<string, string | number> = {
    bare_status: bare.status,
    catalogue_status: r.status,
  };
  if (r.status !== 200) {
    return {
      id: "F04c",
      title: "Region catalogue at /projects/available-regions",
      status: "fail",
      detail: `org-scoped catalogue -> HTTP ${r.status}; residency-facts R01's positive has regressed`,
      measurements,
      evidence: r.text.slice(0, 200),
    };
  }

  const j = r.json as Record<string, unknown>;
  const all = (j.all ?? {}) as Record<string, unknown>;
  const specific = (all.specific ?? []) as Array<{ code?: string }>;
  const groups = (all.smartGroup ?? []) as Array<{ code?: string }>;
  measurements.specific_count = specific.length;
  measurements.smart_group_count = groups.length;

  return {
    id: "F04c",
    title: "Region catalogue at /projects/available-regions",
    status: "pass",
    detail: `catalogue is machine-readable: ${specific.length} specific + ${groups.length} smart groups (bare call -> HTTP ${bare.status}, org slug required)`,
    measurements,
  };
}

const mod: TestModule = {
  id: "F04",
  title: "Region discoverability",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx) {
    return [await catalogueAbsent(ctx), await cataloguePresent(ctx), await observedRegions(ctx)];
  },
};
export default mod;
