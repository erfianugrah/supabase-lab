/**
 * Outage accounting for a probe sampled continuously across several phases
 * (D09: one phase per resize).
 *
 * The first D09 (2026-08-19, re-run 2026-10-13) gave each phase its own
 * accumulator that closed an outage only when a later success arrived in the
 * same phase. A run of failures still open when the phase ended was dropped,
 * and the next phase's fresh accumulator opened a new outage on its first
 * failing sample. So an outage that a resize started and that outlived the
 * status poll read as 0 s on the resize and as a shorter outage on the next
 * phase (2026-10-13: 17 of 46 samples OK with a max outage of 0 on Micro to
 * Small, then 15.063 s on a Small to Large phase whose PATCH was refused).
 *
 * Here one timeline holds every sample of a path and the phase boundaries.
 * An outage is one contiguous run of failed samples, from the first failing
 * sample to the first success after it. It belongs to the phase it STARTED
 * in, at its full length, even when it runs on into later phases; a later
 * phase reports the time it spent inside an earlier phase's outage as
 * `carriedInS`, not as its own outage. An outage still open when the stream
 * ends is closed at the end time and flagged open: its length is a lower
 * bound.
 */

export interface Sample {
  /** ms on any monotonic clock shared with the phase starts. */
  at: number;
  ok: boolean;
}

export interface PhaseMark {
  name: string;
  /** Samples with `at >= startMs` (and before the next phase) belong here. */
  startMs: number;
}

export interface Outage {
  startMs: number;
  endMs: number;
  /** Index into the phase list of the phase the outage started in. */
  phase: number;
  /** Never closed by a success before the stream ended. */
  open: boolean;
  failures: number;
}

export interface PhaseOutageStats {
  name: string;
  samples: number;
  ok: number;
  failures: number;
  /** Longest outage that started in this phase, full length in seconds. */
  maxOutageS: number;
  /** That longest outage was still open at the end of the stream (a lower bound). */
  maxOutageOpen: boolean;
  /** Sum of all outages that started in this phase, seconds. */
  totalOutageS: number;
  outages: number;
  /** An outage (from this phase or carried in) was running when the phase ended. */
  openAtPhaseEnd: boolean;
  /** Seconds this phase spent inside an outage that started in an earlier phase. */
  carriedInS: number;
  /** First failing sample of an outage that started here, seconds after the phase start. */
  firstFailS: number | null;
  /** End of the last outage that started here, seconds after the phase start (may lie past the phase end). */
  lastRecoveryS: number | null;
}

const r3 = (ms: number) => Math.round(ms) / 1000;

function phaseOf(at: number, phases: PhaseMark[]): number {
  let idx = -1;
  for (let i = 0; i < phases.length; i += 1) if (at >= (phases[i] as PhaseMark).startMs) idx = i;
  return idx;
}

/** Pure: samples + phase starts + stream end -> outages, in time order. */
export function outagesOf(samples: Sample[], phases: PhaseMark[], endMs: number): Outage[] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const out: Outage[] = [];
  let cur: Outage | null = null;
  for (const s of sorted) {
    if (!s.ok) {
      if (!cur) cur = { startMs: s.at, endMs: s.at, phase: phaseOf(s.at, phases), open: true, failures: 0 };
      cur.failures += 1;
    } else if (cur) {
      cur.endMs = s.at;
      cur.open = false;
      out.push(cur);
      cur = null;
    }
  }
  if (cur) {
    cur.endMs = Math.max(endMs, cur.startMs);
    out.push(cur);
  }
  return out;
}

/** Pure: per-phase statistics with outages attributed to the phase they started in. */
export function attribute(samples: Sample[], phases: PhaseMark[], endMs: number): PhaseOutageStats[] {
  const outages = outagesOf(samples, phases, endMs);
  return phases.map((p, i) => {
    const phaseEnd = i + 1 < phases.length ? (phases[i + 1] as PhaseMark).startMs : endMs;
    const mine = samples.filter((s) => phaseOf(s.at, phases) === i);
    const own = outages.filter((o) => o.phase === i);
    let longest: Outage | null = null;
    for (const o of own) if (!longest || o.endMs - o.startMs > longest.endMs - longest.startMs) longest = o;
    let carried = 0;
    for (const o of outages) {
      if (o.phase >= i || o.phase < 0) continue;
      const from = Math.max(o.startMs, p.startMs);
      const to = Math.min(o.endMs, phaseEnd);
      if (to > from) carried += to - from;
    }
    const runningAtEnd = outages.some((o) => o.startMs < phaseEnd && (o.endMs > phaseEnd || (o.open && o.endMs >= phaseEnd)));
    const first = own[0];
    const last = own[own.length - 1];
    return {
      name: p.name,
      samples: mine.length,
      ok: mine.filter((s) => s.ok).length,
      failures: mine.filter((s) => !s.ok).length,
      maxOutageS: longest ? r3(longest.endMs - longest.startMs) : 0,
      maxOutageOpen: longest?.open ?? false,
      totalOutageS: r3(own.reduce((a, o) => a + (o.endMs - o.startMs), 0)),
      outages: own.length,
      openAtPhaseEnd: runningAtEnd,
      carriedInS: r3(carried),
      firstFailS: first ? r3(first.startMs - p.startMs) : null,
      lastRecoveryS: last ? r3(last.endMs - p.startMs) : null,
    };
  });
}

/** Collects samples and phase starts as they happen; `stats()` attributes them. */
export class OutageTimeline {
  private samples: Sample[] = [];
  private phases: PhaseMark[] = [];

  beginPhase(name: string, atMs: number): void {
    this.phases.push({ name, startMs: atMs });
  }

  add(ok: boolean, atMs: number): void {
    this.samples.push({ at: atMs, ok });
  }

  /** ms of the latest failing sample, or null if none yet. */
  lastFailMs(): number | null {
    let last: number | null = null;
    for (const s of this.samples) if (!s.ok && (last === null || s.at > last)) last = s.at;
    return last;
  }

  stats(endMs: number): PhaseOutageStats[] {
    return attribute(this.samples, this.phases, endMs);
  }
}

/**
 * Offline re-read of a phase from the old per-phase aggregates (OK samples,
 * total samples, longest outage closed inside the phase), which is all the
 * 2026-08-19 and 2026-10-13 runs kept. Every closed outage ends on a success,
 * so there are at most `ok` of them, and one of length d seconds holds at most
 * floor(d / interval) failures, because sample starts are at least one
 * interval apart. Failures beyond that were still open when the phase ended.
 * Returns the proven minimum of those open failures and the minimum length of
 * the open run they form. Zero means no open run is PROVEN, not that none
 * existed.
 */
export function openTailLowerBound(
  agg: { ok: number; tot: number; maxClosedOutageS: number },
  intervalMs: number,
): { tailFailures: number; tailMinS: number } {
  const perClosed = Math.floor((agg.maxClosedOutageS * 1000 + 1e-6) / intervalMs);
  const closedMax = agg.maxClosedOutageS > 0 ? agg.ok * perClosed : 0;
  const tailFailures = Math.max(0, agg.tot - agg.ok - closedMax);
  return { tailFailures, tailMinS: tailFailures > 0 ? ((tailFailures - 1) * intervalMs) / 1000 : 0 };
}
