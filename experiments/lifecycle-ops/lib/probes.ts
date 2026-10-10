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
