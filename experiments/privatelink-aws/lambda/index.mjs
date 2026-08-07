// pvlab Lambda probe: the customer-shaped path - Lambda in private subnets ->
// PrivateLink endpoint -> Postgres 5432 and PgBouncer 6543.
// Reports per-port connect+query timing so the same function can be used as a
// connectivity test and as the client probe during a restart window.
//
// Env: PGHOST (db.<ref>.supabase.co via the PHZ), PGPASSWORD,
//      PGUSER=postgres, PGDATABASE=postgres, PGSSLMODE=require,
//      SOAK_BUCKET (T29, empty unless enable_soak - see below)
//
// event.port  - probe one port instead of both
// event.host  - probe an arbitrary host instead of PGHOST (T28: does the
//               existing network path reach a read replica's own hostname?)
// event.mode  - "soak" also writes a record to SOAK_BUCKET (T29)
import pg from "pg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const HOST = process.env.PGHOST;
const PORTS = [5432, 6543];
const SOAK_BUCKET = process.env.SOAK_BUCKET || "";
const s3 = SOAK_BUCKET ? new S3Client({}) : null;

// Held across invocations ONLY if AWS happens to reuse this execution
// environment for the next scheduled tick - not guaranteed, no documented
// idle timeout, and AWS can reclaim it at any time. This gives T29's soak an
// OPPORTUNISTIC long-idle probe (the "reused" field is genuinely earned when
// it fires) rather than a fabricated one: a scheduled Lambda cannot promise a
// held-open connection the way a long-running process could, and this does
// not pretend otherwise.
let idleClient = null;
let idleConnectedAt = null;

async function probePort(host, port) {
  const started = Date.now();
  const client = new pg.Client({
    host,
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

/**
 * T29's long-idle path: reuse a module-scope client across invocations when
 * the execution environment survives, otherwise open a fresh one. Always
 * probes the pooler (6543) - PgBouncer's own client ceiling is the question
 * the soak exists to answer.
 */
async function probeIdle() {
  const startedAt = Date.now();
  const wasReused = idleClient !== null;

  if (!idleClient) {
    idleClient = new pg.Client({
      host: HOST,
      port: 6543,
      user: process.env.PGUSER || "postgres",
      database: process.env.PGDATABASE || "postgres",
      password: process.env.PGPASSWORD,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
      query_timeout: 8000,
    });
    try {
      await idleClient.connect();
      idleConnectedAt = Date.now();
    } catch (e) {
      idleClient = null;
      return { kind: "idle", ok: false, reused: false, error: e.message };
    }
  }

  try {
    await idleClient.query("select 1");
    return {
      kind: "idle",
      ok: true,
      reused: wasReused,
      connect_ms: Date.now() - startedAt,
      idle_ms: idleConnectedAt ? Date.now() - idleConnectedAt : 0,
    };
  } catch (e) {
    // The held connection died between ticks - drop it so the NEXT
    // invocation opens a fresh one instead of retrying a dead client.
    await idleClient.end().catch(() => {});
    idleClient = null;
    return { kind: "idle", ok: false, reused: wasReused, error: e.message };
  }
}

async function writeSoakRecord(record) {
  if (!s3) return;
  const key = `soak/${record.ts.replace(/[:.]/g, "-")}-${record.kind}.json`;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: SOAK_BUCKET,
        Key: key,
        Body: JSON.stringify(record),
        ContentType: "application/json",
      }),
    );
  } catch {
    // A failed S3 write should not fail the invocation - the schedule keeps
    // ticking either way, and a gap in the record sequence is itself visible
    // to T29 (fewer records than the interval implies).
  }
}

export const handler = async (event = {}) => {
  const host = event.host || HOST;
  const ports = event.port ? [Number(event.port)] : PORTS;
  const results = [];
  for (const p of ports) results.push(await probePort(host, p));
  const response = {
    host,
    at: new Date().toISOString(),
    all_ok: results.every((r) => r.ok),
    results,
  };

  if (event.mode === "soak") {
    const fresh = results.find((r) => r.port === 6543) ?? results[0];
    await writeSoakRecord({
      ts: response.at,
      kind: "fresh",
      ok: fresh?.ok ?? false,
      connect_ms: fresh?.connect_ms,
      reused: false,
      error: fresh?.error ?? "",
    });
    const idle = await probeIdle();
    await writeSoakRecord({ ts: response.at, error: "", ...idle });
  }

  return response;
};
