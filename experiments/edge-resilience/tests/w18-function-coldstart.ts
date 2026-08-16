/**
 * W18 - edge function cold start.
 *
 * Measures the latency difference between a cold start (after idle)
 * and a warm start (back-to-back) for an Edge Function.
 *
 * Pass criteria: cold and warm distributions recorded. Any measured
 * behavior passes.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W18",
  title: "edge function cold start",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const slug = "w18-sleeper";
    const name = "w18-sleeper";
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

      // 2. Cold start: after deploy, wait 60s of no invocations, then invoke 5 times with 60s gaps (ms=0).
      ctx.log(`Waiting 60s for cold start period...`);
      await new Promise((r) => setTimeout(r, 60000));

      const coldDurations: number[] = [];
      const coldElapseds: number[] = [];

      for (let i = 0; i < 5; i++) {
        ctx.log(`Cold invocation ${i + 1}/5...`);
        const url = `https://${apiHost}/functions/v1/${slug}?ms=0`;
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
            signal: AbortSignal.timeout(30000),
          });
          status = res.status;
          bodyText = await res.text();
          if (res.ok) {
            const json = JSON.parse(bodyText);
            elapsed = json.elapsed;
          }
        } catch (e: any) {
          ctx.log(`Cold invocation ${i + 1} failed: ${e.message}`);
          bodyText = e.message;
        }

        const duration = Date.now() - start;
        coldDurations.push(duration);
        if (elapsed !== undefined) {
          coldElapseds.push(elapsed);
        }
        measurements[`cold_iter_${i + 1}_duration_ms`] = duration;
        if (elapsed !== undefined) {
          measurements[`cold_iter_${i + 1}_elapsed_ms`] = elapsed;
        }
        measurements[`cold_iter_${i + 1}_status`] = status;

        // 60s gap between cold invocations.
        if (i < 4) {
          ctx.log(`Waiting 60s for next cold iteration...`);
          await new Promise((r) => setTimeout(r, 60000));
        }
      }

      // 3. Warm: invoke 20 times back-to-back (ms=0).
      ctx.log(`Starting warm phase (20 iterations)...`);
      const warmDurations: number[] = [];
      for (let i = 0; i < 20; i++) {
        const url = `https://${apiHost}/functions/v1/${slug}?ms=0`;
        const start = Date.now();
        let status = 0;
        let bodyText = "";

        try {
          const res = await fetch(url, {
            headers: {
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
            },
            signal: AbortSignal.timeout(30000),
          });
          status = res.status;
          bodyText = await res.text();
        } catch (e: any) {
          ctx.log(`Warm invocation ${i + 1} failed: ${e.message}`);
          bodyText = e.message;
        }

        const duration = Date.now() - start;
        warmDurations.push(duration);
        measurements[`warm_iter_${i + 1}_duration_ms`] = duration;
        measurements[`warm_iter_${i + 1}_status`] = status;
      }

      // Helper for percentiles
      const getPercentile = (arr: number[], p: number) => {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[index] ?? 0;
      };

      if (coldDurations.length > 0) {
        measurements["cold_p50_duration_ms"] = getPercentile(coldDurations, 50);
        measurements["cold_p99_duration_ms"] = getPercentile(coldDurations, 99);
      }
      if (warmDurations.length > 0) {
        measurements["warm_p50_duration_ms"] = getPercentile(warmDurations, 50);
        measurements["warm_p99_duration_ms"] = getPercentile(warmDurations, 99);
      }

      return {
        id: "W18",
        title: this.title,
        status: "pass",
        detail: "Edge function cold vs warm start latency measured",
        measurements,
      };
    } catch (e: any) {
      return {
        id: "W18",
        title: "Deployment error",
        status: "fail",
        detail: e.message,
        measurements,
      };
    } finally {
      // 4. Finally: delete the function.
      ctx.log(`Deleting function ${slug}...`);
      await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/functions/${slug}`).catch(() => {});
    }
  },
};

export default mod;
