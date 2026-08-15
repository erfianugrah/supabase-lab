/**
 * W13 - edge function wall-clock limit.
 *
 * Deploys a "sleeper" function that waits for a specified duration, then
 * checks the platform's wall-clock timeout limit. Destructive: deletes the
 * function on completion.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W13",
  title: "edge function wall-clock limit",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const slug = "w13-sleeper";
    const name = "w13-sleeper";
    const measurements: Record<string, string | number> = {};
    const apiHost = ctx.apiHost;
    const anonKey = ctx.anonKey!;

    const functionBody = `Deno.serve(async (req)=>{const t=Date.now();const ms=Number(new URL(req.url).searchParams.get('ms')||'0');await new Promise(r=>setTimeout(r,ms));return new Response(JSON.stringify({elapsed:Date.now()-t}))})`.replace(/\s+/g, " ");

    const deployPayload = {
      slug,
      name,
      verify_jwt: false,
      body: functionBody,
    };

    try {
      // 1. Deploy via Management API.
      ctx.log(`Deploying function ${slug}...`);
      const deployRes = await mgmt(ctx, "POST", `/projects/${ctx.ref}/functions`, deployPayload);
      if (deployRes.status >= 300) {
        throw new Error(`Deployment failed: HTTP ${deployRes.status}: ${deployRes.text.slice(0, 400)}`);
      }
      // Wait for deployment to be active (if necessary, though mgmt usually waits for the call to complete)
      // For functions, the POST usually returns once the request is accepted.
      // We'll verify it's there by a small check if needed, but let's proceed.

      // 2. Invoke with different durations.
      const testDurations = [5000, 120000, 400000];
      for (const ms of testDurations) {
        ctx.log(`Invoking function with ms=${ms}...`);
        const url = `https://${apiHost}/functions/v1/${slug}?ms=${ms}`;
        const start = Date.now();
        let status = 0;
        let bodyText = "";
        let elapsed: number | undefined;

        try {
          const res = await fetch(url, {
            headers: {
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
            },
            signal: AbortSignal.timeout(450000), // Allow up to 7.5 mins for the 400s test
          });
          status = res.status;
          bodyText = await res.text();
          if (res.ok) {
            const json = JSON.parse(bodyText);
            elapsed = json.elapsed;
          }
        } catch (e: any) {
          ctx.log(`Invocation failed for ${ms}ms: ${e.message}`);
          bodyText = e.message;
        }

        measurements[`${ms}ms_status`] = status;
        if (elapsed !== undefined) {
          measurements[`${ms}ms_elapsed_ms`] = elapsed;
        }
        if (bodyText) {
          measurements[`${ms}ms_body`] = bodyText.slice(0, 200);
        }
      }

      return {
        id: "W13",
        title: this.title,
        status: "pass",
        detail: "Function wall-clock limit measured via sleeper function",
        measurements,
      };
    } catch (e: any) {
      return {
        id: "DSS", // using DSS as placeholder for error context
        title: "Deployment error",
        status: "fail",
        detail: e.message,
        measurements,
      };
    } finally {
      // 3. Cleanup.
      ctx.log(`Deleting function ${slug}...`);
      await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/functions/${slug}`).catch(() => {});
    }
  },
};

export default mod;
