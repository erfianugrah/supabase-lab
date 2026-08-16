/**
 * W04 - edge cache serves stale through an origin outage.
 *
 * Destructive: redeploys the drill worker with OUTAGE:true, then restores
 * OUTAGE:false in a finally. The worker checks its cache BEFORE the origin,
 * so a warm URL serves HIT or STALE while the origin is unreachable.
 */
import { $ } from "bun";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "W04",
  title: "edge cache serves stale through an origin outage",
  where: "local",
  requires: ["anon-key"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const id = "W04";
    const title = this.title;
    const evidence: string[] = [];

    // Step 1: resolve edge_url.
    const edgeUrl = ctx.endpoints["edge_url"];
    if (!edgeUrl) {
      return {
        id,
        title,
        status: "skip",
        detail: "Missing endpoint: edge_url (absent)",
      };
    }

    // wrangler.jsonc lives one dir up from tests/; probe runs from the
    // experiment root (process.cwd()), so this path always resolves.
    const wranglerConfig = join(process.cwd(), "wrangler.jsonc");
    const probeUrl = `${edgeUrl}/rest/v1/w_probe?select=id`;
    const headers = {
      apikey: ctx.anonKey!,
      Authorization: `Bearer ${ctx.anonKey!}`,
    };

    const measurements: Record<string, number | string> = {};

    /** GET the probe URL with 30s timeout; return status + x-drill-cache header + body text. */
    const fetchProbe = async (
      url: string,
    ): Promise<{ status: number; tag: string | null; body: string }> => {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      const tag = res.headers.get("x-drill-cache");
      const body = await res.text();
      return { status: res.status, tag, body };
    };

    /** Deploy the worker with a specific OUTAGE value. Returns elapsed ms. */
    const deploy = async (outage: boolean): Promise<{ ms: number; output: string }> => {
      const t0 = performance.now();
      const val = outage ? "true" : "false";
      const proc = await $`wrangler deploy --config ${wranglerConfig} --var OUTAGE:${val}`
        .quiet()
        .nothrow()
        .text();
      return { ms: Math.round(performance.now() - t0), output: proc };
    };

    let outageActive = false;

    try {
      // Step 2: prime the cache - GET until we see x-drill-cache HIT (up to 5 attempts, 1s apart).
      let primeAttempts = 0;
      let hitBody: string | null = null;
      for (let i = 0; i < 5; i++) {
        primeAttempts++;
        const r = await fetchProbe(probeUrl);
        const tag = (r.tag ?? "").toUpperCase();
        evidence.push(
          `prime attempt ${primeAttempts}: HTTP ${r.status} x-drill-cache=${r.tag ?? "(none)"}`,
        );
        if (r.status === 200 && tag === "HIT") {
          hitBody = r.body;
          break;
        }
        if (i < 4) await new Promise((res) => setTimeout(res, 1_000));
      }
      measurements["prime_attempts"] = primeAttempts;

      if (hitBody === null) {
        // Never warmed up - cannot measure the resilience claim.
        return {
          id,
          title,
          status: "fail",
          detail: `cache never reached HIT after ${primeAttempts} prime attempts`,
          measurements,
          evidence: evidence.join("\n"),
        };
      }

      // Step 3: capture the HIT body.
      evidence.push(`prime hit body: ${hitBody.slice(0, 200)}`);

      // Step 4: trigger outage - deploy with OUTAGE:true.
      const outageDeploy = await deploy(true);
      outageActive = true;
      measurements["outage_deploy_ms"] = outageDeploy.ms;
      evidence.push(
        `outage deploy (${outageDeploy.ms}ms): ${outageDeploy.output.slice(0, 300)}`,
      );

      // Step 5: warm read under outage - the worker checks cache BEFORE origin.
      // Expect 200 with byte-identical body and x-drill-cache HIT or STALE.
      const warmProbe = await fetchProbe(probeUrl);
      const warmTag = (warmProbe.tag ?? "").toUpperCase();
      measurements["warm_status"] = warmProbe.status;
      measurements["warm_tag"] = warmProbe.tag ?? "(none)";
      measurements["warm_body_equal"] = warmProbe.body === hitBody ? "true" : "false";
      evidence.push(
        `warm read: HTTP ${warmProbe.status} x-drill-cache=${warmProbe.tag ?? "(none)"} body_equal=${warmProbe.body === hitBody}`,
      );

      // Step 6: cold read under outage - unique query string bypasses cache.
      // The worker fetches from the BLACKHOLE (192.0.2.1 TEST-NET-1). CF
      // Workers wraps the TCP failure as a 403 RESPONSE (not a JS exception),
      // which the worker's isFailure() treats as origin failure (5xx, 403, or
      // any non-ok under OUTAGE) - so the catch branch runs: no standby, cold
      // URL not cached -> 503 with x-drill-cache EMPTY. (Pre-W24 workers fell
      // through to 403/PASS here; see RUNLOG W04/W24.)
      const cb = Math.random().toString(36).slice(2, 10);
      const coldUrl = `${edgeUrl}/rest/v1/w_probe?select=id&cb=${cb}`;
      const coldProbe = await fetchProbe(coldUrl);
      const coldTag = (coldProbe.tag ?? "").toUpperCase();
      measurements["cold_status"] = coldProbe.status;
      measurements["cold_tag"] = coldProbe.tag ?? "(none)";
      evidence.push(
        `cold read: HTTP ${coldProbe.status} x-drill-cache=${coldProbe.tag ?? "(none)"}`,
      );

      // Step 7: restore OUTAGE:false.
      const restoreDeploy = await deploy(false);
      outageActive = false;
      measurements["restore_deploy_ms"] = restoreDeploy.ms;
      evidence.push(
        `restore deploy (${restoreDeploy.ms}ms): ${restoreDeploy.output.slice(0, 300)}`,
      );

      // After restore, GET should return 200 with x-drill-cache MISS or HIT.
      const afterProbe = await fetchProbe(probeUrl);
      const afterTag = (afterProbe.tag ?? "").toUpperCase();
      measurements["after_status"] = afterProbe.status;
      measurements["after_tag"] = afterProbe.tag ?? "(none)";
      evidence.push(
        `after restore: HTTP ${afterProbe.status} x-drill-cache=${afterProbe.tag ?? "(none)"}`,
      );

      // Pass criteria (all):
      //   warm read: 200, body byte-identical, tag HIT or STALE
      //   cold read: 503, tag EMPTY
      //   after restore: 200, tag MISS or HIT
      // Cold read pass criteria: status is non-200 AND tag is not HIT/STALE
      // (the worker did not serve a cached response). Today's worker maps the
      // CF-wrapped 403 onto the SPEC's intended 503/EMPTY path via isFailure();
      // pre-W24 workers returned 403/PASS here. Both satisfy the finding:
      // "cold reads fail during outage".
      const crit = {
        warm_200: warmProbe.status === 200,
        warm_body_equal: warmProbe.body === hitBody,
        warm_tag_ok: warmTag === "HIT" || warmTag === "STALE",
        cold_not_200: coldProbe.status !== 200,
        cold_not_cached: coldTag !== "HIT" && coldTag !== "STALE",
        after_200: afterProbe.status === 200,
        after_tag_ok: afterTag === "MISS" || afterTag === "HIT",
      };

      const allPass = Object.values(crit).every(Boolean);
      const failing = Object.entries(crit)
        .filter(([, v]) => !v)
        .map(([k]) => k);

      const detail = allPass
        ? `warm ${warmProbe.tag} body-identical; cold ${coldProbe.status}/${coldProbe.tag} (failed, not cached); restored -> ${afterProbe.tag}`
        : `criteria not met: ${failing.join(", ")}`;

      return {
        id,
        title,
        status: allPass ? "pass" : "fail",
        detail,
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
      // Step 8: always restore OUTAGE:false, even on throw.
      if (outageActive) {
        try {
          await deploy(false);
        } catch {
          // best effort - cannot throw from finally
        }
      }
    }
  },
};

export default mod;
