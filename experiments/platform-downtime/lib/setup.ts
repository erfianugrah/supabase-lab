/**
 * Shared assembly for every module in this experiment.
 *
 * D01 and D02 differ only in which operation they trigger. Everything else -
 * which paths to watch, how to turn windows into report columns, how to read a
 * result - is identical, and duplicating it per module is how the two drift
 * into measuring subtly different things.
 */
import type { Ctx, TestResult } from "../../../harness/src/types";
import type { PathWindow, Probe } from "../../../harness/src/sampler";
import { mgmt } from "../../../harness/src/mgmt";
import { restProbe, authProbe, storageProbe, realtimeProbe, poolerProbe } from "./probes";

/** Verified 200 on a fresh project 2026-08-04; /auth/v1/settings also answers. */
export const AUTH_PATH = "/auth/v1/health";

export const INTERVAL_MS = 500;
export const SETTLE_MS = 5000;

export interface PoolerTarget {
  host: string;
  port: number;
  user: string;
}

/**
 * Read the pooler connection surface from the platform rather than building it.
 * The host is region-dependent (`aws-0-...` on this project, and the digit is
 * not a constant), and the mode-to-port mapping is a platform fact.
 */
export async function resolvePooler(ctx: Ctx): Promise<PoolerTarget | null> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/database/pooler`);
  if (r.status !== 200 || !r.json) return null;
  const body = Array.isArray(r.json) ? r.json[0] : r.json;
  const rec = body as Record<string, unknown> | undefined;
  const host = typeof rec?.db_host === "string" ? rec.db_host : null;
  const port = typeof rec?.db_port === "number" ? rec.db_port : null;
  const user = typeof rec?.db_user === "string" ? rec.db_user : null;
  if (!host || !port || !user) return null;
  return { host, port, user };
}

export async function buildProbes(ctx: Ctx): Promise<{ probes: Probe[]; note: string }> {
  const anon = ctx.anonKey as string;
  const probes: Probe[] = [
    restProbe(ctx.apiHost, anon),
    authProbe(ctx.apiHost, anon, AUTH_PATH),
    storageProbe(ctx.apiHost, anon),
    realtimeProbe(ctx.apiHost, anon),
  ];

  // BOTH conditions. Resolving the target proves the surface exists; the
  // password is what makes a connection meaningful. Without it the probe fails
  // from sample zero, which the healthy-at-start guard would then report as
  // "already failing before the operation" and skip the whole module - a
  // missing password should cost you one PATH, not the run.
  const pooler = await resolvePooler(ctx);
  if (pooler && ctx.dbPassword) {
    probes.push(poolerProbe(pooler.host, pooler.port, pooler.user, ctx.dbPassword));
    return { probes, note: `pooler ${pooler.host}:${pooler.port}` };
  }
  return {
    probes,
    note: pooler ? "pooler skipped: no DB_PASSWORD" : "pooler skipped: config not readable",
  };
}

/**
 * Compute size is an ADDON mutation, not a resize endpoint:
 * `PATCH /v1/projects/{ref}/billing/addons` with `{addon_variant, addon_type}`.
 * Verb, path and body read off the published OpenAPI document on 2026-08-04.
 * Variants run `ci_micro` through `ci_48xlarge`; that enum is the API SURFACE,
 * which is not the same as what a given project is entitled to buy - the GET
 * sibling returns the latter, and it is what F02 reads for the catalogue.
 */
export async function setComputeSize(ctx: Ctx, variant: string): Promise<void> {
  const r = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/billing/addons`, {
    addon_variant: variant,
    addon_type: "compute_instance",
  });
  if (r.status === undefined || r.status >= 300) {
    throw new Error(`resize to ${variant} failed: HTTP ${r.status} ${(r.text ?? "").slice(0, 200)}`);
  }
  ctx.log(`compute -> ${variant}: HTTP ${r.status}`);
}

/**
 * One column per path, plus the resolution the numbers were taken at.
 *
 * `first_fail_s` is separate from `window_s` on purpose: for an operation that
 * takes effect asynchronously, how long the platform took to BITE is a different
 * fact from how long the outage then lasted, and only the first is available
 * when a run ends before recovery.
 *
 * BITE is measured from when SAMPLING STARTED, not from when the operation's own
 * API call returned. `sampleDuring` sets t0 before the probe loops begin and then
 * awaits operation(), so the request's own latency sits inside the window. This
 * comment used to claim "after the API returned 2xx"; RUNLOG repeated it and a
 * published doc inherited it. Capture the response timestamp and subtract if the
 * response-relative figure is ever what you want.
 */
export function flatten(windows: PathWindow[]): Record<string, number | string> {
  const m: Record<string, number | string> = { probe_interval_ms: INTERVAL_MS };
  for (const w of windows) {
    m[`${w.name}_first_fail_s`] =
      w.firstFailMs === null ? "n/a" : Math.round(w.firstFailMs / 1000);
    m[`${w.name}_window_s`] = w.windowMs === null ? "n/a" : Math.round(w.windowMs / 1000);
    m[`${w.name}_mode`] = w.modes[0] ?? "none";
  }
  return m;
}

/**
 * A path that was already down going in voids the run for that operation - the
 * outage was not caused by what we did, and reporting a window would be a lie.
 */
export function verdict(
  id: string,
  title: string,
  windows: PathWindow[],
): Pick<TestResult, "id" | "title" | "status" | "detail" | "measurements"> {
  const measurements = flatten(windows);
  const unhealthy = windows.filter((w) => !w.healthyAtStart).map((w) => w.name);
  const stuck = windows.filter((w) => w.firstFailMs !== null && w.recoveredMs === null);
  const downed = windows.filter((w) => w.firstFailMs !== null);

  if (unhealthy.length > 0) {
    return {
      id,
      title,
      status: "skip",
      detail: `path(s) already failing before the operation: ${unhealthy.join(", ")}`,
      measurements,
    };
  }

  return {
    id,
    title,
    status: stuck.length > 0 ? "fail" : "pass",
    detail:
      stuck.length > 0
        ? `never recovered within the probe window: ${stuck.map((w) => w.name).join(", ")}`
        : downed.length === 0
          ? "no client-visible failure on any path"
          : `outage on ${downed
              .map((w) => `${w.name} ${Math.round((w.windowMs as number) / 1000)}s`)
              .join(", ")}`,
    measurements,
  };
}
