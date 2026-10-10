/**
 * HP02 - Baseline, before any custom domain exists on the project.
 *
 *   HP02a  OAuth round trip through the Keycloak slot entered at the project
 *          hostname: which host the Auth server puts in `redirect_uri`, which
 *          host the issuer sends the browser to, the token's `iss`.
 *   HP02b  The SDK's hosts (supabase-js) against the project hostname:
 *          getPublicUrl, createSignedUrl and the rest.
 *
 * This is the control for HP04/HP05: the same code runs after activation, so
 * any host that changes is a change the custom domain made.
 */
import { fetchKeys } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { oauthResults, sdkResult } from "../lib/phase";
import { useState } from "../lib/state";

const mod: TestModule = {
  id: "HP02",
  title: "Baseline on the project hostname: OAuth hosts and SDK hosts",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const st = await useState(ctx);
    if (!st) return [{ id: "HP02", title: this.title, status: "skip", detail: "no .state.json (HP01 did not run)" }];
    const keys = await fetchKeys(ctx);
    const origin = { label: "origin" as const, host: `${st.ref}.supabase.co` };
    const oauth = await oauthResults("HP02", ctx, st, [origin]);
    const sdk = await sdkResult("HP02s", "SDK hosts, client given the project hostname (no custom domain yet)", ctx, st, origin, keys.service);
    return [...oauth, sdk];
  },
};
export default mod;
