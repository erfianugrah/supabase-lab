/**
 * A module whose promise never settles must fail loudly, not end the run.
 *
 * On 2026-10-23 `Bun.write(path, response)` hung on a download and pvlab
 * exited 0 with no result and no artifact. Mechanism (Bun 1.3.14 on macOS,
 * reproduced 2026-10-26 with `await new Promise(() => {})`, not with the
 * download; that the 2026-10-23 hang was this drain is inference from its
 * exit 0 and missing artifact): when the awaited promise has nothing behind
 * it - no timer, socket or child process left - the event loop drains,
 * "beforeExit" fires once, and the process exits with code 0 while `main()`
 * is still suspended at the `await`. Nothing after it runs, so neither the
 * remaining modules nor the artifact write happen.
 *
 * Two guards, both in the runner:
 *   - drain: a "beforeExit" listener wakes the runner's race while a module
 *     is pending, the module is recorded as failed and the run carries on.
 *     The wake has to go through a timer: in Bun 1.3.14 resolving a promise
 *     inside "beforeExit" does not keep the process alive (the continuation
 *     never ran; a `setTimeout(wake, 0)` does).
 *   - timeout: a module can declare `timeoutMs` for a hang that still holds a
 *     handle (a socket that never delivers). There is no default: modules that
 *     legitimately run for hours keep working. The timer is unref'd, so it
 *     never keeps a drained process alive by itself.
 */

export type Outcome<T> =
  | { kind: "settled"; value: T }
  | { kind: "threw"; error: unknown }
  | { kind: "drained" }
  | { kind: "timeout"; ms: number };

export interface DrainWatch {
  /** Resolves the next time the event loop drains while armed. */
  arm(): Promise<void>;
  disarm(): void;
  armed(): boolean;
}

/**
 * `on` registers the drain callback; the default is process "beforeExit".
 * `idle` runs on a drain with no module armed (the harness hung elsewhere, or
 * the run is simply over).
 */
export function createDrainWatch(
  on: (cb: () => void) => void = (cb) => {
    process.on("beforeExit", cb);
  },
  idle?: () => void,
): DrainWatch {
  let wake: (() => void) | undefined;
  on(() => {
    const w = wake;
    wake = undefined;
    if (w) setTimeout(w, 0);
    else idle?.();
  });
  return {
    arm: () =>
      new Promise<void>((res) => {
        wake = res;
      }),
    disarm: () => {
      wake = undefined;
    },
    armed: () => wake !== undefined,
  };
}

/** Run one module's work and report how it ended. Never rejects. */
export async function settleModule<T>(
  work: () => T | Promise<T>,
  watch: DrainWatch,
  timeoutMs?: number,
): Promise<Outcome<T>> {
  let p: Promise<T>;
  try {
    p = Promise.resolve(work());
  } catch (error) {
    return { kind: "threw", error };
  }
  const races: Promise<Outcome<T>>[] = [
    p.then(
      (value): Outcome<T> => ({ kind: "settled", value }),
      (error): Outcome<T> => ({ kind: "threw", error }),
    ),
    watch.arm().then((): Outcome<T> => ({ kind: "drained" })),
  ];
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    races.push(
      new Promise<Outcome<T>>((res) => {
        timer = setTimeout(() => res({ kind: "timeout", ms: timeoutMs }), timeoutMs);
        timer.unref?.();
      }),
    );
  }
  try {
    return await Promise.race(races);
  } finally {
    if (timer) clearTimeout(timer);
    watch.disarm();
  }
}

/** The detail line for a module that did not settle. */
export function unsettledDetail(o: { kind: "drained" } | { kind: "timeout"; ms: number }): string {
  return o.kind === "drained"
    ? "module promise never settled: the event loop drained with nothing pending, so nothing could resolve it"
    : `module did not settle within its timeoutMs (${o.ms} ms) and was abandoned`;
}
