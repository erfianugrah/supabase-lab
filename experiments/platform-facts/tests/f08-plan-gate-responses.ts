/**
 * F08 - what a refusal looks like on the wire, per plan, for routes the
 * published spec marks as plan-limited or that answered differently across
 * orgs in earlier runs.
 *
 * Records status, `error.code`, `error.feature`, the message, and the key sets
 * of the body and of `error`, so a write-up can say exactly which keys came
 * back instead of reading them off the OpenAPI text. Rows record what was
 * observed; why a route answered as it did is not measured here.
 *
 * Rows:
 *   F08a  GET  /v2/projects/{ref}/analytics/log-drains        (Pro, Team)
 *   F08b  DELETE /v2/organizations/{slug}/members/invitations  (Pro, Free, Team)
 *         - spec `x-allowed-plans`: Team, Enterprise
 *   F08c  GET  /v1/projects/{ref}/database/backups/schedule    (Pro, Team)
 *         - spec `x-allowed-plans`: Enterprise
 *   F08d  GET  /v1/projects/{ref}/database/backups/restore-point (Pro)
 *   F08e  GET  /v1/projects/{ref}/vanity-subdomain             (Pro)
 *         - spec `x-allowed-plans`: Pro, Team, Enterprise
 *   F08f  GET  /v2/projects/{ref}/notebooks                     (Pro)
 *   F08g  GET  /v2/organizations/{slug}/maintenance/windows     (Pro)
 *
 * Writes: none take effect. F08b sends DELETE with `type` "invitation", which
 * is outside the v2 schema's enum (`organization_invitation`), so a request
 * that gets past any plan check stops at schema validation and no invitation
 * is touched. Everything else is GET. No --destructive needed.
 *
 * Needs PVLAB_ORG_PRO, PVLAB_ORG_TEAM and PVLAB_ORG_FREE. Project-scoped rows
 * use the first project listed in the Pro and Team orgs and are recorded as
 * skipped when an org lists none. No ref, slug or org name is measured.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt, mgmtBase } from "../../../harness/src/mgmt";

interface Wire {
  status: number;
  code: string;
  feature: string;
  message: string;
  topKeys: string;
  errorKeys: string;
  errorMeta: string;
}

export function readWire(status: number, json: unknown, text: string): Wire {
  const j = (json && typeof json === "object" && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const e = (j.error && typeof j.error === "object" ? j.error : {}) as Record<string, unknown>;
  return {
    status,
    code: String(e.code ?? "-"),
    feature: String(e.feature ?? "-"),
    message: String(e.description ?? j.message ?? e.message ?? text).slice(0, 160),
    topKeys: Object.keys(j).sort().join(",") || "-",
    errorKeys: Object.keys(e).sort().join(",") || "-",
    errorMeta: e.meta === undefined ? "-" : JSON.stringify(e.meta).slice(0, 160),
  };
}

async function v2(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Wire> {
  const base = mgmtBase(ctx).replace(/\/v1$/, "/v2");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ctx.pat}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return readWire(res.status, json, text);
}

async function v1(ctx: Ctx, method: string, path: string): Promise<Wire> {
  const r = await mgmt(ctx, method, path);
  return readWire(r.status, r.json, r.text);
}

async function firstRef(ctx: Ctx, slug: string): Promise<string | undefined> {
  const r = await mgmt(ctx, "GET", `/organizations/${slug}/projects?limit=1`);
  const j = r.json as { projects?: { ref?: string }[] } | { ref?: string }[] | undefined;
  const list = Array.isArray(j) ? j : j?.projects ?? [];
  return list[0]?.ref;
}

const BAD_INVITE = { data: [{ type: "invitation", attributes: { email: "probe-nobody@lab.invalid" } }] };

const mod: TestModule = {
  id: "F08",
  title: "Refusal responses per plan",
  where: "local",
  requires: ["pat", "org"],
  async run(ctx: Ctx) {
    const results: TestResult[] = [];
    const { pro, team, free } = ctx.orgs;
    if (!pro || !team || !free) {
      return [{ id: "F08", title: "Refusal responses per plan", status: "skip", detail: "needs PVLAB_ORG_PRO, PVLAB_ORG_TEAM and PVLAB_ORG_FREE" }];
    }
    const proRef = await firstRef(ctx, pro);
    const teamRef = await firstRef(ctx, team);
    const push = (id: string, title: string, w: Wire) =>
      results.push({
        id,
        title,
        status: "info",
        detail: `${w.status} ${w.code}`,
        measurements: {
          status: w.status,
          error_code: w.code,
          error_feature: w.feature,
          message: w.message,
          body_keys: w.topKeys,
          error_keys: w.errorKeys,
          error_meta: w.errorMeta,
        },
      });
    const skip = (id: string, title: string, plan: string) =>
      results.push({ id, title, status: "skip", detail: `no project listed in the ${plan} org` });

    if (proRef) push("F08a-pro", "v2 log-drain list, Pro", await v2(ctx, "GET", `/projects/${proRef}/analytics/log-drains`));
    else skip("F08a-pro", "v2 log-drain list, Pro", "Pro");
    if (teamRef) push("F08a-team", "v2 log-drain list, Team", await v2(ctx, "GET", `/projects/${teamRef}/analytics/log-drains`));
    else skip("F08a-team", "v2 log-drain list, Team", "Team");

    push("F08b-pro", "v2 invitation delete, Pro", await v2(ctx, "DELETE", `/organizations/${pro}/members/invitations`, BAD_INVITE));
    push("F08b-free", "v2 invitation delete, Free", await v2(ctx, "DELETE", `/organizations/${free}/members/invitations`, BAD_INVITE));
    push("F08b-team", "v2 invitation delete, Team", await v2(ctx, "DELETE", `/organizations/${team}/members/invitations`, BAD_INVITE));

    if (proRef) push("F08c-pro", "backup schedule read, Pro", await v1(ctx, "GET", `/projects/${proRef}/database/backups/schedule`));
    else skip("F08c-pro", "backup schedule read, Pro", "Pro");
    if (teamRef) push("F08c-team", "backup schedule read, Team", await v1(ctx, "GET", `/projects/${teamRef}/database/backups/schedule`));
    else skip("F08c-team", "backup schedule read, Team", "Team");
    if (proRef) {
      push("F08d-pro", "restore-point list, Pro", await v1(ctx, "GET", `/projects/${proRef}/database/backups/restore-point`));
      push("F08e-pro", "vanity subdomain read, Pro", await v1(ctx, "GET", `/projects/${proRef}/vanity-subdomain`));
      push("F08f-pro", "v2 notebooks list, Pro", await v2(ctx, "GET", `/projects/${proRef}/notebooks`));
    } else {
      for (const id of ["F08d-pro", "F08e-pro", "F08f-pro"]) skip(id, id, "Pro");
    }
    push("F08g-pro", "v2 maintenance windows, Pro", await v2(ctx, "GET", `/organizations/${pro}/maintenance/windows`));

    return results;
  },
};

export default mod;
