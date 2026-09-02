/**
 * F01 - the plan matrix, read from the API instead of a pricing page.
 *
 * `GET /v1/organizations/{slug}/entitlements` is the authoritative answer to
 * "what does this plan actually give me", and it is what the consolidation
 * guide's Pro-vs-Team table was read from. That table is currently a snapshot
 * with a date and no way to re-take it; this makes re-taking it one command.
 *
 * PAYLOAD SHAPE (2026-09-02): a FLAT LIST, not a nested object -
 *
 *   { entitlements: [ { feature: { key: "function.max_count", type: "numeric" },
 *                       type: "numeric", hasAccess: true,
 *                       config: { value: 1000, unlimited: false, enabled: true, unit: "functions" } },
 *                     { feature: { key: "auth.platform.sso", type: "boolean" },
 *                       type: "boolean", hasAccess: false, config: { enabled: false } },
 *                     { feature: { key: "instances.compute_update_available_sizes", type: "set" },
 *                       config: { set: ["ci_micro", ...] } }, ... ] }
 *
 * The first version of this module dug dotted paths into a nested object and
 * rendered every row "absent" once the payload flattened; the edge-function-
 * limits experiment found that on 2026-09-02. Rows are now looked up by
 * feature key, and a row that is genuinely missing from the list says so.
 * The plan label comes from `GET /v1/organizations/{slug}` (`plan`), which
 * the entitlements body does not carry.
 *
 * Org slugs are a PRECONDITION, not a resource: the supabase provider has no
 * organization resource, and plan upgrades are a billing action. Supply them
 * with PVLAB_ORG_SLUGS=slug-a,slug-b - ideally one per plan, since the
 * interesting rows are the ones that differ.
 *
 * Read-only by construction: GET only, no writes, so this runs without
 * --destructive and can go on a schedule.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

/**
 * The feature keys the docs make decisions on. Kept explicit rather than
 * dumping the whole list: a diff across runs is only readable if the column
 * set is stable, and the full body is long and reorders freely.
 */
const ROWS: { key: string; feature: string }[] = [
  { key: "project_scoped_roles", feature: "project_scoped_roles" },
  { key: "member_roles", feature: "security.member_roles" },
  { key: "audit_logs_days", feature: "security.audit_logs_days" },
  { key: "log_retention_days", feature: "log.retention_days" },
  { key: "backup_retention_days", feature: "backup.retention_days" },
  { key: "sso", feature: "auth.platform.sso" },
  { key: "audit_log_drains", feature: "audit_log_drains" },
  { key: "function_max_count", feature: "function.max_count" },
  { key: "function_size_limit_mb", feature: "function.size_limit_mb" },
  { key: "project_pausing", feature: "project_pausing" },
  { key: "api_members_roles", feature: "api.members.roles" },
];

interface Entitlement {
  feature?: { key?: string; type?: string };
  type?: string;
  hasAccess?: boolean;
  config?: {
    value?: number;
    unlimited?: boolean;
    enabled?: boolean;
    unit?: string;
    set?: string[];
  };
}

/** One entitlement row rendered as a stable scalar for the report column. */
export function render(e: Entitlement | undefined): string {
  if (!e) return "absent";
  const c = e.config ?? {};
  if (c.unlimited) return "unlimited";
  if (Array.isArray(c.set)) return c.set.join("|");
  if (typeof c.value === "number") return c.unit ? `${c.value} ${c.unit}` : String(c.value);
  if (typeof e.hasAccess === "boolean") return e.hasAccess ? "yes" : "no";
  if (typeof c.enabled === "boolean") return c.enabled ? "yes" : "no";
  return JSON.stringify(c);
}

export function byFeature(body: unknown): Map<string, Entitlement> {
  const list = ((body as { entitlements?: unknown } | undefined)?.entitlements ?? []) as Entitlement[];
  const m = new Map<string, Entitlement>();
  for (const e of Array.isArray(list) ? list : []) {
    if (e?.feature?.key) m.set(e.feature.key, e);
  }
  return m;
}

const mod: TestModule = {
  id: "F01",
  title: "Plan entitlements per organization",
  where: "local",
  requires: ["pat", "org"],
  async run(ctx: Ctx) {
    const results: TestResult[] = [];

    for (const slug of ctx.orgSlugs) {
      const org = await mgmt(ctx, "GET", `/organizations/${slug}`);
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

      const rows = byFeature(r.json);
      const measurements: Record<string, string | number> = { status: r.status, features_listed: rows.size };
      for (const row of ROWS) measurements[row.key] = render(rows.get(row.feature));

      // `plan` is the label that makes a diff across runs interpretable -
      // without it, two org slugs are two opaque columns.
      const plan = String((org.json as Record<string, unknown> | undefined)?.plan ?? "unknown");

      // Control: an empty list is a fetch that half-worked or a shape change,
      // and every "absent" below would then be an artifact of that. Fail it
      // rather than record eleven absences as facts.
      if (rows.size === 0) {
        results.push({
          id: `F01-${slug}`,
          title: `Entitlements: ${slug}`,
          status: "fail",
          detail: "entitlements list parsed empty - payload shape changed again, or the fetch half-worked",
          measurements: { plan, ...measurements },
          evidence: r.text.slice(0, 1200),
        });
        continue;
      }

      results.push({
        id: `F01-${slug}`,
        title: `Entitlements: ${slug}`,
        // "info": there is no correct answer to assert here. This records
        // what the plan grants; it does not pass or fail on it.
        status: "info",
        detail: `plan=${plan}, ${rows.size} features listed`,
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
