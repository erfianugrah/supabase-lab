/**
 * F01 - the plan matrix, read from the API instead of a pricing page.
 *
 * `GET /v1/organizations/{slug}/entitlements` is the authoritative answer to
 * "what does this plan actually give me", and it is what the consolidation
 * guide's Pro-vs-Team table was read from. That table is currently a snapshot
 * with a date and no way to re-take it; this makes re-taking it one command.
 *
 * Org slugs are a PRECONDITION, not a resource: the supabase provider has no
 * organization resource, and plan upgrades are a billing action. Supply them
 * with PVLAB_ORG_SLUGS=slug-a,slug-b - ideally one Pro and one Team, since
 * the interesting rows are the ones that differ.
 *
 * Read-only by construction: GET only, no writes, so this runs without
 * --destructive and can go on a schedule.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

/**
 * The rows the docs make decisions on. Kept explicit rather than dumping the
 * whole payload: a diff across runs is only readable if the shape is stable,
 * and the full entitlements body is long and reorders freely.
 */
const ROWS: { key: string; path: string[] }[] = [
  { key: "project_scoped_roles", path: ["project_scoped_roles"] },
  { key: "member_roles", path: ["security", "member_roles"] },
  { key: "audit_logs_days", path: ["security", "audit_logs_days"] },
  { key: "log_retention_days", path: ["log", "retention_days"] },
  { key: "backup_retention_days", path: ["backup", "retention_days"] },
  { key: "sso", path: ["auth", "platform", "sso"] },
  { key: "audit_log_drains", path: ["audit_log_drains"] },
  { key: "function_max_count", path: ["function", "max_count"] },
  { key: "project_pausing", path: ["project_pausing"] },
  { key: "api_members_roles", path: ["api", "members", "roles"] },
];

function dig(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function render(v: unknown): string {
  if (v === undefined) return "absent";
  if (Array.isArray(v)) return v.join("|");
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const mod: TestModule = {
  id: "F01",
  title: "Plan entitlements per organization",
  where: "local",
  requires: ["pat", "org"],
  async run(ctx: Ctx) {
    const results: TestResult[] = [];

    for (const slug of ctx.orgSlugs) {
      const r = await mgmt(ctx, "GET", `/organizations/${slug}/entitlements`);
      if (r.status !== 200 || !r.json) {
        results.push({
          id: `F01-${slug}`,
          title: `Entitlements: ${slug}`,
          status: "fail",
          detail: `HTTP ${r.status}`,
          measurements: { status: r.status },
          evidence: r.text.slice(0, 400),
        });
        continue;
      }

      const measurements: Record<string, string | number> = { status: r.status };
      for (const row of ROWS) measurements[row.key] = render(dig(r.json, row.path));

      // `plan` is the label that makes a diff across runs interpretable -
      // without it, two org slugs are two opaque columns.
      const plan = render(dig(r.json, ["plan", "id"]) ?? dig(r.json, ["plan"]));

      results.push({
        id: `F01-${slug}`,
        title: `Entitlements: ${slug}`,
        // "info": there is no correct answer to assert here. This records
        // what the plan grants; it does not pass or fail on it.
        status: "info",
        detail: `plan=${plan}`,
        measurements: { plan, ...measurements },
        // Full body kept: the ROWS list is what we read TODAY, and a new
        // entitlement appears in the body long before anyone adds a row here.
        evidence: JSON.stringify(r.json, null, 2).slice(0, 8000),
      });
    }

    if (!results.length) {
      results.push({
        id: "F01",
        title: this.title,
        status: "skip",
        detail: "PVLAB_ORG_SLUGS empty - supply at least one slug",
      });
    }
    return results;
  },
};
export default mod;
