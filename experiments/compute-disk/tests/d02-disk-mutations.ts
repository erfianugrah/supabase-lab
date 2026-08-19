/**
 * D02/D03 - disk attribute semantics and the rolling modification quota.
 *
 * D02: fresh Pro project -> GET config/disk (baseline: type/size/iops/
 * throughput + last_modified_at), a DECREASE attempt (docs: disks only grow),
 * an INCREASE attempt, and the util endpoint before/after.
 *
 * D03: successive increases until the doc's "four modifications per rolling
 * 24h window" quota rejects one - the rejection status and message are the
 * finding. Attempts are serial; each is +1 GiB so the fifth attempt is on a
 * disk at most ~12 GiB larger by then.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const PRO_ORG = "gfqyoavfwjduavsvhbni";
const REGION = "ap-southeast-1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DiskAttrs {
  attributes?: { iops?: number; size_gb?: number; throughput_mibps?: number; type?: string };
  last_modified_at?: string;
}

async function getDisk(ctx: Ctx, ref: string): Promise<DiskAttrs> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/disk`);
  return (r.json as DiskAttrs | undefined) ?? {};
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`);
  return ((p.json as { status?: string } | undefined)?.status ?? "") as string;
}

const mod: TestModule = {
  id: "D02",
  title: "disk baseline, increase-only semantics, modification quota",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    let ref = "";
    const results: TestResult[] = [];
    const t0 = Date.now();
    try {
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `d02-disk-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) {
        results.push({ id: "D02", title: "D02", status: "fail", detail: `create: HTTP ${create.status}` });
        return results;
      }
      let status = "";
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        status = await statusOf(ctx, ref);
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`project not healthy: ${status}`);

      // ---- D02: baseline + negative/positive control on size ----
      const base = await getDisk(ctx, ref);
      const attrs = base.attributes ?? {};
      const controlNotReady = [results.length + 1];
      void controlNotReady;

      const decrease = await mgmt(
        ctx,
        "POST",
        `/projects/${ref}/config/disk`,
        { attributes: { ...attrs, size_gb: (attrs.size_gb ?? 0) - 1 } },
      );

      const increase = await mgmt(
        ctx,
        "POST",
        `/projects/${ref}/config/disk`,
        { attributes: { ...attrs, size_gb: (attrs.size_gb ?? 0) + 1 } },
      );

      const after = await getDisk(ctx, ref);
      results.push({
        id: "D02",
        title: "D02: disk baseline + increase-only semantics",
        status: increase.status < 300 ? "pass" : "fail",
        detail: `decrease=${decrease.status}/increase=${increase.status}`,
        measurements: {
          type: attrs.type ?? "?",
          baseline_size_gb: attrs.size_gb ?? -1,
          baseline_iops: attrs.iops ?? -1,
          decrease_status: decrease.status,
          increase_status: increase.status,
          mods_remaining_after_increase: "see D03",
        },
        evidence: decrease.status >= 300 ? `decrease rejected: ${decrease.text.slice(0, 300)}` : undefined,
      });

      // ---- D03: iterate increases until rejection (docs claim 4/24h) ----
      const attempts: Array<{ attempt: number; status: number; detail: string }> = [];
      let size = after.attributes?.size_gb ?? (attrs.size_gb ?? 8);
      let quotaHit = false;
      let rejectedText = "";
      for (let attempt = 2; attempt <= 12 && !quotaHit; attempt += 1) {
        const r = await mgmt(
          ctx,
          "POST",
          `/projects/${ref}/config/disk`,
          { attributes: { ...after.attributes, size_gb: size + 1 } },
        );
        if (r.status < 300) {
          size += 1;
          attempts.push({ attempt, status: r.status, detail: "accepted" });
          ctx.log(`D03 attempt ${attempt}: +1GiB accepted (size ${size})`);
        } else {
          quotaHit = true;
          rejectedText = r.text.slice(0, 400);
          attempts.push({ attempt, status: r.status, detail: rejectedText });
          ctx.log(`D03 attempt ${attempt}: rejected HTTP ${r.status}: ${rejectedText}`);
        }
        await sleep(5_000);
      }
      results.push({
        id: "D03",
        title: "D03: modification quota probe (iterate until rejection)",
        status: quotaHit ? "pass" : "info",
        detail: quotaHit
          ? `quota bit after ${attempts.length} consecutive increases; rejection: ${rejectedText}`
          : "all 12 increases accepted in one burst - the 4-mod/24h doc claim fails at API level",
        measurements: {
          accepted_increases: attempts.filter((a) => a.status < 300).length.toFixed(0),
          reject_status: quotaHit ? attempts[attempts.length - 1].status : "none",
          final_size_gb: size,
        },
        evidence: quotaHit ? rejectedText : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["D02", "D03"] as const) {
        if (!results.some((r) => r.id === id)) results.push({ id, title: id, status: "fail", detail: `threw: ${msg}` });
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    return results;
  },
};
export default mod;
