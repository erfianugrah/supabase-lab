/**
 * The direct-connection probe (db.<ref>.supabase.co:5432). The other four
 * paths reuse platform-downtime's probes. On a project without the IPv4
 * add-on this host resolves to AAAA only, so the probe needs an IPv6-capable
 * vantage; a vantage without one fails from sample zero and LO05 voids the run
 * rather than publishing a fake outage.
 *
 * Name resolution is done with resolve6 (c-ares), not the connect path's
 * getaddrinfo: on the macOS vantage of the first LO02 draft, getaddrinfo
 * answered ENOTFOUND for the AAAA-only host while `dig` and resolve6 returned
 * the address and a TCP connect to it succeeded. Connecting to the literal
 * address with the hostname as the TLS server name avoids the system resolver.
 */
import { resolve6 } from "node:dns/promises";
import { Client } from "pg";
import type { Probe } from "../../../harness/src/sampler";

const TIMEOUT_MS = 5000;

export function directProbe(host: string, password: string): Probe {
  return {
    name: "direct",
    async run() {
      let target = host;
      try {
        const addrs = await resolve6(host);
        if (addrs[0]) target = addrs[0];
      } catch {
        // fall through to the hostname; the connect error carries the reason
      }
      const client = new Client({
        host: target,
        port: 5432,
        user: "postgres",
        database: "postgres",
        password,
        ssl: { rejectUnauthorized: false, servername: host },
        connectionTimeoutMillis: TIMEOUT_MS,
        // See platform-downtime poolerProbe: a held query never settles without it (#211).
        query_timeout: TIMEOUT_MS,
      });
      client.on("error", () => {});
      try {
        await client.connect();
        await client.query("select 1");
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}

/** Median of a numeric list (lower middle for even n). */
export function p50(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] as number;
}

/** Tag carried in the holder's statement text, so pg_stat_activity can find it. */
export const LOCK_TAG = "pvlab_lock_holder";

/**
 * LO06's induced fault: one session takes an ACCESS EXCLUSIVE lock on `table`
 * and sleeps inside the transaction, so every read of that table waits behind
 * it while the server, the sockets and the control plane stay healthy. A
 * restart ends the session; so would pg_terminate_backend (cheaper, and what
 * an operator who knew the cause would use). Resolves once the lock is held;
 * `ended` settles with the error text when the session is killed.
 * `host` may be an IPv6 literal with `servername` the TLS name (see directProbe).
 */
export async function holdLock(opts: {
  host: string;
  port: number;
  user: string;
  password: string;
  servername?: string;
  table: string;
  sleepS?: number;
}): Promise<{ ended: Promise<string>; release: () => Promise<void> }> {
  const client = new Client({
    host: opts.host,
    port: opts.port,
    user: opts.user,
    database: "postgres",
    password: opts.password,
    ssl: { rejectUnauthorized: false, ...(opts.servername ? { servername: opts.servername } : {}) },
    connectionTimeoutMillis: 10_000,
  });
  let endedResolve: (s: string) => void = () => {};
  const ended = new Promise<string>((r) => (endedResolve = r));
  client.on("error", (e) => endedResolve(`client error: ${e.message}`));
  await client.connect();
  await client.query("begin");
  await client.query("set local statement_timeout = 0");
  await client.query("set local idle_in_transaction_session_timeout = 0");
  await client.query(`lock table ${opts.table} in access exclusive mode`);
  client
    .query(`select pg_sleep(${opts.sleepS ?? 3600}) /* ${LOCK_TAG} */`)
    .then(() => endedResolve("sleep finished"))
    .catch((e: unknown) => endedResolve(e instanceof Error ? e.message : String(e)));
  return {
    ended,
    release: async () => {
      await client.end().catch(() => {});
    },
  };
}
