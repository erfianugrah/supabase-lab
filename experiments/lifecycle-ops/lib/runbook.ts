/**
 * Cluster B runbook: detect a project whose data path has stopped answering
 * while the control plane still reads it as healthy, decide whether a
 * self-restart is allowed, send it, and verify recovery on the data path.
 * The prose version is RUNBOOK-cluster-b.md; the drill that exercised it is
 * tests/lo06-self-restart-drill.ts.
 *
 * "Cluster B" is the status-page incident class where the platform's advice to
 * an affected project was "restart it": Nano projects becoming unresponsive
 * after hours (2026-09-10 to 09-12, "encouraged to restart their projects
 * which has shown to resolve lasting errors") and refreshed JWTs rejected with
 * HTTP 401 (2026-08-14 to 09-30, "restarting their project after the rollout
 * resolved this issue"). In both, a client sees errors on reads while nothing
 * in the Management API says the project is down.
 *
 * Three measured facts shape the code (RUNLOG, LO05):
 *  - a restart takes REST reads down for 46 to 181 s (2026-10-23, n=5), and
 *  - the control-plane status reads ACTIVE_HEALTHY again before reads recover,
 *    so verification waits for the data path, never for the status, and a
 *    detector left running after a restart would see "healthy status, failing
 *    reads" again: the cooldown below is what stops a restart loop;
 *  - a second POST /restart while one is in flight answers 200 like the first
 *    (LO05c), so the API will not refuse a duplicate: the caller has to.
 *
 * Everything that decides is pure (Detector, RecoveryTracker, decide,
 * gateView); `supervise` is the loop, with every side effect injected so the
 * whole loop runs under a fake clock in runbook.test.ts.
 */
import type { Probe, ProbeOutcome } from "../../../harness/src/sampler";
import {
  RESTART_MIN_AGE_MS,
  decide as gateDecide,
  incidentText,
  isOpen,
  type Op,
  type StatusComponent,
  type StatusIncident,
} from "./gate";

export interface RunbookPolicy {
  /** Delay between probe rounds. */
  intervalMs: number;
  /** Probes whose sustained failure counts as a detection (the data path). Others are context only. */
  triggerPaths: string[];
  /** A trigger path must fail on every sample for this long before it counts. */
  detectAfterMs: number;
  /** ...and on at least this many consecutive samples (guards a slow round). */
  detectMinSamples: number;
  /** Recovery: every probe answers on every sample for this long. */
  settleMs: number;
  /** Give up waiting for recovery after the POST: escalate. */
  verifyMaxMs: number;
  /** No second restart within this long of the previous one (ours or recorded). */
  minIntervalMs: number;
  /** At most this many restarts inside windowMs; the next detection escalates. */
  maxRestartsPerWindow: number;
  windowMs: number;
  /** Control-plane status read at most this often. */
  statusPollMs: number;
  /** Status page read at most this often. */
  gatePollMs: number;
  /** When the status page cannot be read: false = hold (the LO01 gate's default). */
  gateFailOpen: boolean;
}

/**
 * Defaults. Each is a design choice, not a measurement, except where the
 * comment names the run it rests on.
 */
export const DEFAULT_RUNBOOK_POLICY: RunbookPolicy = {
  intervalMs: 2000,
  triggerPaths: ["rest_read"],
  // 60 s of failure on every sample. Longer than any blip the LO06 baseline
  // saw on a healthy project; how long real cluster B episodes lasted before
  // a restart is not in any record here.
  detectAfterMs: 60_000,
  detectMinSamples: 10,
  settleMs: 10_000,
  // LO05 2026-10-23: the longest rest_read window was 181 s. 600 s is about
  // three times that.
  verifyMaxMs: 600_000,
  // Longer than verifyMaxMs, so a restart that is still recovering cannot be
  // followed by another one.
  minIntervalMs: 900_000,
  maxRestartsPerWindow: 2,
  windowMs: 3_600_000,
  statusPollMs: 10_000,
  gatePollMs: 60_000,
  gateFailOpen: false,
};

export interface Observation {
  atMs: number;
  outcomes: { name: string; ok: boolean; error?: string }[];
}

/** Tracks, per path, when the current run of consecutive failures began. */
export class Detector {
  private failSince = new Map<string, { atMs: number; samples: number }>();
  readonly modes = new Map<string, string[]>();

  constructor(private policy: Pick<RunbookPolicy, "triggerPaths" | "detectAfterMs" | "detectMinSamples">) {}

  observe(o: Observation): void {
    for (const r of o.outcomes) {
      if (r.ok) {
        this.failSince.delete(r.name);
        continue;
      }
      const cur = this.failSince.get(r.name);
      this.failSince.set(r.name, cur ? { atMs: cur.atMs, samples: cur.samples + 1 } : { atMs: o.atMs, samples: 1 });
      const m = this.modes.get(r.name) ?? [];
      const e = (r.error ?? "failed").slice(0, 80);
      if (!m.includes(e)) m.push(e);
      this.modes.set(r.name, m);
    }
  }

  /** Earliest start of a still-running failure on a trigger path, or null. */
  firstFailAt(): number | null {
    let first: number | null = null;
    for (const p of this.policy.triggerPaths) {
      const f = this.failSince.get(p);
      if (f && (first === null || f.atMs < first)) first = f.atMs;
    }
    return first;
  }

  /** Trigger paths that have failed long enough and often enough. */
  detected(nowMs: number): string[] {
    return this.policy.triggerPaths.filter((p) => {
      const f = this.failSince.get(p);
      return !!f && nowMs - f.atMs >= this.policy.detectAfterMs && f.samples >= this.policy.detectMinSamples;
    });
  }

  failing(): string[] {
    return [...this.failSince.keys()];
  }
}

/** Recovery = every probe ok on every sample for settleMs; reports the first sample of that run. */
export class RecoveryTracker {
  private okSince: number | null = null;
  constructor(private settleMs: number) {}
  observe(o: Observation): number | null {
    if (o.outcomes.every((r) => r.ok)) {
      if (this.okSince === null) this.okSince = o.atMs;
      if (o.atMs - this.okSince >= this.settleMs) return this.okSince;
    } else this.okSince = null;
    return null;
  }
}

/**
 * Does an incident's text tell affected users to restart? Then the status-page
 * gate should not refuse the remedy the incident itself recommends. A text
 * that says not to restart wins over one that says to.
 */
const ADVISES_RESTART_RE =
  /encouraged to restart|recommend(ed|s)? (a |that you )?restart|restart(ing)? (your|their|the) projects?\b/i;
const ADVISES_AGAINST_RE = /\b(do not|don't|avoid|refrain from|not)\s+(restart|restarting)\b/i;
export function advisesRestart(inc: StatusIncident): boolean {
  const t = incidentText(inc);
  return ADVISES_RESTART_RE.test(t) && !ADVISES_AGAINST_RE.test(t);
}

export interface GateView {
  proceed: boolean;
  blockers: string[];
  warnings: string[];
}

/**
 * The LO01 gate for `restart`, with open incidents that advise a restart moved
 * from blockers to warnings. Without this the gate refuses during the very
 * incident class the runbook exists for: "Unresponsive Projects" names no
 * region and its title matches the gate's restart wording (`unresponsive`).
 */
export function gateView(region: string, components: StatusComponent[], incidents: StatusIncident[], op: Op = "restart"): GateView {
  const advising = incidents.filter((i) => isOpen(i) && advisesRestart(i));
  const rest = incidents.filter((i) => !advising.includes(i));
  const d = gateDecide(region, op, components, rest);
  return {
    proceed: d.proceed,
    blockers: d.blockers,
    warnings: [...d.warnings, ...advising.map((i) => `open incident advises restart: ${i.id} "${i.name}"`)],
  };
}

export type Action = "none" | "hold" | "restart" | "escalate";

export interface DecideInput {
  nowMs: number;
  detectedPaths: string[];
  /** GET /v1/projects/{ref} status, or "HTTP <n>" when unreadable. */
  controlStatus: string;
  /** POST times of earlier restarts (ours, plus any the operator records). */
  restartsAtMs: number[];
  /** When the create completed (first ACTIVE_HEALTHY read), if known. */
  createdAtMs?: number;
  gate: GateView | { unreadable: string };
}

export interface Decision {
  action: Action;
  reasons: string[];
}

/** Guard rails, in order. The first rule that fires decides. */
export function decide(input: DecideInput, policy: RunbookPolicy = DEFAULT_RUNBOOK_POLICY): Decision {
  const { nowMs } = input;
  if (input.detectedPaths.length === 0) return { action: "none", reasons: ["no trigger path past the detection threshold"] };
  const why = `detected on ${input.detectedPaths.join(",")}`;

  const inWindow = input.restartsAtMs.filter((t) => nowMs - t < policy.windowMs);
  if (inWindow.length >= policy.maxRestartsPerWindow) {
    return {
      action: "escalate",
      reasons: [why, `${inWindow.length} restarts in the last ${Math.round(policy.windowMs / 60000)} min (max ${policy.maxRestartsPerWindow}): a restart is not fixing this`],
    };
  }
  if (input.controlStatus !== "ACTIVE_HEALTHY") {
    return { action: "hold", reasons: [why, `control-plane status ${input.controlStatus}: an operation may be in flight, or the platform already reports the project down`] };
  }
  const last = Math.max(-Infinity, ...input.restartsAtMs);
  if (nowMs - last < policy.minIntervalMs) {
    return { action: "hold", reasons: [why, `cooldown: last restart ${Math.round((nowMs - last) / 1000)} s ago (min ${policy.minIntervalMs / 1000} s)`] };
  }
  if (input.createdAtMs !== undefined && nowMs - input.createdAtMs < RESTART_MIN_AGE_MS) {
    return { action: "hold", reasons: [why, `project ${Math.round((nowMs - input.createdAtMs) / 1000)} s old: the API has refused restarts this soon after creation (LO05f)`] };
  }
  if ("unreadable" in input.gate) {
    return policy.gateFailOpen
      ? { action: "restart", reasons: [why, `status page unreadable (${input.gate.unreadable}); gateFailOpen`] }
      : { action: "hold", reasons: [why, `status page unreadable: ${input.gate.unreadable}`] };
  }
  if (!input.gate.proceed) return { action: "hold", reasons: [why, ...input.gate.blockers.map((b) => `gate: ${b}`)] };
  return { action: "restart", reasons: [why, ...input.gate.warnings.map((w) => `gate warning: ${w}`)] };
}

export interface RunbookIO {
  now(): number;
  sleep(ms: number): Promise<void>;
  probes: Probe[];
  /** Run one probe with the caller's deadline (the sampler's withDeadline in the live module). */
  runProbe(p: Probe): Promise<ProbeOutcome>;
  controlStatus(): Promise<string>;
  gate(): Promise<GateView | { unreadable: string }>;
  restart(): Promise<{ http: number; body: string }>;
  log(msg: string): void;
}

export type Outcome =
  | "no-fault"
  | "self-cleared"
  | "recovered"
  | "escalated"
  | "unrecovered"
  | "restart-refused"
  | "hard-stop";

export interface Episode {
  outcome: Outcome;
  startedAtMs: number;
  rounds: number;
  /** Failed samples per probe over the whole episode. */
  failedSamples: Record<string, number>;
  firstFailAtMs: number | null;
  detectedAtMs: number | null;
  /** Each distinct decision, in order, with the time it was first made. */
  decisions: { atMs: number; action: Action; reasons: string[] }[];
  postAtMs: number | null;
  postHttp: number | null;
  postBody: string;
  /** Control-plane view after the POST. */
  statusTransitions: { atMs: number; status: string }[];
  statusHealthyAgainAtMs: number | null;
  /** First sample of the sustained recovery on every probe. */
  recoveredAtMs: number | null;
  modes: Record<string, string[]>;
}

/**
 * One episode: watch until a detection is acted on (restart, then verify) or
 * escalated, or until `maxWatchMs` passes with no action. `restartsAtMs` is
 * the shared history; a restart sent here is appended to it.
 */
export async function supervise(
  io: RunbookIO,
  opts: {
    policy?: RunbookPolicy;
    restartsAtMs: number[];
    createdAtMs?: number;
    /** With no detection by then, the episode ends as no-fault. */
    maxWatchMs: number;
    /** Absolute cap on the episode (holds included). */
    hardStopMs?: number;
  },
): Promise<Episode> {
  const policy = opts.policy ?? DEFAULT_RUNBOOK_POLICY;
  const start = io.now();
  const det = new Detector(policy);
  const rec = new RecoveryTracker(policy.settleMs);
  const cleared = new RecoveryTracker(policy.settleMs);
  const hardStopMs = opts.hardStopMs ?? 7_200_000;
  const ep: Episode = {
    outcome: "no-fault",
    startedAtMs: start,
    rounds: 0,
    failedSamples: Object.fromEntries(io.probes.map((p) => [p.name, 0])),
    firstFailAtMs: null,
    detectedAtMs: null,
    decisions: [],
    postAtMs: null,
    postHttp: null,
    postBody: "",
    statusTransitions: [],
    statusHealthyAgainAtMs: null,
    recoveredAtMs: null,
    modes: {},
  };
  let status = { atMs: -Infinity, value: "" };
  let gate: { atMs: number; value: GateView | { unreadable: string } } = { atMs: -Infinity, value: { unreadable: "not read" } };
  let left = false;

  const finish = (o: Outcome) => {
    ep.outcome = o;
    ep.modes = Object.fromEntries(det.modes);
    return ep;
  };

  for (;;) {
    const roundStart = io.now();
    const outs = await Promise.all(io.probes.map((p) => io.runProbe(p)));
    const obs: Observation = { atMs: io.now(), outcomes: outs.map((o, i) => ({ name: io.probes[i]?.name ?? `p${i}`, ...o })) };
    ep.rounds += 1;
    for (const o of obs.outcomes) if (!o.ok) ep.failedSamples[o.name] = (ep.failedSamples[o.name] ?? 0) + 1;
    det.observe(obs);

    if (obs.atMs - start >= hardStopMs) return finish("hard-stop");
    if (ep.postAtMs === null) {
      // ---- watch, decide, act ----
      const clearedAt = cleared.observe(obs);
      const ff = det.firstFailAt();
      if (ff !== null && ep.firstFailAtMs === null) ep.firstFailAtMs = ff;
      if (ff === null && ep.detectedAtMs === null) ep.firstFailAtMs = null; // a blip that cleared
      const paths = det.detected(obs.atMs);
      if (paths.length) {
        if (ep.detectedAtMs === null) ep.detectedAtMs = obs.atMs;
        if (obs.atMs - status.atMs >= policy.statusPollMs) status = { atMs: obs.atMs, value: await io.controlStatus() };
        if (obs.atMs - gate.atMs >= policy.gatePollMs) gate = { atMs: obs.atMs, value: await io.gate() };
        const d = decide(
          { nowMs: obs.atMs, detectedPaths: paths, controlStatus: status.value, restartsAtMs: opts.restartsAtMs, createdAtMs: opts.createdAtMs, gate: gate.value },
          policy,
        );
        const prev = ep.decisions.at(-1);
        if (!prev || prev.action !== d.action || kind(prev.reasons[1]) !== kind(d.reasons[1])) {
          ep.decisions.push({ atMs: obs.atMs, ...d });
          io.log(`decide ${d.action}: ${d.reasons.join("; ")}`);
        }
        if (d.action === "escalate") return finish("escalated");
        if (d.action === "restart") {
          const t = io.now();
          const r = await io.restart();
          ep.postAtMs = t;
          ep.postHttp = r.http;
          ep.postBody = r.body.slice(0, 300);
          if (r.http < 200 || r.http >= 300) return finish("restart-refused");
          opts.restartsAtMs.push(t);
          status = { atMs: -Infinity, value: "" };
        }
      } else if (ep.detectedAtMs !== null && clearedAt !== null) {
        // Detected, held, and the fault went away before any restart.
        ep.recoveredAtMs = clearedAt;
        return finish("self-cleared");
      } else if (ep.detectedAtMs === null && obs.atMs - start >= opts.maxWatchMs) {
        return finish("no-fault");
      }
    } else {
      // ---- verify on the data path; the status is recorded, not trusted ----
      const back = rec.observe(obs);
      if (obs.atMs - status.atMs >= policy.statusPollMs) {
        status = { atMs: obs.atMs, value: await io.controlStatus() };
        const lastT = ep.statusTransitions.at(-1);
        if (!lastT || lastT.status !== status.value) ep.statusTransitions.push({ atMs: obs.atMs, status: status.value });
        if (status.value !== "ACTIVE_HEALTHY") left = true;
        if (left && status.value === "ACTIVE_HEALTHY" && ep.statusHealthyAgainAtMs === null) ep.statusHealthyAgainAtMs = obs.atMs;
      }
      if (back !== null) {
        ep.recoveredAtMs = back;
        return finish("recovered");
      }
      if (obs.atMs - ep.postAtMs >= policy.verifyMaxMs) return finish("unrecovered");
    }
    const spent = io.now() - roundStart;
    await io.sleep(Math.max(0, policy.intervalMs - spent));
  }
}

/** A reason with its numbers masked, so a countdown does not log a new decision every round. */
const kind = (r: string | undefined) => (r ?? "").replace(/\d+/g, "#");

/** Seconds between two episode timestamps, rounded, or -1 when either is missing. */
export const secs = (from: number | null, to: number | null) =>
  from === null || to === null ? -1 : Math.round((to - from) / 1000);
