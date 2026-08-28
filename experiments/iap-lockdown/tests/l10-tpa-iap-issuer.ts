/**
 * L10 - IAP-as-issuer: third-party auth registered against the project, RLS
 * keyed on the IAP claim, GoTrue signup disabled.
 *
 * The authz-layer version of "IAP over the data APIs": the data API serves
 * only requests carrying IAP identity. Flavour-agnostic by construction -
 * the lab ES256 issuer stands in for whatever the IAP's IdP is.
 *
 *   L10a - register the lab issuer via POST /v1/projects/{ref}/config/auth/
 *          third-party-auth (oidc_issuer_url shape - cross-project-auth
 *          measured it resolving in tens of ms; custom_jwks never resolves,
 *          do not use it). Issuer needs hosting: reuse the edge-resilience
 *          JWKS endpoint pattern (worker/) or any static URL.
 *   L10b - RLS policy keyed on an IAP claim (e.g. jwt ->> 'iap_sub' or an
 *          Access group claim). Fixture table gets RLS + policy in this
 *          module, not in L01.
 *   L10c - three-credential assertion: anon denied; GoTrue-issued user token
 *          WITHOUT the IAP claim denied; IAP-signed token allowed.
 *   L10d - with GoTrue signup disabled (L04) and TPA registered, identity
 *          exists only via the IAP's IdP. Recorded, since that is the actual
 *          end state the customer asked about.
 *
 * JWKS trust lag: ~30s cold after registration (W01) - poll, do not probe once.
 *
 * Reuse: edge-resilience/lib/jwt.ts + scripts/keygen.ts (ES256 issuer),
 * rls-wire-claims C02 (GoTrue-vs-wire claims pattern), cross-project-auth
 * X01/X02 (TPA registration shapes and refusal codes).
 *
 * DESTRUCTIVE: registers/deletes a TPA integration; deletes in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L10",
  title: "IAP-as-issuer: TPA JWKS + claim-keyed RLS gates the data API",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L10",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Needs a hosted JWKS URL (worker/ dir) before it can run.",
    };
  },
};
export default mod;
