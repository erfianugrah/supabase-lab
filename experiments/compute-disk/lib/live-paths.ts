/**
 * D13's I/O half: Postgres path probes, a continuous multi-phase sampler and
 * a server-side write load. Pure accounting lives in disk-change.ts.
 *
 * Why not harness/src/sampler.ts: `sampleDuring` reports one window per path
 * (first failure to settled recovery) and stops early once a path recovered.
 * D13 samples for hours across a dozen phases (baseline, a disk grow, a load,
 * a cooldown wait, the IOPS change, the second change) and has to report
 * every failure with its time and phase, so it keeps every sample and marks
 * phases, the D09 shape (outage.ts). The sampler's sample deadline
 * (`withDeadline`) and its host-pause rule (wall clock against monotonic) are
 * reused.
 *
 * Two probe kinds per Postgres path, because a disk change could hurt them
 * differently:
 *   held   one connection kept open, `select pg_postmaster_start_time()` each
 *          sample: catches a dropped session (restart, failover, pooler
 *          reconnect) and reads the postmaster start time on every sample.
 *          On any error the client is destroyed and the next sample
 *          reconnects, which is what an application's pool does.
 *   fresh  connect, `select 1`, disconnect: catches a window in which new
 *          connections are refused.
 * Both set `query_timeout` (a pg query without one can pin its loop, #211).
 */
import { Client } from "pg";
import { withDeadline } from "../../../harness/src/sampler";
import { PAUSE_SLACK_MS } from "../../../harness/src/host-pause";
import type { PhaseMark } from "./outage";
import { mbps, parseNodeMetrics, diskDelta, pathPhaseStats, failureLines, type NodeSnap, type PathSample, type PathPhaseStats, type DiskDelta } from "./disk-change";

export const PROBE_TIMEOUT_MS = 5_000;

export interface PgTarget {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface Outcome {
  ok: boolean;
  error?: string;
  ms: number;
}

export interface TimedProbe {
  name: string;
  intervalMs: number;
  run(): Promise<Outcome>;
  close?(): Promise<void>;
}

const errText = (e: unknown): string => {
  const code = (e as { code?: string } | null)?.code;
  const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ");
  return (code && !msg.includes(code) ? `${code} ${msg}` : msg).slice(0, 160);
};

function mkClient(t: PgTarget, queryTimeoutMs = PROBE_TIMEOUT_MS): Client {
  const c = new Client({
    host: t.host,
    port: t.port,
    user: t.user,
    password: t.password,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    query_timeout: queryTimeoutMs,
    keepAlive: true,
  });
  return c;
}

async function destroy(c: Client | null): Promise<void> {
  if (!c) return;
  (c as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
  await Promise.race([c.end().catch(() => {}), Bun.sleep(2_000)]);
}

/** Postmaster start times (epoch s) seen on held probes, with the first time each was seen. */
export class PostmasterLog {
  readonly seen = new Map<number, { firstAt: number; path: string }>();
  note(pst: number, path: string, at: number, log: (m: string) => void): void {
    if (this.seen.has(pst)) return;
    this.seen.set(pst, { firstAt: at, path });
    if (this.seen.size > 1) log(`POSTMASTER START TIME CHANGED: ${new Date(pst * 1000).toISOString()} first seen on ${path}`);
  }
}

export function heldProbe(name: string, t: PgTarget, intervalMs: number, pm: PostmasterLog, events: string[], log: (m: string) => void): TimedProbe & { reconnects(): number } {
  let c: Client | null = null;
  let connects = 0;
  return {
    name,
    intervalMs,
    reconnects: () => Math.max(0, connects - 1),
    async run(): Promise<Outcome> {
      const m0 = performance.now();
      try {
        if (!c) {
          const nc = mkClient(t);
          nc.on("error", (e) => {
            const line = `${new Date().toISOString()} ${name}: held connection error event: ${errText(e)}`;
            events.push(line);
            log(line);
          });
          c = nc;
          await nc.connect();
          connects += 1;
        }
        const r = await c.query("select extract(epoch from pg_postmaster_start_time())::float8 as pst");
        const pst = Number((r.rows[0] as { pst?: number } | undefined)?.pst);
        if (Number.isFinite(pst)) pm.note(pst, name, Date.now(), log);
        return { ok: true, ms: Math.round(performance.now() - m0) };
      } catch (e) {
        const dead = c;
        c = null;
        await destroy(dead);
        return { ok: false, error: errText(e), ms: Math.round(performance.now() - m0) };
      }
    },
    async close() {
      const dead = c;
      c = null;
      await destroy(dead);
    },
  };
}

export function freshProbe(name: string, t: PgTarget, intervalMs: number): TimedProbe {
  return {
    name,
    intervalMs,
    async run(): Promise<Outcome> {
      const m0 = performance.now();
      const c = mkClient(t);
      c.on("error", () => {});
      try {
        await c.connect();
        await c.query("select 1");
        return { ok: true, ms: Math.round(performance.now() - m0) };
      } catch (e) {
        return { ok: false, error: errText(e), ms: Math.round(performance.now() - m0) };
      } finally {
        await destroy(c);
      }
    },
  };
}

/** Wrap a harness Probe (rest_read) with latency. */
export function timed(name: string, intervalMs: number, run: () => Promise<{ ok: boolean; error?: string }>): TimedProbe {
  return {
    name,
    intervalMs,
    async run(): Promise<Outcome> {
      const m0 = performance.now();
      const o = await run();
      return { ...o, ms: Math.round(performance.now() - m0) };
    },
  };
}

export interface Pause {
  fromMs: number;
  toMs: number;
  phase: string;
  suspended: boolean;
}

/**
 * Every path sampled on its own loop from start() to stop(), every sample
 * kept, phases marked on one shared list. Logs a path's transitions (down,
 * up again), not every failure.
 */
export class Continuous {
  readonly samples = new Map<string, PathSample[]>();
  readonly phases: PhaseMark[] = [];
  readonly pauses: Pause[] = [];
  private stopped = false;
  private loops: Promise<void>[] = [];
  readonly t0 = Date.now();

  constructor(
    private readonly probes: TimedProbe[],
    private readonly log: (m: string) => void,
    private readonly sampleDeadlineMs = 30_000,
  ) {
    for (const p of probes) this.samples.set(p.name, []);
  }

  phase(name: string, at = Date.now()): void {
    this.phases.push({ name, startMs: at });
    this.log(`-- phase ${name} at +${((at - this.t0) / 1000).toFixed(1)}s`);
  }

  current(): string {
    return this.phases[this.phases.length - 1]?.name ?? "";
  }

  start(firstPhase: string): void {
    this.phase(firstPhase);
    for (const p of this.probes) this.loops.push(this.loop(p));
    this.loops.push(this.watchdog());
  }

  private async loop(p: TimedProbe): Promise<void> {
    const arr = this.samples.get(p.name) as PathSample[];
    let down = false;
    while (!this.stopped) {
      const at = Date.now();
      const m0 = performance.now();
      const o = (await withDeadline(
        p.run().then((x) => x as unknown as { ok: boolean; error?: string }),
        this.sampleDeadlineMs,
      ).catch((e: unknown) => ({ ok: false, error: errText(e) }))) as Outcome;
      const ms = typeof o.ms === "number" ? o.ms : Math.round(performance.now() - m0);
      arr.push({ at, ok: o.ok, ms, ...(o.ok ? {} : { error: (o.error ?? "unknown").slice(0, 160) }) });
      if (!o.ok && !down) this.log(`${p.name} DOWN [${this.current()}] ${o.error ?? "unknown"}`);
      if (o.ok && down) this.log(`${p.name} up again [${this.current()}]`);
      down = !o.ok;
      const spent = performance.now() - m0;
      if (spent < p.intervalMs) await Bun.sleep(p.intervalMs - spent);
    }
  }

  private async watchdog(): Promise<void> {
    let w = Date.now();
    let m = performance.now();
    while (!this.stopped) {
      await Bun.sleep(1_000);
      const w1 = Date.now();
      const m1 = performance.now();
      const late = w1 - w - 1_000;
      if (late > PAUSE_SLACK_MS) {
        const suspended = w1 - w - (m1 - m) > PAUSE_SLACK_MS;
        this.pauses.push({ fromMs: w, toMs: w1, phase: this.current(), suspended });
        this.log(`host paused ${Math.round((w1 - w) / 1000)} s in [${this.current()}] (${suspended ? "the host was suspended" : "the event loop was blocked"}); no sample ran in it`);
      }
      w = w1;
      m = m1;
    }
  }

  async stop(): Promise<number> {
    this.stopped = true;
    await Promise.all(this.loops);
    await Promise.all(this.probes.map((p) => p.close?.().catch(() => {})));
    return Date.now();
  }

  stats(endMs: number): Map<string, PathPhaseStats[]> {
    const out = new Map<string, PathPhaseStats[]>();
    for (const [name, arr] of this.samples) out.set(name, pathPhaseStats(arr, this.phases, endMs));
    return out;
  }

  failureLog(capPerPath = 300): string[] {
    const lines: string[] = [];
    for (const [name, arr] of this.samples) lines.push(...failureLines(name, arr, this.phases, this.t0, capPerPath));
    const t = (l: string) => (l.startsWith("+") ? Number.parseFloat(l.slice(1)) : Number.POSITIVE_INFINITY);
    return lines.sort((a, b) => t(a) - t(b));
  }
}

/** The project's node_exporter snapshot (Basic auth as service_role). Null on any failure. */
export async function scrapeNode(apiHost: string, serviceKey: string): Promise<NodeSnap | null> {
  try {
    const auth = Buffer.from(`service_role:${serviceKey}`).toString("base64");
    const r = await fetch(`https://${apiHost}/customer/v1/privileged/metrics`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const s = parseNodeMetrics(await r.text());
    return Number.isFinite(s.timeS) ? s : null;
  } catch {
    return null;
  }
}

/** Poll until a snapshot newer than `afterWallMs` arrives (the endpoint serves a cached snapshot), or give up. */
export async function freshSnap(apiHost: string, serviceKey: string, afterWallMs: number, maxMs = 120_000): Promise<NodeSnap | null> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const s = await scrapeNode(apiHost, serviceKey);
    if (s && s.timeS * 1000 > afterWallMs) return s;
    await Bun.sleep(5_000);
  }
  return null;
}

export interface LoadResult {
  label: string;
  ok: boolean;
  error: string;
  rowsPerSession: number;
  sessions: number;
  insertMs: number;
  checkpoint: string;
  checkpointMs: number;
  totalMs: number;
  heapBytes: number;
  walBytes: number;
  unlogged: boolean;
  /** (heap + WAL) / insert time. WAL is flushed by commit; the heap can still be in the page cache. */
  writtenMBps: number;
  /** WAL / insert time: the part that is on disk when the INSERT returns. */
  walMBps: number;
  disk: DiskDelta | null;
}

/**
 * Server-side write load sized in bytes, not time, so a faster disk cannot
 * fill the volume: `sessions` sessions each insert `rows` rows of about 1.9 kB
 * (four per 8 kB page, under the TOAST threshold, so nothing is compressed)
 * into their own table, then try CHECKPOINT (refused to `postgres` on the
 * platform, 42501, 2026-11-04). With 500,000 rows a session writes about 1 GB
 * of heap and as much WAL. The insert time is the measurement; WAL bytes come
 * from the LSN, heap bytes from the relation size. `unlogged` writes the same
 * rows with no WAL: the control for how much of the logged time is WAL I/O.
 * Tables are truncated afterwards.
 */
export async function ioLoad(
  label: string,
  t: PgTarget,
  opts: { rows: number; sessions: number; apiHost: string; serviceKey: string; log: (m: string) => void; unlogged?: boolean },
): Promise<LoadResult> {
  const res: LoadResult = {
    label, ok: false, error: "", rowsPerSession: opts.rows, sessions: opts.sessions, insertMs: -1,
    checkpoint: "not run", checkpointMs: -1, totalMs: -1, heapBytes: -1, walBytes: -1, unlogged: !!opts.unlogged,
    writtenMBps: -1, walMBps: -1, disk: null,
  };
  const ctl = mkClient(t, 900_000);
  ctl.on("error", () => {});
  const tables = Array.from({ length: opts.sessions }, (_, i) => `pvlab_${opts.unlogged ? "iou" : "io"}_${i + 1}`);
  try {
    await ctl.connect();
    await ctl.query("set statement_timeout = 0");
    for (const tb of tables) {
      await ctl.query(`create ${opts.unlogged ? "unlogged " : ""}table if not exists public.${tb} (id int, v text) with (autovacuum_enabled = false)`);
      await ctl.query(`truncate public.${tb}`);
    }
    const lsn0 = Number((await ctl.query("select pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::float8 as b")).rows[0]?.b);
    const snap0 = await scrapeNode(opts.apiHost, opts.serviceKey);
    const m0 = performance.now();
    const per = await Promise.all(
      tables.map(async (tb) => {
        const c = mkClient(t, 900_000);
        c.on("error", () => {});
        try {
          await c.connect();
          await c.query("set statement_timeout = 0");
          const s = performance.now();
          await c.query(`insert into public.${tb} select g, repeat('x', 1900) from generate_series(1, ${opts.rows}) g`);
          return performance.now() - s;
        } finally {
          await destroy(c);
        }
      }),
    );
    const m1 = performance.now();
    res.insertMs = Math.round(Math.max(...per));
    try {
      await ctl.query("checkpoint");
      res.checkpoint = "ok";
      res.checkpointMs = Math.round(performance.now() - m1);
    } catch (e) {
      res.checkpoint = `refused: ${errText(e)}`.slice(0, 120);
    }
    const m2 = performance.now();
    const endWall = Date.now();
    res.totalMs = Math.round(m2 - m0);
    const lsn1 = Number((await ctl.query("select pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::float8 as b")).rows[0]?.b);
    res.walBytes = Math.round(lsn1 - lsn0);
    res.heapBytes = Number(
      (await ctl.query(`select (${tables.map((tb) => `pg_total_relation_size('public.${tb}')`).join(" + ")})::float8 as b`)).rows[0]?.b,
    );
    res.writtenMBps = mbps(res.heapBytes + res.walBytes, res.insertMs);
    res.walMBps = mbps(res.walBytes, res.insertMs);
    const snap1 = snap0 ? await freshSnap(opts.apiHost, opts.serviceKey, endWall) : null;
    res.disk = snap0 && snap1 ? diskDelta(snap0, snap1) : null;
    for (const tb of tables) await ctl.query(`truncate public.${tb}`);
    res.ok = true;
    opts.log(
      `load ${label}: insert ${res.insertMs} ms, checkpoint ${res.checkpoint} ${res.checkpointMs} ms, heap ${Math.round(res.heapBytes / 1e6)} MB + WAL ${Math.round(res.walBytes / 1e6)} MB${opts.unlogged ? " (unlogged)" : ""}, ${res.writtenMBps} MB/s written, ${res.walMBps} MB/s WAL; disk ${res.disk ? `${res.disk.device} ${res.disk.writtenMB} MB over ${res.disk.seconds} s` : "no fresh metrics"}`,
    );
  } catch (e) {
    res.error = errText(e);
    opts.log(`load ${label} FAILED: ${res.error}`);
  } finally {
    await destroy(ctl);
  }
  return res;
}
