/**
 * The client policy under test (CR02), written the way an application would.
 *
 *  - `hedgedGet`: one GET with an overall deadline (`AbortSignal.timeout`) and
 *    at most ONE extra attempt, started either when the first fails with a
 *    retryable outcome or when it has been outstanding for `hedgeAfterMs`
 *    (a "hedge"). The first success wins and the other request is aborted.
 *    The built-in retries are switched off on each attempt so the policy owns
 *    the attempt budget; `keepBuiltin` leaves them on to measure the stacking.
 *  - `refreshThenRetry`: on a 401, call `auth.refreshSession()` once and
 *    repeat the request once; if the refresh fails or the retry is 401 again,
 *    return the error.
 *
 * Neither function touches a write path: a hedged or retried POST is a
 * duplicate write unless the caller made it idempotent (CR02g measures that).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Resp<T = unknown> {
  data: T | null;
  error: { code?: string; message?: string; name?: string } | null;
  status: number;
}

/** A request builder the caller supplies; it must return a thenable supabase-js query. */
export type Build<T> = (signal: AbortSignal) => PromiseLike<Resp<T>>;

/** Retry on a network error / abort (status 0) or any 5xx, including the 525 the built-in policy skips. */
export function retryable(r: Resp): boolean {
  return r.status === 0 || r.status >= 500;
}

export interface HedgeOpts {
  /** Deadline for the whole call, all attempts included. */
  timeoutMs: number;
  /** Start the second attempt if the first has not answered by then. */
  hedgeAfterMs: number;
}

export interface HedgeResult<T> extends Resp<T> {
  /** 1 or 2 */
  started: number;
  /** which attempt produced the returned response (1-based) */
  winner: number;
}

export async function hedgedGet<T>(build: Build<T>, o: HedgeOpts): Promise<HedgeResult<T>> {
  const deadline = AbortSignal.timeout(o.timeoutMs);
  const controllers: AbortController[] = [];
  const start = (): Promise<{ n: number; r: Resp<T> }> => {
    const ac = new AbortController();
    controllers.push(ac);
    const n = controllers.length;
    const onAbort = () => ac.abort();
    deadline.addEventListener("abort", onAbort, { once: true });
    return Promise.resolve(build(ac.signal)).then(
      (r) => ({ n, r }),
      (e: unknown) => ({ n, r: { data: null, error: { name: (e as Error)?.name ?? "error", message: String(e) }, status: 0 } as Resp<T> }),
    );
  };

  return new Promise<HedgeResult<T>>((resolve) => {
    let started = 0;
    let settled = 0;
    let done = false;
    let last: { n: number; r: Resp<T> } | undefined;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (w: { n: number; r: Resp<T> }) => {
      if (done) return;
      done = true;
      clearTimeout(hedgeTimer);
      for (const [i, c] of controllers.entries()) if (i + 1 !== w.n) c.abort();
      resolve({ ...w.r, started, winner: w.n });
    };
    const launch = () => {
      if (done || started >= 2) return;
      started++;
      void start().then((w) => {
        settled++;
        last = w;
        if (!retryable(w.r)) return finish(w);
        // Retryable failure: the second attempt is the retry, if not already running.
        if (started < 2 && !deadline.aborted) return launch();
        if (settled === started) finish(w);
      });
    };
    hedgeTimer = setTimeout(launch, o.hedgeAfterMs);
    deadline.addEventListener("abort", () => setTimeout(() => last && finish(last), 50), { once: true });
    launch();
  });
}

export interface RefreshResult<T> extends Resp<T> {
  refreshed: boolean;
  refreshError: string;
  requests: number;
}

/** Run `call`; on 401, refresh the session once and run it once more. */
export async function refreshThenRetry<T>(client: SupabaseClient, call: () => PromiseLike<Resp<T>>): Promise<RefreshResult<T>> {
  const first = await call();
  if (first.status !== 401) return { ...first, refreshed: false, refreshError: "", requests: 1 };
  const { error } = await client.auth.refreshSession();
  if (error) return { ...first, refreshed: false, refreshError: error.code ?? error.name ?? "refresh_failed", requests: 1 };
  const second = await call();
  return { ...second, refreshed: true, refreshError: "", requests: 2 };
}
