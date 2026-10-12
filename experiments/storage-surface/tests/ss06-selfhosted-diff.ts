/**
 * SS06 - managed vs self-hosted Storage, row by row, from SS03 run artifacts.
 *
 * Offline: reads the SS03 artifacts named in PVLAB_ENDPOINT_SS06_RUNS
 * (space-separated paths; `make ss06 RUNS=a.json,b.json,...`), one per
 * target (managed, sh-file, sh-s3, and the self-hosted stack with the
 * storage image at the managed version). Each artifact names its own target
 * in SS03_target.kind and its server version in SS03_target.storage_version,
 * so the columns label themselves; nothing here knows which run is which.
 *
 *   SS06-targets   the column order: kind and storage version per artifact
 *   SS06-<row>     per SS03/SS04/SS05 row: every measurement key, either
 *                  `same: <value>` on all targets or `<kind>: <value>` per
 *                  target joined with " | "; plus counts of same / differing
 *                  keys. Keys absent on a target show as `(absent)`.
 *
 * Values are compared as recorded strings, so timings (`ms=`, SS03j) always
 * differ; they are listed, not graded. Not settled by this module: whether
 * a difference is the backend, the version or the gateway - the
 * version-matched self-hosted target exists to separate the first two.
 */
import { readFileSync } from "node:fs";
import type { Ctx, RunArtifact, TestModule, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "SS06",
  title: "managed vs self-hosted Storage, row by row (diff of SS03 artifacts)",
  where: "local",
  requires: [],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const paths = (ctx.endpoints["ss06_runs"] ?? "").split(/\s+/).filter(Boolean);
    if (paths.length < 2) return [{ id: "SS06", title: this.title, status: "skip", detail: "PVLAB_ENDPOINT_SS06_RUNS needs two or more SS03 artifacts (make ss06 RUNS=...)" }];
    const runs = paths.map((p) => JSON.parse(readFileSync(p, "utf8")) as RunArtifact);
    const label = (r: RunArtifact) => String(r.results.find((x) => x.id === "SS03_target")?.measurements?.kind ?? "?");
    const labels = runs.map(label);
    const out: TestResult[] = [];
    const tm: Record<string, string> = {};
    runs.forEach((r, i) => {
      const t = r.results.find((x) => x.id === "SS03_target")?.measurements ?? {};
      tm[`column_${i + 1}`] = `${labels[i]} (storage ${String(t.storage_version ?? "?")}, run ${r.startedAt})`;
    });
    out.push({ id: "SS06-targets", title: "SS06: targets in column order", status: "info", measurements: tm });
    const rowIds = [...new Set(runs.flatMap((r) => r.results.map((x) => x.id)))].filter((id) => /^SS0[345]/.test(id) && id !== "SS03_target");
    for (const id of rowIds) {
      const per = runs.map((r) => r.results.find((x) => x.id === id));
      const keys = [...new Set(per.flatMap((x) => Object.keys(x?.measurements ?? {})))];
      const m: Record<string, string | number> = {};
      let same = 0;
      let differ = 0;
      for (const k of keys) {
        const vals = per.map((x) => (x?.measurements && k in x.measurements ? String(x.measurements[k]) : "(absent)"));
        if (vals.every((v) => v === vals[0])) {
          same++;
          m[k] = `same: ${vals[0]}`;
        } else {
          differ++;
          m[k] = vals.map((v, i) => `${labels[i]}: ${v}`).join(" | ");
        }
      }
      out.push({
        id: `SS06-${id}`,
        title: `SS06: ${id} across ${labels.join(", ")}`,
        status: "info",
        detail: `${same} keys the same on every target, ${differ} differ; statuses ${per.map((x, i) => `${labels[i]}=${x?.status ?? "absent"}`).join(", ")}`,
        measurements: { keys_same: same, keys_differ: differ, ...m },
      });
    }
    return out;
  },
};
export default mod;
