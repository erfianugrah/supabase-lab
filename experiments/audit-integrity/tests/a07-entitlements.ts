/**
 * A07 - how long each store keeps the evidence, and whether it can leave the
 * platform. Both are entitlements, so they answer per PLAN rather than per
 * project - which is why a compliance answer about audit trails on Supabase
 * has to name a plan.
 *
 * PAT only, read-only. Runs against every org role supplied
 * (PVLAB_ORG_PRO/TEAM/FREE); a role that is absent is simply not in the table.
 *
 *   A07a  GET organizations/{slug}/entitlements for each role: audit log
 *         retention days, log retention days, backup retention, audit log
 *         drains, log drains, PITR variants
 *   A07b  the Management API's own audit surface: how many /v1 paths mention
 *         audit at all
 *
 * Not settled by this module: whether an Enterprise audit log drain actually
 * delivers (no lever on /v1; Dashboard-only), and Dashboard-side retention
 * copy, which is prose rather than an entitlement.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const WANT = ["security.audit_logs_days", "log.retention_days", "backup.retention_days", "audit_log_drains", "log_drains", "pitr.available_variants", "security.private_link", "security.soc2_report"];
const SPEC_URL = "https://api.supabase.com/api/v1-json";

/**
 * The shape the endpoint actually returns - discovered by reading one response
 * rather than assuming. The first run of this module reported every feature as
 * "present" because it looked for a top-level `value`, which does not exist:
 * the number lives in `config.value`, the boolean in `hasAccess`, and a tier
 * list in `config.set`.
 */
interface Ent {
  feature?: { key?: string; type?: string };
  hasAccess?: boolean;
  type?: string;
  config?: { enabled?: boolean; value?: number; unlimited?: boolean; unit?: string; set?: string[] };
}

const mod: TestModule = {
  id: "A07",
  title: "retention and export of each audit store, by plan (entitlements)",
  where: "local",
  requires: ["pat", "org"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const roles = Object.keys(ctx.orgs);
    const lines: string[] = [];
    const measurements: Record<string, number | string> = { orgs_probed: roles.length };

    for (const role of roles) {
      const slug = ctx.orgs[role];
      const r = await mgmt(ctx, "GET", `/organizations/${slug}/entitlements`);
      const ents = ((r.json as { entitlements?: Ent[] })?.entitlements ?? []) as Ent[];
      const org = await mgmt(ctx, "GET", `/organizations/${slug}`);
      const plan = String((org.json as { plan?: string })?.plan ?? "?");
      const pick = (k: string) => {
        const e = ents.find((x) => x.feature?.key === k);
        if (!e) return "absent";
        if (e.type === "numeric") return `${e.hasAccess ? "" : "no-access:"}${e.config?.unlimited ? "unlimited" : String(e.config?.value ?? "?")}${e.config?.unit ? ` ${e.config.unit}` : ""}`;
        if (e.type === "set") return (e.config?.set ?? []).join("|") || "none";
        return String(e.hasAccess ?? e.config?.enabled ?? "?");
      };
      lines.push(`${role} (plan=${plan}, HTTP ${r.status}, ${ents.length} entitlements): ${WANT.map((k) => `${k}=${pick(k)}`).join("; ")}`);
      measurements[`${role}_plan`] = plan;
      measurements[`${role}_audit_log_days`] = pick("security.audit_logs_days");
      measurements[`${role}_log_retention_days`] = pick("log.retention_days");
      measurements[`${role}_backup_retention_days`] = pick("backup.retention_days");
      measurements[`${role}_audit_log_drains`] = pick("audit_log_drains");
      measurements[`${role}_log_drains`] = pick("log_drains");
    }

    out.push({
      id: "A07a",
      title: "audit and log retention per plan, from the entitlement API",
      status: roles.length ? "pass" : "skip",
      detail: lines.join(" || ") || "no org roles supplied",
      measurements,
      evidence: lines.join("\n"),
    });

    const spec = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
    const doc = (await spec.json()) as { paths?: Record<string, unknown> };
    const paths = Object.keys(doc.paths ?? {});
    const auditPaths = paths.filter((p) => /audit/i.test(p));
    out.push({
      id: "A07b",
      title: "the platform audit log on the Management API",
      status: "info",
      detail: `${paths.length} paths in the /v1 spec; ${auditPaths.length} mention audit${auditPaths.length ? `: ${auditPaths.join(", ")}` : " - the platform audit log has no read path, no export path and no delete path on the public API. It is Dashboard-only, which is why no tenant credential can rewrite it and also why nobody can pull it into a SIEM"}.`,
      measurements: { spec_paths: paths.length, audit_paths: auditPaths.length },
    });

    return out;
  },
};
export default mod;
