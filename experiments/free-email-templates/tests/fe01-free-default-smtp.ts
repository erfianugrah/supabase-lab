/**
 * FE01 - auth email templates on a NEW free-org project.
 *
 * Claim under test (public changelog, 2026-06-03,
 * https://github.com/orgs/supabase/discussions/46599): new free-plan projects
 * on the default email provider can no longer modify their auth email
 * templates; free projects that configure their own SMTP keep template
 * editing; paid plans are unaffected.
 *
 * Self-provisioning: creates one project (name prefix fe-) on the
 * free org, runs the sequence in lib/phases.ts (a..i), deletes it in finally.
 * If the first free org already holds 2 active projects the second free org
 * (PVLAB_ORG_FREE2) is used instead.
 *
 * Needs PVLAB_ORG_FREE (and optionally PVLAB_ORG_FREE2).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { call } from "../lib/probe.js";
import { runPhases } from "../lib/phases.js";

const ACTIVE = /^(ACTIVE_HEALTHY|COMING_UP|ACTIVE_UNHEALTHY|RESTORING|UPGRADING)$/;

async function activeCount(ctx: Ctx, org: string): Promise<number> {
  const r = await call(ctx, "GET", `/organizations/${org}/projects`);
  const arr = ((r.json as { projects?: Array<{ status?: string }> } | undefined)?.projects ?? []) as Array<{ status?: string }>;
  return arr.filter((p) => ACTIVE.test(String(p.status ?? ""))).length;
}

const mod: TestModule = {
  id: "FE01",
  title: "Free org, default SMTP vs custom SMTP: auth email template writes",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const candidates = [ctx.orgs.free, ctx.orgs.free2].filter((s): s is string => !!s);
    if (!candidates.length) return [{ id: "FE01", title: this.title, status: "skip", detail: "PVLAB_ORG_FREE not set" }];
    let org = "";
    for (const c of candidates) {
      if ((await activeCount(ctx, c)) < 2) {
        org = c;
        break;
      }
    }
    if (!org) return [{ id: "FE01", title: this.title, status: "skip", detail: "every supplied free org already holds 2 active projects" }];
    return runPhases(ctx, { org, prefix: "FE01", label: "a free org", full: true });
  },
};
export default mod;
