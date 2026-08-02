/**
 * T07 - pooler client ceiling.
 *
 * Method matters here; the first bash version got this wrong. It ran
 * `pgbench -c N -j N` on a 2-vCPU runner, so a failure at high N could have
 * been the client dying, and the wrong answer happened to match the published
 * figure. This pins the thread count, ramps past the expected limit, and
 * classifies the outcome from the SERVER's error text:
 *
 *   - "client being queued"      -> below the ceiling, pool saturated
 *   - "max_client_conn"          -> the actual ceiling
 *   - thread/fd/memory errors    -> measuring the runner, reported as such
 */
import { $ } from "bun";
import type { TestModule, TestResult } from "../../../harness/src/types";

const SERVER_REFUSAL = /max_client_conn|too many clients|remaining connection slots/i;
const CLIENT_LIMIT = /could not create thread|cannot allocate|too many open files/i;
const QUEUED = /client being queued/i;

const mod: TestModule = {
  id: "T07",
  title: "Pooler client ceiling on 6543 (queue vs refusal)",
  where: "runner",
  requires: ["db", "pgbench"],
  async run(ctx) {
    const conn = `host=${ctx.phzHost} port=6543 user=postgres dbname=postgres sslmode=require`;
    await Bun.write("/tmp/pvlab-instant.sql", "select 1;\n");
    const results: TestResult[] = [];

    for (const clients of [150, 200, 250]) {
      const out = await $`pgbench ${conn} -f /tmp/pvlab-instant.sql -c ${clients} -j 8 -n -t 1`
        .env({ ...process.env, PGPASSWORD: ctx.dbPassword, PGCONNECT_TIMEOUT: "10" })
        .quiet()
        .nothrow()
        .text()
        .catch((e) => String(e));

      const refused = SERVER_REFUSAL.test(out);
      const clientBound = CLIENT_LIMIT.test(out);
      const queued = QUEUED.test(out);
      const failedAt = out.match(/could not create connection for client (\d+)/)?.[1];

      results.push({
        id: `T07-${clients}`,
        title: `${clients} concurrent clients`,
        // A refusal is the finding, not a failure of the test.
        status: clientBound ? "fail" : "info",
        detail: clientBound
          ? "runner-side resource limit hit - this row measures the client, not the pooler"
          : refused
            ? `server refused (max_client_conn) at client ${failedAt ?? "?"}`
            : queued
              ? "accepted all clients; pool saturated, server queued them"
              : "accepted all clients, no queueing observed",
        measurements: {
          clients,
          server_refusal: refused ? "yes" : "no",
          queued: queued ? "yes" : "no",
          refused_at_client: failedAt ?? "",
        },
        evidence: out.split("\n").filter((l) => SERVER_REFUSAL.test(l) || QUEUED.test(l))[0] ?? "",
      });
    }
    return results;
  },
};
export default mod;
