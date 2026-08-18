/**
 * M03 - the attribution estimator, run against the LIVE org (read-only).
 *
 * Not a theory: this module walks every project the PAT can see, reads the
 * selected compute SKU, current status, database size, storage bytes, and
 * the analytics request counters, and emits a per-project cost table using
 * the rate card read off a real invoice. Reconcile the table against the
 * invoice's per-ref lines at month end; the estimator's job is to see the
 * month before it closes.
 *
 *   M03-control  list projects; measure the enumeration.
 *   M03a         per-project compute: SKU from billing/addons, status, and
 *                the derived hourly/monthly cost.
 *   M03b         ground truth: pg_database_size + storage bytes per project.
 *   M03c         request volumes: usage.api-counts latest bucket per project.
 *
 * Read-only by design - no provisioning, no pausing, no writes. Rates are a
 * const map (invoice-observed; extend as sizes appear).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

// Rate card, USD/hour unless noted - read off a real Pro invoice's per-ref
// lines (2026-08). Extend as larger SKUs appear; unknown SKUs cost as NaN
// and are flagged, never silently zeroed.
const COMPUTE_RATE_PER_HOUR: Record<string, number> = {
  "none(micro)": 0.01344, // the invoice bills the absence of an addon as Micro
  ci_micro: 0.01344,
  ci_small: 0.0206,
};
const HOURS_PER_MONTH = 730;

interface ProjectRow {
  id?: string;
  ref?: string;
  name?: string;
  status?: string;
}
interface AddonsResponse {
  selected_addons?: Array<{ addon_type?: string; addon_variant?: string }>;
}
interface UsageBucket {
  total_auth_requests?: number;
  total_realtime_requests?: number;
  total_rest_requests?: number;
  total_storage_requests?: number;
}

interface ProjectCost {
  ref: string;
  name: string;
  status: string;
  sku: string;
  hourlyUsd: number | null; // null = SKU not in the rate card
  monthlyUsd: number | null;
}

const mod: TestModule = {
  id: "M03",
  title: "Attribution estimator against the live org (read-only)",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const costs: ProjectCost[] = [];
    const sizes: Record<string, number | string>[] = [];
    const usage: Record<string, number | string>[] = [];

    try {
      // ---- M03-control: enumerate ----
      const list = await mgmt(ctx, "GET", "/projects");
      const projects = (Array.isArray(list.json) ? list.json : []) as ProjectRow[];
      results.push({
        id: "M03-control",
        title: "M03-control: enumerate projects",
        status: list.status === 200 ? "pass" : "fail",
        measurements: { project_count: projects.length, list_status: list.status },
      });
      if (list.status !== 200) return results;

      // ---- M03a: compute SKU + cost per project ----
      for (const p of projects) {
        const ref = p.ref ?? p.id ?? "";
        if (!ref) continue;
        const addons = await mgmt(ctx, "GET", `/projects/${ref}/billing/addons`);
        const data = addons.json as AddonsResponse | undefined;
        const selected = Array.isArray(data?.selected_addons) ? data.selected_addons : [];
        const sku =
          selected.find((a) => a?.addon_type === "compute_instance")?.addon_variant ?? "none(micro)";
        const rate = COMPUTE_RATE_PER_HOUR[sku];
        costs.push({
          ref,
          name: p.name ?? "",
          status: p.status ?? "unknown",
          sku,
          hourlyUsd: rate === undefined ? null : rate,
          monthlyUsd: rate === undefined ? null : Math.round(rate * HOURS_PER_MONTH * 100) / 100,
        });
      }
      const unknownSkus = costs.filter((c) => c.hourlyUsd === null).map((c) => c.sku);
      const orgMonthly = costs.reduce((s, c) => s + (c.monthlyUsd ?? 0), 0);
      results.push({
        id: "M03a",
        title: "M03a: per-project compute cost",
        status: "info",
        detail: unknownSkus.length ? `SKUs missing from the rate card: ${unknownSkus.join(", ")}` : undefined,
        measurements: {
          projects_priced: costs.filter((c) => c.hourlyUsd !== null).length,
          org_monthly_compute_usd: Math.round(orgMonthly * 100) / 100,
        },
        // The per-project table is the point of the module - keep it in evidence.
        evidence: costs
          .map((c) => `${c.ref}  ${c.name}  ${c.status}  ${c.sku}  $${c.monthlyUsd ?? "?"}/mo`)
          .join("\n"),
      });

      // ---- M03b: ground truth sizes (bounded: first 5 projects) ----
      for (const c of costs.slice(0, 5)) {
        const q = await mgmt(ctx, "POST", `/projects/${c.ref}/database/query`, {
          query: "select pg_database_size(current_database()) as bytes",
        });
        const rows = Array.isArray(q.json) ? (q.json as Array<{ bytes?: number }>) : [];
        const bytes = rows[0]?.bytes;
        sizes.push({ ref: c.ref, db_bytes: typeof bytes === "number" ? bytes : "unread", query_status: q.status });
      }
      results.push({
        id: "M03b",
        title: "M03b: ground-truth DB sizes",
        status: "info",
        measurements: { projects_measured: sizes.filter((s) => typeof s.db_bytes === "number").length },
        evidence: sizes.map((s) => `${s.ref}  db=${s.db_bytes}`).join("\n"),
      });

      // ---- M03c: request counters (bounded: first 5 projects) ----
      for (const c of costs.slice(0, 5)) {
        const u = await mgmt(ctx, "GET", `/projects/${c.ref}/analytics/endpoints/usage.api-counts?interval=15min`);
        const buckets = (u.json as { result?: UsageBucket[] } | undefined)?.result ?? [];
        const latest = buckets[buckets.length - 1];
        usage.push({
          ref: c.ref,
          status: u.status,
          rest: latest?.total_rest_requests ?? 0,
          auth: latest?.total_auth_requests ?? 0,
          realtime: latest?.total_realtime_requests ?? 0,
          storage: latest?.total_storage_requests ?? 0,
        });
      }
      results.push({
        id: "M03c",
        title: "M03c: request counters per project",
        status: "info",
        measurements: { projects_read: usage.filter((u) => u.status === 200).length },
        evidence: usage
          .map((u) => `${u.ref}  rest=${u.rest} auth=${u.auth} realtime=${u.realtime} storage=${u.storage}`)
          .join("\n"),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["M03-control", "M03a", "M03b", "M03c"] as const) {
        if (!results.some((r) => r.id === id)) results.push({ id, title: id, status: "fail", detail: `threw: ${msg}` });
      }
    }
    return results;
  },
};
export default mod;
