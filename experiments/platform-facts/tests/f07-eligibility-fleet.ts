/**
 * F07 - upgrade eligibility across every project in the lab organizations
 * (work-supabase-lab#41).
 *
 * F06 reads one project. The 2026-08-04 hand sweep across the account found
 * one project answering `eligible: null` with no version fields, and nothing
 * recorded what that project was doing. F07 reads, for every project in the
 * organizations given by PVLAB_ORG_SLUGS, the project's status, age and region
 * (`GET /v1/projects/{ref}`) and its eligibility payload, so a null can be set
 * beside a status (paused? coming up?) and a payload shape.
 *
 * Read-only: two GETs per project, paced under the 120-per-minute budget. The
 * module never upgrades anything. Measurements and evidence carry no ref and
 * no name: projects are numbered oldest first, organizations are labelled by
 * their PVLAB_ORG_<ROLE> role (else o1, o2, ...).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt, type MgmtResponse } from "../../../harness/src/mgmt";
import { byCreation, rowLine, summarise, toRow, type ListedProject } from "../lib/eligibility";

const MAX_PROJECTS = 60;
const PACE_MS = 600;

/** One GET, retried once after a minute if the budget ran out. */
async function get(ctx: Ctx, path: string): Promise<MgmtResponse> {
  let r = await mgmt(ctx, "GET", path);
  if (r.status === 429 || r.throttled) {
    ctx.log(`throttled on ${path.replace(/\/projects\/[^/]+/, "/projects/{ref}")}; waiting 65 s`);
    await Bun.sleep(65_000);
    r = await mgmt(ctx, "GET", path);
  }
  await Bun.sleep(PACE_MS);
  return r;
}

function orgLabel(ctx: Ctx, slug: string, i: number): string {
  const role = Object.entries(ctx.orgs).find(([, s]) => s === slug)?.[0];
  return role ?? `o${i + 1}`;
}

const mod: TestModule = {
  id: "F07",
  title: "Upgrade eligibility across the lab organizations' projects (what eligible: null goes with)",
  where: "local",
  requires: ["pat", "org"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const refs: { ref: string; org: string }[] = [];
    const listErrors: string[] = [];
    for (const [i, slug] of ctx.orgSlugs.entries()) {
      const l = await get(ctx, `/organizations/${slug}/projects`);
      if (l.status !== 200) {
        listErrors.push(`${orgLabel(ctx, slug, i)}: HTTP ${l.status}`);
        continue;
      }
      const arr = Array.isArray(l.json) ? l.json : ((l.json as { projects?: unknown[] } | undefined)?.projects ?? []);
      for (const p of arr as { ref?: unknown; id?: unknown }[]) {
        const ref = typeof p.ref === "string" ? p.ref : typeof p.id === "string" ? p.id : "";
        if (ref) refs.push({ ref, org: orgLabel(ctx, slug, i) });
      }
    }
    if (refs.length === 0) {
      return [
        {
          id: "F07a",
          title: "Upgrade eligibility, every project in the lab organizations",
          status: listErrors.length ? "fail" : "info",
          detail: listErrors.length ? `could not list projects: ${listErrors.join("; ")}` : "no projects listed",
        },
      ];
    }

    const read: { project: ListedProject; httpStatus: number; json: unknown }[] = [];
    for (const { ref, org } of refs.slice(0, MAX_PROJECTS)) {
      const p = await get(ctx, `/projects/${ref}`);
      const pj = (p.json ?? {}) as Record<string, unknown>;
      const e = await get(ctx, `/projects/${ref}/upgrade/eligibility`);
      read.push({
        project: { org, created_at: pj.created_at, status: pj.status, region: pj.region },
        httpStatus: e.status,
        json: e.json,
      });
    }

    const now = Date.now();
    const ordered = byCreation(read.map((r) => r.project));
    const rows = ordered.map((project, i) => {
      const hit = read.find((r) => r.project === project);
      return toRow(i + 1, project, hit?.httpStatus ?? 0, hit?.json, now);
    });
    const summary = summarise(rows);
    const truncated = refs.length > MAX_PROJECTS ? `; ${refs.length - MAX_PROJECTS} project(s) past the cap of ${MAX_PROJECTS} not read` : "";

    return [
      {
        id: "F07a",
        title: "Upgrade eligibility, every project in the lab organizations",
        status: "info",
        detail:
          `${rows.length} project(s): eligible true ${summary.eligible_true}, false ${summary.eligible_false}, ` +
          `null ${summary.eligible_null} (statuses ${summary.null_statuses}; ${summary.null_with_version_fields} with version fields), ` +
          `absent ${summary.eligible_absent}, unread ${summary.eligible_unread}` +
          truncated +
          (listErrors.length ? `; list errors: ${listErrors.join("; ")}` : ""),
        measurements: summary,
        evidence: rows.map(rowLine).join("\n"),
      },
    ];
  },
};
export default mod;
