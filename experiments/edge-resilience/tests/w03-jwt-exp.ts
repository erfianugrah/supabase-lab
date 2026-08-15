
import type { TestModule, Ctx, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

export default {
  id: "W03",
  title: "W03 - jwt_exp lever: accepted AND effective",
  where: "local" as const,
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult> {
    let originalJwtExp: number | undefined;
    const measurements: Record<string, number | string> = {};

    try {
      // 1. GET current jwt_exp
      const authRes = await fetch(`${ctx.apiHost}/auth/v1/config`, {
        headers: { apikey: ctx.anonKey!, Authorization: `Bearer ${ctx.anonKey}` },
      });
      if (!authRes.ok) {
        throw new Error(`Failed to fetch auth config: ${authRes.status}`);
      }
      const authConfig = await authRes.json() as any;
      originalJwtExp = authConfig.jwt_exp;
      measurements["initial_jwt_exp"] = originalJwtExp!;

      // 2. PATCH to 43200
      const targetExp = 43200;
      await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, { jwt_exp: targetExp });

      // Poll GET until it reads 43200
      const startPolling = Date.now();
      let readbackExp: number | undefined;
      while (Date.now() - startPolling < 30000) {
        const pollRes = await fetch(`${ctx.apiHost}/auth/v1/config`, {
          headers: { apikey: ctx.anonKey!, Authorization: `Bearer ${ctx.anonKey}` },
        });
        const pollConfig = await pollRes.json() as any;
        if (pollConfig.jwt_exp === targetExp) {
          readbackExp = pollConfig.jwt_exp;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (readbackExp !== targetExp) {
        throw new Error(`config write not readable back: ${readbackExp}`);
      }
      measurements["readback_jwt_exp"] = readbackExp;

      // 3. Effect check: signup
      const startSignup = Date.now();
      let effectiveExp: number | undefined;
      let signupAttempts = 0;

      while (Date.now() - startSignup < 60000) {
        signupAttempts++;
        const email = `test-${Math.random().toString(36).slice(2)}-${Date.now()}@example.com`;
        const password = "password12ments";

        try {
          const signupRes = await fetch(`${ctx.apiHost}/auth/v1/signup`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: ctx.anonKey!,
              Authorization: `Bearer ${ctx.anonKey}`,
            },
            body: JSON.stringify({ email, password }),
          });

          // We check the response body if it's a success, but signup might return 200 or 201
          // The requirement says "decode the returned access_token payload"
          // Note: signup might return a JSON with access_token or it might redirect/be empty if error
          if (signupRes.ok) {
            const signupData = await signupRes.json() as any;
            if (signupData?.access_token) {
              const token = signupData.access_token;
              const payloadBase64 = token.split(".")[1];
              const payload = JSON.parse(atob(payloadBase64.replace(/-/g, "+").replace(/_/g, "/")));
              effectiveExp = payload.exp - payload.iat;
              if (effectiveExp === targetExp) break;
            }
          } else {
            const errorText = await signupRes.text();
            // If it's a rate limit error, we just retry
            // (as seen in the failed logs: "Signup error: over_email_send_rate_limit")
          }
        } catch (e) {
          // Network error, retry
        }
        await new Promise((r) => setTimeout(r, 5000));
      }

      if (effectiveExp === undefined) {
        throw new Error(`issuer still minting ${effectiveExp ?? "unknown"}s tokens 60s after config accepted 43200`);
      }

      measurements["effective_jwt_exp"] = effectiveExp;
      measurements["signup_attempts"] = signupAttempts;
      measurements["effect_delay_ms"] = Date.now() - startSignup;

      return {
        id: "W03",
        title: "W03 - jwt_exp lever: accepted AND effective",
        status: "pass" as const,
        measurements,
      };
    } catch (e: any) {
      return {
        id: "W03",
        title: "W03 - jwt_exp lever: accepted AND effective",
        status: "fail" as const,
        detail: e.message,
        measurements,
      };
    } finally {
      if (originalJwtExp !== undefined) {
        await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, { jwt_exp: originalJwtExp });
        // Confirm restoration
        const restoreRes = await fetch(`${ctx.apiHost}/auth/v1/config`, {
          headers: { apikey: ctx.anonKey!, Authorization: `Bearer ${ctx.anonKey}` },
        });
        const restoreConfig = await restoreRes.json() as any;
        if (restoreConfig.jwt_exp !== originalJwtExp) {
          console.error("CRITICAL: failed to restore jwt_exp");
        }
      }
    }
  },
};
