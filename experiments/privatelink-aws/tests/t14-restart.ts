/**
 * T14 - interruption window during a project restart, measured through the
 * Lambda client rather than a psql loop, because that is the shape a
 * serverless caller actually experiences.
 *
 * DESTRUCTIVE: restarts the project.
 *
 * The failure MODE matters as much as the duration: run 6 measured
 * "timeout expired" rather than a refusal, meaning a function with a long
 * client timeout spends its whole budget on a single attempt.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { invokeProbe } from "./t15-lambda";

const PROBE_EVERY_MS = 5000;
const MAX_WAIT_MS = 420_000;

const mod: TestModule = {
  id: "T14",
  title: "Restart interruption window through a Lambda client",
  where: "local",
  requires: ["lambda", "pat"],
  destructive: true,
  async run(ctx): Promise<TestResult> {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ctx.ref}/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.pat}` },
      signal: AbortSignal.timeout(30000),
    });
    ctx.log(`restart API: HTTP ${res.status}`);
    if (!res.ok) {
      return {
        id: "T14",
        title: "Restart interruption window",
        status: "fail",
        detail: `restart request failed: HTTP ${res.status}`,
      };
    }

    const t0 = Date.now();
    let firstFail: number | null = null;
    let recovered: number | null = null;
    const errors = new Set<string>();

    while (Date.now() - t0 < MAX_WAIT_MS) {
      const probe = await invokeProbe(ctx.region, { port: 6543 });
      const ok = probe.all_ok === true;
      const err = probe.results?.[0]?.error;
      if (err) errors.add(err.slice(0, 80));
      ctx.log(`${new Date().toISOString().slice(11, 19)} ok=${ok}${err ? ` err=${err}` : ""}`);

      if (!ok && firstFail === null) firstFail = Date.now();
      if (ok && firstFail !== null) {
        recovered = Date.now();
        break;
      }
      await Bun.sleep(PROBE_EVERY_MS);
    }

    if (firstFail === null) {
      return {
        id: "T14",
        title: "Restart interruption window",
        status: "info",
        detail: "no client-visible failure observed - restart completed between probes",
        measurements: { probe_interval_s: PROBE_EVERY_MS / 1000 },
      };
    }

    const windowS = recovered ? Math.round((recovered - firstFail) / 1000) : null;
    return {
      id: "T14",
      title: "Restart interruption window",
      status: recovered ? "pass" : "fail",
      detail: recovered
        ? `client-visible outage ${windowS}s; failure mode: ${[...errors].join("; ") || "unknown"}`
        : "never recovered within the probe window",
      measurements: {
        window_s: windowS ?? "n/a",
        probe_interval_s: PROBE_EVERY_MS / 1000,
        failure_mode: [...errors].join("; ") || "none",
      },
    };
  },
};
export default mod;
