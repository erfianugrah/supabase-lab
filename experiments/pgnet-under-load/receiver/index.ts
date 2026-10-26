// Receiver for pgnet-under-load (NL01-NL04). A workers.dev Worker that records
// every request it receives in a SQLite-backed Durable Object (one per run),
// BEFORE it answers, so the record exists even when the caller gave up.
//
//   POST /echo            200 at once
//   POST /sleep?ms=N      200 after N ms (NL01 ceiling, NL02 slow / hanging call)
//   POST /flaky           20% 503, 10% 200 after 8 s, 70% 200 at once (NL04)
//   GET  /ledger?run=R    every record of run R as JSON
//
// The request body is the JSON pg_net sends: {run, id, msg?, enq_ms, target}.
// enq_ms is the database's clock_timestamp() when the call was enqueued, so
// arr_ms - enq_ms is queue wait plus send time (plus clock offset between the
// database host and Cloudflare). No client address is stored or returned:
// the ledger is published.
import { DurableObject } from "cloudflare:workers";

interface Env {
  LEDGER: DurableObjectNamespace<Ledger>;
}

interface Rec {
  id: number;
  msg: number | null;
  path: string;
  outcome: string;
  arr_ms: number;
  enq_ms: number | null;
  sleep_ms: number;
}

/** Fault mix for /flaky, as fractions of requests. */
const P_5XX = 0.2;
const P_HANG = 0.1;
const HANG_MS = 8_000;

export class Ledger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "create table if not exists r (seq integer primary key autoincrement, id integer, msg integer, path text, outcome text, arr_ms integer, enq_ms integer, sleep_ms integer)",
    );
  }
  record(x: Rec): void {
    this.ctx.storage.sql.exec(
      "insert into r (id, msg, path, outcome, arr_ms, enq_ms, sleep_ms) values (?, ?, ?, ?, ?, ?, ?)",
      x.id, x.msg, x.path, x.outcome, x.arr_ms, x.enq_ms, x.sleep_ms,
    );
  }
  dump(): Record<string, unknown>[] {
    return this.ctx.storage.sql.exec("select id, msg, path, outcome, arr_ms, enq_ms, sleep_ms from r order by seq").toArray();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const arr = Date.now();
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/ledger") {
      const run = url.searchParams.get("run") ?? "";
      if (!run) return new Response("run required", { status: 400 });
      const rows = await env.LEDGER.get(env.LEDGER.idFromName(run)).dump();
      return Response.json(rows);
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await req.text()); } catch { /* not JSON */ }
    const run = String(body.run ?? "none");
    const id = Number(body.id ?? -1);
    const msg = body.msg === undefined || body.msg === null ? null : Number(body.msg);
    const enq = body.enq_ms === undefined ? null : Number(body.enq_ms);
    let outcome = "ok";
    let ms = 0;
    let status = 200;
    if (url.pathname === "/sleep") {
      ms = Math.max(0, Math.min(900_000, Number(url.searchParams.get("ms") ?? 0)));
      outcome = "sleep";
    } else if (url.pathname === "/flaky") {
      const r = Math.random();
      if (r < P_5XX) { outcome = "5xx"; status = 503; }
      else if (r < P_5XX + P_HANG) { outcome = "hang"; ms = HANG_MS; }
    } else if (url.pathname !== "/echo") {
      return new Response("not found", { status: 404 });
    }
    // Record first: a caller that times out still leaves the arrival behind.
    await env.LEDGER.get(env.LEDGER.idFromName(run)).record({ id, msg, path: url.pathname, outcome, arr_ms: arr, enq_ms: enq, sleep_ms: ms });
    if (ms > 0) await sleep(ms);
    return Response.json({ ok: status === 200, outcome, id, msg, arr_ms: arr, done_ms: Date.now() }, { status });
  },
};
