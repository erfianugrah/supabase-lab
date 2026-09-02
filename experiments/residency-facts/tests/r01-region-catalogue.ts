/**
 * R01 - is the creatable-region set machine-readable, and what's in it?
 *
 * History: platform-facts F04 (2026-08-04) probed /regions,
 * /platform/regions and /projects/regions, got 404s, and concluded the
 * creatable-region set was documentation-only. The residency doc then quoted
 * GET /v1/projects/available-regions as returning the full catalogue
 * (measured 2026-08-10, ad hoc, uncommitted). This module settles which is
 * true, on the record, with the F04 control pattern: /projects and
 * /organizations must answer 200 in the SAME run or the negative means
 * nothing.
 *
 * Asserts (these have genuine right answers, per the doc's claims):
 *   - the catalogue endpoint answers 200
 *   - it contains eu-central-2 (Zurich) as a specific region
 *   - it contains the three smart groups (americas, emea, apac)
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

interface RegionEntry {
  code?: string;
  name?: string;
  type?: string;
  provider?: string;
  status?: string;
}

const mod: TestModule = {
  id: "R01",
  title: "Region catalogue endpoint",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult> {
    const measurements: Record<string, string | number> = {};

    // Controls first: without them a non-200 on the catalogue is
    // uninterpretable (dead token, outage, wrong base URL all look alike).
    let controlsOk = true;
    for (const path of ["/projects", "/organizations"]) {
      const r = await mgmt(ctx, "GET", path);
      measurements[`control${path.replace(/\//g, "_")}`] = r.status;
      if (r.status !== 200) controlsOk = false;
    }

    // The endpoint requires ?organization_slug - a bare call answers 400
    // "organization_slug: Invalid input". The catalogue can differ per org
    // (plan gating), so the org is part of the measurement.
    // First supplied slug, else the Team role; never a literal in source.
    const org = ctx.orgSlugs[0] ?? ctx.orgs.team ?? "";
    if (!org) return { id: "R01", title: this.title, status: "skip", detail: "PVLAB_ORG_SLUGS or PVLAB_ORG_TEAM not set" };
    const r = await mgmt(ctx, "GET", `/projects/available-regions?organization_slug=${org}`);
    measurements.catalogue_status = r.status;
    measurements.org = org;
    if (r.throttled) {
      return {
        id: "R01a",
        title: this.title,
        status: "skip",
        detail: "throttled (HTML interstitial) - re-run",
        measurements,
      };
    }
    if (!controlsOk) {
      return {
        id: "R01a",
        title: this.title,
        status: "fail",
        detail: "control endpoints did not answer 200 - the catalogue result means nothing",
        measurements,
      };
    }
    if (r.status !== 200) {
      return {
        id: "R01a",
        title: this.title,
        status: "fail",
        detail: `GET /projects/available-regions -> HTTP ${r.status}; the doc's measured claim is wrong (or moved)`,
        measurements,
        evidence: r.text.slice(0, 300),
      };
    }

    // Shape (measured 2026-08-19): { recommendations: { smartGroup,
    // specific[] }, all: { smartGroup[], specific[] } }. The catalogue is
    // under `all`; `recommendations` is the platform's capacity pick.
    const j = r.json as Record<string, unknown>;
    const all = (j.all ?? {}) as Record<string, unknown>;
    const groups = (all.smartGroup ?? all.smart_groups ?? []) as RegionEntry[];
    const specific = (all.specific ?? (Array.isArray(j) ? j : [])) as RegionEntry[];
    const codes = specific.map((e) => e.code ?? "").filter(Boolean);
    const groupCodes = groups.map((e) => e.code ?? "").filter(Boolean);

    const rec = (j.recommendations ?? {}) as Record<string, unknown>;
    const recSpecific = ((rec.specific ?? []) as RegionEntry[]).map((e) => e.code ?? "").filter(Boolean);
    const recGroup = ((rec.smartGroup ?? {}) as RegionEntry).code ?? "";
    measurements.recommended_group = recGroup || "none";
    measurements.recommended_specific = recSpecific.join(",") || "none";
    measurements.specific_count = codes.length;
    measurements.smart_group_count = groupCodes.length;
    measurements.has_zurich = codes.includes("eu-central-2") ? "yes" : "no";
    measurements.smart_groups = groupCodes.sort().join(",") || "none";
    measurements.has_london = codes.includes("eu-west-2") ? "yes" : "no";
    measurements.has_me_region = codes.some((c) => c.startsWith("me-")) ? "yes" : "no";
    measurements.has_jakarta = codes.includes("ap-southeast-3") ? "yes" : "no";

    const ok =
      codes.includes("eu-central-2") &&
      ["americas", "emea", "apac"].every((g) => groupCodes.includes(g));

    return {
      id: "R01a",
      title: this.title,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `catalogue readable: ${codes.length} specific regions + smart groups ${groupCodes.sort().join("/")}; Zurich present`
        : `catalogue readable but content differs from the doc's claims (zurich=${measurements.has_zurich}, groups=${measurements.smart_groups})`,
      measurements,
      evidence: JSON.stringify({ specific: codes, smartGroups: groupCodes }),
    };
  },
};
export default mod;
