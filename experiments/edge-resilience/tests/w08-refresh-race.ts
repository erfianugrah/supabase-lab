/**
 * W08 - refresh-token rotation race (multi-tab failure mode).
 *
 * Creates a user, gets tokens, then fires two concurrent refreshes with
 * the same refresh_token. Records outcomes for both.
 */
import type { TestModule, Ctx, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "W08",
  title: "refresh-token rotation race",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: false,

  async run(ctx: Ctx): Promise<TestResult> {
    if (!ctx.serviceKey) {
      return {
        id: "W08",
        title: this.title,
        status: "skip",
        detail: "serviceKey absent (SUPABASE_SERVICE_ROLE_KEY not set)",
      };
    }

    const measurements: Record<string, number | string> = {};
    const apiHost = `https://${ctx.apiHost}`;
    let createdUserId: string | undefined;

    try {
      // Step 1: Admin-create a user.
      const rand = Math.random().toString(36).slice(2, 10);
      const email = `w08-${rand}-${Date.now()}@example.com`;
      const password = `W08-${rand}-pass!`;

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
        return {
          id: "W08",
          title: this.title,
          status: "fail",
          detail: `Admin user creation failed: HTTP ${createRes.status}`,
          evidence: errText.slice(0, 400),
          measurements,
        };
      }

      const created = (await createRes.json()) as { id?: string };
      createdUserId = created.id;
      if (!createdUserId) {
        throw new Error("Created user ID is missing in response");
      }

      // Step 2: Password-grant to get access_token + refresh_token.
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
        const errText = await tokenRes.text().catch(() => "");
        return {
          id: "W08",
          title: this.title,
          status: "fail",
          detail: `Password grant failed: HTTP ${tokenRes.status}`,
          evidence: errText.slice(0, 400),
          measurements,
        };
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
      };

      const accessToken = tokenData.access_token;
      const refreshToken = tokenData.refresh_token;

      if (!accessToken || !refreshToken) {
        return {
          id: "W08",
          title: this.title,
          status: "fail",
          detail: "Missing access_token or refresh_token in response",
          measurements,
        };
      }

      // Step 3: Fire TWO concurrent refreshes of the SAME refresh_token simultaneously.
      const refreshTask = async (id: number) => {
        const res = await fetch(
          `${apiHost}/auth/v1/token?grant_type=refresh_token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: ctx.anonKey!,
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ refresh_token: refreshToken }),
            signal: AbortSignal.timeout(30_000),
          },
        );
        const status = res.status;
        const text = await res.text().catch(() => "");
        let errorInfo = "";
        try {
          const errJson = JSON.parse(text);
          errorInfo = errJson.error || errJson.code || "";
        } catch {
          errorInfo = text.slice(0, 50);
        }
        return { id, status, errorInfo };
      };

      const [r1, r2] = await Promise.all([
        refreshTask(1),
        refreshTask(2),
      ]);

      measurements["outcome1_status"] = r1.status;
      measurements["outcome1_error"] = r1.errorInfo;
      measurements["outcome2_status"] = r2.status;
      measurements["outcome2_error"] = r2.errorInfo;

      const evidence = `Outcome 1: HTTP ${r1.status} ${r1.errorInfo}\nOutcome 2: HTTP ${r2.status} ${r2.errorInfo}`;

      return {
        id: "W08",
        title: this.title,
        status: "pass",
        detail: `Concurrent refreshes completed. Outcomes: 1:${r1.status} 2:${r2.status}`,
        measurements,
        evidence,
      };
    } catch (e: unknown) {
      return {
        id: "W08",
        title: this.title,
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
        measurements,
      };
    } finally {
      // Cleanup: delete the user.
      if (createdUserId) {
        await fetch(`${apiHost}/auth/v1/admin/users/${createdUserId}`, {
          method: "DELETE",
          headers: {
            apikey: ctx.serviceKey!,
            Authorization: `Bearer ${ctx.serviceKey}`,
          },
        }).catch(() => {});
      }
    }
  },
};

export default mod;
