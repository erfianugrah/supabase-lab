/**
 * W03 - jwt_exp lever: accepted AND effective.
 *
 * Mutates auth config (jwt_exp). Restores the original value in a finally.
 * Uses the admin users API, not /auth/v1/signup, to avoid email-rate-limit.
 */
import type { TestModule, Ctx, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W03",
  title: "jwt_exp lever: accepted AND effective",
  where: "local",
  requires: ["pat", "anon-key"],
  // NOT destructive per SPEC; config is mutated and restored inside the run.

  async run(ctx: Ctx): Promise<TestResult> {
    if (!ctx.serviceKey) {
      return {
        id: "W03",
        title: this.title,
        status: "skip",
        detail: "serviceKey absent (SUPABASE_SERVICE_ROLE_KEY not set)",
      };
    }

    const measurements: Record<string, number | string> = {};
    let originalJwtExp: number | undefined;
    const targetExp = 43200;

    try {
      // Step 1: read current jwt_exp via management API.
      const getRes = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
      if (getRes.status !== 200 || !getRes.json) {
        return {
          id: "W03",
          title: this.title,
          status: "fail",
          detail: `GET /config/auth HTTP ${getRes.status}`,
          evidence: getRes.text.slice(0, 400),
          measurements,
        };
      }
      const currentConfig = getRes.json as Record<string, unknown>;
      originalJwtExp = typeof currentConfig.jwt_exp === "number" ? currentConfig.jwt_exp : undefined;
      if (originalJwtExp === undefined) {
        return {
          id: "W03",
          title: this.title,
          status: "fail",
          detail: `jwt_exp missing or non-numeric in config response`,
          evidence: getRes.text.slice(0, 400),
          measurements,
        };
      }
      measurements["initial_jwt_exp"] = originalJwtExp;

      // Step 2: PATCH to 43200, then poll until readback matches.
      const patchRes = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, {
        jwt_exp: targetExp,
      });
      if (patchRes.status >= 300) {
        return {
          id: "W03",
          title: this.title,
          status: "fail",
          detail: `PATCH /config/auth HTTP ${patchRes.status}`,
          evidence: patchRes.text.slice(0, 400),
          measurements,
        };
      }

      const pollStart = Date.now();
      let readbackExp: number | undefined;
      while (Date.now() - pollStart < 30_000) {
        const pollRes = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
        if (pollRes.json) {
          const cfg = pollRes.json as Record<string, unknown>;
          if (cfg.jwt_exp === targetExp) {
            readbackExp = targetExp;
            break;
          }
        }
        await new Promise<void>((r) => setTimeout(r, 2_000));
      }

      if (readbackExp !== targetExp) {
        return {
          id: "W03",
          title: this.title,
          status: "fail",
          detail: `config write not readable back: last readback=${readbackExp ?? "undefined"}`,
          measurements,
        };
      }
      measurements["readback_jwt_exp"] = readbackExp;

      // Step 3: effect check via admin users API (no email send -> no rate limit).
      const apiHost = `https://${ctx.apiHost}`;
      const effectStart = Date.now();
      let effectiveExp: number | undefined;
      let signupAttempts = 0;
      let lastCreatedUserId: string | undefined;

      while (Date.now() - effectStart < 60_000) {
        signupAttempts++;
        const rand = Math.random().toString(36).slice(2, 10);
        const email = `w03-${rand}-${Date.now()}@example.com`;
        const password = `W03-${rand}-pass!`;

        // Create user without email send via admin endpoint.
        const createRes = await fetch(`${apiHost}/auth/v1/admin/users`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: ctx.serviceKey!,
            Authorization: `Bearer ${ctx.serviceKey}`,
          },
          body: JSON.stringify({
            email,
            password,
            email_confirm: true,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!createRes.ok) {
          const errText = await createRes.text().catch(() => "");
          // 429 / service restart transient - wait and retry
          await new Promise<void>((r) => setTimeout(r, 5_000));
          measurements[`attempt_${signupAttempts}_create_error`] = `HTTP ${createRes.status} ${errText.slice(0, 60)}`;
          continue;
        }

        const created = (await createRes.json()) as { id?: string };
        lastCreatedUserId = created.id;

        // Get a token via password grant.
        const tokenRes = await fetch(
          `${apiHost}/auth/v1/token?grant_type=password`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: ctx.anonKey!,
            },
            body: JSON.stringify({ email, password }),
            signal: AbortSignal.timeout(30_000),
          },
        );

        if (!tokenRes.ok) {
          // Clean up this user and retry
          if (lastCreatedUserId) {
            await fetch(`${apiHost}/auth/v1/admin/users/${lastCreatedUserId}`, {
              method: "DELETE",
              headers: {
                apikey: ctx.serviceKey!,
                Authorization: `Bearer ${ctx.serviceKey}`,
              },
            }).catch(() => {});
            lastCreatedUserId = undefined;
          }
          await new Promise<void>((r) => setTimeout(r, 5_000));
          continue;
        }

        const tokenData = (await tokenRes.json()) as {
          access_token?: string;
        };

        // Clean up the user (best effort).
        if (lastCreatedUserId) {
          await fetch(`${apiHost}/auth/v1/admin/users/${lastCreatedUserId}`, {
            method: "DELETE",
            headers: {
              apikey: ctx.serviceKey!,
              Authorization: `Bearer ${ctx.serviceKey}`,
            },
          }).catch(() => {});
          lastCreatedUserId = undefined;
        }

        if (!tokenData.access_token) {
          await new Promise<void>((r) => setTimeout(r, 5_000));
          continue;
        }

        // Decode payload (no verification needed; just measure exp - iat).
        try {
          const parts = tokenData.access_token.split(".");
          const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
          const payload = JSON.parse(
            Buffer.from(padded, "base64").toString("utf8"),
          ) as { exp?: number; iat?: number };
          if (typeof payload.exp === "number" && typeof payload.iat === "number") {
            const ttl = payload.exp - payload.iat;
            measurements[`attempt_${signupAttempts}_ttl`] = ttl;
            if (ttl === targetExp) {
              effectiveExp = ttl;
              break;
            }
          }
        } catch {
          // malformed JWT - retry
        }

        await new Promise<void>((r) => setTimeout(r, 5_000));
      }

      // Final cleanup of any dangling user.
      if (lastCreatedUserId) {
        await fetch(`${apiHost}/auth/v1/admin/users/${lastCreatedUserId}`, {
          method: "DELETE",
          headers: {
            apikey: ctx.serviceKey!,
            Authorization: `Bearer ${ctx.serviceKey}`,
          },
        }).catch(() => {});
      }

      measurements["signup_attempts"] = signupAttempts;
      measurements["effect_delay_ms"] = Date.now() - effectStart;

      if (effectiveExp !== targetExp) {
        return {
          id: "W03",
          title: this.title,
          status: "fail",
          detail: `issuer still minting ${effectiveExp ?? "unknown"}s tokens 60s after config accepted ${targetExp}`,
          measurements,
        };
      }

      measurements["effective_jwt_exp"] = effectiveExp;

      return {
        id: "W03",
        title: this.title,
        status: "pass",
        detail: `jwt_exp written, read back, and effective: ${effectiveExp}s tokens minted`,
        measurements,
      };
    } catch (e: unknown) {
      return {
        id: "W03",
        title: this.title,
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
        measurements,
      };
    } finally {
      // Restore original jwt_exp unconditionally.
      if (originalJwtExp !== undefined) {
        try {
          await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, {
            jwt_exp: originalJwtExp,
          });
          // Confirm restoration.
          const confirmRes = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
          if (confirmRes.json) {
            const cfg = confirmRes.json as Record<string, unknown>;
            if (cfg.jwt_exp !== originalJwtExp) {
              ctx.log(`WARN: jwt_exp restore unconfirmed; expected ${originalJwtExp}, got ${cfg.jwt_exp}`);
            }
          }
        } catch (e: unknown) {
          ctx.log(`WARN: failed to restore jwt_exp: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  },
};

export default mod;
