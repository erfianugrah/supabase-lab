/**
 * Lock plumbing shared by the AL modules: a session-mode pooler connection you
 * can hold a transaction open on, and the pg_locks read that says which lock
 * mode a statement actually took - the whole point of the experiment.
 *
 * Session mode (port 5432) matters: transaction mode hands the backend back
 * between statements, so a BEGIN ... hold-open ... would land its later
 * statements on a different backend and the lock would not be held. Every
 * connection here is session mode.
 *
 * The direct 5432 host is IPv6-only (AGENTS.md), so from an IPv4 vantage these
 * go through the session pooler; the Makefile supplies its host as
 * PVLAB_ENDPOINT_POOLER. A missing pooler host is a skip with a reason, never a
 * probe against an empty string.
 */
import { Client } from "pg";
import type { Ctx } from "../../../harness/src/types";

const CONNECT_TIMEOUT_MS = 10_000;

/** Session-mode pooler host and user for this project. */
export function poolerTarget(ctx: Ctx): { host: string; port: number; user: string } | null {
  const host = ctx.endpoints.pooler ?? (ctx.region ? `aws-0-${ctx.region}.pooler.supabase.com` : "");
  if (!host) return null;
  return { host, port: 5432, user: `postgres.${ctx.ref}` };
}

/** A connected session-mode client, or null with the connect error in `err`. */
export async function connect(ctx: Ctx): Promise<{ client: Client | null; err?: string }> {
  const t = poolerTarget(ctx);
  if (!t) return { client: null, err: "no pooler host (PVLAB_ENDPOINT_POOLER unset and region unknown)" };
  const client = new Client({
    host: t.host,
    port: t.port,
    user: t.user,
    database: "postgres",
    password: ctx.dbPassword,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    return { client };
  } catch (e) {
    await client.end().catch(() => {});
    return { client: null, err: `connect ${t.host}:${t.port} as ${t.user}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface HeldLock {
  mode: string;
  granted: boolean;
}

/**
 * The lock modes THIS backend currently holds on <schema>.<table>. Read inside
 * the same transaction that took them, before COMMIT/ROLLBACK. `granted`
 * distinguishes a held lock from one this backend is still waiting on.
 */
export async function locksOn(client: Client, schema: string, table: string): Promise<HeldLock[]> {
  const r = await client.query<{ mode: string; granted: boolean }>(
    `select l.mode, l.granted
       from pg_locks l
       join pg_class c on c.oid = l.relation
       join pg_namespace n on n.oid = c.relnamespace
      where l.pid = pg_backend_pid()
        and n.nspname = $1
        and c.relname = $2
        and l.locktype = 'relation'
      order by l.mode`,
    [schema, table],
  );
  return r.rows.map((row) => ({ mode: row.mode, granted: row.granted }));
}

/** Did this backend take ShareRowExclusiveLock (or stronger) on the table? */
export function hasMode(locks: HeldLock[], mode: string): boolean {
  return locks.some((l) => l.mode === mode && l.granted);
}

/**
 * Try one statement under a short lock_timeout on a SEPARATE connection, so a
 * lock held open by another session shows up as `55P03 lock_not_available`
 * rather than hanging the run. Returns the outcome and the verbatim error.
 */
export async function tryUnderLockTimeout(
  ctx: Ctx,
  statement: string,
  lockTimeout = "2s",
): Promise<{ ok: boolean; blocked: boolean; code: string; error: string }> {
  const { client, err } = await connect(ctx);
  if (!client) return { ok: false, blocked: false, code: "connect", error: err ?? "no client" };
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = '${lockTimeout}'`);
    await client.query(statement);
    await client.query("rollback");
    return { ok: true, blocked: false, code: "", error: "" };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    const code = (e as { code?: string } | undefined)?.code ?? "";
    const msg = e instanceof Error ? e.message : String(e);
    // 55P03 = lock_not_available (lock_timeout fired) - the blocked signature.
    return { ok: false, blocked: code === "55P03", code, error: msg.slice(0, 200) };
  } finally {
    await client.end().catch(() => {});
  }
}

/** A password sign-in against managed GoTrue - the real observable a lock on auth.users blocks. */
export async function signInPassword(
  ctx: Ctx,
  email: string,
  password: string,
  timeoutMs = 15_000,
): Promise<{ status: number; ms: number; body: string; error?: string }> {
  const url = `https://${ctx.apiHost}/auth/v1/token?grant_type=password`;
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { apikey: ctx.anonKey ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.text()).slice(0, 200);
    return { status: res.status, ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), body: "", error: (e instanceof Error ? e.message : String(e)).slice(0, 160) };
  }
}

/** Admin-create a confirmed user (service key) so a sign-in observable is deterministic. Hashes but sends no email. */
export async function adminCreateUser(ctx: Ctx, serviceKey: string, email: string, password: string): Promise<number> {
  const res = await fetch(`https://${ctx.apiHost}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  }).catch(() => ({ status: 0 }) as Response);
  return res.status;
}
