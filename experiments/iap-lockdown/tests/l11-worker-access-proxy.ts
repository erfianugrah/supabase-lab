/**
 * L11 - IAP-as-proxy: Cloudflare Worker behind Access, holding the service
 * key server-side.
 *
 *   L11a - deploy worker/ (Access JWT validation against the team certs
 *          endpoint, service key injected from a Worker secret, proxies
 *          /rest/v1/* to the origin). gocurl the added latency p50/p95 vs
 *          direct origin.
 *   L11b - THE load-bearing row: with the proxy up, direct-origin access
 *          with the anon key still answers. The proxy gates nothing on its
 *          own; the origin hostname keeps serving anyone holding a key.
 *          Measured, not asserted - this is the fact the customer answer
 *          turns on.
 *   L11c - close the bypass: revoke browser-usable keys (L05) and/or deny
 *          by default at RLS/grants (L08), then re-measure: direct origin
 *          refuses, proxy still serves. Only NOW is the IAP the only path.
 *
 * Ops notes: render-wrangler pattern from edge-resilience/scripts/render-
 * wrangler.ts for wrangler.toml; worker needs no nodejs_compat (JWT verify
 * via WebCrypto, edge-resilience/lib/jwt.ts has the ES256 verify half).
 * Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in env and an Access
 * application on the lab zone; self-skip with reason otherwise.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L11",
  title: "IAP-as-proxy: Access-gated worker, service key server-side, bypass measured",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L11",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Needs worker/ deployed + an Access application; gates on CF env vars.",
    };
  },
};
export default mod;
