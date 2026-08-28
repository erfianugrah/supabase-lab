/**
 * L20 - the fully-locked end state, from the runner vantage.
 *
 * The composition privatelink-aws does not test: PrivateLink up AND network
 * restrictions at restrict-all AND Data API off, all at once. The claim is
 * that the private DB path survives the HTTP lockdown - and this is where it is
 * shown, closing the T22d/e/f gap http-tier-lockdown left open.
 *
 *   L20a - from inside the VPC, the DB socket over the PrivateLink endpoint is
 *          reachable on 5432 and 6543 even with restrict-all applied to the
 *          public internet and the Data API wedged. (Full psql auth over the
 *          endpoint is privatelink-aws's T01-T09; here it is the TCP reach that
 *          proves the private path is alive under the lockdown.)
 *
 * The public-vantage half - which HTTP surfaces still answer under the same
 * lockdown - is the local-vantage L01 inventory run alongside this.
 *
 * where: "runner" - executes in-VPC via SSM (privatelink-aws/suite.sh is the
 * orchestration reference). Self-skips without the "endpoint" capability, i.e.
 * when the Phase C AWS stack is not applied.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { connect } from "node:net";

function tcpReach(host: string, port: number, timeoutMs = 8000): Promise<{ ok: boolean; ms: number; err?: string }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const sock = connect({ host, port });
    const done = (ok: boolean, err?: string) => {
      sock.destroy();
      resolve({ ok, ms: Math.round(performance.now() - t0), err });
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false, "timeout"));
    sock.once("error", (e) => done(false, e.message.slice(0, 80)));
  });
}

const mod: TestModule = {
  id: "L20",
  title: "fully-locked end state: the private DB path survives the HTTP lockdown",
  where: "runner",
  requires: ["pat", "db", "endpoint"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    for (const port of [5432, 6543]) {
      const r = await tcpReach(ctx.phzHost, port);
      results.push({
        id: `L20-${port}`,
        title: `endpoint reachable on ${port} from inside the VPC under restrict-all`,
        status: r.ok ? "pass" : "fail",
        detail: r.ok
          ? `TCP connect to ${ctx.phzHost}:${port} over the endpoint -> ok in ${r.ms}ms while the public internet is restrict-all and the Data API is off. The private path survives the HTTP lockdown.`
          : `TCP connect to ${ctx.phzHost}:${port} -> failed (${r.err}). Expected reachable over the endpoint; full auth is privatelink-aws T01-T09.`,
        measurements: { port, connect_ms: r.ms, reachable: String(r.ok) },
      });
    }
    return results;
  },
};
export default mod;
