/**
 * Logical-slot consumers and accounting for RP09 (slots across platform
 * operations).
 *
 * Three consumers, one slot each, all reading the same table
 * (`public.rp_slot_events`, one row per transaction from a steady writer):
 *
 *   pgoutput_sql  `pg_logical_slot_get_binary_changes` through the session
 *                 pooler, proto_version 1, parsed here (B/R/I/C messages).
 *   wal2json_sql  `pg_logical_slot_get_changes` through the session pooler,
 *                 format-version 2.
 *   wal2json_stream  `pg_recvlogical --start` over the direct IPv6 host, a
 *                 walsender connection that holds the slot `active`. Spawned
 *                 with `--no-loop` so this process owns reconnection.
 *
 * The SQL interface advances the slot when the call returns, so for the two
 * SQL consumers a transaction delivered twice means the slot's
 * confirmed_flush_lsn went backwards (or a call's result was lost on the
 * wire after the slot moved, which shows up as a gap, not a duplicate). For
 * the streaming consumer a redelivery is expected for anything past the last
 * flush position it confirmed; only a redelivered transaction whose end LSN
 * is at or before that confirmed position is a rewind.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve6 } from "node:dns/promises";
import type { Client } from "pg";

/* ---------- LSN helpers ---------- */

/** "16/B374D848" -> bigint byte position. */
export function lsnToBig(lsn: string): bigint {
  const m = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(lsn.trim());
  if (!m) throw new Error(`not an LSN: ${lsn}`);
  return (BigInt(`0x${m[1]}`) << 32n) + BigInt(`0x${m[2]}`);
}

export function bigToLsn(b: bigint): string {
  return `${(b >> 32n).toString(16).toUpperCase()}/${(b & 0xffffffffn).toString(16).toUpperCase()}`;
}

/* ---------- decoded transactions ---------- */

/** One decoded transaction: the row ids it inserted and its end LSN. */
export interface DecodedTx {
  /** End of the commit record (the position a consumer confirms). */
  endLsn: bigint;
  ids: number[];
}

/**
 * Parse pgoutput (proto_version 1) messages for one call's result rows into
 * transactions. Only B, I and C carry what we need; R (relation), Y (type),
 * O (origin) and anything else is skipped. The first column of the tuple is
 * the id, sent as text ('t').
 */
export function parsePgoutput(msgs: Buffer[]): DecodedTx[] {
  const out: DecodedTx[] = [];
  let cur: DecodedTx | null = null;
  for (const m of msgs) {
    const kind = String.fromCharCode(m[0] ?? 0);
    if (kind === "B") {
      cur = { endLsn: 0n, ids: [] };
    } else if (kind === "I" && cur) {
      // 'I' int32 relid, 'N', int16 ncols, then per column a kind byte.
      let o = 1 + 4;
      if (String.fromCharCode(m[o] ?? 0) !== "N") continue;
      o += 1;
      const ncols = m.readInt16BE(o);
      o += 2;
      if (ncols < 1) continue;
      const ck = String.fromCharCode(m[o] ?? 0);
      o += 1;
      if (ck !== "t") continue;
      const len = m.readInt32BE(o);
      o += 4;
      const id = Number(m.subarray(o, o + len).toString("utf8"));
      if (Number.isFinite(id)) cur.ids.push(id);
    } else if (kind === "C" && cur) {
      // 'C' int8 flags, int64 commit lsn, int64 end lsn, int64 ts.
      cur.endLsn = m.readBigUInt64BE(1 + 1 + 8);
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

/**
 * Parse wal2json format-version 2 lines (one JSON object per action) into
 * transactions. With `include-lsn` B and C carry `nextlsn` (the end of the
 * commit record); without it endLsn stays 0 (run S1's wal2json SQL
 * consumer ran that way, under the working id RP08). I carries `columns`
 * with the id.
 */
export function parseWal2json(lines: string[]): DecodedTx[] {
  const out: DecodedTx[] = [];
  let cur: DecodedTx | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let j: { action?: string; nextlsn?: string; table?: string; columns?: { name: string; value: unknown }[] };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.action === "B") cur = { endLsn: 0n, ids: [] };
    else if (j.action === "I" && cur && j.table === "rp_slot_events") {
      const v = j.columns?.find((c) => c.name === "id")?.value;
      if (v !== undefined) cur.ids.push(Number(v));
    } else if (j.action === "C" && cur) {
      cur.endLsn = j.nextlsn ? lsnToBig(j.nextlsn) : 0n;
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

/* ---------- per-consumer ledger ---------- */

export interface Redelivery {
  id: number;
  phase: string;
  endLsn: string;
  /** True when the tx ended at or before the position this consumer had already confirmed. */
  rewind: boolean;
}

/**
 * What one consumer received, by phase. `confirmed` is the position the slot
 * was told it may forget: for the SQL interface, the end of the last
 * transaction a call returned; for the stream, the last flush position
 * pg_recvlogical reported sending.
 */
export class Ledger {
  readonly name: string;
  seen = new Map<number, string>();
  received: { id: number; phase: string; at: number }[] = [];
  redeliveries: Redelivery[] = [];
  confirmed = 0n;
  maxEnd = 0n;
  lastOkAt = 0;
  /** Gaps between successful calls/messages longer than 5 s, as [phase, seconds]. */
  stalls: { phase: string; s: number }[] = [];
  errors: string[] = [];
  calls = 0;
  constructor(name: string) {
    this.name = name;
  }
  /** Record one delivered transaction. `confirmedBefore` is the consumer's confirmed position before this delivery. */
  take(tx: DecodedTx, phase: string, confirmedBefore: bigint, at = Date.now()): void {
    for (const id of tx.ids) {
      if (this.seen.has(id)) {
        this.redeliveries.push({ id, phase, endLsn: bigToLsn(tx.endLsn), rewind: tx.endLsn <= confirmedBefore });
      } else {
        this.seen.set(id, phase);
      }
      this.received.push({ id, phase, at });
    }
    if (tx.endLsn > this.maxEnd) this.maxEnd = tx.endLsn;
  }
  ok(phase: string, at = Date.now()): void {
    if (this.lastOkAt && at - this.lastOkAt > 5000) this.stalls.push({ phase, s: Math.round((at - this.lastOkAt) / 1000) });
    this.lastOkAt = at;
  }
  err(e: string): void {
    if (!this.errors.includes(e) && this.errors.length < 20) this.errors.push(e);
  }
}

/** Ids the writer had acked that a consumer never received. */
export function gaps(acked: Map<number, string>, l: Ledger): { id: number; phase: string }[] {
  const out: { id: number; phase: string }[] = [];
  for (const [id, phase] of acked) if (!l.seen.has(id)) out.push({ id, phase });
  return out;
}

/** Summary per phase: duplicates (all / rewind-class) and gaps. */
export function phaseCounts(phase: string, acked: Map<number, string>, l: Ledger): { dup: number; dupRewind: number; gap: number; recv: number } {
  const dup = l.redeliveries.filter((r) => r.phase === phase);
  return {
    dup: dup.length,
    dupRewind: dup.filter((r) => r.rewind).length,
    gap: gaps(acked, l).filter((g) => g.phase === phase).length,
    recv: l.received.filter((r) => r.phase === phase).length,
  };
}

/* ---------- SQL-interface consumer ---------- */

export interface SqlConsumerOpts {
  ledger: Ledger;
  plugin: "pgoutput" | "wal2json";
  slot: string;
  connect: () => Promise<Client>;
  phase: () => string;
  /** Called after a reconnect, before the first call: lets the observer read the slot first. */
  afterReconnect: (since: number) => Promise<void>;
  intervalMs?: number;
}

export interface Runner {
  stop(): Promise<void>;
}

export function sqlConsumer(o: SqlConsumerOpts): Runner {
  let running = true;
  const q =
    o.plugin === "pgoutput"
      ? `select lsn::text, data from pg_logical_slot_get_binary_changes('${o.slot}', null, null, 'proto_version', '1', 'publication_names', 'rp_slot_pub')`
      : `select lsn::text, data from pg_logical_slot_get_changes('${o.slot}', null, null, 'format-version', '2', 'include-lsn', 'true', 'add-tables', 'public.rp_slot_events')`;
  const loop = (async () => {
    let c: Client | null = null;
    let lostAt = 0;
    while (running) {
      try {
        if (!c) {
          c = await o.connect();
          if (lostAt) await o.afterReconnect(lostAt);
          lostAt = 0;
        }
        o.ledger.calls += 1;
        const r = await c.query(q);
        const txs =
          o.plugin === "pgoutput"
            ? parsePgoutput(r.rows.map((x: { data: Buffer }) => x.data))
            : parseWal2json(r.rows.map((x: { data: string }) => x.data));
        const phase = o.phase();
        for (const tx of txs) {
          o.ledger.take(tx, phase, o.ledger.confirmed);
        }
        // The call returned, so the slot moved to the end of the last tx it decoded.
        for (const tx of txs) if (tx.endLsn > o.ledger.confirmed) o.ledger.confirmed = tx.endLsn;
        o.ledger.ok(phase);
      } catch (e) {
        o.ledger.err((e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160));
        if (c) await c.end().catch(() => {});
        c = null;
        if (!lostAt) lostAt = Date.now();
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      await new Promise((r) => setTimeout(r, o.intervalMs ?? 1000));
    }
    if (c) await c.end().catch(() => {});
  })();
  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}

/* ---------- streaming consumer (pg_recvlogical) ---------- */

export interface StreamOpts {
  ledger: Ledger;
  slot: string;
  host: string;
  password: string;
  phase: () => string;
  /** Directory for per-spawn output files (gitignored evidence dir). */
  dir: string;
  log: (m: string) => void;
  /** Called before every respawn after the first, with the exit time. */
  beforeRespawn?: (lostAt: number) => Promise<void>;
}

export interface StreamRunner extends Runner {
  spawns: number;
  /** One line per spawn exit: "t <iso> exit <code> <last stderr>". */
  exits: string[];
}

/**
 * Keep pg_recvlogical running against the slot. `--no-loop` makes it exit on
 * connection loss; it is respawned after 3 s with a fresh AAAA lookup (the
 * address may change across a resize). Output goes to a file per spawn which
 * is tailed every 250 ms, so each line gets a receive timestamp and phase.
 * stderr's "confirming write up to X, flush to Y" lines (-v) set the
 * consumer's confirmed position.
 */
export function streamConsumer(o: StreamOpts): StreamRunner {
  let running = true;
  let child: ChildProcess | null = null;
  const st: StreamRunner = {
    spawns: 0,
    exits: [],
    async stop() {
      running = false;
      child?.kill("SIGINT");
      await loop;
    },
  };
  const loop = (async () => {
    while (running) {
      const file = `${o.dir}/stream-${st.spawns}.jsonl`;
      let addr = "";
      try {
        addr = (await resolve6(o.host))[0] ?? "";
      } catch (e) {
        o.ledger.err(`resolve6: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
      }
      if (!addr) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      st.spawns += 1;
      let lastErr = "";
      const conninfo = `host=${o.host} hostaddr=${addr} port=5432 user=postgres dbname=postgres sslmode=require connect_timeout=10`;
      const p = spawn(
        "pg_recvlogical",
        ["-d", conninfo, "--slot", o.slot, "--start", "--no-loop", "-f", file, "-F", "1", "-s", "1", "-o", "format-version=2", "-o", "include-lsn=true", "-o", "add-tables=public.rp_slot_events", "-v"],
        { env: { PATH: process.env.PATH ?? "", PGPASSWORD: o.password } },
      );
      child = p;
      p.stderr?.on("data", (d: Buffer) => {
        for (const line of String(d).split("\n")) {
          const m = /flush to ([0-9A-F]+\/[0-9A-F]+)/i.exec(line);
          if (m?.[1]) {
            const f = lsnToBig(m[1]);
            if (f > o.ledger.confirmed) o.ledger.confirmed = f;
            o.ledger.ok(o.phase());
          } else if (line.trim() && !/confirming|streaming initiated|starting log streaming/.test(line)) {
            lastErr = line.trim().slice(0, 160);
            o.ledger.err(lastErr.replace(/[0-9a-f:]{6,}/gi, "<addr>"));
          }
        }
      });
      const done = new Promise<number>((r) => p.on("exit", (code) => r(code ?? -1)));
      // Tail the output file.
      let pos = 0;
      let buf = "";
      let pending: string[] = [];
      let exited = false;
      void done.then(() => (exited = true));
      while (!exited || pos < sizeOf(file)) {
        const sz = sizeOf(file);
        if (sz > pos) {
          const fd = openSync(file, "r");
          const b = Buffer.alloc(sz - pos);
          readSync(fd, b, 0, b.length, pos);
          closeSync(fd);
          pos = sz;
          buf += b.toString("utf8");
          const parts = buf.split("\n");
          buf = parts.pop() ?? "";
          pending = pending.concat(parts);
          // Only hand over complete transactions (through the last C line).
          let lastC = -1;
          for (let i = pending.length - 1; i >= 0; i--) if (pending[i]?.includes('"action":"C"')) { lastC = i; break; }
          if (lastC >= 0) {
            const phase = o.phase();
            const before = o.ledger.confirmed;
            for (const tx of parseWal2json(pending.slice(0, lastC + 1))) o.ledger.take(tx, phase, before);
            pending = pending.slice(lastC + 1);
          }
        }
        if (exited && sizeOf(file) <= pos) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const code = await done;
      st.exits.push(`${new Date().toISOString()} exit ${code} ${lastErr.replace(/[0-9a-f:]{6,}/gi, "<addr>")}`.slice(0, 200));
      child = null;
      if (running) {
        await new Promise((r) => setTimeout(r, 3000));
        if (o.beforeRespawn) await o.beforeRespawn(Date.now());
      }
    }
  })();
  return st;
}

function sizeOf(f: string): number {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
}

/* ---------- slot snapshots ---------- */

export interface SlotRow {
  slot_name: string;
  plugin: string | null;
  slot_type: string;
  active: boolean;
  restart_lsn: string | null;
  confirmed_flush_lsn: string | null;
  wal_status: string | null;
  retained_bytes: string | null;
}

export interface Snapshot {
  at: number;
  phase: string;
  currentLsn: string;
  postmasterStart: string;
  maxSlots: string;
  slots: SlotRow[];
}

export const SNAPSHOT_SQL =
  "select now(), pg_current_wal_lsn()::text as cur, pg_postmaster_start_time()::text as pm, current_setting('max_replication_slots') as mrs, " +
  "coalesce(json_agg(json_build_object('slot_name', slot_name, 'plugin', plugin, 'slot_type', slot_type, 'active', active, " +
  "'restart_lsn', restart_lsn::text, 'confirmed_flush_lsn', confirmed_flush_lsn::text, 'wal_status', wal_status, " +
  "'retained_bytes', pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint::text) order by slot_name) filter (where slot_name is not null), '[]') as slots " +
  "from (select 1) x left join pg_replication_slots on true";

/** One line per slot: "name active=.. restart=.. confirmed=.. retained=..". */
export function snapLine(s: Snapshot | undefined): string {
  if (!s) return "none";
  return s.slots
    .map((x) => `${x.slot_name}(${x.slot_type}${x.plugin ? `/${x.plugin}` : ""}) active=${x.active} restart=${x.restart_lsn} confirmed=${x.confirmed_flush_lsn} retained=${x.retained_bytes} wal_status=${x.wal_status}`)
    .join("; ");
}
