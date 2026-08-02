// pvlab Lambda probe: the customer-shaped path - Lambda in private subnets ->
// PrivateLink endpoint -> Postgres 5432 and PgBouncer 6543.
// Reports per-port connect+query timing so the same function can be used as a
// connectivity test and as the client probe during a restart window.
//
// Env: PGHOST (db.<ref>.supabase.co via the PHZ), PGPASSWORD,
//      PGUSER=postgres, PGDATABASE=postgres, PGSSLMODE=require
import pg from "pg";

const HOST = process.env.PGHOST;
const PORTS = [5432, 6543];

async function probePort(port) {
  const started = Date.now();
  const client = new pg.Client({
    host: HOST,
    port,
    user: process.env.PGUSER || "postgres",
    database: process.env.PGDATABASE || "postgres",
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    query_timeout: 8000,
  });

  const out = { port, ok: false };
  try {
    await client.connect();
    out.connect_ms = Date.now() - started;

    const q = Date.now();
    const r = await client.query("select now() as now");
    out.query_ms = Date.now() - q;
    out.now = r.rows[0].now;
    out.ok = true;

    // Named statement = server-side prepare. Run-5 measured this succeeding on
    // the transaction pooler; re-check it here from the Lambda client stack.
    try {
      await client.query({ name: "pvlab-prepared", text: "select 1" });
      out.prepared = "ok";
    } catch (e) {
      out.prepared = `failed: ${e.message}`;
    }
  } catch (e) {
    out.error = e.message;
    out.total_ms = Date.now() - started;
  } finally {
    await client.end().catch(() => {});
  }
  return out;
}

export const handler = async (event = {}) => {
  const ports = event.port ? [Number(event.port)] : PORTS;
  const results = [];
  for (const p of ports) results.push(await probePort(p));
  return {
    host: HOST,
    at: new Date().toISOString(),
    all_ok: results.every((r) => r.ok),
    results,
  };
};
