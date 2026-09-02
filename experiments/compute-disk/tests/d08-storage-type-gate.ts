/**
 * D08 - gp3/io2 and IOPS/throughput provisioning gate.
 *
 * Docs: "Adjusting your disk performance limits requires LARGE Compute or
 * above". This module provisions a Pro micro project, issues ONE bump
 * request, and verifies with a follow-up GET whether the elevated IOPS/
 * throughput actually stuck. The first run's report ({"request went through
 * at Micro"} = API accepted) is only half the story; the verify GET is the
 * control that tells "API accepted" apart from "effect applied".
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

let PRO_ORG = ""; // from PVLAB_ORG_PRO via ctx.orgs.pro; set in run()
const REGION = "ap-southeast-1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DiskAttrs {
  attributes?: { iops?: number; size_gb?: number; throughput_mibps?: number; type?: string };
}

async function getDisk(ctx: Ctx, ref: string): Promise<DiskAttrs> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/disk`);
  return (r.json as DiskAttrs | undefined) ?? {};
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`);
  return ((p.json as { status?: string } | undefined)?.status ?? "") as string;
}

async function waitHealthy(ctx: Ctx, ref: string, maxMs: number): Promise<string> {
  let status = "";
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
    await sleep(10_000);
    status = await statusOf(ctx, ref);
  }
  return status;
}

const mod: TestModule = {
  id: "D08",
  title: "disk performance provisioning gate (below vs at Large)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    PRO_ORG = ctx.orgs.pro ?? "";
    if (!PRO_ORG) return [{ id: "D08", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    let detailed = "";
    const results: TestResult[] = [];
    try {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `d08-gate-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) {
        results.push({ id: "D08", title: "D08", status: "fail", detail: `create: HTTP ${create.status}` });
        return results;
      }
      const initStatus = await waitHealthy(ctx, ref, 20 * 60_000);
      if (initStatus !== "ACTIVE_HEALTHY") throw new Error(`project not healthy: ${initStatus}`);

      const base = await getDisk(ctx, ref);
      const attrs = base.attributes ?? {};
      const bump = {
        attributes: { ...attrs, iops: 4000, throughput_mibps: 200 },
      };

      // single bump attempt at Micro, then verify whether it actually stuck
      const microTry = await mgmt(ctx, "POST", `/projects/${ref}/config/disk`, bump);
      await sleep(5_000);
      const afterIos = await getDisk(ctx, ref);
      const applied =
        afterIos.attributes?.iops === 4000 || afterIos.attributes?.throughput_mibps === 200;
      detailed = applied ? "applied" : "accepted-but-not-applied";

      results.push({
        id: "D08",
        title: "D08: disk performance provisioning gate (verify after POST)",
        status: microTry.status >= 300 && !applied ? "pass" : "fail",
        detail:
          microTry.status >= 300
            ? `micro rejected: ${microTry.text.slice(0, 240)}`
            : applied
              ? "API accepted AND attributes changed - no Large gate at runtime"
              : "API accepted but attributes unchanged - accepted-but-not-applied",
        measurements: {
          micro_status: microTry.status,
          iops_after: afterIos.attributes?.iops ?? "?",
          throughput_after: afterIos.attributes?.throughput_mibps ?? "?",
          applied: applied ? 1 : 0,
        },
        evidence: microTry.status >= 300 ? `rejection: ${microTry.text.slice(0, 400)}` : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!results.some((r) => r.id === "D08")) {
        results.push({ id: "D08", title: "D08", status: "fail", detail: `threw: ${msg}` });
      }
    } finally {
      void detailed;
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    return results;
  },
};
export default mod;
