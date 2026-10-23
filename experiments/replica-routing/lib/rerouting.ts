/**
 * Pure helpers for RR02 (re-routing on a lagging or unhealthy replica).
 *
 * Every read in RR02 is `GET /rest/v1/rpc/rr_node`, a stable function that
 * reads the newest heartbeat row of `rr_marker` and returns which node ran it
 * (`pg_is_in_recovery()`), that node's postmaster start time, and how old the
 * newest heartbeat row it can see is (`stale_ms`, the node's clock minus the
 * primary's `written_at`, so clock skew between the hosts is inside it). A
 * heartbeat writer inserts a row every 250 ms while a phase runs, so a fresh
 * node reads a few hundred ms and a node whose replay has stopped reads the
 * length of the stop.
 *
 * A tick is one such read from one source (`lb`, `replica`, `primary`); the
 * functions below turn a list of ticks into the scalar figures the report
 * contract can carry.
 */

export type NodeKind = "primary" | "replica";

export interface Tick {
  /** ms since the phase started. */
  t: number;
  src: string;
  status: number;
  node?: NodeKind;
  pm?: number;
  staleMs?: number;
  err?: string;
}

export interface NodeBody {
  node?: NodeKind;
  pm?: number;
  staleMs?: number;
  err?: string;
}

/** HTTP status + body of `rpc/rr_node` -> which node and how stale. */
export function parseNode(status: number, body: string): NodeBody {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return { err: `HTTP ${status} ${body.replace(/\s+/g, " ").trim().slice(0, 60)}`.trim() };
  }
  const o = (j ?? {}) as Record<string, unknown>;
  if (status === 200 && typeof o.in_recovery === "boolean") {
    return {
      node: o.in_recovery ? "replica" : "primary",
      pm: typeof o.pm === "number" ? o.pm : undefined,
      staleMs: typeof o.stale_ms === "number" ? o.stale_ms : undefined,
    };
  }
  const code = String(o.code ?? o.message ?? o.error ?? o.msg ?? "").replace(/\s+/g, " ").slice(0, 60);
  return { err: code ? `HTTP ${status} ${code}` : `HTTP ${status}` };
}

/** What a tick says served it: `primary`, `replica`, or the error text. */
export const label = (k: Tick): string => k.node ?? k.err ?? `HTTP ${k.status}`;

/**
 * The span during which `src` (a direct read of the replica) saw data older
 * than `thresholdMs`: from the first such tick to the last one. Null when the
 * source never lagged past the threshold.
 */
export function lagWindow(ticks: Tick[], src: string, thresholdMs: number): { startT: number; endT: number; maxStaleMs: number } | null {
  const lagging = ticks.filter((k) => k.src === src && k.node === "replica" && (k.staleMs ?? 0) > thresholdMs);
  if (!lagging.length) return null;
  return {
    startT: lagging[0]!.t,
    endT: lagging[lagging.length - 1]!.t,
    maxStaleMs: Math.max(...lagging.map((k) => k.staleMs ?? 0)),
  };
}

export interface Served {
  n: number;
  replica: number;
  primary: number;
  errors: number;
  /** Largest stale_ms among ticks the replica served. NaN when none. */
  maxStaleReplicaMs: number;
  /** Ticks served by the replica with stale_ms above the threshold given. */
  replicaStale: number;
  firstPrimaryT: number | null;
  lastReplicaT: number | null;
  firstErrorT: number | null;
  lastErrorT: number | null;
}

/** What `src` saw between `from` and `to` (inclusive, ms since phase start). */
export function servedDuring(ticks: Tick[], src: string, from: number, to: number, staleThresholdMs = Infinity): Served {
  const ks = ticks.filter((k) => k.src === src && k.t >= from && k.t <= to);
  const rep = ks.filter((k) => k.node === "replica");
  const pri = ks.filter((k) => k.node === "primary");
  const errs = ks.filter((k) => !k.node);
  return {
    n: ks.length,
    replica: rep.length,
    primary: pri.length,
    errors: errs.length,
    maxStaleReplicaMs: rep.length ? Math.max(...rep.map((k) => k.staleMs ?? 0)) : NaN,
    replicaStale: rep.filter((k) => (k.staleMs ?? 0) > staleThresholdMs).length,
    firstPrimaryT: pri[0]?.t ?? null,
    lastReplicaT: rep.length ? rep[rep.length - 1]!.t : null,
    firstErrorT: errs[0]?.t ?? null,
    lastErrorT: errs.length ? errs[errs.length - 1]!.t : null,
  };
}

/** Every change of what served `src`, in order. The first tick is a transition from `start`. */
export function transitions(ticks: Tick[], src: string): { t: number; from: string; to: string }[] {
  const out: { t: number; from: string; to: string }[] = [];
  let prev = "start";
  for (const k of ticks.filter((x) => x.src === src)) {
    const l = label(k);
    if (l !== prev) out.push({ t: k.t, from: prev, to: l });
    prev = l;
  }
  return out;
}

/**
 * One line per `sizeMs` bucket per source: `+10s lb R8 P0 E0 max 412ms`.
 * R/P/E count replica-served, primary-served and failed ticks; `max` is the
 * largest stale_ms in the bucket. Evidence text, not a measurement column.
 */
export function buckets(ticks: Tick[], srcs: string[], sizeMs: number): string[] {
  if (!ticks.length) return [];
  const last = Math.max(...ticks.map((k) => k.t));
  const lines: string[] = [];
  for (let b = 0; b <= last; b += sizeMs) {
    const parts: string[] = [];
    for (const s of srcs) {
      const ks = ticks.filter((k) => k.src === s && k.t >= b && k.t < b + sizeMs);
      if (!ks.length) continue;
      const r = ks.filter((k) => k.node === "replica").length;
      const p = ks.filter((k) => k.node === "primary").length;
      const e = ks.length - r - p;
      const st = ks.filter((k) => k.staleMs !== undefined).map((k) => k.staleMs!);
      parts.push(`${s} R${r} P${p} E${e}${st.length ? ` max ${Math.max(...st)}ms` : ""}`);
    }
    if (parts.length) lines.push(`+${Math.round(b / 1000)}s ${parts.join(" | ")}`);
  }
  return lines;
}

/** Distinct error texts for `src`, first-seen order. */
export function errorModes(ticks: Tick[], src: string): string[] {
  const out: string[] = [];
  for (const k of ticks) if (k.src === src && !k.node && !out.includes(label(k))) out.push(label(k));
  return out;
}
