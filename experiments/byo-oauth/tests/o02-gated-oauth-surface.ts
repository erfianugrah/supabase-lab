/**
 * O02 - the contract-gated edge of the platform OAuth surface, measured.
 *
 * Two documented-but-gated capabilities sit next to the plain OAuth2 flow:
 *
 *   POST /v1/oauth/authorize/project-claim  - initiates transferring a
 *     project to an end user's org while the platform keeps delegated
 *     access. The public spec marks it "Available to Supabase for Platforms
 *     (SfP) partners and Supabase-managed OAuth applications".
 *   POST /v1/oauth/token with
 *     grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer  - the IDJAG
 *     (identity assertion) exchange. The public spec marks it "currently
 *     only available for Supabase's internal OAuth applications, or for
 *     Team/Enterprise organizations".
 *
 * Neither says what a normal Pro org gets when it knocks. This module
 * records the exact gate shape - status and verbatim body - so the doc can
 * quote the platform instead of the marketing page.
 *
 *   O02-control  the PAT reaches the Management API.
 *   O02a         project-claim with the Pro org slug.
 *   O02b         jwt-bearer grant with a structurally-valid junk assertion.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const PRO_ORG = "gfqyoavfwjduavsvhbni"; // same Pro org as w21/i01/m01

const mod: TestModule = {
  id: "O02",
  title: "Contract-gated OAuth surface: project-claim and jwt-bearer on a Pro org",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];

    try {
      const control = await mgmt(ctx, "GET", "/projects");
      results.push({
        id: "O02-control",
        title: "O02-control: PAT reaches the Management API",
        status: control.status === 200 ? "pass" : "fail",
        detail:
          control.status === 200
            ? undefined
            : `GET /projects HTTP ${control.status} - the other rows are uninterpretable`,
        measurements: { status: control.status },
      });
    } catch (e) {
      results.push({
        id: "O02-control",
        title: "O02-control: PAT reaches the Management API",
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // O02a: project claim. Whatever the platform answers is the finding.
    try {
      const claim = await mgmt(ctx, "POST", "/oauth/authorize/project-claim", {
        organization_slug: PRO_ORG,
      });
      results.push({
        id: "O02a",
        title: "O02a: project-claim on a Pro org",
        status: "info",
        measurements: { claim_status: claim.status },
        evidence: claim.text.slice(0, 300),
      });
    } catch (e) {
      results.push({
        id: "O02a",
        title: "O02a: project-claim on a Pro org",
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // O02b: jwt-bearer grant. Structurally-valid junk JWT (header.payload.sig)
    // - the point is whether the gate fires before signature validation.
    try {
      const junkJwt = `${btoa('{"alg":"RS256","typ":"JWT"}')}.${btoa('{"iss":"pvlab","sub":"pvlab","aud":"https://api.supabase.com/v1/oauth/token","exp":9999999999}')}.junk`;
      const res = await fetch("https://api.supabase.com/v1/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: junkJwt,
        }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      results.push({
        id: "O02b",
        title: "O02b: jwt-bearer grant on a Pro org",
        status: "info",
        measurements: { jwt_bearer_status: res.status },
        evidence: text.slice(0, 300),
      });
    } catch (e) {
      results.push({
        id: "O02b",
        title: "O02b: jwt-bearer grant on a Pro org",
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    return results;
  },
};
export default mod;
