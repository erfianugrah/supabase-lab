/**
 * D04/D07 - the disk autoscale config surface, read and probe mutations.
 *
 * The published spec only lists GET /config/disk/autoscale (defaults:
 * growth_percent / min_increment_gb / max_size_gb). The dashboard edits all
 * three (screenshot in the lab's evidence), so this module probes PUT/POST/
 * PATCH against the endpoint on a Pro org (D04) and on a Team org (D07),
 * recording each verbatim status. If a mutation verb lands, it re-reads the
 * config, restores the original where possible, and deletes the project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const PRO_ORG = "gfqyoavfwjduavsvhbni";
const TEAM_ORG = "kqiknhvnmyxpyhudlyxh";
const REGION = "ap-southeast-1";
const PROBE_VERBS = ["PUT", "POST", "PATCH"] as const;
const PROBE_BODY = { growth_percent: 20, min_increment_gb: 2, max_size_gb: 24 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AutoCfg {
  growth_percent?: number;
  min_increment_gb?: number;
  max_size_gb?: number;
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`);
  return ((p.json as { status?: string } | undefined)?.status ?? "") as string;
}

const mod: TestModule = {
  id: "D04",
  title: "autoscale config surface (pro + team)",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions projects; any mutation verb that lands is contained
  async run(ctx: Ctx): Promise<TestResult[]> {
    const outcomes: TestResult[] = [];
    for (const [id, org] of [
      ["D04", PRO_ORG],
      ["D07", TEAM_ORG],
    ] as const) {
      let ref = "";
      try {
        const t0 = Date.now();
        const create = await mgmt(ctx, "POST", "/projects", {
          organization_slug: org,
          name: `d04-auto-${t0}`,
          db_pass: `${crypto.randomUUID()}Aa1!`,
          region: REGION,
        });
        ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
        if (create.status !== 201 || !ref) {
          outcomes.push({ id, title: id, status: "fail", detail: `create: HTTP ${create.status}` });
          continue;
        }
        let status = "";
        const deadline = Date.now() + 20 * 60_000;
        while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
          await sleep(10_000);
          status = await statusOf(ctx, ref);
        }
        if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);

        const before = await mgmt(ctx, "GET", `/projects/${ref}/config/disk/autoscale`);
        const cfg = (before.json as AutoCfg | undefined) ?? {};
        const verbResults: Record<string, number> = {};
        let appliedVerb = "";
        for (const verb of PROBE_VERBS) {
          const r = await mgmt(ctx, verb, `/projects/${ref}/config/disk/autoscale`, PROBE_BODY);
          verbResults[verb] = r.status;
          ctx.log(`D04/${org === PRO_ORG ? "pro" : "team"} ${verb}: HTTP ${r.status}`);
          if (!appliedVerb && r.status < 300) appliedVerb = verb;
        }
        let mutationApplied = false;
        if (appliedVerb) {
          const after = await mgmt(ctx, "GET", `/projects/${ref}/config/disk/autoscale`);
          const afterCfg = (after.json as AutoCfg | undefined) ?? {};
          mutationApplied =
            afterCfg.growth_percent === PROBE_BODY.growth_percent ||
            afterCfg.min_increment_gb === PROBE_BODY.min_increment_gb ||
            afterCfg.max_size_gb === PROBE_BODY.max_size_gb;
        }
        outcomes.push({
          id,
          title: `${id}: autoscale surface (${org === PRO_ORG ? "pro" : "team"})`,
          status: "info",
          detail: appliedVerb
            ? `${appliedVerb} accepted (${JSON.stringify(verbResults)})`
            : `all mutation verbs rejected (${JSON.stringify(verbResults)})`,
          measurements: {
            growth_percent: cfg.growth_percent ?? "?",
            min_increment_gb: cfg.min_increment_gb ?? "?",
            max_size_gb: cfg.max_size_gb ?? "?",
            put_status: verbResults.PUT ?? 0,
            post_status: verbResults.POST ?? 0,
            patch_status: verbResults.PATCH ?? 0,
            mutation_applied: mutationApplied ? 1 : 0,
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!outcomes.some((r) => r.id === id)) {
          outcomes.push({ id, title: id, status: "fail", detail: `threw: ${msg}` });
        }
      } finally {
        if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
      }
    }
    return outcomes;
  },
};
export default mod;
