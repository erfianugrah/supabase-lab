/**
 * W07 - break-glass edge token minting.
 *
 * Validates that the jwt_secret is exposed via the Management API's
 * /projects/{ref}/postgrest config endpoint, allowing for HS256 token
 * minting as an escape hatch during Auth outages.
 */
import type { TestModule, Ctx, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { createHmac } from "node:crypto";

const mod: TestModule = {
  id: "W07",
  title: "break-glass edge token minting",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: false,

  async run(ctx: Ctx): Promise<TestResult> {
    const measurements: Record<string, number | string> = {};
    let jwtSecret: string | undefined;

    try {
      // Step 1: GET /projects/{ref}/postgrest via mgmt; record whether jwt_secret is present.
      const postgrestRes = await mgmt(ctx, "GET", `/projects/${ctx.ref}/postgrest`);
      if (postgrestRes.status !== 200 || !postgrestRes.json) {
        return {
          id: "W07",
          title: this.title,
          status: "fail",
          detail: `GET /postgrest HTTP ${postgrestRes.status}`,
          evidence: postgrestRes.text.slice(0, 400),
          measurements,
        };
      }

      const config = postgrestRes.json as Record<string, unknown>;
      if (typeof config.jwt_secret !== "string") {
        return {
          id: "W07",
          title: this.title,
          status: "fail",
          detail: "jwt_secret missing or non-string in /postgrest response",
          measurements,
        };
      }

      jwtSecret = config.jwt_secret;
      measurements["jwt_secret_present"] = "true";
      measurements["jwt_secret_redacted"] = `${jwtSecret.slice(0, 6)}...${jwtSecret.length}`;

      // Step 2: Mint HS256 locally (HMAC-SHA256, base64url no padding).
      const header = JSON.stringify({ alg: "HS256", typ: "JWT" });
      const sub = "00000000-0000-0000-0000-000000000001"; // Fixed UUID for stability
      const now = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({
        role: "authenticated",
        aud: "authenticated",
        sub,
        iat: now,
        exp: now + 3600,
      });

      const b64 = (str: string) =>
        Buffer.from(str).toString("base64")
          .replace(/=/g, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_");

      const encodedHeader = b64(header);
      const encodedPayload = b64(payload);
      const signature = createHmac("sha256", jwtSecret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

      const mintedToken = `${encodedHeader}.${encodedPayload}.${signature}`;

      // Step 3: GET /rest/v1/w_probe?select=id with apikey=ctx.anonKey + bearer=minted.
      // Expect 200 => escape hatch CONFIRMED.
      const probeUrl = `https://${ctx.apiHost}/rest/v1/w_probe?select=id`;
      const probeRes = await fetch(probeUrl, {
        method: "GET",
        headers: {
          apikey: ctx.anonKey!,
          Authorization: `Bearer ${mintedToken}`,
        },
        signal: AbortSignal.timeout(30_000),
      });

      measurements["minted_token_status"] = probeRes.status;

      if (probeRes.status !== 200) {
        return {
          id: "W07",
          title: this.title,
          status: "fail",
          detail: `minted token failed: HTTP ${probeRes.status}`,
          evidence: (await probeRes.text()).slice(0, 400),
          measurements,
        };
      }

      // Step 4: Wrong-secret control: same with a random secret => expect 401.
      const randomSecret = "wrong-secret-value-to-test-control";
      const wrongSignature = createHmac("sha256", randomSecret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

      const wrongToken = `${encodedHeader}.${encodedPayload}.${wrongSignature}`;
      const wrongProbeRes = await fetch(probeUrl, {
        method: "GET",
        headers: {
          apikey: ctx.anonKey!,
          Authorization: `Bearer ${wrongToken}`,
        },
        signal: AbortSignal.timeout(30_000),
      });

      measurements["wrong_secret_status"] = wrongProbeRes.status;

      if (wrongProbeRes.status !== 401) {
        return {
          id: "W07",
          title: this.title,
          status: "fail",
          detail: `wrong secret failed to 401: HTTP ${wrongProbeRes.status}`,
          evidence: (await wrongProbeRes.text()).slice(0, 400),
          measurements,
        };
      }

      return {
        id: "W07",
        title: this.title,
        status: "pass",
        detail: "escape hatch confirmed: minted token works, wrong secret fails",
        measurements,
      };
    } catch (e: unknown) {
      return {
        id: "W07",
        title: this.title,
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
        measurements,
      };
    }
  },
};

export default mod;
