/**
 * R07 - is log-drain configuration reachable from the published API?
 *
 * Context: the residency doc's unknowns table asks whether log drains (the
 * only customer-facing lever on log residency) can be automated; the public
 * log-drains page documents only dashboard configuration, and states that
 * custom-endpoint requests are unsigned. Delivery itself is dashboard-gated,
 * so this module asks the narrower, decidable question: does the published
 * Management API contract carry ANY log-drain operation?
 *
 * METHOD is F05's, for F05's reason: concluding absence after probing only
 * paths named after the thing is how you get confidently wrong answers. So
 * this enumerates EVERY operation in the published OpenAPI document and then
 * filters. The parse count doubles as the control - a document that
 * half-arrived would make the absence an artifact.
 *
 * Read-only and unauthenticated (the spec is public).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const SPEC_URL = "https://api.supabase.com/api/v1-json";
const VERBS = ["get", "post", "put", "patch", "delete"] as const;

const mod: TestModule = {
  id: "R07",
  title: "Log-drain surface in the published API",
  where: "local",
  requires: [], // spec is unauthenticated; no PAT needed
  async run(_ctx: Ctx): Promise<TestResult> {
    let spec: Record<string, unknown>;
    try {
      const res = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        return {
          id: "R07a",
          title: this.title,
          status: "fail",
          detail: `spec fetch: HTTP ${res.status}`,
          measurements: { spec_status: res.status },
        };
      }
      spec = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      return {
        id: "R07a",
        title: this.title,
        status: "fail",
        detail: `spec fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
    const ops: string[] = [];
    for (const [path, item] of Object.entries(paths)) {
      for (const verb of VERBS) {
        if (item[verb]) ops.push(`${verb.toUpperCase()} ${path}`);
      }
    }

    // Broad filter on purpose: drain-shaped, log-shaped, and telemetry-shaped
    // paths all count. Narrowing to "drain" alone is the name-guessing
    // failure this method exists to avoid.
    const hits = ops.filter((op) => /drain|log.?drain|telemetry|otel|otlp|logflare|analytics/i.test(op));

    const measurements: Record<string, string | number> = {
      spec_status: 200,
      operation_count: ops.length,
      drain_like_operations: hits.length,
    };

    // Control: a spec that parsed to a handful of operations did not arrive.
    if (ops.length < 100) {
      return {
        id: "R07a",
        title: this.title,
        status: "fail",
        detail: `only ${ops.length} operations parsed - the spec did not arrive whole, the absence below is an artifact`,
        measurements,
      };
    }

    return {
      id: "R07a",
      title: this.title,
      status: "info",
      detail:
        hits.length === 0
          ? `no log-drain operation across all ${ops.length} published operations - drains are dashboard-only as far as the stable contract is concerned`
          : `drain-like operations present: ${hits.join("; ")}`,
      measurements,
      evidence: hits.join("\n").slice(0, 500),
    };
  },
};
export default mod;
