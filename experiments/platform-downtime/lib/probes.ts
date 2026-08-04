/**
 * One probe per connection path.
 *
 * "Healthy" means the service ANSWERED, not that it answered 200. Measured on
 * a fresh project 2026-08-04: /rest/v1/ gives anon a 401, /storage/v1/bucket
 * gives 400 with only an apikey and 200 with a bearer as well, /auth/v1/health
 * and /auth/v1/settings both give 200. A probe that demanded 200 would report a
 * permanent outage on two of those paths.
 *
 * 5xx IS down: a wedged PostgREST answers 503 PGRST002, which is exactly the
 * state the matrix is for.
 *
 * Transports match the rest of the repo - `pg`'s Client for Postgres
 * (t02-connectivity.ts) and the `ws` package for WebSocket (t16-realtime.ts).
 */
import { Client } from "pg";
import WebSocket from "ws";
import type { Probe, ProbeOutcome } from "../../../harness/src/sampler";

const TIMEOUT_MS = 5000;

function httpProbe(name: string, url: string, headers: Record<string, string>): Probe {
  return {
    name,
    async run() {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.status >= 500) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

export function restProbe(apiHost: string, anonKey: string): Probe {
  return httpProbe("rest", `https://${apiHost}/rest/v1/`, { apikey: anonKey });
}

export function authProbe(apiHost: string, anonKey: string, path: string): Probe {
  return httpProbe("auth", `https://${apiHost}${path}`, { apikey: anonKey });
}

/** Bearer as well as apikey: with apikey alone this path answers 400. */
export function storageProbe(apiHost: string, anonKey: string): Probe {
  return httpProbe("storage", `https://${apiHost}/storage/v1/bucket`, {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  });
}

/**
 * Pooler on 6543. Host, port and username all come from
 * GET /v1/projects/{ref}/config/database/pooler at run time rather than being
 * constructed here - the host is region-dependent and the mode-to-port mapping
 * is a platform fact, not a constant.
 *
 * Prepared-statement behaviour across a pooled connection is deliberately not
 * exercised: that is a pooler-semantics question, not a downtime one.
 */
export function poolerProbe(host: string, port: number, user: string, password: string): Probe {
  return {
    name: "pooler",
    async run() {
      const client = new Client({
        host,
        port,
        user,
        database: "postgres",
        password,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: TIMEOUT_MS,
      });
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

/**
 * Realtime handshake only. Whether a JOIN would be permitted is an
 * authorization question http-tier-lockdown already settled, and this matrix
 * does not re-ask it.
 *
 * ASYMMETRY WITH httpProbe, measured 2026-08-04 and not a preference: the HTTP
 * probes treat any non-5xx as "answered", but this one cannot. Bun does not
 * implement ws's `unexpected-response` event (it says so on stderr), and the
 * `error` it raises instead carries no status - a 401 upgrade arrives as
 * `failed: Expected 101 status code`, indistinguishable from a dead endpoint.
 * Verified by pointing this at the live project with no apikey: curl gets 401,
 * ws gets that string.
 *
 * So a Realtime 4xx reads as DOWN here. That is survivable rather than correct:
 * the probe sends a valid key, and if the key were wrong the path would fail
 * from sample zero and the healthy-at-start guard voids the run instead of
 * publishing a fake outage. Do not add an `unexpected-response` handler back -
 * it will never fire under this runtime.
 */
export function realtimeProbe(apiHost: string, anonKey: string): Probe {
  const url = `wss://${apiHost}/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`;
  return {
    name: "realtime",
    async run() {
      return await new Promise<ProbeOutcome>((resolve) => {
        const ws = new WebSocket(url, { handshakeTimeout: TIMEOUT_MS });
        const done = (outcome: ProbeOutcome) => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          resolve(outcome);
        };
        const timer = setTimeout(
          () => done({ ok: false, error: "ws handshake timeout" }),
          TIMEOUT_MS,
        );
        ws.on("open", () => done({ ok: true }));
        ws.on("error", (e: Error) => done({ ok: false, error: e.message }));
      });
    },
  };
}
