/**
 * Closed-loop write load with a client-side commit log, and the analysis that
 * turns the log plus the final table into a failover window and a lost-commit
 * count.
 *
 * Each worker owns one connection and writes (w, n) rows with n counting up,
 * one autocommit INSERT at a time. An INSERT that returns without error is an
 * ACKNOWLEDGED commit and goes in the log. One that errors is IN DOUBT: the
 * commit may or may not have landed, and the final table says which. After an
 * error the worker reconnects and carries on with the next n.
 *
 * Lost commit = acknowledged (w, n) absent from the table at the end. A row
 * present in the table whose INSERT errored is "committed but unacknowledged"
 * and is reported separately; it is not a loss.
 */
import { Client } from "pg";
import { PG_PASSWORD } from "./cluster";

export interface WriteEvent {
  w: number;
  n: number;
  /** epoch ms the statement was sent / settled */
  t0: number;
  t1: number;
  ok: boolean;
  err?: string;
}

export interface ConnectError {
  t: number;
  err: string;
}

export interface Writers {
  events: WriteEvent[];
  /** Failed (re)connect attempts. Not statements, so not in `events`; during a stall they show what clients saw. */
  connectErrors: ConnectError[];
  /** Successful connects that took more than 200 ms (the gateway accepted the connection but made the client wait). */
  connectWaits: { t: number; ms: number }[];
  stop(): Promise<void>;
}

export interface WriterOpts {
  host: string;
  port: number;
  workers: number;
  table: string;
  /** Client-side bound on one statement, so a hang is recorded as an error instead of blocking forever. */
  queryTimeoutMs: number;
  /** Sleep between statements on one worker. 0 or absent = closed loop. */
  pauseMs?: number;
}

function newClient(o: WriterOpts): Client {
  const c = new Client({
    host: o.host,
    port: o.port,
    user: "postgres",
    password: PG_PASSWORD,
    database: "postgres",
    connectionTimeoutMillis: 5000,
    query_timeout: o.queryTimeoutMs,
  });
  c.on("error", () => {});
  return c;
}

export function startWriters(o: WriterOpts): Writers {
  const events: WriteEvent[] = [];
  const connectErrors: ConnectError[] = [];
  const connectWaits: { t: number; ms: number }[] = [];
  let stopping = false;
  const loops: Promise<void>[] = [];

  async function worker(w: number): Promise<void> {
    let n = 0;
    let client: Client | null = null;
    while (!stopping) {
      if (!client) {
        const c = newClient(o);
        const tc = Date.now();
        try {
          await c.connect();
          client = c;
          if (Date.now() - tc > 200) connectWaits.push({ t: tc, ms: Date.now() - tc });
        } catch (e) {
          connectErrors.push({ t: Date.now(), err: (e instanceof Error ? e.message : String(e)).slice(0, 160) });
          await c.end().catch(() => {});
          await Bun.sleep(100);
          continue;
        }
      }
      n += 1;
      const t0 = Date.now();
      try {
        await client.query(`insert into ${o.table}(w, n) values ($1, $2)`, [w, n]);
        events.push({ w, n, t0, t1: Date.now(), ok: true });
      } catch (e) {
        events.push({
          w,
          n,
          t0,
          t1: Date.now(),
          ok: false,
          err: (e instanceof Error ? e.message : String(e)).slice(0, 160),
        });
        const dead = client;
        client = null;
        dead.end().catch(() => {});
      }
      if (o.pauseMs) await Bun.sleep(o.pauseMs);
    }
    await client?.end().catch(() => {});
  }

  for (let w = 0; w < o.workers; w++) loops.push(worker(w));
  return {
    events,
    connectErrors,
    connectWaits,
    async stop() {
      stopping = true;
      await Promise.all(loops);
    },
  };
}

export interface Analysis {
  attempts: number;
  acked: number;
  errored: number;
  /** acked (w, n) pairs missing from the final table */
  lost: number;
  /** errored (w, n) pairs that are in the final table anyway */
  committedUnacked: number;
  /** errored pairs absent from the table */
  erroredAbsent: number;
  /** Longest interval with no ack from any worker that ends after the fault. null if there is no ack after it. */
  stallMs: number | null;
  /** ms from the fault to the first failed statement's start; null if none failed. */
  firstErrorAfterFaultMs: number | null;
  /** ms from the fault to the last failed statement's end; null if none failed. */
  lastErrorAfterFaultMs: number | null;
  /** ms from the fault to the first ack that started after the last error (sustained recovery). */
  recoveredMs: number | null;
  maxLatencyMs: number;
  /** distinct error texts with counts, most frequent first */
  errorModes: [string, number][];
  tpsBefore: number | null;
  tpsAfter: number | null;
}

/** Pure: no clock, no network. `present` is the set of "w:n" keys found in the final table. */
export function analyse(events: WriteEvent[], present: Set<string>, tFault: number): Analysis {
  const key = (e: WriteEvent) => `${e.w}:${e.n}`;
  const acked = events.filter((e) => e.ok);
  const errored = events.filter((e) => !e.ok);
  const lost = acked.filter((e) => !present.has(key(e))).length;
  const committedUnacked = errored.filter((e) => present.has(key(e))).length;

  const ackTimes = acked.map((e) => e.t1).sort((a, b) => a - b);
  let stallMs: number | null = null;
  for (let i = 1; i < ackTimes.length; i++) {
    const a = ackTimes[i - 1]!;
    const b = ackTimes[i]!;
    // tFault is stamped before the signal is delivered, so acks can still land
    // for tens of ms after it; take the longest ack-free interval that ENDS
    // after the fault rather than the one that contains it.
    if (b > tFault) stallMs = Math.max(stallMs ?? 0, b - a);
  }

  const errAfter = errored.filter((e) => e.t1 >= tFault);
  const firstErr = errAfter.length ? Math.min(...errAfter.map((e) => e.t0)) : null;
  const lastErrEnd = errAfter.length ? Math.max(...errAfter.map((e) => e.t1)) : null;
  const firstAckAfterLastErr =
    lastErrEnd === null ? null : (ackTimes.find((t) => t > lastErrEnd) ?? null);

  const modes = new Map<string, number>();
  for (const e of errored) modes.set(e.err ?? "", (modes.get(e.err ?? "") ?? 0) + 1);

  const before = acked.filter((e) => e.t1 < tFault);
  const t0 = events.length ? Math.min(...events.map((e) => e.t0)) : tFault;
  const after = acked.filter((e) => e.t1 > tFault);
  const tEnd = events.length ? Math.max(...events.map((e) => e.t1)) : tFault;

  return {
    attempts: events.length,
    acked: acked.length,
    errored: errored.length,
    lost,
    committedUnacked,
    erroredAbsent: errored.length - committedUnacked,
    stallMs,
    firstErrorAfterFaultMs: firstErr === null ? null : Math.max(0, firstErr - tFault),
    lastErrorAfterFaultMs: lastErrEnd === null ? null : lastErrEnd - tFault,
    recoveredMs: firstAckAfterLastErr === null ? null : firstAckAfterLastErr - tFault,
    maxLatencyMs: events.reduce((m, e) => Math.max(m, e.t1 - e.t0), 0),
    errorModes: [...modes.entries()].sort((a, b) => b[1] - a[1]),
    tpsBefore: tFault > t0 ? Math.round((before.length / (tFault - t0)) * 1000) : null,
    tpsAfter: tEnd > tFault ? Math.round((after.length / (tEnd - tFault)) * 1000) : null,
  };
}

/** Read every (w, n) back through a fresh connection. */
export async function readPresent(host: string, port: number, table: string): Promise<Set<string>> {
  const c = new Client({
    host,
    port,
    user: "postgres",
    password: PG_PASSWORD,
    database: "postgres",
    connectionTimeoutMillis: 5000,
  });
  c.on("error", () => {});
  await c.connect();
  try {
    const r = await c.query<{ w: number; n: number }>(`select w, n from ${table}`);
    return new Set(r.rows.map((x) => `${x.w}:${x.n}`));
  } finally {
    await c.end().catch(() => {});
  }
}
