/**
 * G08 - the disk ceiling: largest discoverable disk size for a single project.
 *
 * G06 probed several endpoint shapes and found only disk THROUGHPUT fields
 * (baseline_disk_io_mbs, max_disk_io_mbs) - no size ceiling. The question
 * "can one project hold a corpus of this order" is the largest open commercial
 * risk and remains unanswered.
 *
 * This probes the billing ADDON CATALOGUE rather than the project config:
 * available_addons on the billing endpoint lists variants, and the largest
 * published variant is the ceiling if one is published. It also probes the
 * org-level billing endpoint if org slugs are available.
 *
 * PROBE SEVERAL SHAPES, NOT ONE. This repo has been wrong exactly this way
 * before (platform-facts F05: the lever was on a differently-named path).
 * Every candidate endpoint gets probed and its result recorded, including the
 * ones that 404. Do NOT attempt a resize.
 *
 * CONTROLS ARE MANDATORY. A wall of 404s also describes a dead token or an
 * outage. The control paths must answer 200 in the same run.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt, type MgmtResponse } from "../../../harness/src/mgmt";

const CONTROLS = ["/projects", "/projects/{ref}"];

/** Endpoint shapes that could plausibly carry disk/volume size information.
 * Absence of any one is not a finding on its own - only the aggregate. */
const CANDIDATES = [
  "/projects/{ref}/billing/addons",
  "/projects/{ref}/billing",
  "/projects/{ref}/addons",
];

/** Org-level candidates, only probed when ctx.orgSlugs is non-empty. */
const ORG_CANDIDATES = [
  "/organizations/{slug}/billing/addons",
  "/organizations/{slug}/billing",
];

// max_disk deliberately excluded: the addons endpoint returns max_disk_io_mbs
// (disk throughput, not size). G06 already documented this field as throughput;
// matching it would produce a false-positive ceiling measurement exactly where
// G06 was careful to separate throughput from size. disk_size and disk_gb cover
// the genuine size fields.
const DISK_SIZE_RE = /disk_volume|disk_size|storage_size|volume_size|disk_gb|storage_gb|volume_gb/i;

function scanForDiskSizes(obj: unknown, path = "", depth = 0, out: string[] = []): string[] {
  if (depth > 5 || obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k;
    if (DISK_SIZE_RE.test(k)) {
      const rendered = v != null && typeof v !== "object" ? String(v) : JSON.stringify(v);
      out.push(`${here}=${rendered}`.slice(0, 200));
    }
    if (v && typeof v === "object" && !Array.isArray(v)) scanForDiskSizes(v, here, depth + 1, out);
    if (Array.isArray(v)) {
      for (let i = 0; i < Math.min(v.length, 20); i++) scanForDiskSizes(v[i], `${here}[${i}]`, depth + 1, out);
    }
  }
  return out;
}

function measurementKey(path: string): string {
  return path.replace(/[{}/]/g, "_").replace(/^_+|_+$/g, "");
}

const mod: TestModule = {
  id: "G08",
  title: "Disk ceiling: probing the billing addon catalogue for disk-size variants",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) {
      return [{ id: "G08", title: mod.title, status: "skip", detail: "PVLAB_REF not set - no project to probe" }];
    }

    const measurements: Record<string, number | string> = {};
    const evidenceParts: string[] = [];
    let throttled = false;
    let controlsOk = true;

    // Phase 1: control endpoints.
    for (const tpl of CONTROLS) {
      const path = tpl.replace("{ref}", ctx.ref);
      const r = await mgmt(ctx, "GET", path);
      if (r.throttled) throttled = true;
      if (r.status !== 200) controlsOk = false;
      measurements[`control_${measurementKey(tpl)}_status`] = r.status;
    }

    // Phase 2: project-level candidates.
    const foundAny: { path: string; fields: string[] }[] = [];
    for (const tpl of CANDIDATES) {
      const path = tpl.replace("{ref}", ctx.ref);
      const r: MgmtResponse = await mgmt(ctx, "GET", path);
      if (r.throttled) throttled = true;
      const key = measurementKey(tpl);
      measurements[`candidate_${key}_status`] = r.status;

      if (r.status === 200 && r.json) {
        const fields = scanForDiskSizes(r.json);
        measurements[`candidate_${key}_disk_size_fields`] = fields.length ? fields.join("; ").slice(0, 500) : "none found";
        if (fields.length) foundAny.push({ path, fields });
        evidenceParts.push(`${path} (200):\n${JSON.stringify(r.json, null, 2).slice(0, 3000)}`);
      } else {
        evidenceParts.push(`${path} (${r.status}): ${r.text.slice(0, 300)}`);
      }
    }

    // Phase 3: org-level candidates, only if org slugs are available.
    const orgSlugs = ctx.orgSlugs ?? [];
    if (orgSlugs.length > 0) {
      measurements.org_slugs_available = orgSlugs.length;
      for (const slug of orgSlugs) {
        for (const tpl of ORG_CANDIDATES) {
          const path = tpl.replace("{slug}", slug);
          const r: MgmtResponse = await mgmt(ctx, "GET", path);
          if (r.throttled) throttled = true;
          const key = measurementKey(tpl.replace("{slug}", slug));
          measurements[`org_${key}_status`] = r.status;

          if (r.status === 200 && r.json) {
            const fields = scanForDiskSizes(r.json);
            measurements[`org_${key}_disk_size_fields`] = fields.length ? fields.join("; ").slice(0, 500) : "none found";
            if (fields.length) foundAny.push({ path, fields });
            evidenceParts.push(`${path} (200):\n${JSON.stringify(r.json, null, 2).slice(0, 3000)}`);
          } else {
            evidenceParts.push(`${path} (${r.status}): ${r.text.slice(0, 300)}`);
          }
        }
      }
    } else {
      measurements.org_slugs_available = 0;
    }

    if (throttled) {
      return [{
        id: "G08",
        title: mod.title,
        status: "skip",
        detail: "throttled (HTML interstitial) on at least one probe - re-run, the negative is not trustworthy",
        measurements,
      }];
    }

    if (!controlsOk) {
      return [{
        id: "G08",
        title: mod.title,
        status: "fail",
        detail: "control endpoints did not answer 200 in this run - the candidate results above mean nothing",
        measurements,
      }];
    }

    measurements.disk_size_surfaces = foundAny.length;
    measurements.endpoints_probed = CANDIDATES.length + (orgSlugs.length > 0 ? ORG_CANDIDATES.length * orgSlugs.length : 0);

    const ceilingSummary = foundAny.length
      ? `disk-size-shaped fields found at: ${foundAny.map((f) => `${f.path}: ${f.fields.join(", ")}`).join(" | ")}`
      : `no disk-size fields found across ${CANDIDATES.length} project endpoints` +
        (orgSlugs.length > 0 ? ` + ${ORG_CANDIDATES.length * orgSlugs.length} org endpoints` : "") +
        ", with controls answering 200 in the same run - a project's maximum disk size " +
        "appears not to be discoverable through the Management API today. " +
        "The ceiling question remains open.";

    return [{
      id: "G08",
      title: mod.title,
      status: "info",
      detail: ceilingSummary.slice(0, 800),
      measurements,
      evidence: evidenceParts.join("\n\n").slice(0, 10000),
    }];
  },
};

export default mod;