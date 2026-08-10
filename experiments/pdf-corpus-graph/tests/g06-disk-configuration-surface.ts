/**
 * G06 - disk ceiling and disk configuration: is it discoverable at all?
 *
 * Whether a single project can hold a corpus of this order (terabytes) is
 * currently unanswered, and the first question underneath that is whether
 * disk size, type (gp3 vs io2), provisioned IOPS/throughput, or a documented
 * maximum are even VISIBLE through the Management API.
 *
 * PROBE SEVERAL SHAPES, NOT ONE. This repo has been wrong exactly this way
 * before: platform-facts F05 concluded an API "could not do X" after probing
 * only paths whose name contained X, when the real lever sat on a
 * differently-named path. So this probes several plausible endpoint shapes
 * for disk configuration AND scans every response body generically for
 * disk/iops/throughput/volume-shaped fields, rather than committing to one
 * guessed shape and reading its absence as the answer.
 *
 * A CONTROL IS MANDATORY, same reasoning as F04: a wall of 404s also
 * describes a dead token or an outage, not just "no such endpoint". The
 * control paths must answer 200 in the SAME run for the candidate results to
 * mean anything.
 *
 * Read-only throughout - GET requests only. No resize is attempted here or
 * anywhere in this test file.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt, type MgmtResponse } from "../../../harness/src/mgmt";

const CONTROLS = ["/projects", "/projects/{ref}"];

/** Endpoint shapes that COULD plausibly carry disk configuration. Absence of
 * any one of these is not a finding on its own - only the aggregate, read
 * against the controls above, is. */
const CANDIDATES = [
  "/projects/{ref}/billing/addons",
  "/projects/{ref}/config/database",
  "/projects/{ref}/database",
  "/projects/{ref}/database/disk",
  "/projects/{ref}/disk",
];

const DISK_FIELD_RE = /disk|iops|throughput|volume|storage_size|gp3|io2/i;

/** Recursively walk a parsed JSON body up to a bounded depth and collect any
 * key that LOOKS disk-shaped, so a field this test did not think to name in
 * advance still surfaces instead of silently reading as absent. */
function scanForDiskFields(obj: unknown, path = "", depth = 0, out: string[] = []): string[] {
  if (depth > 4 || obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k;
    if (DISK_FIELD_RE.test(k)) {
      const rendered = v != null && typeof v !== "object" ? String(v) : JSON.stringify(v);
      out.push(`${here}=${rendered}`.slice(0, 120));
    }
    if (v && typeof v === "object" && !Array.isArray(v)) scanForDiskFields(v, here, depth + 1, out);
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 5)) scanForDiskFields(item, `${here}[]`, depth + 1, out);
    }
  }
  return out;
}

function measurementKey(path: string): string {
  return path.replace(/[{}/]/g, "_").replace(/^_+|_+$/g, "");
}

const mod: TestModule = {
  id: "G06",
  title: "Disk configuration surface: probing several endpoint shapes, not guessing one",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) {
      return [{ id: "G06", title: mod.title, status: "skip", detail: "PVLAB_REF not set - no project to probe" }];
    }

    const measurements: Record<string, number | string> = {};
    const evidenceParts: string[] = [];
    let throttled = false;
    let controlsOk = true;

    for (const tpl of CONTROLS) {
      const path = tpl.replace("{ref}", ctx.ref);
      const r = await mgmt(ctx, "GET", path);
      if (r.throttled) throttled = true;
      if (r.status !== 200) controlsOk = false;
      measurements[`control_${measurementKey(tpl)}_status`] = r.status;
    }

    const foundAny: string[] = [];
    for (const tpl of CANDIDATES) {
      const path = tpl.replace("{ref}", ctx.ref);
      const r: MgmtResponse = await mgmt(ctx, "GET", path);
      if (r.throttled) throttled = true;
      const key = measurementKey(tpl);
      measurements[`candidate_${key}_status`] = r.status;

      if (r.status === 200 && r.json) {
        const fields = scanForDiskFields(r.json);
        measurements[`candidate_${key}_disk_fields`] = fields.length ? fields.join("; ").slice(0, 400) : "none found";
        if (fields.length) foundAny.push(`${path}: ${fields.join(", ")}`);
        evidenceParts.push(`${path} (200):\n${JSON.stringify(r.json, null, 2).slice(0, 2000)}`);
      } else {
        evidenceParts.push(`${path} (${r.status}): ${r.text.slice(0, 200)}`);
      }
    }

    if (throttled) {
      return [
        {
          id: "G06",
          title: mod.title,
          status: "skip",
          detail: "throttled (HTML interstitial) on at least one probe - re-run, the negative is not trustworthy",
          measurements,
        },
      ];
    }

    if (!controlsOk) {
      return [
        {
          id: "G06",
          title: mod.title,
          status: "fail",
          detail: "control endpoints did not answer 200 in this run - the candidate results above mean nothing",
          measurements,
        },
      ];
    }

    measurements.disk_fields_found = foundAny.length;

    return [
      {
        id: "G06",
        title: mod.title,
        status: "info",
        detail: foundAny.length
          ? `disk-shaped fields found via: ${foundAny.map((f) => f.split(":")[0]).join(", ")}`
          : `no disk-shaped fields found across ${CANDIDATES.length} candidate endpoint(s), ` +
            `with controls answering 200 in the same run - disk configuration appears not to be ` +
            "exposed via the Management API today",
        measurements,
        evidence: evidenceParts.join("\n\n").slice(0, 8000),
      },
    ];
  },
};

export default mod;
