/**
 * Pure helpers for RR04 (same-region load balancer: read-your-writes, a stale
 * or loaded node, a restart, and what answers HEAD on the replica's host).
 */
import type { Tick } from "./rerouting";

export interface RawHttp {
  /** First line as received, or the first 80 bytes when no header block ended. */
  statusLine: string;
  /** 0 when the response did not parse. */
  status: number;
  /** Lowercased name, value as sent, in order. */
  headers: [string, string][];
  /** Body bytes after the header block, de-chunked when `transfer-encoding: chunked`. */
  body: Buffer;
}

function dechunk(b: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < b.length) {
    const eol = b.indexOf("\r\n", i);
    if (eol < 0) break;
    const size = parseInt(b.subarray(i, eol).toString().split(";")[0]!.trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(b.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/** An HTTP/1.1 response as read off the socket (Connection: close). */
export function parseRawHttp(raw: Buffer): RawHttp {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) return { statusLine: raw.subarray(0, 80).toString(), status: 0, headers: [], body: Buffer.alloc(0) };
  const lines = raw.subarray(0, end).toString().split("\r\n");
  const statusLine = lines[0] ?? "";
  const status = Number(statusLine.split(" ")[1] ?? 0) || 0;
  const headers: [string, string][] = lines.slice(1).map((l) => {
    const c = l.indexOf(":");
    return [l.slice(0, c).trim().toLowerCase(), l.slice(c + 1).trim()];
  });
  let body = raw.subarray(end + 4);
  if (headers.some(([k, v]) => k === "transfer-encoding" && v.toLowerCase().includes("chunked"))) body = dechunk(body);
  return { statusLine, status, headers, body };
}

export const headerNames = (h: [string, string][]): string[] => [...new Set(h.map(([k]) => k.toLowerCase()))].sort();

/** Adjacent changes in a node sequence and the longest run of one letter. */
export function seqStats(seq: string): { switches: number; max_run: number } {
  let sw = 0;
  let run = 0;
  let maxRun = 0;
  for (let i = 0; i < seq.length; i++) {
    if (i && seq[i] !== seq[i - 1]) sw++;
    run = i && seq[i] === seq[i - 1] ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  }
  return { switches: sw, max_run: maxRun };
}

/** First and last failing tick of `src` (no node in the answer). Null when it never failed. */
export function errorSpan(ticks: Tick[], src: string): { from: number; to: number; errors: number } | null {
  const e = ticks.filter((k) => k.src === src && !k.node);
  if (!e.length) return null;
  return { from: e[0]!.t, to: e[e.length - 1]!.t, errors: e.length };
}

export interface RywTry {
  node?: "primary" | "replica";
  /** Did the GET see the row the POST just wrote. */
  seen?: boolean;
  err?: string;
  postMs: number;
  getMs: number;
  /** For a stale read: ms from the stale answer until a GET through the same endpoint saw the row. */
  untilSeenMs?: number;
  retries?: number;
  /** Replica only: the replica's clock minus the primary's commit time of the last replayed transaction (includes clock skew between the hosts). */
  replayAgeMs?: number;
}

const p = (xs: number[], q: number) => {
  if (!xs.length) return "none";
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1))]!;
};

/** Scalar figures for a read-your-writes arm. `stale` counts misses: replica answers that did not see the row (row visibility, not stale_ms). */
export function rywSummary(tries: RywTry[]): Record<string, number | string> {
  const rep = tries.filter((t) => t.node === "replica");
  const pri = tries.filter((t) => t.node === "primary");
  const stale = rep.filter((t) => t.seen === false);
  const until = stale.filter((t) => t.untilSeenMs !== undefined).map((t) => t.untilSeenMs!);
  return {
    n: tries.length,
    replica: rep.length,
    primary: pri.length,
    errors: tries.filter((t) => !t.node).length,
    stale: stale.length,
    stale_of_replica_reads: `${stale.length} of ${rep.length}`,
    primary_unseen: pri.filter((t) => t.seen === false).length,
    until_seen_max_ms: until.length ? Math.max(...until) : "none",
    until_seen_p50_ms: p(until, 50),
    post_p50_ms: p(tries.map((t) => t.postMs), 50),
    get_p50_ms: p(tries.map((t) => t.getMs), 50),
  };
}
