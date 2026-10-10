/**
 * PL01 - what a Management API token can reach of Pipelines.
 *
 * Pipelines (public alpha, renamed from Database Replication on 2026-09-21) is
 * configured in the Dashboard. The question for anything that has to create or
 * operate a pipeline from code is whether a personal access token reaches it.
 * Three probes, read-only:
 *
 *   PL01a  the public Management API description (api.supabase.com/api/v1-json)
 *          names no pipelines, replication-destination or ETL route. The
 *          read-replica routes match "replica" and are excluded.
 *   PL01b  the Dashboard's own route family (`/platform/replication/{ref}/...`,
 *          from the open-source Studio data layer) with the same token. A
 *          real project ref is used when a PL fixture exists, else a
 *          syntactically valid unused one; the answer is recorded for both
 *          because a 404 for a missing project and a 401 for an unaccepted
 *          token are different findings. Control: the same token on a
 *          `/v1` route answers 200.
 *   PL01c  the destination and pipeline schemas Studio sends (create body)
 *          are read from the public Studio source, not measured: recorded as
 *          a documentation line in the RUNLOG, not here.
 *
 * Info-only: a 401 is the measurement, not a failure.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { controlOrigin, lbl, rawGet } from "../lib/util.js";
import { RUN_DIR } from "../lib/stack.js";

const mod: TestModule = {
  id: "PL01",
  title: "PL01 - Pipelines API surface for a PAT",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const origin = controlOrigin(ctx);

    // PL01a: public API description
    const spec = await rawGet(ctx, `${origin}/api/v1-json`);
    const paths = Object.keys(((spec.json as { paths?: Record<string, unknown> } | undefined)?.paths) ?? {});
    const hits = paths.filter((p) => /pipeline|replication|etl|destination|ducklake|warehouse/i.test(p) && !/read-replica/i.test(p));
    results.push({
      id: "PL01a",
      title: "PL01a: public Management API description names no Pipelines route",
      status: spec.status === 200 && paths.length > 0 ? "info" : "fail",
      detail: `${paths.length} paths; ${hits.length} match pipeline|replication|etl|destination|ducklake|warehouse (read-replica routes excluded)`,
      measurements: {
        spec_http: spec.status,
        spec_path_count: paths.length,
        pipeline_like_paths: hits.length,
        matched: lbl(hits.join(" ") || "none"),
      },
    });

    // PL01b: Dashboard route family with the PAT
    let realRef = "";
    if (existsSync(`${RUN_DIR}/fixture.json`)) {
      realRef = (JSON.parse(await readFile(`${RUN_DIR}/fixture.json`, "utf8")) as { ref?: string }).ref ?? "";
    }
    const fake = "a".repeat(20);
    const m: Record<string, number | string> = {};
    for (const [label, ref] of [["unused_ref", fake], ["own_project", realRef]] as const) {
      if (!ref) continue;
      for (const route of ["sources", "destinations", "pipelines"]) {
        const r = await rawGet(ctx, `${origin}/platform/replication/${ref}/${route}`);
        m[`${label}_${route}_http`] = r.status;
        m[`${label}_${route}_body`] = lbl(r.text, 100);
      }
    }
    const control = await mgmt(ctx, "GET", "/projects");
    m.control_v1_projects_http = control.status;
    const accepted = Object.entries(m).some(([k, v]) => k.endsWith("_http") && k !== "control_v1_projects_http" && v === 200);
    results.push({
      id: "PL01b",
      title: "PL01b: PAT on the Dashboard's replication routes",
      status: "info",
      detail: accepted
        ? "a PAT reached at least one /platform/replication route (see measurements)"
        : "no /platform/replication route accepted the PAT while the same PAT answered /v1",
      measurements: m,
    });
    return results;
  },
};

export default mod;
