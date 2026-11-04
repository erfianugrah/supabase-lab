/**
 * EB01 - Setup and control: one Micro project in ap-northeast-1 (the PVLAB_ORG_PRO org; Team on 2026-11-04,
 * created through POST /v1/projects), the two functions deployed through the
 * Management API (server-side bundling, verify_jwt false), and 20 sequential
 * warm invocations per function from this lab's Mac (Singapore, IPv4) with
 * `x-region: ap-northeast-1`, legacy anon key as apikey and bearer.
 *
 *   EB01a  project: region, Postgres version, seconds to ready
 *   EB01b  eb-noop: header probe (x-sb-edge-region, cf-ray colo, header
 *          names) and 20 sequential invocations: status, p50/p95
 *   EB01c  eb-rpc: the same, plus the rpc status the function reports
 *
 * Not settled by this module: anything about load; the vantage RTT alone
 * (p50 here includes the function's own work).
 *
 * DESTRUCTIVE: creates the project (EB99 deletes it). Self-skips without
 * PVLAB_ORG_PRO.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { NOOP_SLUG, REGION, RPC_SLUG, ensureProject, errText, fireFor, headerProbe, skipWithout, sleep, scrub } from "../lib/eb.js";
import { histogram, pct } from "../lib/load.js";

async function control(id: string, title: string, p: Awaited<ReturnType<typeof ensureProject>>, slug: string): Promise<TestResult> {
  const fire = fireFor(p, slug);
  // A fresh deploy propagates over ~10 s: wait for the first 200 (5 s apart, 120 s budget).
  let first = await fire();
  for (let i = 0; i < 24 && first.status !== 200; i++) {
    await sleep(5_000);
    first = await fire();
  }
  const hdr = await headerProbe(p, slug);
  const res: { status: number; ms: number; region: string; rpc: string }[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const a = await fire();
    res.push({ status: a.status, ms: Math.round(performance.now() - t0), region: a.region, rpc: (a.text.match(/"rpc"\s*:\s*(\d+|null)/) ?? [])[1] ?? "" });
  }
  const ok = res.filter((r) => r.status === 200).length;
  const rpc = res.map((r) => r.rpc).filter(Boolean);
  const rpcOk = slug === RPC_SLUG ? rpc.filter((s) => s === "200").length === res.length : true;
  return {
    id,
    title,
    status: ok === res.length && rpcOk ? "pass" : "fail",
    detail: `${ok}/20 HTTP 200${rpc.length ? `, rpc ${histogram(rpc)}` : ""}; p50 ${pct(res.map((r) => r.ms), 0.5)} ms, p95 ${pct(res.map((r) => r.ms), 0.95)} ms; x-sb-edge-region ${hdr.x_sb_edge_region || "(absent)"}, colo ${hdr.cf_colo}`,
    measurements: {
      ok_of_20: ok,
      p50_ms: pct(res.map((r) => r.ms), 0.5),
      p95_ms: pct(res.map((r) => r.ms), 0.95),
      status_histogram: histogram(res.map((r) => String(r.status))),
      edge_region: histogram(res.map((r) => r.region)),
      ...(rpc.length ? { rpc_histogram: histogram(rpc) } : {}),
      x_sb_edge_region: hdr.x_sb_edge_region || "absent",
      cf_colo: hdr.cf_colo ?? "",
      server: hdr.server || "absent",
      sb_gateway_version: hdr.sb_gateway_version || "absent",
    },
    evidence: `header names: ${hdr.header_names}\nbody: ${hdr.body}\nfirst answer while waiting: ${first.status} ${scrub(first.text).slice(0, 200)}`,
  };
}

const mod: TestModule = {
  id: "EB01",
  title: "setup and control: Micro in ap-northeast-1, two functions, 20 sequential invocations each",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "EB01", this.title);
    if (skip) return skip;
    try {
      const p = await ensureProject(ctx);
      return [
        {
          id: "EB01a",
          title: "project ready: Micro, created through the Management API",
          status: "pass",
          detail: `${REGION}, ${p.plan} org, ${p.pgVersion}, ready in ${p.createS} s (create, healthy, SQL function, two deploys read back)${p.reused ? " (reused)" : ""}`,
          measurements: { region: REGION, org_plan: p.plan, pg_version: p.pgVersion, ready_s: p.createS, size: "micro" },
        },
        await control("EB01b", "eb-noop control: 20 sequential invocations, x-region ap-northeast-1", p, NOOP_SLUG),
        await control("EB01c", "eb-rpc control: 20 sequential invocations, one supabase-js rpc() each", p, RPC_SLUG),
      ];
    } catch (e) {
      return [{ id: "EB01", title: this.title, status: "fail", detail: `threw: ${scrub(errText(e))}` }];
    }
  },
};
export default mod;
