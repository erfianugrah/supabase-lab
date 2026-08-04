/**
 * Continuous multi-path sampler.
 *
 * Runs an operation while sampling several connection paths independently, and
 * reports one window per path. Separating "what operation" from "what paths"
 * from "how we time it" is what lets one module per platform operation stay a
 * few dozen lines - see t14-restart.ts for the interleaved version this
 * generalises.
 *
 * Everything returned is scalar: `measurements` in the report contract is
 * Record<string, number | string>, so a series has nowhere to go.
 */

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
}

export interface SampleOptions {
  /** Delay between samples on one path. Chosen per module, not measured. */
  intervalMs: number;
  /** Hard stop for the whole run. */
  maxWaitMs: number;
  /** Sustained success required before recovery is believed. */
  settleMs: number;
  log?: (msg: string) => void;
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
}

function finalise(state: PathState): PathWindow {
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
  const t0 = Date.now();
  const states: PathState[] = probes.map((probe) => ({
    probe,
    healthyAtStart: null,
    samples: 0,
    failures: 0,
    firstFailMs: null,
    pendingRecoveryMs: null,
    recoveredMs: null,
    modes: [],
  }));

  let stop = false;

  async function loop(state: PathState): Promise<void> {
    while (!stop && Date.now() - t0 < opts.maxWaitMs) {
      const at = Date.now() - t0;
      let outcome: ProbeOutcome;
      try {
        outcome = await state.probe.run();
      } catch (e) {
        outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      state.samples += 1;
      if (state.healthyAtStart === null) state.healthyAtStart = outcome.ok;

      if (!outcome.ok) {
        state.failures += 1;
        state.pendingRecoveryMs = null;
        if (state.firstFailMs === null) state.firstFailMs = at;
        const mode = (outcome.error ?? "unknown").slice(0, 80);
        if (!state.modes.includes(mode)) state.modes.push(mode);
        opts.log?.(`${state.probe.name} down at +${at}ms: ${mode}`);
      } else if (state.firstFailMs !== null && state.recoveredMs === null) {
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
    while (!stop && Date.now() - t0 < opts.maxWaitMs) {
      // Stop early ONLY once something actually went down and came back.
      // A no-op operation must run to maxWaitMs: a null result has to be
      // earned by waiting, not assumed by an early exit.
      if (states.some((s) => s.firstFailMs !== null) && allSettled(states)) break;
      await Bun.sleep(opts.intervalMs);
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

  return states.map(finalise);
}
