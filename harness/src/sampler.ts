/**
 * Continuous multi-path sampler.
 *
 * Runs an operation while sampling several connection paths independently, and
 * reports one window per path. Separating "what operation" from "what paths"
 * from "how we time it" is what lets one module per platform operation stay a
 * few dozen lines - see privatelink-aws/tests/t26-restart-paths.ts for a
 * module built on this. It replaced an earlier hand-rolled, interleaved,
 * first-success loop (t14-restart.ts, since deleted) that this generalises.
 *
 * Everything returned is scalar: `measurements` in the report contract is
 * Record<string, number | string>, so a series has nowhere to go.
 */
import { PAUSE_SLACK_MS, systemClock, type Clock } from "./host-pause";

export interface ProbeOutcome {
  ok: boolean;
  /** Short failure text. Kept verbatim: the MODE matters as much as the duration. */
  error?: string;
}

export interface Probe {
  name: string;
  run(): Promise<ProbeOutcome>;
}

export interface PathWindow {
  name: string;
  /** Did the FIRST sample succeed? False means the path was already down. */
  healthyAtStart: boolean;
  samples: number;
  failures: number;
  /** ms after sampling started. */
  firstFailMs: number | null;
  /** ms after sampling started, at the first sample of the sustained recovery. */
  recoveredMs: number | null;
  /** recoveredMs - firstFailMs, or null if it never failed or never recovered. */
  windowMs: number | null;
  /** Distinct failure texts, in first-seen order. */
  modes: string[];
  /**
   * Host pause (machine asleep, or the event loop blocked) inside
   * [0, recoveredMs or end of sampling], in ms: a span in which no sample ran.
   * Non-zero means the window, or a "never failed", has a blind spot that long.
   */
  pausedMs: number;
}

export interface SampleOptions {
  /** Delay between samples on one path. Chosen per module, not measured. */
  intervalMs: number;
  /** Hard stop for the whole run. */
  maxWaitMs: number;
  /** Sustained success required before recovery is believed. */
  settleMs: number;
  /**
   * Hard cap on one probe.run(), default 30 s. A probe's own timeouts are not
   * enough: on 2026-10-23 a fetch with AbortSignal.timeout(5000) took 262 s
   * to return during a resize. A sample past the cap counts as failed with a
   * fixed mode; the abandoned promise is left to settle on its own. That
   * 262 s was the Mac asleep (see host-pause.ts), which no deadline
   * fixes; the cap is for a probe that really hangs, e.g. a pg query with no
   * timeout, which before it pinned its path's loop for good.
   */
  sampleDeadlineMs?: number;
  log?: (msg: string) => void;
  /** Injected in tests; defaults to Date.now() / performance.now(). */
  clock?: Clock;
}

const DEFAULT_SAMPLE_DEADLINE_MS = 30_000;

export function withDeadline(p: Promise<ProbeOutcome>, ms: number = DEFAULT_SAMPLE_DEADLINE_MS): Promise<ProbeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProbeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `probe did not answer within ${ms} ms` }), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

interface PathState {
  probe: Probe;
  healthyAtStart: boolean | null;
  samples: number;
  failures: number;
  firstFailMs: number | null;
  /** Candidate recovery: first OK sample after a failure, pending settle. */
  pendingRecoveryMs: number | null;
  recoveredMs: number | null;
  modes: string[];
  /** Last sample failed: the next OK one is a recovery, logged even after the first. */
  down: boolean;
}

interface Pause {
  fromMs: number;
  toMs: number;
}

function overlap(p: Pause, from: number, to: number): number {
  return Math.max(0, Math.min(p.toMs, to) - Math.max(p.fromMs, from));
}

function finalise(state: PathState, pauses: Pause[], endMs: number): PathWindow {
  const windowMs =
    state.firstFailMs !== null && state.recoveredMs !== null
      ? state.recoveredMs - state.firstFailMs
      : null;
  return {
    name: state.probe.name,
    healthyAtStart: state.healthyAtStart ?? false,
    samples: state.samples,
    failures: state.failures,
    firstFailMs: state.firstFailMs,
    recoveredMs: state.recoveredMs,
    windowMs,
    modes: state.modes,
    pausedMs: pauses.reduce((n, p) => n + overlap(p, 0, state.recoveredMs ?? endMs), 0),
  };
}

/** True once every path that failed has recovered and settled. */
function allSettled(states: PathState[]): boolean {
  return states.every((s) => s.firstFailMs === null || s.recoveredMs !== null);
}

export async function sampleDuring(
  probes: Probe[],
  opts: SampleOptions,
  operation: () => Promise<void>,
): Promise<PathWindow[]> {
  const clock = opts.clock ?? systemClock;
  const t0 = clock.wall();
  const pauses: Pause[] = [];
  const states: PathState[] = probes.map((probe) => ({
    probe,
    healthyAtStart: null,
    samples: 0,
    failures: 0,
    firstFailMs: null,
    pendingRecoveryMs: null,
    recoveredMs: null,
    modes: [],
    down: false,
  }));

  let stop = false;

  async function loop(state: PathState): Promise<void> {
    while (!stop && clock.wall() - t0 < opts.maxWaitMs) {
      const at = clock.wall() - t0;
      let outcome: ProbeOutcome;
      try {
        outcome = await withDeadline(state.probe.run(), opts.sampleDeadlineMs ?? DEFAULT_SAMPLE_DEADLINE_MS);
      } catch (e) {
        outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      state.samples += 1;
      if (state.healthyAtStart === null) state.healthyAtStart = outcome.ok;

      if (!outcome.ok) {
        state.failures += 1;
        state.down = true;
        state.pendingRecoveryMs = null;
        if (state.firstFailMs === null) state.firstFailMs = at;
        const mode = (outcome.error ?? "unknown").slice(0, 80);
        if (!state.modes.includes(mode)) state.modes.push(mode);
        opts.log?.(`${state.probe.name} down at +${at}ms: ${mode}`);
      } else if (state.firstFailMs !== null && state.recoveredMs !== null) {
        // Later outages are counted in `failures` but do not move the window;
        // log their end anyway, or a path that went quiet reads as a hang.
        if (state.down) opts.log?.(`${state.probe.name} up again at +${at}ms`);
        state.down = false;
      } else if (state.firstFailMs !== null && state.recoveredMs === null) {
        state.down = false;
        if (state.pendingRecoveryMs === null) {
          state.pendingRecoveryMs = at;
        } else if (at - state.pendingRecoveryMs >= opts.settleMs) {
          state.recoveredMs = state.pendingRecoveryMs;
          opts.log?.(`${state.probe.name} recovered at +${state.recoveredMs}ms`);
        }
      }

      await Bun.sleep(opts.intervalMs);
    }
  }

  const loops = states.map((s) => loop(s));
  const watchdog = (async () => {
    let lastWall = clock.wall();
    let lastMono = clock.mono();
    while (!stop && clock.wall() - t0 < opts.maxWaitMs) {
      // Stop early ONLY once something actually went down and came back.
      // A no-op operation must run to maxWaitMs: a null result has to be
      // earned by waiting, not assumed by an early exit.
      if (states.some((s) => s.firstFailMs !== null) && allSettled(states)) break;
      await Bun.sleep(opts.intervalMs);
      // This loop does nothing but sleep, so a late wake-up is the host's
      // doing: wall advanced and monotonic did not = the machine slept;
      // both advanced = the event loop was blocked. Either way no probe ran.
      const wall = clock.wall();
      const mono = clock.mono();
      const late = wall - lastWall - opts.intervalMs;
      if (late > PAUSE_SLACK_MS) {
        pauses.push({ fromMs: lastWall - t0, toMs: wall - t0 });
        const monoS = ((mono - lastMono) / 1000).toFixed(1);
        const why = wall - lastWall - (mono - lastMono) > PAUSE_SLACK_MS ? "the host was suspended" : "the event loop was blocked";
        opts.log?.(
          `host paused ${Math.round((wall - lastWall) / 1000)} s at +${lastWall - t0}ms (monotonic clock advanced ${monoS} s: ${why}); no sample ran in it`,
        );
      }
      lastWall = wall;
      lastMono = mono;
    }
  })();

  try {
    await operation();
  } catch (e) {
    stop = true;
    await Promise.all([...loops, watchdog]);
    throw e;
  }

  await watchdog;
  stop = true;
  await Promise.all(loops);

  const endMs = clock.wall() - t0;
  return states.map((s) => finalise(s, pauses, endMs));
}
