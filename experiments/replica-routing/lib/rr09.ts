/**
 * Pure helpers for RR09 (cold reads per node, an IO-saturated primary, edge_logs
 * per hostname, and the load balancer after its only replica is removed).
 *
 * Block counters come from `pg_stat_database` on each node (`blks_read`,
 * `blks_hit`), read over a session connection to that node. `blks_read` counts
 * shared-buffer misses, which includes reads the OS page cache answered, so it
 * stands in for disk reads only when the table is several times the node's RAM
 * (the module sizes it that way).
 */
import { tallyBy } from "./rr08";

export interface Blks {
  read: number;
  hit: number;
}

/** after - before; -1 everywhere if a counter went backwards (stats reset, e.g. a restart). */
export function blkDelta(before: Blks, after: Blks): { read: number; hit: number; missPct: number } {
  const read = after.read - before.read;
  const hit = after.hit - before.hit;
  if (read < 0 || hit < 0) return { read: -1, hit: -1, missPct: -1 };
  const total = read + hit;
  return { read, hit, missPct: total ? Math.round((read / total) * 1000) / 10 : 0 };
}

/** Replica's percent of the two nodes' total; -1 if either side is unknown or both are 0. */
export function replicaShare(primary: number, replica: number): number {
  if (primary < 0 || replica < 0 || primary + replica === 0) return -1;
  return Math.round((replica / (primary + replica)) * 1000) / 10;
}

/** The `rr9-<label>` tag RR09d puts in a `tag=eq.` filter, read back from a logged query string. */
export function tagOf(search: string): string {
  const m = /tag=eq\.rr9-([a-z]+)/.exec(search ?? "");
  return m ? m[1]! : "none";
}

export interface RemovalTick {
  /** Seconds since the remove call. */
  t: number;
  /** `primary`, `replica`, or the error text. */
  label: string;
}

const served = (l: string) => l === "primary" || l === "replica";

/** What the load balancer did after `read-replicas/remove`: when it started failing, when (if) it served again, and what. */
export function removalSummary(ticks: RemovalTick[]): {
  firstErrorS: number | "none";
  lastErrorS: number | "none";
  recoveredS: number | "never" | "n/a";
  errors: number;
  ok: number;
  errorLabels: string;
  afterRecovery: string;
  endLabel: string;
} {
  const errs = ticks.filter((k) => !served(k.label));
  const firstErr = errs[0];
  const lastErr = errs[errs.length - 1];
  let recovered: number | "never" | "n/a" = "n/a";
  let after: RemovalTick[] = [];
  if (lastErr) {
    const i = ticks.indexOf(lastErr);
    after = ticks.slice(i + 1).filter((k) => served(k.label));
    recovered = after.length ? after[0]!.t : "never";
  }
  return {
    firstErrorS: firstErr ? firstErr.t : "none",
    lastErrorS: lastErr ? lastErr.t : "none",
    recoveredS: recovered,
    errors: errs.length,
    ok: ticks.length - errs.length,
    errorLabels: errs.length ? tallyBy(errs.map((k) => k.label)) : "none",
    afterRecovery: after.length ? tallyBy(after.map((k) => k.label)) : "none",
    endLabel: ticks.length ? ticks[ticks.length - 1]!.label : "none",
  };
}
