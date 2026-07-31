// pvlab Lambda probe: prepared-statement behaviour on the transaction pooler
// through the PrivateLink endpoint (T11-lambda), plus basic connectivity.
// Env: PGHOST (db.<ref>.supabase.co via the PHZ), PGPASSWORD, PGUSER=postgres,
// PGDATABASE=postgres, PGSSLMODE=require
import pg from "pg";

export const handler = async () => {
  const pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 8000 });
  const out = { prepared: null, plain: null };
  try {
    try {
      // named statement = server-side prepare. Run-5 finding (T11): this now
      // SUCCEEDS on Supavisor transaction mode - the old "transaction mode
      // breaks prepared statements" assumption is stale. Record either way.
      await pool.query({ name: "pvlab-prepared", text: "select 1" });
      out.prepared = "ok (Supavisor transaction mode supports prepared statements)";
    } catch (e) {
      out.prepared = `failed: ${e.message}`;
    }
    const r = await pool.query("select now()");
    out.plain = `ok: ${r.rows[0].now}`;
  } finally {
    await pool.end().catch(() => {});
  }
  return out;
};
