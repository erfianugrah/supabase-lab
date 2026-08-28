/**
 * L03 - Realtime private_only against the inventory.
 *
 * T23 (http-tier-lockdown / privatelink-aws) measured the enforcement point in
 * isolation (handshake succeeds, refusal lands in the join reply). This module
 * is the same lever inside the full inventory: after private_only=true, what do
 * REST/Auth/Storage/EF answer? Expected: unchanged - the lever is Realtime-
 * scoped - but the point of the experiment is that "expected" gets measured.
 *
 * Lever: PATCH /projects/{ref}/config/realtime { private_only }. Enforcement
 * is at channel JOIN, not the WS upgrade (T23) - so the anon socket still
 * opens and Realtime stays an internet-reachable surface.
 *
 * DESTRUCTIVE: PATCHes realtime config; restores the baseline value in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, inventory, realtimeJoin, toMeasurements } from "../lib/inventory.js";

async function getPrivateOnly(ctx: Ctx): Promise<boolean> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/realtime`);
  if (r.status !== 200) throw new Error(`GET realtime config http ${r.status}: ${r.text.slice(0, 200)}`);
  return Boolean((r.json as { private_only?: boolean }).private_only);
}

const mod: TestModule = {
  id: "L03",
  title: "Realtime private_only against the full inventory",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const baseline = await getPrivateOnly(ctx);
    const results: TestResult[] = [];

    // Baseline control: a public-channel join must succeed BEFORE the flip,
    // or a refusal after it proves nothing.
    const open = await realtimeJoin(ctx, keys.anonJwt);
    results.push({
      id: "L03a",
      title: "public-channel join, baseline",
      status: open.joinStatus === "ok" ? "pass" : "info",
      detail: `handshake=${open.handshake} join="${open.joinStatus}" (private_only=${baseline})`,
      measurements: { handshake_ms: open.handshakeMs, join_status: open.joinStatus, private_only: String(baseline) },
      evidence: open.detail,
    });
    if (open.joinStatus !== "ok") {
      results.push({
        id: "L03",
        title: this.title,
        status: "skip",
        detail: `baseline public join did not succeed ("${open.joinStatus}") - no control, no conclusion`,
      });
      return results;
    }

    // The realtime config PATCH returns 204 No Content on success.
    const flip = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/realtime`, { private_only: true });
    results.push({
      id: "L03b",
      title: "PATCH private_only=true",
      status: flip.status < 300 ? "pass" : "fail",
      measurements: { patch_status: flip.status },
      evidence: flip.status < 300 ? undefined : flip.text.slice(0, 300),
    });
    if (flip.status >= 300) return results;

    try {
      // Poll the join until it refuses; config propagation is not instant.
      const t0 = Date.now();
      let attempt = await realtimeJoin(ctx, keys.anonJwt);
      while (Date.now() - t0 < 120_000 && attempt.joinStatus === "ok") {
        await new Promise((r) => setTimeout(r, 5000));
        attempt = await realtimeJoin(ctx, keys.anonJwt);
      }
      const seconds = Math.round((Date.now() - t0) / 1000);
      const refused = attempt.joinStatus !== "ok";
      results.push({
        id: "L03c",
        title: "public-channel join with private_only=true",
        status: refused ? "pass" : "fail",
        detail: refused
          ? `refused after ${seconds}s: handshake ${attempt.handshake ? "STILL SUCCEEDS (channel-join enforcement, not network)" : "refused at upgrade"}, join="${attempt.joinStatus}"`
          : `still joined ${seconds}s after the flip`,
        measurements: {
          time_to_effect_s: refused ? seconds : "no-effect",
          handshake: attempt.handshake ? "ok" : "refused",
          enforcement_point: !refused ? "none" : attempt.handshake ? "channel-join" : "ws-upgrade",
        },
        evidence: attempt.detail,
      });

      // The whole point: does a Realtime-scoped lever touch any other surface?
      const inv = await inventory(ctx, keys.anonJwt, "");
      results.push({
        id: "L03d",
        title: "rest of the HTTP inventory under private_only",
        status: "info",
        detail: inv.map((r) => `${r.surface}=${r.status}`).join(" "),
        measurements: toMeasurements(inv, "rt_private"),
      });
    } finally {
      const back = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/realtime`, { private_only: baseline });
      results.push({
        id: "L03z",
        title: "restore private_only",
        status: back.status < 300 ? "pass" : "fail",
        detail: back.status < 300 ? `restored to ${baseline}` : `restore HTTP ${back.status} - PROJECT LEFT WITH private_only=true`,
        measurements: { restore_status: back.status },
      });
    }
    return results;
  },
};
export default mod;
