/**
 * Connection-level faults for MF06 / MF07, run in-process on 127.0.0.1.
 *
 * The status-level proxy (../proxy/server.ts) runs in a container and answers
 * HTTP, and the container's port forwarder sits between it and the client
 * (whether that forwarder passes an RST through unchanged was not tested).
 * This one is a raw TCP
 * listener in the test process that speaks just enough HTTP/1.1 to read a
 * request (Content-Length bodies only) and forward it to the Management API
 * over HTTPS with `fetch`. Rule modes:
 *
 *   reset-before  read the whole request, then abort the TCP connection
 *                 (`socket.terminate()`, an RST; curl reports "Connection
 *                 reset by peer"). Upstream is not contacted.
 *   close-before  read the whole request, then close the connection cleanly
 *                 (`socket.end()`, a FIN; curl reports "Empty reply from
 *                 server"). Upstream is not contacted.
 *   reset-after   forward, wait for upstream's answer, then RST the client:
 *                 the operation happened and the caller heard nothing.
 *   pass          forward and relay (explicit, so the log shows the rule).
 *
 * `startTlsTrap()` is a TLS listener with a throwaway self-signed certificate
 * (a TLS failure before any request byte is sent); `refusedUrl()` is a port
 * with nothing listening (connection refused); DNS_FAIL_HOST is under the
 * reserved `.invalid` TLD (RFC 2606), so it never resolves.
 *
 * Like the container proxy, the log never holds request bodies or headers:
 * method, path, body byte count and, for an upstream JSON answer, only its
 * `ref`/`id` and `created_at` fields.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";

export const UPSTREAM = "https://api.supabase.com";
export const DNS_FAIL_HOST = "api.mf-dns-fail.invalid";

export interface ConnRule {
  id: string;
  method?: string;
  /** Regex source matched against path + query. */
  path: string;
  mode: "reset-before" | "close-before" | "reset-after" | "pass";
  /** Fault only the first `times` matching requests (0 or absent = all). */
  times?: number;
  fired?: number;
}

export interface ConnLogRow {
  seq: number;
  t: number;
  conn: number;
  method: string;
  path: string;
  bodyBytes: number;
  rule?: string;
  action: string;
  upstreamStatus?: number;
  upstreamRef?: string;
  /** `created_at` from an upstream JSON answer, when it has one. */
  upstreamCreatedAt?: string;
  clientStatus?: number;
  ms: number;
}

interface ConnState {
  id: number;
  buf: Buffer;
  busy: boolean;
  out: Buffer[];
  dead: boolean;
}

const STRIP_REQ = new Set(["host", "content-length", "accept-encoding", "connection", "transfer-encoding", "keep-alive", "proxy-connection"]);
const STRIP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

/** Pick the first rule that matches and still has budget; counts the firing. */
export function pickRule(rules: ConnRule[], method: string, path: string): ConnRule | undefined {
  for (const r of rules) {
    if (r.method && r.method.toUpperCase() !== method) continue;
    if (!new RegExp(r.path).test(path)) continue;
    if (r.times && (r.fired ?? 0) >= r.times) continue;
    r.fired = (r.fired ?? 0) + 1;
    return r;
  }
  return undefined;
}

export interface ParsedRequest {
  method: string;
  path: string;
  headers: Array<[string, string]>;
  body: Buffer;
  /** bytes consumed from the buffer */
  used: number;
}

/**
 * Parse one HTTP/1.1 request from the front of `buf`. Returns null when more
 * bytes are needed, or `{ error }` for a request this proxy does not handle
 * (chunked request bodies).
 */
export function parseRequest(buf: Buffer): ParsedRequest | null | { error: string } {
  const end = buf.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const head = buf.subarray(0, end).toString("latin1").split("\r\n");
  const [method = "", path = ""] = (head[0] ?? "").split(" ");
  const headers: Array<[string, string]> = [];
  let len = 0;
  for (const line of head.slice(1)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    headers.push([k, v]);
    if (k.toLowerCase() === "content-length") len = Number(v) || 0;
    if (k.toLowerCase() === "transfer-encoding" && /chunked/i.test(v)) return { error: "chunked request body" };
  }
  const start = end + 4;
  if (buf.length < start + len) return null;
  return { method: method.toUpperCase(), path, headers, body: buf.subarray(start, start + len), used: start + len };
}

export interface ConnProxy {
  url: string;
  port: number;
  setRules(rules: ConnRule[]): void;
  reset(): void;
  log(): ConnLogRow[];
  /** TCP connections accepted since the last reset. */
  conns(): number;
  stop(): void;
}

export function startConnProxy(upstream = UPSTREAM): ConnProxy {
  let rules: ConnRule[] = [];
  let log: ConnLogRow[] = [];
  let seq = 0;
  let connSeq = 0;
  let accepted = 0;
  const state = new WeakMap<Socket<unknown>, ConnState>();

  const flush = (s: Socket<unknown>, st: ConnState) => {
    while (st.out.length) {
      const chunk = st.out[0]!;
      const n = s.write(chunk);
      if (n < 0) return;
      if (n < chunk.length) {
        st.out[0] = chunk.subarray(n);
        return;
      }
      st.out.shift();
    }
  };

  const handle = async (s: Socket<unknown>, st: ConnState, req: ParsedRequest) => {
    const t0 = Date.now();
    const row: ConnLogRow = { seq: ++seq, t: t0, conn: st.id, method: req.method, path: req.path, bodyBytes: req.body.length, action: "forward", ms: 0 };
    log.push(row);
    const rule = pickRule(rules, req.method, req.path);
    if (rule) row.rule = rule.id;
    if (rule?.mode === "reset-before" || rule?.mode === "close-before") {
      row.action = rule.mode;
      row.ms = Date.now() - t0;
      st.dead = true;
      if (rule.mode === "reset-before") s.terminate();
      else s.end();
      return;
    }
    const headers = new Headers();
    for (const [k, v] of req.headers) if (!STRIP_REQ.has(k.toLowerCase())) headers.append(k, v);
    let status = 502;
    let statusText = "Bad Gateway";
    let body: Buffer = Buffer.from("upstream unreachable");
    const outHeaders: Array<[string, string]> = [];
    try {
      const up = await fetch(upstream + req.path, {
        method: req.method,
        headers,
        body: req.body.length ? new Uint8Array(req.body) : undefined,
        redirect: "manual",
      });
      body = Buffer.from(await up.arrayBuffer());
      status = up.status;
      statusText = up.statusText || "OK";
      row.upstreamStatus = up.status;
      up.headers.forEach((v, k) => {
        if (!STRIP_RES.has(k.toLowerCase())) outHeaders.push([k, v]);
      });
      try {
        const j = JSON.parse(body.toString("utf8")) as { ref?: string; id?: unknown; created_at?: unknown };
        row.upstreamRef = j.ref ?? (typeof j.id === "string" ? j.id : undefined);
        if (typeof j.created_at === "string") row.upstreamCreatedAt = j.created_at;
      } catch {
        /* not JSON */
      }
    } catch {
      row.action = "upstream-unreachable";
    }
    if (rule?.mode === "reset-after") {
      row.action = "reset-after";
      row.ms = Date.now() - t0;
      st.dead = true;
      s.terminate();
      return;
    }
    if (st.dead) return;
    const head =
      `HTTP/1.1 ${status} ${statusText}\r\n` +
      outHeaders.map(([k, v]) => `${k}: ${v}\r\n`).join("") +
      `content-length: ${body.length}\r\nconnection: keep-alive\r\n\r\n`;
    st.out.push(Buffer.from(head, "latin1"), body);
    flush(s, st);
    row.clientStatus = status;
    row.ms = Date.now() - t0;
  };

  const pump = async (s: Socket<unknown>, st: ConnState) => {
    if (st.busy) return;
    st.busy = true;
    try {
      while (!st.dead) {
        const p = parseRequest(st.buf);
        if (p === null) break;
        if ("error" in p) {
          log.push({ seq: ++seq, t: Date.now(), conn: st.id, method: "?", path: "?", bodyBytes: 0, action: `refused: ${p.error}`, ms: 0 });
          st.dead = true;
          s.end();
          break;
        }
        st.buf = st.buf.subarray(p.used);
        await handle(s, st, p);
      }
    } finally {
      st.busy = false;
    }
  };

  const server = Bun.listen<unknown>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        accepted++;
        state.set(s, { id: ++connSeq, buf: Buffer.alloc(0), busy: false, out: [], dead: false });
      },
      data(s, chunk) {
        const st = state.get(s);
        if (!st || st.dead) return;
        st.buf = Buffer.concat([st.buf, Buffer.from(chunk)]);
        void pump(s, st);
      },
      drain(s) {
        const st = state.get(s);
        if (st) flush(s, st);
      },
      close(s) {
        const st = state.get(s);
        if (st) st.dead = true;
      },
      error() {
        /* client went away; nothing to record beyond the log row */
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    setRules: (r) => {
      rules = r.map((x) => ({ ...x, fired: 0 }));
    },
    reset: () => {
      rules = [];
      log = [];
      seq = 0;
      accepted = 0;
    },
    log: () => log.map((r) => ({ ...r })),
    conns: () => accepted,
    stop: () => server.stop(true),
  };
}

export interface TlsTrap {
  url: string;
  /** TCP connections accepted, handshakes that failed / succeeded, requests that arrived. */
  counts(): { conns: number; handshakeFail: number; handshakeOk: number; dataEvents: number };
  reset(): void;
  stop(): void;
}

/**
 * A TLS listener with a self-signed certificate for CN=localhost, made fresh
 * with openssl in a temporary directory and deleted on stop. Every client in
 * these modules uses the system trust store, so the handshake is expected to
 * fail before any HTTP byte is sent; if one ever succeeds the trap drops the
 * connection and counts it.
 */
export function startTlsTrap(): TlsTrap {
  const dir = mkdtempSync(join(tmpdir(), "mf-tls-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const gen = Bun.spawnSync([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdout: "ignore", stderr: "pipe" });
  if (gen.exitCode !== 0) throw new Error(`openssl failed: ${gen.stderr.toString().slice(0, 200)}`);
  const c = { conns: 0, handshakeFail: 0, handshakeOk: 0, dataEvents: 0 };
  const server = Bun.listen<unknown>({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") },
    socket: {
      open() {
        c.conns++;
      },
      handshake(s, success) {
        if (success) {
          c.handshakeOk++;
          s.terminate();
        } else c.handshakeFail++;
      },
      data(s) {
        c.dataEvents++;
        s.terminate();
      },
      error() {
        /* expected: the client aborts the handshake */
      },
    },
  });
  return {
    url: `https://localhost:${server.port}`,
    counts: () => ({ ...c }),
    reset: () => {
      c.conns = 0;
      c.handshakeFail = 0;
      c.handshakeOk = 0;
      c.dataEvents = 0;
    },
    stop: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A loopback port that was free a moment ago and has nothing listening now. */
export function refusedUrl(): string {
  const s = Bun.listen<unknown>({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return `http://127.0.0.1:${port}`;
}

/** Collapse a log to "METHOD path action -> status xN" lines; refs become {ref}. */
export function connShape(log: ConnLogRow[]): string {
  const counts = new Map<string, number>();
  for (const r of log) {
    const p = r.path.replace(/\b[a-z]{20}\b/g, "{ref}").replace(/\?.*$/, "");
    const k = `${r.method} ${p} ${r.action}${r.upstreamStatus ? ` (upstream ${r.upstreamStatus})` : ""}${r.clientStatus ? ` -> ${r.clientStatus}` : ""}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${n}x ${k}`).join("\n");
}
