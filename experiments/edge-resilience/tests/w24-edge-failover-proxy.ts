/**
 * W24 - edge failover proxy with flap damping.
 *
 * Measures whether the drill worker correctly fails over to a standby URL
 * when the primary fails, and holds on standby for HOLD_MS even after the
 * primary is restored (flap damping).
 *
 * Steps:
 * 1. Deploy worker with FAILOVER_PRIMARY=<real> FAILOVER_STANDBY=<real>
 *    HOLD_MS=60000. Prime the probe URL; confirm x-drill-origin: primary.
 * 2. Redeploy with FAILOVER_PRIMARY=<unroutable>. GET -> expect standby.
 * 3. Redeploy with FAILOVER_PRIMARY=<real> restored. Immediately GET ->
 *    expect still standby (hold window). Wait HOLD_MS + buffer. GET ->
 *    expect primary. Record timings.
 * 4. Restore default deploy (no FAILOVER vars).
 *
 * Pass criteria (SPEC W24): "Any measured behavior passes" - the sequence
 * primary/standby/holdover/return is recorded with timings. A fail is only
 * emitted if the worker itself fails to deploy or is unreachable.
 */
import { $ } from "bun";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const UNROUTABLE = "https://192.0.2.1";
// The hold window must comfortably exceed the redeploy+settle path between
// the last outage probe and the holdover probe (~11s observed) - HOLD_MS=15000
// was marginal and measured an expired window.
const HOLD_MS = 60_000;

const mod: TestModule = {
  id: "W24",
  title: "edge failover proxy with flap damping",
  where: "local",
  requires: ["anon-key"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const id = "W24";
    const title = this.title;

    const edgeUrl = ctx.endpoints["edge_url"];
    if (!edgeUrl) {
      return {
        id,
        title,
        status: "skip",
        detail: "Missing endpoint: edge_url (absent)",
      };
    }

    const primaryUrl = `https://${ctx.ref}.supabase.co`;
    const wranglerConfig = join(process.cwd(), "wrangler.jsonc");
    const probeUrl = `${edgeUrl}/rest/v1/w_probe?select=id`;
    const headers = {
      apikey: ctx.anonKey!,
      Authorization: `Bearer ${ctx.anonKey!}`,
    };

    const measurements: Record<string, number | string> = {};
    const evidence: string[] = [];

    /** Deploy the worker with the given extra vars. */
    const deploy = async (vars: Record<string, string>): Promise<{ ms: number; output: string }> => {
      const t0 = performance.now();
      const varArgs = Object.entries(vars).flatMap(([k, v]) => [`--var`, `${k}:${v}`]);
      const proc = await $`wrangler deploy --config ${wranglerConfig} ${varArgs}`
        .quiet()
        .nothrow()
        .text();
      return { ms: Math.round(performance.now() - t0), output: proc };
    };

    /** GET the probe URL; return status + x-drill-cache + x-drill-origin. */
    const fetchProbe = async (
      url: string,
    ): Promise<{ status: number; cache: string | null; origin: string | null; body: string }> => {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      const cache = res.headers.get("x-drill-cache");
      const origin = res.headers.get("x-drill-origin");
      const body = await res.text();
      return { status: res.status, cache, origin, body };
    };

    /** Unique cache-buster query param per step. The worker strips
     *  _-prefixed params from the origin URL (PostgREST would 400 on unknown
     *  params) but keeps the full URL in the cache key, so each step gets a
     *  fresh cache entry. Failover hold state lives in the Cache API
     *  (https://worker/last-failure) and persists across redeploys - that is
     *  what the holdover probe exercises. */
    const freshUrl = () => `${edgeUrl}/rest/v1/w_probe?select=id&_w24=${Date.now()}`;

    let restoredDeployPending = false;

    try {
      // Step 1: deploy with failover mode enabled (both real URLs).
      const d1 = await deploy({
        FAILOVER_PRIMARY: primaryUrl,
        FAILOVER_STANDBY: primaryUrl, // standby = same project; origin header tells us which path
        HOLD_MS: String(HOLD_MS),
      });
      measurements["deploy1_ms"] = d1.ms;
      evidence.push(`deploy1 (${d1.ms}ms): ${d1.output.slice(0, 200)}`);

      // Prime the cache - up to 5 attempts until we get a response.
      let primeOrigin: string | null = null;
      for (let i = 0; i < 5; i++) {
        const r = await fetchProbe(freshUrl());
        evidence.push(`prime attempt ${i + 1}: HTTP ${r.status} cache=${r.cache} origin=${r.origin}`);
        if (r.status === 200) {
          primeOrigin = r.origin;
          break;
        }
        await new Promise((res) => setTimeout(res, 2_000));
      }
      measurements["prime_origin"] = primeOrigin ?? "none";

      // Step 2: simulate primary outage by pointing FAILOVER_PRIMARY at an
      // unroutable address.
      const d2 = await deploy({
        FAILOVER_PRIMARY: UNROUTABLE,
        FAILOVER_STANDBY: primaryUrl,
        HOLD_MS: String(HOLD_MS),
      });
      measurements["deploy2_ms"] = d2.ms;
      evidence.push(`deploy2 outage (${d2.ms}ms): ${d2.output.slice(0, 200)}`);
      restoredDeployPending = true;

      // Allow a brief settle for CF to propagate the new version.
      await new Promise((res) => setTimeout(res, 3_000));

      let outageOrigin: string | null = null;
      let outageStatus = 0;
      for (let i = 0; i < 5; i++) {
        const r = await fetchProbe(freshUrl());
        evidence.push(`outage probe ${i + 1}: HTTP ${r.status} cache=${r.cache} origin=${r.origin}`);
        outageStatus = r.status;
        if (r.status === 200) {
          outageOrigin = r.origin;
          break;
        }
        await new Promise((res) => setTimeout(res, 2_000));
      }
      measurements["outage_status"] = outageStatus;
      measurements["outage_origin"] = outageOrigin ?? "none";

      // Step 3: restore primary URL. The hold window should keep the worker on
      // standby immediately after restore.
      const d3 = await deploy({
        FAILOVER_PRIMARY: primaryUrl,
        FAILOVER_STANDBY: primaryUrl,
        HOLD_MS: String(HOLD_MS),
      });
      measurements["deploy3_ms"] = d3.ms;
      evidence.push(`deploy3 restore (${d3.ms}ms): ${d3.output.slice(0, 200)}`);
      restoredDeployPending = false;

      // Allow a brief settle.
      await new Promise((res) => setTimeout(res, 3_000));

      // Probe immediately after restore - should still be on standby (hold window).
      const holdProbe = await fetchProbe(freshUrl());
      measurements["holdover_status"] = holdProbe.status;
      measurements["holdover_origin"] = holdProbe.origin ?? "none";
      evidence.push(
        `holdover probe (immediately after restore): HTTP ${holdProbe.status} cache=${holdProbe.cache} origin=${holdProbe.origin}`,
      );

      // Wait for the hold window to expire, then probe again.
      const waitMs = HOLD_MS + 5_000; // extra 5s buffer
      evidence.push(`waiting ${waitMs}ms for hold window to expire...`);
      await new Promise((res) => setTimeout(res, waitMs));

      const returnProbe = await fetchProbe(freshUrl());
      measurements["return_status"] = returnProbe.status;
      measurements["return_origin"] = returnProbe.origin ?? "none";
      evidence.push(
        `return probe (after hold window): HTTP ${returnProbe.status} cache=${returnProbe.cache} origin=${returnProbe.origin}`,
      );

      // Step 4: restore default deploy. Clear the failover vars explicitly -
      // an empty string is falsy in the worker, and this also covers the case
      // where wrangler keeps CLI-set vars from a previous deploy.
      const d4 = await deploy({
        OUTAGE: "false",
        FAILOVER_PRIMARY: "",
        FAILOVER_STANDBY: "",
        HOLD_MS: "",
      });
      measurements["deploy4_ms"] = d4.ms;
      evidence.push(`deploy4 default restore (${d4.ms}ms): ${d4.output.slice(0, 200)}`);

      // Pass criteria: SPEC says "Any measured behavior passes" - record the
      // sequence and timings. The only failure is an infrastructure error
      // (deploy failed, worker unreachable).
      return {
        id,
        title,
        status: "pass",
        detail: `failover sequence: prime=${primeOrigin ?? "none"} -> outage(${outageOrigin ?? "none"}) -> holdover=${holdProbe.origin ?? "none"} -> return=${returnProbe.origin ?? "none"}`,
        measurements,
        evidence: evidence.join("\n"),
      };
    } catch (e: unknown) {
      return {
        id,
        title,
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
        measurements,
        evidence: evidence.join("\n"),
      };
    } finally {
      // Always restore the default deploy (same var-clearing as step 4).
      if (restoredDeployPending) {
        try {
          await deploy({
            OUTAGE: "false",
            FAILOVER_PRIMARY: "",
            FAILOVER_STANDBY: "",
            HOLD_MS: "",
          });
        } catch {
          // best effort
        }
      }
    }
  },
};

export default mod;
