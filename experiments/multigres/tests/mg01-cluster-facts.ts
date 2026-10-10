/**
 * MG01 - what the all-in-one Multigres container is, before any fault.
 *
 * Read-only. Records the server and gateway versions, the durability setting
 * the shard bootstrapped with, which cell holds the primary, and what a client
 * sees through the gateway (read-write routing, replication view). Everything
 * later in this experiment is interpreted against these facts: the failover
 * numbers belong to a 3-cell cluster with ANY-1-of-3 synchronous commit on one
 * Docker host, not to the Kubernetes operator deployment.
 */
import { cells, connect, containerOf, gatewayOf, primaryOf } from "../lib/cluster";
import { preflight } from "../lib/preflight";
import type { TestModule, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "MG01",
  title: "Multigres all-in-one cluster: topology and durability setting",
  where: "local",
  async run(ctx): Promise<TestResult> {
    const skip = await preflight(ctx, "MG01", "Multigres cluster facts");
    if (skip) return skip;
    const gw = gatewayOf(ctx, 1);
    const c = await connect(gw.host, gw.port);
    const one = async (sql: string): Promise<string> => {
      try {
        const r = await c.query(sql);
        const row = r.rows[0] as Record<string, unknown> | undefined;
        return row ? String(Object.values(row)[0]) : "(no row)";
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    };
    const m: Record<string, string | number> = {};
    m.server_version = await one("show server_version");
    m.version_banner = (await one("select version()")).slice(0, 80);
    m.multigres_version = await one("select multigres.version()");
    m.synchronous_commit = await one("show synchronous_commit");
    const sync = await one("show synchronous_standby_names");
    // ids are per-run random; keep the shape ("ANY 1 (a, b, c)") and the count
    m.synchronous_standby_names_shape = sync.replace(/"[^"]+"/g, "<id>");
    m.max_connections = await one("show max_connections");
    m.in_recovery_via_gateway = await one("select pg_is_in_recovery()");
    m.read_only_via_gateway = await one("show transaction_read_only");
    m.walsenders_visible_via_gateway = await one("select count(*) from pg_stat_replication");
    await c.end();

    const cs = await cells(containerOf(ctx));
    const p = primaryOf(cs);
    m.cells = cs.length;
    m.primary_cell = p?.cell ?? "none";
    m.standbys = cs.filter((x) => x.inRecovery === true).length;

    return {
      id: "MG01",
      title: "Multigres all-in-one cluster: topology and durability setting",
      status: "info",
      detail: `${cs.length} cells, primary ${p?.cell ?? "none"}, ${m.synchronous_standby_names_shape}, synchronous_commit=${m.synchronous_commit}`,
      measurements: m,
    };
  },
};
export default mod;
