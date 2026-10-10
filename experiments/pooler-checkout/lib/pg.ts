/**
 * Probe helpers for the checkout-timeout modules: hold N pooler backends with
 * `pg_sleep`, time one extra client, observe the backend count from outside
 * the pooler (Management API query endpoint, which does not go through
 * Supavisor).
 */
import { Client } from "pg";
import { sql } from "../../../harness/src/platform";
import type { Ctx } from "../../../harness/src/types";
import { errText, sleep, type PcProject } from "./project";

export interface Target {
  label: string;
  host: string;
  port: number;
  user: string;
}

export const sharedTxn = (p: PcProject): Target => ({ label: "supavisor_txn_6543", host: p.poolerHost, port: 6543, user: p.poolerUser });
export const sharedSession = (p: PcProject): Target => ({ label: "supavisor_session_5432", host: p.poolerHost, port: 5432, user: p.poolerUser });
export const dedicated = (p: PcProject): Target => ({ label: "dedicated_6543", host: `db.${p.ref}.supabase.co`, port: 6543, user: "postgres" });
export const direct = (p: PcProject): Target => ({ label: "direct_5432", host: `db.${p.ref}.supabase.co`, port: 5432, user: "postgres" });

export function mkClient(t: Target, password: string, connectTimeoutMs = 30_000): Client {
  const c = new Client({
    host: t.host,
    port: t.port,
    user: t.user,
    password,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: connectTimeoutMs,
  });
  // A server-side kill surfaces as an 'error' event; without a listener it
  // would take the whole process down mid-run.
  c.on("error", () => {});
  return c;
}

export interface Outcome {
  ok: boolean;
  /** connect() duration, ms (null if connect itself failed) */
  connectMs: number | null;
  /** from query send to answer or error, ms */
  queryMs: number | null;
  /** from connect start to the end, ms */
  totalMs: number;
  /** server SQLSTATE or node error code */
  code: string;
  error: string;
}

/**
 * Connect, then run one statement, with a CLIENT-side deadline on the query
 * (deadlineMs). The deadline is the client giving up, not a server answer, and
 * is reported as code `CLIENT_DEADLINE`.
 */
export async function timedQuery(t: Target, password: string, query: string, deadlineMs: number, connectTimeoutMs = 30_000): Promise<Outcome> {
  const t0 = Date.now();
  const c = mkClient(t, password, connectTimeoutMs);
  let connectMs: number | null = null;
  let tq = 0;
  try {
    await c.connect();
    connectMs = Date.now() - t0;
    tq = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      c.query(query),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error(`client gave up after ${deadlineMs} ms`), { code: "CLIENT_DEADLINE" })), deadlineMs);
      }),
    ]).finally(() => clearTimeout(timer));
    return { ok: true, connectMs, queryMs: Date.now() - tq, totalMs: Date.now() - t0, code: "", error: "" };
  } catch (e) {
    const code = String((e as { code?: string }).code ?? "Error");
    return { ok: false, connectMs, queryMs: tq ? Date.now() - tq : null, totalMs: Date.now() - t0, code, error: errText(e) };
  } finally {
    // destroy, not end(): end() would queue behind the stuck query.
    (c as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
    c.end().catch(() => {});
  }
}

export interface Holders {
  /** resolves when every holder has finished (ok or error) */
  done: Promise<Outcome[]>;
}

/** Start n clients on target t, each running `select pg_sleep(sleepSec)`. */
export function holdPool(t: Target, password: string, n: number, sleepSec: number): Holders {
  const one = async (): Promise<Outcome> => timedQuery(t, password, `select pg_sleep(${sleepSec})`, (sleepSec + 60) * 1000);
  return { done: Promise.all(Array.from({ length: n }, one)) };
}

/** Active `pg_sleep` backends, read through the Management API so the pooler is not in the measuring path. */
export async function activeSleepers(ctx: Ctx): Promise<{ active: number; idle: number; error: string }> {
  const r = await sql(
    ctx,
    "select state, count(*)::int n from pg_stat_activity where query like 'select pg_sleep(%' and pid <> pg_backend_pid() group by 1",
  );
  if (r.error) return { active: -1, idle: -1, error: r.error };
  const n = (s: string) => Number(r.rows.find((x) => x.state === s)?.n ?? 0);
  return { active: n("active"), idle: n("idle"), error: "" };
}

export { sleep };
