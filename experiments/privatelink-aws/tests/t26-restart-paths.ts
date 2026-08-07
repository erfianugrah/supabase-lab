/**
 * T26 - restart interruption window, per PRIVATE path, replacing T14.
 *
 * T14 measured one path (the pooler, via a Lambda client) with a hand-rolled
 * loop that treated the FIRST successful sample as "recovered" and had no
 * baseline gate at all: if that probe path was already broken going in, the
 * whole window it reported was pre-existing downtime wearing this test's
 * label. RUNLOG run 8 records two other tests that once reported the exact
 * opposite of the truth for precisely this reason, and that entry's own
 * conclusion - "adopt this for every future fault-injection test" - was
 * never applied here.
 *
 * sampleDuring (harness/src/sampler.ts) is the general fix already built for
 * this: independent per-path sampling, sustained recovery (a settle window,
 * not first success), and a `healthyAtStart` flag per path so a broken
 * control cannot be mistaken for a measured outage. See t21-az-failure.ts for
 * the canonical write-up of why the control matters, and
 * experiments/platform-downtime/lib/setup.ts's verdict() for the same
 * skip-when-unhealthy shape this module mirrors (kept local rather than
 * imported - that helper is platform-downtime's, this experiment's tests
 * import only from harness/src and this experiment's own lib/).
 *
 * Probes the PRIVATE paths - direct Postgres and the dedicated pooler,
 * through the PHZ host - not the public pooler T14 used. platform-downtime
 * already measured the public HTTP tier and public pooler across four
 * operations; this experiment's whole point is the endpoint, so T26 measures
 * through it instead of duplicating that public-side work.
 *
 * DESTRUCTIVE: restarts the project.
 */
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { sampleDuring, type PathWindow, type Probe } from "../../../harness/src/sampler";

const INTERVAL_MS = 500;
const SETTLE_MS = 5000;
const MAX_WAIT_MS = 420_000;

function pgProbe(name: string, ctx: Ctx, port: number): Probe {
  return {
    name,
    async run() {
      const client = new Client({
        host: ctx.phzHost,
        port,
        user: "postgres",
        database: "postgres",
        password: ctx.dbPassword,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 4000,
        query_timeout: 4000,
      });
      try {
        await client.connect();
        await client.query("select 1");
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}

/** One column per path - same shape as platform-downtime's flatten(). */
function flatten(windows: PathWindow[]): Record<string, number | string> {
  const m: Record<string, number | string> = { probe_interval_ms: INTERVAL_MS };
  for (const w of windows) {
    m[`${w.name}_first_fail_s`] = w.firstFailMs === null ? "n/a" : Math.round(w.firstFailMs / 1000);
    m[`${w.name}_window_s`] = w.windowMs === null ? "n/a" : Math.round(w.windowMs / 1000);
    m[`${w.name}_mode`] = w.modes[0] ?? "none";
  }
  return m;
}

const mod: TestModule = {
  id: "T26",
  title: "Restart interruption window, per private path",
  where: "runner",
  requires: ["db", "pat"],
  destructive: true,
  async run(ctx): Promise<TestResult> {
    const probes: Probe[] = [pgProbe("direct-5432", ctx, 5432), pgProbe("pooler-6543", ctx, 6543)];

    const windows = await sampleDuring(
      probes,
      { intervalMs: INTERVAL_MS, maxWaitMs: MAX_WAIT_MS, settleMs: SETTLE_MS, log: ctx.log },
      async () => {
        const res = await mgmt(ctx, "POST", `/projects/${ctx.ref}/restart`);
        if (res.status >= 300) throw new Error(`restart request failed: HTTP ${res.status}`);
        ctx.log(`restart API: HTTP ${res.status}`);
      },
    );

    const measurements = flatten(windows);

    // BASELINE GATE: sampleDuring records healthyAtStart per path - a path
    // already failing before the restart call went out cannot have its
    // downtime attributed to the restart. T14 had no such gate: a broken
    // probe silently absorbed pre-existing downtime into the published
    // window. This is the defect being fixed - if it regresses, the skip
    // below is what would have caught it.
    const unhealthy = windows.filter((w) => !w.healthyAtStart).map((w) => w.name);
    if (unhealthy.length > 0) {
      return {
        id: "T26",
        title: mod.title,
        status: "skip",
        detail: `path(s) already failing before the restart - no control, no conclusion: ${unhealthy.join(", ")}`,
        measurements,
      };
    }

    const stuck = windows.filter((w) => w.firstFailMs !== null && w.recoveredMs === null);
    const downed = windows.filter((w) => w.firstFailMs !== null);

    return {
      id: "T26",
      title: mod.title,
      status: stuck.length > 0 ? "fail" : "pass",
      detail:
        stuck.length > 0
          ? `never recovered within the probe window: ${stuck.map((w) => w.name).join(", ")}`
          : downed.length === 0
            ? "no client-visible failure on either path"
            : `outage on ${downed
                .map((w) => `${w.name} ${Math.round((w.windowMs as number) / 1000)}s`)
                .join(", ")}`,
      measurements,
    };
  },
};
export default mod;
