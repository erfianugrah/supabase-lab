/**
 * L11 - IAP-as-proxy: the bypass is the load-bearing fact.
 *
 *   L11b - with a proxy fronting the project, the ORIGIN hostname keeps
 *          answering anyone holding a key. Direct <ref>.supabase.co with the
 *          anon key still serves - the proxy gates nothing on its own. This
 *          is the fact the customer answer turns on; measured, not asserted.
 *   L11c - close the bypass: disable the legacy keys (L05 lever), then the
 *          direct origin refuses the anon key. Only combined with key
 *          revocation (and RLS, L10) does the proxy become the only path.
 *
 * The Access-gated Worker call itself (latency p50/p95, and proxy-still-serves
 * after the bypass closes) needs an Access service token or the chrome login
 * to pass the edge; that half is the chrome/service-token follow-up. This
 * module measures the origin side, which needs no token.
 *
 * DESTRUCTIVE: toggles legacy keys; restores + verifies in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http, waitFor, TABLE } from "../lib/inventory.js";

async function anonRead(ctx: Ctx, anonJwt: string) {
  return http(`https://${ctx.apiHost}/rest/v1/${TABLE}?select=id&limit=1`, { key: anonJwt });
}

const mod: TestModule = {
  id: "L11",
  title: "IAP-as-proxy: the direct-origin bypass, and closing it",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const results: TestResult[] = [];

    const proxy = ctx.endpoints["worker"];
    const before = await anonRead(ctx, keys.anonJwt);
    results.push({
      id: "L11b",
      title: "direct origin serves the anon key regardless of any proxy",
      status: before.status === 200 ? "pass" : "fail",
      detail: `direct ${ctx.apiHost} with the anon key -> ${before.status}. A proxy at ${proxy ?? "<hostname>"} cannot gate this: the origin keeps answering anyone holding a key - the bypass.`,
      measurements: { direct_anon_status: before.status },
    });

    let disabled = false;
    try {
      const off = await mgmt(ctx, "PUT", `/projects/${ctx.ref}/api-keys/legacy?enabled=false`);
      disabled = off.status < 300;
      if (disabled) {
        const closed = await waitFor(async () => (await anonRead(ctx, keys.anonJwt)).status >= 400, 60_000);
        const after = await anonRead(ctx, keys.anonJwt);
        results.push({
          id: "L11c",
          title: "closing the bypass: revoke keys and the direct origin refuses",
          status: after.status >= 400 ? "pass" : "fail",
          detail: `after disabling legacy keys, direct origin with the anon key -> ${after.status} ${after.code} (in ${closed.elapsedS}s). Now the only paths are key-holding server-side (the proxy) or an IAP identity (L10).`,
          measurements: { direct_anon_after: after.status },
        });
      } else {
        results.push({ id: "L11c", title: "closing the bypass", status: "fail", detail: `could not disable legacy keys: HTTP ${off.status}` });
      }
    } finally {
      if (disabled) {
        let ok = false;
        for (let i = 0; i < 5 && !ok; i++) {
          const on = await mgmt(ctx, "PUT", `/projects/${ctx.ref}/api-keys/legacy?enabled=true`);
          if (on.status < 300) ok = (await waitFor(async () => (await anonRead(ctx, keys.anonJwt)).status === 200, 60_000)).ok;
          if (!ok) await new Promise((r) => setTimeout(r, 5000));
        }
        results.push({
          id: "L11z",
          title: "restore legacy keys",
          status: ok ? "pass" : "fail",
          detail: ok ? "legacy keys re-enabled, anon read confirmed" : "RESTORE FAILED - project destroyed at end of run anyway",
        });
      }
    }
    return results;
  },
};
export default mod;
