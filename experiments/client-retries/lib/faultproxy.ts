/**
 * A local fault-injecting HTTP proxy for client-retry experiments.
 *
 * It sits between a client and an upstream (a project's `https://<ref>.supabase.co`
 * or a local mock) and decides per request, from a script, whether to forward it,
 * answer with a synthetic status, delay it, reset the TCP connection, or hold it
 * open without answering. Every request is logged with the `X-Retry-Count`
 * header the client sent, so attempt counts and retry spacing are read from the
 * wire, not from the client's own bookkeeping.
 *
 * Why a local process and not a Cloudflare Worker: the Worker route needs a token
 * that can deploy Workers; the vault token cannot (403 on Workers Scripts,
 * 2026-10-10). A local proxy also puts the fault between the client and the
 * network, which is where the client library sees it either way.
 *
 * Built on node:http because Bun.serve cannot destroy the underlying socket,
 * and a connection reset is one of the faults under test.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Action =
  /**
   * Forward to the upstream and relay its answer. `delayMs` holds the request
   * BEFORE it is forwarded (a slow network in front of the server; an aborted
   * client means the server never sees it). `delayAfterMs` forwards at once
   * and holds the ANSWER (a slow server; the write lands even if the client
   * gives up).
   */
  | { kind: "pass"; delayMs?: number; delayAfterMs?: number }
  /** Answer with a synthetic status; the upstream is never contacted. */
  | { kind: "status"; status: number; headers?: Record<string, string>; body?: string; delayMs?: number }
  /** Destroy the TCP connection without writing a response. */
  | { kind: "reset" }
  /** Accept the request and never answer. */
  | { kind: "hang" };

export interface ReqInfo {
  /** 0-based index among ALL requests seen. */
  n: number;
  /** 0-based index among requests the filter selected (the ones the script governs). */
  k: number;
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
}

export type Script = (r: ReqInfo) => Action;

export interface Seen {
  n: number;
  k: number;
  /** ms since the proxy started */
  tMs: number;
  method: string;
  path: string;
  retryCount: string | null;
  /** First 8 hex of sha256(Authorization header), "" when absent: tells two tokens apart without logging one. */
  authFp: string;
  action: string;
  upstreamStatus?: number;
  /** Retry-After header on the upstream answer, when present */
  upstreamRetryAfter?: string;
  /** ms from arrival until the response finished, when it did */
  doneMs?: number;
  /** the client closed the connection before a response was written */
  clientAborted?: boolean;
}

export interface FaultProxy {
  url: string;
  seen: Seen[];
  /** Requests the script governed (path matched the filter). */
  governed(): Seen[];
  setScript(s: Script, filter?: (path: string) => boolean): void;
  /** Clear the log and reset k. */
  reset(): void;
  stop(): Promise<void>;
}

/** Forward headers a client sent, minus hop-by-hop and length/encoding ones we recompute. */
const DROP_REQ = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "keep-alive"]);
const DROP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `pass` for everything by default. `filter` selects the paths the script
 * governs (default: PostgREST, `/rest/v1/`); other paths (Auth) are forwarded
 * and logged but do not advance `k`.
 */
export async function startFaultProxy(
  upstream: string,
  script: Script = () => ({ kind: "pass" }),
  filter: (path: string) => boolean = (p) => p.startsWith("/rest/v1/"),
): Promise<FaultProxy> {
  const t0 = Date.now();
  const seen: Seen[] = [];
  let k = 0;
  let n = 0;
  let current = script;
  let currentFilter = filter;
  const open = new Set<ServerResponse>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const arrived = Date.now();
    const path = req.url ?? "/";
    const method = req.method ?? "GET";
    const governed = currentFilter(path);
    const info: ReqInfo = { n: n++, k: governed ? k++ : -1, method, path, headers: req.headers };
    const action: Action = governed ? current(info) : { kind: "pass" };
    const rc = req.headers["x-retry-count"];
    const entry: Seen = {
      n: info.n,
      k: info.k,
      tMs: arrived - t0,
      method,
      path,
      retryCount: Array.isArray(rc) ? (rc[0] ?? null) : (rc ?? null),
      authFp: req.headers.authorization ? new Bun.CryptoHasher("sha256").update(req.headers.authorization).digest("hex").slice(0, 8) : "",
      action: describe(action),
    };
    seen.push(entry);
    open.add(res);
    // Bun's node:http does not always emit "close" on the response when the
    // client aborts; the socket's close is the reliable signal.
    const onGone = () => {
      open.delete(res);
      if (!res.writableEnded) entry.clientAborted = true;
    };
    res.on("close", onGone);
    req.socket.setMaxListeners(0);
    req.socket.on("close", onGone);
    // Not reading a GET/HEAD body matters: on Bun, draining the request stream
    // suppresses the abort events that clientAborted relies on.
    const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);

    if (action.kind === "reset") {
      req.socket.destroy();
      return;
    }
    if (action.kind === "hang") return;

    if (action.kind === "status") {
      if (action.delayMs) await sleep(action.delayMs);
      if (res.destroyed) return;
      res.writeHead(action.status, { "content-type": "application/json", ...(action.headers ?? {}) });
      res.end(action.body ?? JSON.stringify({ code: "FAULT", message: `injected ${action.status}` }));
      entry.doneMs = Date.now() - arrived;
      return;
    }

    if (action.delayMs) await sleep(action.delayMs);
    if (res.destroyed) return;
    const headers: Record<string, string> = {};
    for (const [key, v] of Object.entries(req.headers)) {
      if (DROP_REQ.has(key) || v === undefined) continue;
      headers[key] = Array.isArray(v) ? v.join(", ") : v;
    }
    headers["accept-encoding"] = "identity";
    try {
      const up = await fetch(`${upstream}${path}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body),
        redirect: "manual",
      });
      const buf = Buffer.from(await up.arrayBuffer());
      if (action.delayAfterMs) await sleep(action.delayAfterMs);
      entry.upstreamStatus = up.status;
      const ra = up.headers.get("retry-after");
      if (ra !== null) entry.upstreamRetryAfter = ra;
      const out: Record<string, string> = {};
      up.headers.forEach((v, key) => {
        if (!DROP_RES.has(key)) out[key] = v;
      });
      if (res.destroyed) return;
      res.writeHead(up.status, out);
      res.end(method === "HEAD" ? undefined : buf);
    } catch (e) {
      if (res.destroyed) return;
      res.writeHead(599, { "content-type": "text/plain" });
      res.end(`proxy upstream error: ${e instanceof Error ? e.message : String(e)}`);
    }
    entry.doneMs = Date.now() - arrived;
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.destroyed) res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    governed: () => seen.filter((s) => s.k >= 0),
    setScript(s, f) {
      current = s;
      if (f) currentFilter = f;
    },
    reset() {
      seen.length = 0;
      k = 0;
      n = 0;
    },
    async stop() {
      for (const r of open) r.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function describe(a: Action): string {
  switch (a.kind) {
    case "pass":
      return `pass${a.delayMs ? `+${a.delayMs}ms-before` : ""}${a.delayAfterMs ? `+${a.delayAfterMs}ms-after` : ""}`;
    case "status":
      return `${a.status}${a.delayMs ? `+${a.delayMs}ms` : ""}`;
    default:
      return a.kind;
  }
}

/** First `faults.length` governed requests get those actions, the rest get `rest` (default pass). */
export function sequence(faults: Action[], rest: Action = { kind: "pass" }): Script {
  return ({ k }) => faults[k] ?? rest;
}

/** Every governed request gets `a`. */
export const always =
  (a: Action): Script =>
  () =>
    a;

/** The same fault on the first `count` governed requests, then pass. */
export function firstN(count: number, a: Action): Script {
  return sequence(Array.from({ length: count }, () => a));
}

/** `retryCount` values in arrival order, `-` for none. */
export function retryCounts(rows: Seen[]): string {
  return rows.map((r) => r.retryCount ?? "-").join(",");
}

/** Gaps in ms between consecutive arrivals, rounded to 100 ms. */
export function gaps(rows: Seen[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < rows.length; i++) out.push(Math.round((rows[i]!.tMs - rows[i - 1]!.tMs) / 100) * 100);
  return out;
}
