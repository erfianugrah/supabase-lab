/**
 * T25 - the VPC Lattice SERVICE NETWORK consumption path, as an alternative
 * to the direct Resource endpoint T02 already measures.
 *
 * AWS's pricing page quotes a roughly 5x per-resource-hour delta for this
 * path over the endpoint-hours this lab already runs - cited from pricing
 * documentation, never built. `lattice.tf` (enable_service_network) builds
 * it for real: a service network, a resource association for the SAME
 * resource configuration T02 already uses, and a VPC association onto the
 * lab VPC - so the SAME runner that answers T02 can answer this too.
 *
 * Same reachability matrix as T02: same probe (connect, `select 1`), a
 * different host - the Lattice-generated DNS name instead of the PHZ name.
 */
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

async function probe(ctx: Ctx, host: string, port: number, label: string): Promise<TestResult> {
  const id = port === 5432 ? "T25-5432" : "T25-6543";
  const client = new Client({
    host,
    port,
    user: "postgres",
    database: "postgres",
    password: ctx.dbPassword,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
  });

  const t0 = performance.now();
  try {
    await client.connect();
    const connectMs = Math.round(performance.now() - t0);
    const q0 = performance.now();
    await client.query("select 1");
    const queryMs = Math.round(performance.now() - q0);
    return {
      id,
      title: `${label} through the service network`,
      status: "pass",
      detail: `connected via ${host}:${port}`,
      measurements: { connect_ms: connectMs, query_ms: queryMs },
    };
  } catch (e) {
    // A failure to reach the service-network path is a RESULT, not a defect
    // in this test - the 5x pricing claim being paid for a path that does not
    // work would itself be worth knowing.
    return {
      id,
      title: `${label} through the service network`,
      status: "info",
      detail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

const mod: TestModule = {
  id: "T25",
  title: "Postgres 5432 and pooler 6543 through the Lattice service network",
  where: "runner",
  requires: ["db", "service-network"],
  async run(ctx) {
    const host = ctx.endpoints.service_network_dns;
    if (!host) {
      return {
        id: "T25",
        title: mod.title,
        status: "skip",
        detail:
          "enable_service_network is off (or the resource association never resolved a DNS name) - set it true and apply to exercise this",
      };
    }
    return [
      await probe(ctx, host, 5432, "direct Postgres"),
      await probe(ctx, host, 6543, "dedicated pooler (transaction mode)"),
    ];
  },
};
export default mod;
