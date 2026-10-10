/**
 * pgbench as the write load, with its own per-transaction log (-l) as the
 * client-side commit log. A pgbench log line is written when a transaction
 * COMPLETES, i.e. the server acknowledged the commit. The script inserts one
 * row per transaction tagged with :client_id, so per-client counts in the
 * table can be compared with per-client counts in the log: a client with more
 * logged transactions than rows lost acknowledged commits. (pgbench has no
 * per-client sequence number, so this finds a loss but cannot name the row.)
 */

export interface PgbenchLogLine {
  client: number;
  /** completion time, epoch ms */
  tMs: number;
}

/** `client_id transaction_no latency script_no time_epoch time_us` */
export function parsePgbenchLog(text: string): PgbenchLogLine[] {
  const out: PgbenchLogLine[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const client = Number(f[0]);
    const epoch = Number(f[4]);
    const us = Number(f[5]);
    if (![client, epoch, us].every(Number.isFinite)) continue;
    out.push({ client, tMs: epoch * 1000 + us / 1000 });
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

export interface PgbenchAnalysis {
  acked: number;
  lost: number;
  /** longest interval with no completed transaction that ends after the fault */
  stallMs: number | null;
  /** clients with at least one completed transaction after the fault + 1 s */
  clientsAlive: number;
  clientsTotal: number;
  /** last completion time minus the fault, ms: when the log stops */
  logEndsAfterFaultMs: number | null;
}

export function analysePgbench(lines: PgbenchLogLine[], rowsPerClient: Map<number, number>, tFault: number): PgbenchAnalysis {
  const perClient = new Map<number, number>();
  for (const l of lines) perClient.set(l.client, (perClient.get(l.client) ?? 0) + 1);
  let lost = 0;
  for (const [c, n] of perClient) lost += Math.max(0, n - (rowsPerClient.get(c) ?? 0));
  let stall: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.tMs > tFault) stall = Math.max(stall ?? 0, lines[i]!.tMs - lines[i - 1]!.tMs);
  }
  const alive = new Set(lines.filter((l) => l.tMs > tFault + 1000).map((l) => l.client));
  return {
    acked: lines.length,
    lost,
    stallMs: stall,
    clientsAlive: alive.size,
    clientsTotal: perClient.size,
    logEndsAfterFaultMs: lines.length ? Math.round(lines[lines.length - 1]!.tMs - tFault) : null,
  };
}
