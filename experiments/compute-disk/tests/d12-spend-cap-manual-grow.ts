/**
 * D12 - does the spend cap gate a MANUAL disk grow past the 8 GB plan baseline?
 *
 * The database-size guide says to disable the spend cap for a Pro instance to
 * auto-scale beyond 8 GB. D10 already saw autoscale go 8 -> 12 GB on a Pro org
 * with the cap on, so that sentence did not hold at runtime for autoscale.
 * This module asks the other half: on a fresh project (2 GB volume), is a
 * single manual `POST /config/disk` to 12 GB accepted and applied with the cap
 * on? One POST only - the manual quota is once per four hours (D03/D10c).
 *
 * The spend cap is not readable through the Management API (GET
 * /v1/organizations/{slug} carries no such field), so the operator states it:
 * PVLAB_SPEND_CAP=on|off. Missing = skip with a reason.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const REGION = "ap-southeast-1";
const TARGET_GB = 12;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type DiskAttrs = { type?: string; size_gb?: number; iops?: number; throughput_mibps?: number };

async function disk(ctx: Ctx, ref: string): Promise<DiskAttrs> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/disk`);
  return ((r.json as { attributes?: DiskAttrs } | undefined)?.attributes ?? {}) as DiskAttrs;
}

const mod: TestModule = {
  id: "D12",
  title: "Spend cap vs a manual disk grow past the 8 GB baseline (Pro, fresh project)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ORG = ctx.orgs.pro ?? "";
    const cap = (process.env.PVLAB_SPEND_CAP ?? "").toLowerCase();
    const skip = (detail: string): TestResult[] => [{ id: "D12", title: this.title, status: "skip", detail }];
    if (!ORG) return skip("PVLAB_ORG_PRO not set");
    if (cap !== "on" && cap !== "off") return skip("PVLAB_SPEND_CAP=on|off not set (not readable via the API)");

    let ref = "";
    const meas: Record<string, number | string> = { spend_cap: cap };
    try {
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: ORG,
        name: `d12-cap-${Date.now()}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) {
        return [{ id: "D12", title: this.title, status: "fail", detail: `create: HTTP ${create.status}` }];
      }
      let status = "";
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        status = ((p.json as { status?: string } | undefined)?.status ?? "") as string;
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);

      const before = await disk(ctx, ref);
      meas.baseline_size_gb = before.size_gb ?? -1;
      meas.baseline_type = before.type ?? "?";

      const post = await mgmt(ctx, "POST", `/projects/${ref}/config/disk`, {
        attributes: { type: before.type ?? "gp3", size_gb: TARGET_GB, iops: before.iops ?? 3000, throughput_mibps: before.throughput_mibps ?? 125 },
      });
      meas.grow_post_http = post.status;
      meas.grow_post_body = (post.text ?? "").slice(0, 240) || "(empty)";

      let after = before;
      if (post.status < 300) {
        for (let i = 0; i < 18; i += 1) {
          await sleep(10_000);
          after = await disk(ctx, ref);
          if (after.size_gb === TARGET_GB) break;
        }
      }
      meas.after_size_gb = after.size_gb ?? -1;
      const verdict = post.status < 300 && after.size_gb === TARGET_GB
        ? "accepted and applied"
        : post.status < 300
          ? "accepted, not applied within 3 min"
          : "refused";
      meas.manual_grow_past_8gb = verdict;

      // A definitive answer either way is a pass; only an unreadable outcome fails.
      return [{
        id: "D12",
        title: this.title,
        status: verdict === "accepted, not applied within 3 min" ? "fail" : "pass",
        detail: `spend cap ${cap}: manual grow ${before.size_gb} -> ${TARGET_GB} GB ${verdict} (HTTP ${post.status})`,
        measurements: meas,
      }];
    } catch (e) {
      return [{ id: "D12", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}`, measurements: meas }];
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
  },
};
export default mod;
