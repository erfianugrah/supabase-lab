/**
 * SS07 - region catalogue and key-management API surface (read only, no project).
 *
 * Side: the Management API, read with the operator's PAT, for the Pro-plan
 * org (`ctx.orgs.pro`). Nothing is created.
 *
 *   SS07a  GET /v1/projects/available-regions?organization_slug=<pro org>:
 *          the `specific` region codes and the smart groups, compared with
 *          the 17 specific codes residency-facts read on 2026-08-20 (that run
 *          did not record the codes, so only the count is comparable)
 *   SS07b  the published OpenAPI document (https://api.supabase.com/api/v1-json)
 *          enumerated whole (F05's method): every operation whose path,
 *          operationId, summary or description mentions encryption, KMS,
 *          customer-managed or BYO keys; and, for context, every operation
 *          with "key" in its path, so a reader can see what "key" means there
 *
 * An empty SS07b is "no published API surface", not "the platform has no
 * such option": entitlements, dashboard-only settings and contract terms are
 * outside what an OpenAPI document shows.
 *
 * Not settled by this module: which regions a given org may actually create
 * in beyond the catalogue's answer; any non-API (support or contract) route
 * to customer-managed keys.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmtRetry } from "../lib";

const SPEC_URL = "https://api.supabase.com/api/v1-json";
const KMS_RE = /encrypt|\bkms\b|customer[- ]managed|bring[- ]your[- ]own[- ]key|\bbyok\b|\bcmk\b|key[- ]management/i;

const mod: TestModule = {
  id: "SS07",
  title: "region catalogue and key-management API surface (read only)",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = ctx.orgs.pro ?? "";
    if (!org) out.push({ id: "SS07a", title: "SS07a: available regions for the Pro org", status: "skip", detail: "PVLAB_ORG_PRO not set" });
    else {
      const r = await mgmtRetry(ctx, "GET", `/projects/available-regions?organization_slug=${encodeURIComponent(org)}`);
      const j = (r.json ?? {}) as { recommendations?: unknown; all?: { smartGroup?: Array<{ code?: string; name?: string }>; specific?: Array<{ code?: string; name?: string; provider?: string; status?: string }> } };
      const spec = j.all?.specific ?? [];
      const groups = j.all?.smartGroup ?? [];
      const providers = [...new Set(spec.map((x) => x.provider ?? "-"))].join(",");
      const statuses = [...new Set(spec.map((x) => x.status ?? "-"))].join(",");
      out.push({
        id: "SS07a",
        title: "SS07a: available regions for the Pro org",
        status: r.status === 200 ? "info" : "fail",
        detail: `HTTP ${r.status}; ${spec.length} specific regions (17 on 2026-08-20), ${groups.length} smart groups`,
        measurements: {
          http: r.status,
          specific_count: spec.length,
          specific_count_2026_08_20: 17,
          specific_codes: spec.map((x) => x.code ?? "?").sort().join(","),
          smart_group_codes: groups.map((x) => x.code ?? "?").sort().join(","),
          providers,
          statuses,
          recommendations_present: String(j.recommendations !== undefined),
        },
      });
    }
    const res = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
    const doc = (await res.json().catch(() => ({}))) as { info?: { version?: string }; paths?: Record<string, Record<string, { operationId?: string; summary?: string; description?: string; tags?: string[]; deprecated?: boolean }>> };
    const ops: Array<{ m: string; p: string; id: string; text: string; dep: boolean }> = [];
    for (const [p, item] of Object.entries(doc.paths ?? {}))
      for (const [m, op] of Object.entries(item ?? {})) {
        if (!/^(get|post|put|patch|delete)$/.test(m)) continue;
        ops.push({ m: m.toUpperCase(), p, id: op.operationId ?? "", text: `${p} ${op.operationId ?? ""} ${op.summary ?? ""} ${op.description ?? ""} ${(op.tags ?? []).join(" ")}`, dep: Boolean(op.deprecated) });
      }
    const kms = ops.filter((o) => KMS_RE.test(o.text));
    const keyPaths = ops.filter((o) => /key/i.test(o.p));
    out.push({
      id: "SS07b",
      title: "SS07b: key-management operations in the published OpenAPI document",
      status: res.status === 200 ? "info" : "fail",
      detail: `${ops.length} operations; ${kms.length} mention encryption / KMS / customer-managed keys; ${keyPaths.length} have "key" in the path`,
      measurements: {
        spec_http: res.status,
        spec_version: String(doc.info?.version ?? "-"),
        operations_total: ops.length,
        encryption_or_kms_operations: kms.length,
        encryption_or_kms_list: kms.map((o) => `${o.m} ${o.p}`).join("; ") || "none",
        key_path_operations: keyPaths.length,
        key_path_list: keyPaths.map((o) => `${o.m} ${o.p}${o.dep ? " (deprecated)" : ""}`).join("; "),
      },
    });
    return out;
  },
};
export default mod;
