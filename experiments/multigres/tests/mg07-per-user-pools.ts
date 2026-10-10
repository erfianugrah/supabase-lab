/**
 * MG07 - does the multigateway keep a pool per user?
 *
 * The v0.1.0 release notes list "per-user pools". Observable consequence: a
 * client that logs in as role X is served by a postgres backend whose
 * `usename` is X (a shared superuser pool with SET ROLE would show the
 * superuser), and two roles never share a backend pid. Both are read from
 * pg_stat_activity on the primary, through the same gateway.
 *
 * Read-only apart from two throwaway roles, dropped in `finally`.
 */
import { Client } from "pg";
import { connect, gatewayOf } from "../lib/cluster";
import { preflight } from "../lib/preflight";
import type { TestModule, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "MG07",
  title: "Per-user pools: backend role seen in pg_stat_activity",
  where: "local",
  async run(ctx): Promise<TestResult> {
    const skip = await preflight(ctx, "MG07", "per-user pools");
    if (skip) return skip;
    const gw = gatewayOf(ctx, 1);
    const admin = await connect(gw.host, gw.port);
    const roles = ["mg07_a", "mg07_b"];
    const clients: Client[] = [];
    try {
      for (const r of roles) {
        await admin.query(`drop role if exists ${r}`);
        await admin.query(`create role ${r} login password 'pw_${r}'`);
      }
      const seen: Record<string, { pid: number; currentUser: string; backendUser: string }> = {};
      for (const r of roles) {
        const c = new Client({ host: gw.host, port: gw.port, user: r, password: `pw_${r}`, database: "postgres", connectionTimeoutMillis: 5000 });
        c.on("error", () => {});
        await c.connect();
        clients.push(c);
        const q = await c.query<{ pid: number; u: string }>("select pg_backend_pid() as pid, current_user as u");
        const pid = Number(q.rows[0]!.pid);
        const a = await admin.query<{ usename: string }>("select usename from pg_stat_activity where pid = $1", [pid]);
        seen[r] = { pid, currentUser: q.rows[0]!.u, backendUser: a.rows[0]?.usename ?? "(pid not visible)" };
      }
      const a = seen.mg07_a!;
      const b = seen.mg07_b!;
      const perUser = a.backendUser === "mg07_a" && b.backendUser === "mg07_b";
      return {
        id: "MG07",
        title: "Per-user pools: backend role seen in pg_stat_activity",
        status: "info",
        detail: perUser
          ? "each role was served by a backend logged in as that role"
          : `backend roles seen: ${a.backendUser}, ${b.backendUser}`,
        measurements: {
          a_current_user: a.currentUser,
          a_backend_usename: a.backendUser,
          b_current_user: b.currentUser,
          b_backend_usename: b.backendUser,
          distinct_backend_pids: a.pid !== b.pid ? "yes" : "no",
        },
      };
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
      for (const r of roles) await admin.query(`drop role if exists ${r}`).catch(() => {});
      await admin.end().catch(() => {});
    }
  },
};
export default mod;
