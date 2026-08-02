/**
 * T02/T03 - direct Postgres and the dedicated pooler through the endpoint.
 * Replaces the psql-and-grep matrix: same probe, typed timings.
 */
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

async function probe(ctx: Ctx, port: number, label: string): Promise<TestResult> {
  const id = port === 5432 ? "T02" : "T03";
  const client = new Client({
    host: ctx.phzHost,
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

    // Named statement = server-side prepare. Recorded either way: the "no
    // prepared statements in transaction mode" rule measured false on 6543.
    let prepared = "n/a";
    try {
      await client.query({ name: `pvlab-${port}`, text: "select 1" });
      prepared = "ok";
    } catch (e) {
      prepared = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    return {
      id,
      title: `${label} through the endpoint`,
      status: "pass",
      detail: `connected via ${ctx.phzHost}:${port}`,
      measurements: { connect_ms: connectMs, query_ms: queryMs, prepared_stmt: prepared },
    };
  } catch (e) {
    return {
      id,
      title: `${label} through the endpoint`,
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

const mod: TestModule = {
  id: "T02",
  title: "Postgres 5432 and pooler 6543 through the endpoint",
  where: "runner",
  requires: ["db"],
  async run(ctx) {
    return [
      await probe(ctx, 5432, "direct Postgres"),
      await probe(ctx, 6543, "dedicated pooler (transaction mode)"),
    ];
  },
};
export default mod;
