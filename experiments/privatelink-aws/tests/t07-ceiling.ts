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
    // Each client must HOLD its connection, otherwise clients recycle faster
    // than they accumulate and the ceiling is never reached - the port's first
    // version used an instant query and "found" no ceiling at 250.
    const HOLD_S = Number(process.env.PVLAB_HOLD_S ?? 20);
    await Bun.write("/tmp/pvlab-hold.sql", `select pg_sleep(${HOLD_S});\n`);
    const results: TestResult[] = [];
    // ORDER IS LOAD-BEARING: this runs FIRST, on a quiet system. Run 7 had it
    // after the ramp and reported "refusal at client 24" - the previous step's
    // held connections were still occupying the budget. The ramp below then
    // establishes the SHAPE (queue before refuse); only this probe produces a
    // number worth quoting.
    await Bun.write("/tmp/pvlab-instant.sql", "select 1;\n");
    const isolated = await $`pgbench ${conn} -f /tmp/pvlab-instant.sql -c 300 -j 8 -n -t 1`
      .env({ ...process.env, PGPASSWORD: ctx.dbPassword, PGCONNECT_TIMEOUT: "10" })
      .quiet()
      .nothrow();
    const isoOut = isolated.stdout.toString() + isolated.stderr.toString();
    const isoAt = isoOut.match(/could not create connection for client (\d+)/)?.[1];
    results.push({
      id: "T07-ceiling",
      title: "isolated ceiling probe (quiet system, instant query, 300 requested)",
      status: isoAt ? "info" : "info",
      detail: isoAt
        ? `first refusal at client ${isoAt} - the number to size concurrency against`
        : "no refusal at 300 concurrent; ceiling is above the probe",
      measurements: {
        requested: 300,
        first_refusal_at_client: isoAt ?? "none",
        server_refusal: SERVER_REFUSAL.test(isoOut) ? "yes" : "no",
      },
      evidence: isoOut.split("\n").find((l) => SERVER_REFUSAL.test(l)) ?? "",
    });


    // Connections from the previous step keep the budget occupied while they
    // drain, which drags the apparent boundary down (run 6 saw refusal at
    // client 124 of 200 for exactly this reason). Wait out the hold first.
    let first = true;
    for (const clients of [150, 200, 250]) {
      if (!first) await Bun.sleep((HOLD_S + 5) * 1000);
      first = false;
      // pgbench writes NOTICEs and connection errors to stderr; capturing only
      // stdout made the classifier see nothing and report "no queueing" (run 7).
      const proc = await $`pgbench ${conn} -f /tmp/pvlab-hold.sql -c ${clients} -j 8 -n -t 1`
        .env({ ...process.env, PGPASSWORD: ctx.dbPassword, PGCONNECT_TIMEOUT: "10" })
        .quiet()
        .nothrow();
      const out = proc.stdout.toString() + proc.stderr.toString();

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
