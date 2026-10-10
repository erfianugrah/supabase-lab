/**
 * MF01 - what the harness's own Management API client does when the API
 * misbehaves. Every call goes through the local fault proxy; the proxy log is
 * the attempt count, so "retries" is counted at the wire, not inferred from
 * the client's source.
 *
 *   MF01a  mgmt() GET answered 500/502/503/504 on every attempt: attempts
 *          per call, and whether the 5xx comes back as a status or a throw.
 *   MF01b  mgmt() GET answered 500 once, then healthy: does the second
 *          attempt happen on its own.
 *   MF01c  functionPresent() (the one helper that retries) through 429 x2
 *          then healthy, vs 500 x1 then healthy: attempts and the `present`
 *          answer a caller would act on.
 *   MF01d  mgmt() GET held 35 s by the proxy against the client's 30 s
 *          default timeout: what the caller sees and how many attempts.
 *
 * No project is created; the only upstream traffic is read-only GETs. The
 * fault rules answer before contacting upstream (error-before), except the
 * "then healthy" tails, which are read-only.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { functionPresent } from "../../../harness/src/platform.js";
import { attempts, missingTool, shape, withProxy } from "../lib/proxy.js";

const ORGS = /^\/v1\/organizations$/;

const mod: TestModule = {
  id: "MF01",
  title: "Harness mgmt() client under injected 5xx, 429 and latency",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const missing = await missingTool(["docker"]);
    if (missing) return [{ id: "MF01", title: this.title, status: "skip", detail: missing }];
    const results: TestResult[] = [];
    try {
      await withProxy(async (px) => {
        const pctx = { ...ctx, mgmtBase: `${px.url}/v1`, ref: "abcdefghijklmnopqrst" } as Ctx;

        // ---- MF01a: persistent 5xx ----
        const rows: string[] = [];
        const m: Record<string, number | string> = {};
        let ok = true;
        for (const status of [500, 502, 503, 504]) {
          await px.reset();
          await px.setRules([{ id: `s${status}`, method: "GET", path: "^/v1/organizations$", mode: "error-before", status }]);
          let outcome = "";
          try {
            const r = await mgmt(pctx, "GET", "/organizations");
            outcome = `returned status ${r.status}`;
            m[`status_${status}_returned`] = r.status;
          } catch (e) {
            outcome = `threw ${(e as Error).name}`;
            m[`status_${status}_returned`] = `threw`;
            ok = false;
          }
          const n = attempts(await px.log(), "GET", ORGS).length;
          m[`status_${status}_attempts`] = n;
          rows.push(`${status}: ${n} attempt(s), ${outcome}`);
        }
        results.push({
          id: "MF01a",
          title: "MF01a: mgmt() GET on persistent 5xx - attempts per call",
          status: ok ? "info" : "fail",
          detail: rows.join("; "),
          measurements: m,
        });

        // ---- MF01b: one 500 then healthy ----
        await px.reset();
        await px.setRules([{ id: "once500", method: "GET", path: "^/v1/organizations$", mode: "error-before", status: 500, times: 1 }]);
        const first = await mgmt(pctx, "GET", "/organizations");
        const lb = await px.log();
        results.push({
          id: "MF01b",
          title: "MF01b: mgmt() GET after a single transient 500",
          status: "info",
          detail: `first call returned ${first.status}; ${attempts(lb, "GET", ORGS).length} attempt(s) on the wire (upstream would have answered 200)`,
          measurements: { first_call_status: first.status, attempts: attempts(lb, "GET", ORGS).length },
          evidence: shape(lb),
        });

        // ---- MF01c: functionPresent 429 vs 500 ----
        const fnRe = /^\/v1\/projects\/[a-z]{20}\/functions\/mf-probe$/;
        await px.reset();
        await px.setRules([
          { id: "twice429", method: "GET", path: "^/v1/projects/[a-z]{20}/functions/mf-probe$", mode: "error-before", status: 429, times: 2, headers: { "retry-after": "1" } },
        ]);
        const t429 = Date.now();
        const fp429 = await functionPresent(pctx, "mf-probe");
        const ms429 = Date.now() - t429;
        const n429 = attempts(await px.log(), "GET", fnRe).length;
        await px.reset();
        await px.setRules([
          { id: "once500", method: "GET", path: "^/v1/projects/[a-z]{20}/functions/mf-probe$", mode: "error-before", status: 500, times: 1 },
        ]);
        const t500 = Date.now();
        const fp500 = await functionPresent(pctx, "mf-probe");
        const ms500 = Date.now() - t500;
        const n500 = attempts(await px.log(), "GET", fnRe).length;
        results.push({
          id: "MF01c",
          title: "MF01c: functionPresent() through 429 x2 vs 500 x1",
          status: "info",
          detail:
            `429 x2 then upstream: ${n429} attempts, ${ms429} ms, final status ${fp429.status}; ` +
            `500 x1 then upstream: ${n500} attempt(s), ${ms500} ms, status ${fp500.status}, present=${fp500.present}`,
          measurements: {
            r429_attempts: n429,
            r429_ms: ms429,
            r429_final_status: fp429.status,
            r500_attempts: n500,
            r500_ms: ms500,
            r500_status: fp500.status,
            r500_present: fp500.present ? 1 : 0,
          },
        });

        // ---- MF01d: latency beyond the client timeout ----
        await px.reset();
        await px.setRules([{ id: "hold35", method: "GET", path: "^/v1/organizations$", mode: "delay-before", delayMs: 35_000 }]);
        const td = Date.now();
        let outcome = "";
        try {
          const r = await mgmt(pctx, "GET", "/organizations");
          outcome = `returned ${r.status}`;
        } catch (e) {
          outcome = `threw ${(e as Error).name}`;
        }
        const msd = Date.now() - td;
        // The proxy keeps going after the client leaves; give it time to forward so the log row is complete.
        await Bun.sleep(8000);
        const ld = await px.log();
        results.push({
          id: "MF01d",
          title: "MF01d: mgmt() GET held 35 s against the 30 s default timeout",
          status: "info",
          detail: `${outcome} after ${msd} ms; ${attempts(ld, "GET", ORGS).length} attempt(s); proxy row action=${ld[0]?.action} upstream=${ld[0]?.upstreamStatus ?? "-"}`,
          measurements: { client_ms: msd, attempts: attempts(ld, "GET", ORGS).length, threw: outcome.startsWith("threw") ? 1 : 0 },
          evidence: outcome,
        });
      });
    } catch (e) {
      results.push({ id: "MF01", title: "MF01", status: "fail", detail: `test threw: ${e instanceof Error ? e.message : String(e)}` });
    }
    return results;
  },
};
export default mod;
