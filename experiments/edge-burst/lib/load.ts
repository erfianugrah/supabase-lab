/**
 * Open-loop load against one URL, and the pure functions that turn the
 * per-request records into a step's measurements.
 *
 * Open loop means requests leave on a fixed schedule (request i at i / rate
 * seconds) whether or not earlier ones answered, so a slow or refusing
 * platform cannot slow the generator down and hide its own refusals. Two
 * client-side ceilings are made visible instead of silently bending the
 * schedule:
 *
 *  - an in-flight cap (`maxInFlight`): a request due while the cap is full
 *    is counted as `skipped`, not queued. Bun's fetch queues requests above
 *    BUN_CONFIG_MAX_HTTP_REQUESTS (default 256, bun docs "Simultaneous
 *    connection limit"), and a queued request's send time would be a lie, so
 *    the Makefile raises Bun's limit above this cap.
 *  - send lag: the gap between a request's scheduled time and the moment
 *    fetch() was called. A step whose p99 lag or achieved send rate misses
 *    the plan is flagged `client_limited` (`clientLimited`).
 *
 * Bun 1.3.14's fetch spoke HTTP/1.1 to Cloudflare (cdn-cgi/trace,
 * 2026-11-04), so one in-flight request is one socket; this Mac has hit
 * `Network is unreachable (os error 51)` near 512 concurrent sockets
 * (data-api-capacity DC07, 512 concurrent requests).
 */

export interface Answer {
  status: number;
  contentType: string;
  text: string;
  /** `x-sb-edge-region` response header, "" when absent. */
  region: string;
  /** Cloudflare colo from the `cf-ray` suffix, "" when absent. */
  colo: string;
  /** Client-side error message when no HTTP answer arrived (status 0). */
  err?: string;
}

export type Fire = () => Promise<Answer>;

export interface Shot {
  /** Scheduled send time, ms after the step started (open loop), or -1 in a burst. */
  schedMs: number;
  /** Actual fetch() call time, ms after the step started. */
  sendMs: number;
  /** Request to fully read body, ms. */
  ms: number;
  status: number;
  cls: string;
  region: string;
  colo: string;
  /** Body (first 200 chars), kept for the first shot of each non-ok class only by the summariser. */
  body: string;
  /** rpc arm: the inner rpc status the function reported, "" for other arms. */
  rpc: string;
}

export interface LoadRun {
  shots: Shot[];
  scheduled: number;
  skipped: number;
  maxInFlightSeen: number;
  /** Wall and monotonic span of the run, ms (host-pause check). */
  wallMs: number;
  monoMs: number;
}

/**
 * Classify one answer. The codes are the platform's own `code` field when
 * the body carries one (verbatim strings in lib/load.test.ts); a Cloudflare
 * HTML page and client-side failures get their own classes so neither is
 * read as a function error.
 */
export function classify(a: Pick<Answer, "status" | "contentType" | "text" | "err">): string {
  if (a.status === 0) {
    const e = (a.err ?? "").toLowerCase();
    if (e.includes("os error 51") || e.includes("network is unreachable")) return "client_unreachable";
    if (e.includes("timeout") || e.includes("timed out") || e.includes("aborted")) return "client_timeout";
    if (e.includes("connection") || e.includes("socket") || e.includes("econn")) return "client_socket";
    return "client_other";
  }
  if (a.status === 200) return "ok";
  const ct = (a.contentType ?? "").toLowerCase();
  if (ct.includes("text/html") || /^\s*<(?:!doctype|html)/i.test(a.text)) return `html_${a.status}`;
  const m = a.text.match(/"code"\s*:\s*"([A-Z][A-Z0-9_]+)"/);
  if (m) return `${a.status}_${m[1]}`;
  return a.text.trim() ? `${a.status}_other` : `${a.status}_empty`;
}

/** The rpc arm's function answers 200 with `{"rpc": <status>}`; anything else is "". */
export function rpcStatus(text: string): string {
  const m = text.match(/"rpc"\s*:\s*(\d+|null)/);
  return m ? m[1]! : "";
}

export function coloOf(cfRay: string | null): string {
  const m = (cfRay ?? "").match(/-([A-Z]{3})$/);
  return m ? m[1]! : "";
}

const now = () => performance.now();

async function shoot(fire: Fire, t0: number, schedMs: number, out: Shot[]): Promise<void> {
  const sendMs = now() - t0;
  const a = await fire();
  const ms = now() - t0 - sendMs;
  out.push({
    schedMs,
    sendMs: Math.round(sendMs * 10) / 10,
    ms: Math.round(ms),
    status: a.status,
    cls: classify(a),
    region: a.region,
    colo: a.colo,
    body: (a.status === 200 ? "" : a.text || a.err || "").slice(0, 200),
    rpc: rpcStatus(a.text),
  });
}

/** Fixed arrival rate for `durationMs`, ticking every `tickMs`. */
export async function openLoop(opts: { rate: number; durationMs: number; maxInFlight: number; fire: Fire; tickMs?: number }): Promise<LoadRun> {
  const { rate, durationMs, maxInFlight, fire } = opts;
  const tick = opts.tickMs ?? 5;
  const shots: Shot[] = [];
  const pending = new Set<Promise<void>>();
  let skipped = 0;
  let maxSeen = 0;
  let i = 0;
  const total = Math.round((rate * durationMs) / 1000);
  const w0 = Date.now();
  const t0 = now();
  while (i < total) {
    const elapsed = now() - t0;
    const due = Math.min(total, Math.floor((elapsed * rate) / 1000) + 1);
    while (i < due) {
      const sched = Math.round((i * 1000) / rate);
      i++;
      if (pending.size >= maxInFlight) {
        skipped++;
        continue;
      }
      const p: Promise<void> = shoot(fire, t0, sched, shots).finally(() => pending.delete(p));
      pending.add(p);
      if (pending.size > maxSeen) maxSeen = pending.size;
    }
    if (i < total) await Bun.sleep(tick);
  }
  await Promise.all(pending);
  return { shots, scheduled: total, skipped, maxInFlightSeen: maxSeen, wallMs: Date.now() - w0, monoMs: Math.round(now() - t0) };
}

/**
 * `n` requests as fast as `maxInFlight` sockets allow: the first
 * min(n, maxInFlight) leave at once, each completion launches the next.
 */
export async function burst(opts: { n: number; maxInFlight: number; fire: Fire }): Promise<LoadRun> {
  const shots: Shot[] = [];
  let next = 0;
  let maxSeen = 0;
  let inFlight = 0;
  const w0 = Date.now();
  const t0 = now();
  const lane = async () => {
    while (next < opts.n) {
      next++;
      inFlight++;
      if (inFlight > maxSeen) maxSeen = inFlight;
      await shoot(opts.fire, t0, -1, shots);
      inFlight--;
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.n, opts.maxInFlight) }, lane));
  return { shots, scheduled: opts.n, skipped: 0, maxInFlightSeen: maxSeen, wallMs: Date.now() - w0, monoMs: Math.round(now() - t0) };
}

/** min/max without spreading: a 400/s step holds 48,000 values, too many for an argument list. */
export function minOf(xs: number[]): number {
  let m = Infinity;
  for (const x of xs) if (x < m) m = x;
  return m;
}
export function maxOf(xs: number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  return m;
}

export function pct(xs: number[], q: number): number {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

export function histogram(values: string[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(v || "-", (m.get(v || "-") ?? 0) + 1);
  return (
    [...m.entries()]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b, "en"))
      .map(([k, n]) => `${k}:${n}`)
      .join("|") || "none"
  );
}

/** Non-ok answers per `bucketS` seconds of send time, as "start_s:count" for non-empty buckets. */
export function errorTimeline(shots: Shot[], bucketS = 10): string {
  const m = new Map<number, number>();
  for (const s of shots) {
    if (s.cls === "ok") continue;
    const b = Math.floor(s.sendMs / 1000 / bucketS) * bucketS;
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return [...m.entries()].sort(([a], [b]) => a - b).map(([b, n]) => `${b}:${n}`).join("|") || "none";
}

export interface ClientLimit {
  limited: boolean;
  reason: string;
}

/**
 * A step measures the platform only if the client kept its schedule: no
 * request skipped at the in-flight cap, achieved send rate within 5 % of the
 * plan, p99 send lag under 250 ms, and every request got an HTTP answer.
 * The last condition was added after run 1 (2026-11-04), whose 1,000-request
 * burst left 483 requests without an answer while the flag read "no".
 */
export function clientLimited(run: LoadRun, rate: number): ClientLimit {
  const reasons: string[] = [];
  if (run.skipped > 0) reasons.push(`${run.skipped} skipped at the in-flight cap`);
  const noAnswer = run.shots.filter((s) => s.status === 0).length;
  if (noAnswer > 0) reasons.push(`${noAnswer} without an HTTP answer`);
  const sends = run.shots.map((s) => s.sendMs);
  if (rate > 0 && sends.length > 1) {
    const span = (maxOf(sends) - minOf(sends)) / 1000;
    const achieved = span > 0 ? (sends.length - 1) / span : 0;
    if (achieved < rate * 0.95) reasons.push(`achieved ${achieved.toFixed(1)}/s of ${rate}/s`);
    const lag = pct(
      run.shots.map((s) => s.sendMs - s.schedMs),
      0.99,
    );
    if (lag > 250) reasons.push(`p99 send lag ${Math.round(lag)} ms`);
  }
  if (run.wallMs - run.monoMs > 2000) reasons.push(`host paused ${Math.round((run.wallMs - run.monoMs) / 1000)} s`);
  return { limited: reasons.length > 0, reason: reasons.join("; ") || "none" };
}

/** First body seen per non-ok class, "class => body" lines. */
export function firstBodies(shots: Shot[], scrub: (s: string) => string = (s) => s): string {
  const seen = new Map<string, string>();
  for (const s of shots) if (s.cls !== "ok" && !seen.has(s.cls)) seen.set(s.cls, scrub(s.body.replace(/\s+/g, " ").trim()));
  return [...seen.entries()].map(([c, b]) => `${c} => ${b || "(empty)"}`).join("\n") || "";
}

export interface StepSummary {
  measurements: Record<string, number | string>;
  errorShare: number;
  rle: number;
}

/** One step's measurements from its run. `rate` 0 marks a burst. */
export function summarise(run: LoadRun, rate: number, maxInFlight: number): StepSummary {
  const sh = run.shots;
  const sent = sh.length;
  const answered = sh.filter((s) => s.status !== 0);
  const ok = sh.filter((s) => s.cls === "ok");
  const notOk = sent - ok.length;
  const rle = sh.filter((s) => s.cls === "429_RATE_LIMIT_EXCEEDED").length;
  const sends = sh.map((s) => s.sendMs);
  const span = sends.length > 1 ? (maxOf(sends) - minOf(sends)) / 1000 : 0;
  const ends = sh.map((s) => s.sendMs + s.ms);
  const wholeS = ends.length ? (maxOf(ends) - minOf(sends)) / 1000 : 0;
  const lim = clientLimited(run, rate);
  const rlFirst = sh.filter((s) => s.cls === "429_RATE_LIMIT_EXCEEDED").map((s) => s.sendMs);
  const m: Record<string, number | string> = {
    requested_rps: rate,
    scheduled: run.scheduled,
    sent,
    skipped_at_cap: run.skipped,
    in_flight_cap: maxInFlight,
    max_in_flight: run.maxInFlightSeen,
    send_span_s: Math.round(span * 10) / 10,
    achieved_send_rps: span > 0 ? Math.round(((sent - 1) / span) * 10) / 10 : sent,
    answered_rps: wholeS > 0 ? Math.round((answered.length / wholeS) * 10) / 10 : answered.length,
    send_lag_p99_ms: rate > 0 ? Math.round(pct(sh.map((s) => s.sendMs - s.schedMs), 0.99)) : -1,
    client_limited: lim.limited ? "yes" : "no",
    client_limit_reason: lim.reason,
    status_histogram: histogram(sh.map((s) => String(s.status))),
    class_histogram: histogram(sh.map((s) => s.cls)),
    not_ok: notOk,
    error_share_pct: sent ? Math.round((notOk / sent) * 10000) / 100 : 0,
    rate_limit_exceeded: rle,
    rle_first_send_s: rlFirst.length ? Math.round(minOf(rlFirst) / 100) / 10 : -1,
    not_ok_per_10s: errorTimeline(sh),
    p50_ms: pct(answered.map((s) => s.ms), 0.5),
    p95_ms: pct(answered.map((s) => s.ms), 0.95),
    p99_ms: pct(answered.map((s) => s.ms), 0.99),
    ok_p50_ms: pct(ok.map((s) => s.ms), 0.5),
    ok_p99_ms: pct(ok.map((s) => s.ms), 0.99),
    edge_region: histogram(answered.map((s) => s.region)),
    cf_colo: histogram(answered.map((s) => s.colo)),
  };
  const rpc = sh.filter((s) => s.rpc !== "").map((s) => s.rpc);
  if (rpc.length) m.rpc_histogram = histogram(rpc);
  if (run.wallMs - run.monoMs > 2000) m.host_suspended_s = Math.round((run.wallMs - run.monoMs) / 1000);
  return { measurements: m, errorShare: sent ? notOk / sent : 0, rle };
}
