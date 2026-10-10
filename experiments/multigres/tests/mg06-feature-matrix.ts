/**
 * MG06 - pooler-semantics S01's feature matrix, re-run through the Multigres
 * multigateway.
 *
 * Same probes (`featuresFor` from experiments/pooler-semantics/lib), same
 * reading: the direct postgres row is the CONTROL and is the only one that
 * asserts; a feature that fails only through a gateway is the finding. The
 * control is the primary's backend port published by the container (25432 +
 * cell offset), i.e. the same postgres the gateway routes to, minus the
 * gateway and multipooler.
 *
 * Rows: a = direct primary (control), b = zone1 gateway, c = zone2 gateway
 * (a second gateway in front of the same shard; whether it differs from b is
 * measured, not assumed).
 *
 * Read-only apart from session-scoped probes (temp table, advisory lock,
 * LISTEN), so it is not destructive and runs before MG02..MG05.
 */
import { Client } from "pg";
import { cells, containerOf, gatewayOf, primaryOf, PG_PASSWORD } from "../lib/cluster";
import { preflight } from "../lib/preflight";
import { featuresFor } from "../../pooler-semantics/lib/features";
import {
  renderEvidence,
  runFeatures,
  summariseRow,
  toMeasurements,
} from "../../../harness/src/matrix";
import type { TestModule, TestResult } from "../../../harness/src/types";

const CELL_MAX = 110;

async function row(id: string, label: string, host: string, port: number, control: boolean, advisoryKey: number): Promise<TestResult> {
  const client = new Client({ host, port, user: "postgres", password: PG_PASSWORD, database: "postgres", connectionTimeoutMillis: 10_000 });
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (e) {
    await client.end().catch(() => {});
    return { id, title: label, status: "skip", detail: `could not connect to ${host}:${port}: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const outcomes = await runFeatures(featuresFor(client, id.toLowerCase(), advisoryKey));
    const { status, detail } = summariseRow(outcomes, { control });
    return {
      id,
      title: label,
      status,
      detail,
      measurements: { mode: label, host_port: `${host}:${port}`, ...toMeasurements(outcomes, CELL_MAX) },
      evidence: renderEvidence(outcomes),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

const mod: TestModule = {
  id: "MG06",
  title: "Pooler feature matrix through the multigateway (S01 probes)",
  where: "local",
  async run(ctx): Promise<TestResult[]> {
    const skip = await preflight(ctx, "MG06", "feature matrix through the gateway");
    if (skip) return [skip];
    const advisoryKey = Date.now() % 2_000_000_000;
    const out: TestResult[] = [];
    const p = primaryOf(await cells(containerOf(ctx)));
    if (p) {
      out.push(await row("MG06a", "direct postgres on the primary (control)", "127.0.0.1", p.pgPort, true, advisoryKey));
    } else {
      out.push({ id: "MG06a", title: "direct postgres (control)", status: "skip", detail: "no primary found" });
    }
    const g1 = gatewayOf(ctx, 1);
    const g2 = gatewayOf(ctx, 2);
    out.push(await row("MG06b", "multigateway zone1", g1.host, g1.port, false, advisoryKey));
    out.push(await row("MG06c", "multigateway zone2", g2.host, g2.port, false, advisoryKey));
    return out;
  },
};
export default mod;
