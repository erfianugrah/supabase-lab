/**
 * Pure reduction of one drivers/probe.mjs run to the numbers PC03 reports.
 * Split out so the arithmetic (which attempts count as "in the window", what
 * "after clear" means) is unit tested without a network.
 *
 * Times are epoch ms. An attempt belongs to the window by its START time:
 * a query that began before the fault and failed inside it is counted as a
 * pre-fault start, which is the honest reading for a pool handing out an
 * already-dead connection.
 */
export interface QEvent {
  e: "q";
  w: number;
  t: number;
  ok: boolean;
  ms: number;
  code?: string;
  msg?: string;
  retry_ok?: boolean;
  retry_ms?: number;
  retry_code?: string;
}

export interface RunSummary {
  attempts: number;
  attempts_in_window: number;
  failed_total: number;
  failed_in_window: number;
  /** first attempts that STARTED after the fault was cleared and still failed */
  failed_after_clear: number;
  /** ms from fault clear to the start of the last failing attempt; null when none failed after clear */
  last_fail_after_clear_ms: number | null;
  /** ms from fault clear to the first attempt started after it that succeeded */
  first_ok_after_clear_ms: number | null;
  /** ms from fault start to the first failing attempt; null when nothing failed */
  first_fail_after_fault_ms: number | null;
  /** failures whose immediate single retry succeeded / all failures */
  retry_rescued: number;
  retry_failed: number;
  /** attempts that never answered inside the probe's own query timeout */
  app_timeouts: number;
  max_ms: number;
  errors: Record<string, number>;
}

export function summarise(events: QEvent[], faultOn: number, faultOff: number): RunSummary {
  const qs = events.filter((x) => x.e === "q");
  const failed = qs.filter((q) => !q.ok);
  const inWin = (q: QEvent) => q.t >= faultOn && q.t <= faultOff;
  const after = qs.filter((q) => q.t > faultOff);
  const failAfter = after.filter((q) => !q.ok);
  const firstOkAfter = after.filter((q) => q.ok).sort((a, b) => a.t - b.t)[0];
  const lastFailAfter = failAfter.sort((a, b) => b.t - a.t)[0];
  const firstFail = failed.filter((q) => q.t >= faultOn).sort((a, b) => a.t - b.t)[0];
  const errors: Record<string, number> = {};
  for (const q of failed) {
    const k = `${q.code ?? "Error"}: ${(q.msg ?? "").slice(0, 80)}`;
    errors[k] = (errors[k] ?? 0) + 1;
  }
  return {
    attempts: qs.length,
    attempts_in_window: qs.filter(inWin).length,
    failed_total: failed.length,
    failed_in_window: failed.filter(inWin).length,
    failed_after_clear: failAfter.length,
    last_fail_after_clear_ms: lastFailAfter ? lastFailAfter.t - faultOff : null,
    first_ok_after_clear_ms: firstOkAfter ? firstOkAfter.t - faultOff : null,
    first_fail_after_fault_ms: firstFail ? firstFail.t - faultOn : null,
    retry_rescued: failed.filter((q) => q.retry_ok === true).length,
    retry_failed: failed.filter((q) => q.retry_ok === false).length,
    app_timeouts: failed.filter((q) => q.code === "APP_TIMEOUT").length,
    max_ms: qs.reduce((m, q) => Math.max(m, q.ms), 0),
    errors,
  };
}

export function parseLines(stdout: string): { events: QEvent[]; other: Record<string, unknown>[] } {
  const events: QEvent[] = [];
  const other: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as { e?: string };
      if (o.e === "q") events.push(o as QEvent);
      else other.push(o as Record<string, unknown>);
    } catch {
      // partial line from a killed process
    }
  }
  return { events, other };
}
