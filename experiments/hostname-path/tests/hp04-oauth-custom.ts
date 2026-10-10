/**
 * HP04 - OAuth round trip with the custom domain active.
 *
 * Same flow as HP02, entered at the custom host and, as a second row, still at
 * the project hostname. The blog account this probes (an auth callback that
 * stayed on a hardcoded domain behind a proxy domain) says callbacks do not
 * follow the host a client entered at; this records which host the Auth
 * server puts in `redirect_uri`, which host the browser is sent to after the
 * issuer, the token's `iss`, and whether a token minted through one host is
 * accepted through the other.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { oauthResults } from "../lib/phase";
import { useState } from "../lib/state";

const mod: TestModule = {
  id: "HP04",
  title: "OAuth round trip with the custom domain active",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const st = await useState(ctx);
    if (!st?.domainActive) return [{ id: "HP04", title: this.title, status: "skip", detail: "custom domain not active (HP03 did not complete)" }];
    return oauthResults("HP04", ctx, st, [
      { label: "custom", host: st.host },
      { label: "origin", host: `${st.ref}.supabase.co` },
    ]);
  },
};
export default mod;
