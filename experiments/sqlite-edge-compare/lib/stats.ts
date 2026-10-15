/**
 * Pure helpers for the fairness rules in the plan: percentiles, a summary
 * with the warm-up dropped and counted, the "spread does not overlap" test,
 * a round-robin scheduler that rotates backend order per iteration, an
 * interleave helper, and a seeded RNG for synthetic data.
 */

/**
 * Percentile by linear interpolation between closest ranks (the "type 7"
 * definition numpy and most spreadsheets default to). `p` in [0, 100].
 * NaN for an empty sample.
 */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * (Math.min(100, Math.max(0, p)) / 100);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo]! + (s[hi]! - s[lo]!) * (h - lo);
}

export interface Summary {
  /** Samples after the warm-up was dropped. */
  n: number;
  /** Warm-up samples dropped from the front. */
  dropped: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);

/** Summarise a sample in arrival order, dropping the first `warmup` values. Values rounded to 0.01 ms. */
export function summarize(xs: readonly number[], warmup = 0): Summary {
  const kept = xs.slice(Math.min(warmup, xs.length));
  const mean = kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : Number.NaN;
  return {
    n: kept.length,
    dropped: xs.length - kept.length,
    min: r2(kept.length ? Math.min(...kept) : Number.NaN),
    p25: r2(percentile(kept, 25)),
    p50: r2(percentile(kept, 50)),
    p75: r2(percentile(kept, 75)),
    p95: r2(percentile(kept, 95)),
    p99: r2(percentile(kept, 99)),
    max: r2(kept.length ? Math.max(...kept) : Number.NaN),
    mean: r2(mean),
  };
}

/**
 * The plan's rule for calling one backend faster: the p25-p75 ranges do not
 * overlap. Returns "a" or "b" for the faster side when separated, else null.
 */
export function separated(a: Pick<Summary, "p25" | "p75">, b: Pick<Summary, "p25" | "p75">): "a" | "b" | null {
  if (a.p75 < b.p25) return "a";
  if (b.p75 < a.p25) return "b";
  return null;
}

/** Flatten a Summary into measurement columns: `${prefix}_p50` etc. */
export function summaryColumns(prefix: string, s: Summary): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(s)) out[`${prefix}_${k}`] = v;
  return out;
}

export interface Slot<T> {
  /** Iteration number, 0-based, counting warm-up iterations. */
  iter: number;
  /** Position within the iteration. */
  pos: number;
  item: T;
  warmup: boolean;
}

/**
 * Round-robin schedule: `iterations` rounds over `items`, the starting item
 * rotating by one each round so no backend always goes first (or always
 * follows the same neighbour). The first `warmup` rounds are flagged.
 */
export function roundRobin<T>(items: readonly T[], iterations: number, warmup = 0): Slot<T>[] {
  const out: Slot<T>[] = [];
  const k = items.length;
  for (let iter = 0; iter < iterations; iter++) {
    for (let pos = 0; pos < k; pos++) {
      out.push({ iter, pos, item: items[(iter + pos) % k]!, warmup: iter < warmup });
    }
  }
  return out;
}

/** Interleave lists element by element: [[a1,a2],[b1]] -> [a1,b1,a2]. */
export function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

/** mulberry32: small, fast, deterministic. Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
