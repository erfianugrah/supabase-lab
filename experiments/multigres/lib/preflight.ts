import type { Ctx, TestResult } from "../../../harness/src/types";
import { connect, containerOf, containerRunning, gatewayOf } from "./cluster";

/** Skip result when there is no cluster to probe, else null. These modules need no capability flag because the cluster is a local container. */
export async function preflight(ctx: Ctx, id: string, title: string): Promise<TestResult | null> {
  const container = containerOf(ctx);
  if (!(await containerRunning(container))) {
    return {
      id,
      title,
      status: "skip",
      detail: `container "${container}" is not running - \`make up\` in experiments/multigres first (or set PVLAB_ENDPOINT_CONTAINER)`,
    };
  }
  const gw = gatewayOf(ctx, 1);
  try {
    const c = await connect(gw.host, gw.port);
    await c.query("select 1");
    await c.end();
  } catch (e) {
    return {
      id,
      title,
      status: "skip",
      detail: `gateway ${gw.host}:${gw.port} not answering: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return null;
}

export const repsOf = (ctx: Ctx, dflt: number): number => {
  const n = Number(ctx.endpoints.reps ?? dflt);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
