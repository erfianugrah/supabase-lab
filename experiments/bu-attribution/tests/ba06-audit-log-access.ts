/**
 * BA06 - can a PAT read the organization audit log? (read-only)
 *
 * The audit log is the manual backstop for a ref the sweep cannot
 * attribute: per the Platform Audit Logs guide each entry carries the actor
 * and token type, and the open-source dashboard (apps/studio,
 * organization-audit-logs-query.ts) reads it from
 * `GET /platform/organizations/{slug}/audit` with a response type
 * (`AuditLogsResponse_Output`) that declares token_type, token_hash,
 * token_alias and oauth_app_id/name per actor. The guide lists no export and
 * no log drain, and `/v1` has no audit path. This module measures the one
 * remaining question for automation: does a PAT reach the dashboard's route.
 *
 *   BA06-control  GET /v1/organizations/{slug} with the PAT (token valid).
 *   BA06a         GET /platform/organizations/{slug}/audit with the same PAT
 *                 over the last hour; status and error message verbatim.
 *
 * Only statuses and the error message are recorded - never entries.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt, mgmtBase } from "../../../harness/src/mgmt.js";

const mod: TestModule = {
  id: "BA06",
  title: "Audit log reachable with a PAT? (read-only)",
  where: "local",
  requires: ["pat", "org"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgSlugs[0] ?? "";
    const control = await mgmt(ctx, "GET", `/organizations/${org}`);
    const results: TestResult[] = [
      {
        id: "BA06-control",
        title: "BA06-control: PAT valid on /v1",
        status: control.status === 200 ? "pass" : "fail",
        measurements: { v1_status: control.status },
      },
    ];
    if (control.status !== 200) return results;

    const end = new Date();
    const start = new Date(end.getTime() - 3600_000);
    const base = mgmtBase(ctx).replace(/\/v1\/?$/, "");
    const url =
      `${base}/platform/organizations/${org}/audit` +
      `?iso_timestamp_start=${encodeURIComponent(start.toISOString())}` +
      `&iso_timestamp_end=${encodeURIComponent(end.toISOString())}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ctx.pat}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let message = "";
    try {
      message = String((JSON.parse(text) as { message?: string }).message ?? "");
    } catch {
      message = text.slice(0, 120);
    }
    results.push({
      id: "BA06a",
      title: "BA06a: PAT on the dashboard audit route",
      status: "info",
      detail: res.status === 200 ? "READABLE with a PAT" : `refused: ${message}`,
      measurements: { audit_status: res.status },
      // Status and message only; a 200 body would carry emails and IPs.
      evidence: res.status === 200 ? "body not recorded" : message,
    });
    return results;
  },
};
export default mod;
