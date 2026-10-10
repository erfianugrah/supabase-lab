/**
 * Pure analysis of a redeploy window: given timestamped canary responses (each
 * carrying the build it came from), derive the numbers that say how long old and
 * new builds were served side by side. Kept free of I/O so the arithmetic is
 * unit tested; the module only collects samples.
 */
export interface Sample {
  /** ms since the deploy API call returned (negative = before). */
  t: number;
  /** HTTP status; 0 for a transport error. */
  status: number;
  /** Build hash from the body, "" when the response carried none. */
  build: string;
  isolate: string;
  ms: number;
}

export interface Drift {
  samples: number;
  newBuildFirstMs: number;
  oldBuildLastMs: number;
  /** Time during which both builds were being served: last old minus first new, floored at 0. */
  mixedWindowMs: number;
  /** Old-build answers that arrived after the first new-build answer. */
  oldAfterFirstNew: number;
  nonOk: number;
  isolatesNew: number;
  isolatesOld: number;
}

export function analyseDrift(samples: Sample[], oldBuild: string, newBuild: string): Drift {
  const ordered = [...samples].sort((a, b) => a.t - b.t);
  const news = ordered.filter((s) => s.build === newBuild);
  const olds = ordered.filter((s) => s.build === oldBuild && s.t >= 0);
  const firstNew = news[0]?.t ?? -1;
  const lastOld = olds.at(-1)?.t ?? -1;
  const oldAfterFirstNew = firstNew < 0 ? 0 : olds.filter((s) => s.t > firstNew).length;
  return {
    samples: ordered.length,
    newBuildFirstMs: firstNew,
    oldBuildLastMs: lastOld,
    mixedWindowMs: firstNew < 0 || lastOld < 0 ? 0 : Math.max(0, lastOld - firstNew),
    oldAfterFirstNew,
    nonOk: ordered.filter((s) => s.status !== 200).length,
    isolatesNew: new Set(news.map((s) => s.isolate)).size,
    isolatesOld: new Set(ordered.filter((s) => s.build === oldBuild).map((s) => s.isolate)).size,
  };
}

/** Fixed-width buckets over (t, ms) pairs: p95 per bucket, for a "p95 jump" rule. */
export function bucketP95(points: { t: number; ms: number }[], widthMs: number, p95: (v: number[]) => number): { start: number; n: number; p95: number }[] {
  const by = new Map<number, number[]>();
  for (const pt of points) {
    const k = Math.floor(pt.t / widthMs) * widthMs;
    const arr = by.get(k) ?? [];
    arr.push(pt.ms);
    by.set(k, arr);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([start, v]) => ({ start, n: v.length, p95: p95(v) }));
}
