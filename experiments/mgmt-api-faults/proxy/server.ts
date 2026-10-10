/**
 * Fault-injecting reverse proxy for the Supabase Management API.
 *
 * Runs inside an oven/bun container (see ../lib/proxy.ts). Everything is
 * forwarded to UPSTREAM unchanged unless a rule matches. Rules are set at
 * run time through /__admin/*, so one container serves every scenario.
 *
 * Rule modes
 *   error-before  answer `status` (default 500) WITHOUT contacting upstream:
 *                 the operation did not happen.
 *   error-after   forward to upstream, wait for its answer, discard it and
 *                 answer `status` to the client: the operation happened and
 *                 the caller was told it failed.
 *   delay-before  sleep delayMs, then forward and relay (a slow upstream).
 *   delay-after   forward, then sleep delayMs before relaying the answer (the
 *                 operation happened; a client timeout fires before it hears).
 *   passthrough   explicit no-op, so the log shows a rule was consulted.
 *
 * `skip` lets the first K matching requests through, `times` bounds how many
 * matching requests after that are faulted (0 = unbounded). Rules are tried in
 * order; the first that still has budget wins.
 *
 * The log never holds request bodies or the Authorization header: a create
 * body carries the database password. It records method, path, a body byte
 * count and hash, and for upstream JSON bodies only the `ref`/`id` field, so a
 * run can tell which created project a discarded answer belonged to.
 */
const UPSTREAM = process.env.UPSTREAM ?? "https://api.supabase.com";

interface Rule {
  id: string;
  method?: string;
  /** Regex source matched against the path including the query string. */
  path: string;
  mode: "error-before" | "error-after" | "delay-before" | "delay-after" | "passthrough";
  status?: number;
  delayMs?: number;
  headers?: Record<string, string>;
  body?: string;
  skip?: number;
  times?: number;
  /** runtime counters */
  seen?: number;
  fired?: number;
}

interface LogRow {
  seq: number;
  t: number;
  method: string;
  path: string;
  bodyBytes: number;
  bodySha: string;
  rule?: string;
  action: string;
  clientStatus?: number;
  upstreamStatus?: number;
  upstreamRef?: string;
  ms: number;
}

let rules: Rule[] = [];
let log: LogRow[] = [];
let seq = 0;

const STRIP_REQ = new Set(["host", "content-length", "accept-encoding", "connection", "transfer-encoding"]);
const STRIP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sha(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pick(method: string, path: string): Rule | undefined {
  for (const r of rules) {
    if (r.method && r.method.toUpperCase() !== method) continue;
    if (!new RegExp(r.path).test(path)) continue;
    r.seen = (r.seen ?? 0) + 1;
    if (r.seen <= (r.skip ?? 0)) continue;
    if (r.times && (r.fired ?? 0) >= r.times) continue;
    r.fired = (r.fired ?? 0) + 1;
    return r;
  }
  return undefined;
}

function faultResponse(r: Rule): Response {
  const status = r.status ?? 500;
  return new Response(r.body ?? JSON.stringify({ message: `injected ${status} (${r.id})` }), {
    status,
    headers: { "content-type": "application/json", ...(r.headers ?? {}) },
  });
}

async function admin(req: Request, url: URL): Promise<Response> {
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/__admin/health") return json({ ok: true, upstream: UPSTREAM });
  if (url.pathname === "/__admin/rules" && req.method === "PUT") {
    rules = ((await req.json()) as Rule[]).map((r) => ({ ...r, seen: 0, fired: 0 }));
    return json({ rules: rules.length });
  }
  if (url.pathname === "/__admin/rules") return json(rules);
  if (url.pathname === "/__admin/log") return json(log);
  if (url.pathname === "/__admin/reset") {
    rules = [];
    log = [];
    seq = 0;
    return json({ ok: true });
  }
  return json({ error: "unknown admin route" }, 404);
}

Bun.serve({
  port: 8080,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__admin/")) return admin(req, url);

    const t0 = Date.now();
    const path = url.pathname + url.search;
    const body = req.method === "GET" || req.method === "HEAD" ? new ArrayBuffer(0) : await req.arrayBuffer();
    const row: LogRow = {
      seq: ++seq,
      t: t0,
      method: req.method,
      path,
      bodyBytes: body.byteLength,
      bodySha: body.byteLength ? await sha(body) : "",
      action: "forward",
      ms: 0,
    };
    log.push(row);
    const rule = pick(req.method, path);
    if (rule) row.rule = rule.id;

    const done = (res: Response) => {
      row.clientStatus = res.status;
      row.ms = Date.now() - t0;
      return res;
    };

    if (rule?.mode === "error-before") {
      row.action = "error-before";
      return done(faultResponse(rule));
    }
    if (rule?.mode === "delay-before") {
      row.action = "delay-before";
      await sleep(rule.delayMs ?? 0);
    }

    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (!STRIP_REQ.has(k.toLowerCase())) headers.set(k, v);
    });
    let up: Response;
    try {
      up = await fetch(UPSTREAM + path, {
        method: req.method,
        headers,
        body: body.byteLength ? body : undefined,
        redirect: "manual",
      });
    } catch (e) {
      row.action = "upstream-unreachable";
      return done(new Response(String(e), { status: 502 }));
    }
    const buf = await up.arrayBuffer();
    row.upstreamStatus = up.status;
    try {
      const j = JSON.parse(new TextDecoder().decode(buf)) as { ref?: string; id?: string };
      row.upstreamRef = j.ref ?? (typeof j.id === "string" ? j.id : undefined);
    } catch {
      /* not JSON */
    }

    if (rule?.mode === "error-after") {
      row.action = "error-after";
      return done(faultResponse(rule));
    }
    if (rule?.mode === "delay-after") {
      row.action = "delay-after";
      await sleep(rule.delayMs ?? 0);
    }
    const out = new Headers();
    up.headers.forEach((v, k) => {
      if (!STRIP_RES.has(k.toLowerCase())) out.set(k, v);
    });
    return done(new Response(buf, { status: up.status, headers: out }));
  },
});
console.log("mgmt-fault-proxy listening on :8080 ->", UPSTREAM);
