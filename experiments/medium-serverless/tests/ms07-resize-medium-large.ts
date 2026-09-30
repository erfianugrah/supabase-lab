/**
 * MS07 - what a Medium -> Large -> Medium resize costs each client path.
 *
 * platform-downtime D03/D04 measured Micro <-> Small per path (Auth 131 s,
 * pooler 207 s resizing up); compute-disk D09 measured Small -> Large from the
 * HTTP side only (61 s settle, 17 s REST outage). Nothing measured a resize
 * FROM Medium, and none saw the dedicated pooler or direct 5432. Rows, every
 * path sampled at 500 ms until 5 s of sustained recovery:
 *
 *   MS07a  Medium -> Large: first-fail and outage window per path - REST,
 *          Auth (/auth/v1/health), Storage, Realtime handshake, shared pooler
 *          6543 and 5432, dedicated 6543, direct 5432 - with the failure MODE.
 *   MS07b  Large -> Medium: the same.
 *
 * DESTRUCTIVE and BILLABLE: Large is USD 0.1517/h while it lasts; MS07b puts
 * Medium back. Adjacent addon PATCHes are rate-limited (429 "try again in N
 * minutes", D09), which `applyAddon` waits out. Not settled: an authenticated
 * Auth call across the window (the health endpoint is not one).
 */
import { sampleDuring } from "../../../harness/src/sampler";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { addons, allProbes, applyAddon, flatten, INTERVAL_MS, SETTLE_MS, sleep, waitHealthy } from "../lib/setup";

const MAX_WAIT_MS = 15 * 60_000;

async function resize(ctx: Ctx, id: string, title: string, variant: string): Promise<TestResult> {
  const { probes, note } = await allProbes(ctx);
  ctx.log(`${id}: paths ${note}`);
  const windows = await sampleDuring(probes, { intervalMs: INTERVAL_MS, maxWaitMs: MAX_WAIT_MS, settleMs: SETTLE_MS, log: ctx.log }, async () => {
    const r = await applyAddon(ctx, "compute_instance", variant);
    if (r.status >= 300) throw new Error(`resize to ${variant} refused: HTTP ${r.status} ${r.text}`);
    ctx.log(`compute -> ${variant}: HTTP ${r.status}`);
  });
  const measurements = flatten(windows);
  const unhealthy = windows.filter((w) => !w.healthyAtStart).map((w) => w.name);
  const stuck = windows.filter((w) => w.firstFailMs !== null && w.recoveredMs === null);
  const downed = windows.filter((w) => w.firstFailMs !== null);
  const ad = await addons(ctx);
  measurements.compute_after = ad.selected.find((a) => a.type === "compute_instance")?.variant ?? "ci_micro(null)";
  return {
    id,
    title,
    status: unhealthy.length ? "skip" : stuck.length ? "fail" : "pass",
    detail: unhealthy.length
      ? `path(s) already failing before the operation: ${unhealthy.join(", ")}`
      : stuck.length
        ? `never recovered within ${MAX_WAIT_MS / 60000} min: ${stuck.map((w) => w.name).join(", ")}`
        : downed.length
          ? `outage on ${downed.map((w) => `${w.name} ${Math.round((w.windowMs as number) / 1000)}s`).join(", ")}; untouched: ${windows.filter((w) => w.firstFailMs === null).map((w) => w.name).join(", ") || "none"}`
          : "no client-visible failure on any path",
    measurements,
    evidence: windows.map((w) => `${w.name}: samples ${w.samples} failures ${w.failures} modes ${JSON.stringify(w.modes)}`).join("\n"),
  };
}

const mod: TestModule = {
  id: "MS07",
  title: "Resize Medium -> Large -> Medium: outage per connection path",
  where: "local",
  requires: ["pat", "db", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ad = await addons(ctx);
    const current = ad.selected.find((a) => a.type === "compute_instance")?.variant ?? "ci_micro";
    if (current !== "ci_medium")
      return [{ id: "MS07", title: mod.title, status: "skip", detail: `project is on ${current}, not ci_medium - this module measures Medium <-> Large only` }];

    const up = await resize(ctx, "MS07a", "Medium -> Large: outage per path", "ci_large");
    const h1 = await waitHealthy(ctx, ["db", "rest", "auth", "pg_bouncer"], 10 * 60_000);
    ctx.log(`healthy after up: ${h1.ok} in ${Math.round(h1.waitedMs / 1000)}s ${JSON.stringify(h1.last)}`);
    // D09: a second addon PATCH inside the settling window answers 429; wait it out before the return trip.
    await sleep(150_000);
    const down = await resize(ctx, "MS07b", "Large -> Medium: outage per path", "ci_medium");
    const h2 = await waitHealthy(ctx, ["db", "rest", "auth", "pg_bouncer"], 10 * 60_000);
    down.measurements = { ...down.measurements, healthy_after_s: Math.round(h2.waitedMs / 1000), health_after: JSON.stringify(h2.last) };
    up.measurements = { ...up.measurements, healthy_after_s: Math.round(h1.waitedMs / 1000), health_after: JSON.stringify(h1.last) };
    return [up, down];
  },
};
export default mod;
