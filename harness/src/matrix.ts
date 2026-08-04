/**
 * Feature-matrix probing: run the same set of named feature probes against
 * several connection modes and turn each mode's outcomes into one report row.
 *
 * The generalisation is the same one sampler.ts makes for downtime. There,
 * "what operation" is separated from "what paths"; here, "what feature" is
 * separated from "what connection mode", so adding a mode is a table row and
 * adding a feature is one closure.
 *
 * Two rules are encoded here rather than left to each experiment:
 *
 * 1. A feature can fail SILENTLY. `pg_advisory_unlock` returns false and emits
 *    a warning when the lock is not held; nothing is raised. `FeatureFailure`
 *    is how a probe reports that, so "no exception" never reads as "worked".
 * 2. The error text is the finding, not decoration. A reader wants to know how
 *    the failure will present in their application, so the server's wording is
 *    carried verbatim into `evidence` and only TRUNCATED (never reworded) for
 *    the measurement cell.
 */
import type { Status } from "./types";

/** Thrown by a probe whose feature did not work but which raised nothing. */
export class FeatureFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureFailure";
  }
}

export interface Feature {
  name: string;
  /** Resolve (optionally with a note) on success; THROW on failure. */
  run(): Promise<string | void>;
}

export interface FeatureOutcome {
  name: string;
  ok: boolean;
  /** Verbatim, single-lined. Empty string when ok. */
  error: string;
  /** Recorded on success - e.g. the backend pid the probe observed. */
  note?: string;
}

/** Error -> a single line. Unwrapped only; never reworded. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Runs the probes IN ORDER on one connection. Order matters: the
 * prepared-statement reuse probe is only meaningful after the statement has
 * been prepared, so the caller's array order is preserved and never
 * parallelised.
 */
export async function runFeatures(features: Feature[]): Promise<FeatureOutcome[]> {
  const outcomes: FeatureOutcome[] = [];
  for (const f of features) {
    try {
      const note = await f.run();
      outcomes.push({ name: f.name, ok: true, error: "", ...(note ? { note } : {}) });
    } catch (e) {
      outcomes.push({ name: f.name, ok: false, error: errorText(e) });
    }
  }
  return outcomes;
}

/** One measurement per feature. `maxLen` bounds the table cell, not the record. */
export function toMeasurements(
  outcomes: FeatureOutcome[],
  maxLen: number,
): Record<string, string> {
  const m: Record<string, string> = {};
  for (const o of outcomes) {
    if (o.ok) m[o.name] = o.note ? `ok (${o.note})` : "ok";
    else
      m[o.name] =
        o.error.length > maxLen ? `failed: ${o.error.slice(0, maxLen)}...` : `failed: ${o.error}`;
  }
  return m;
}

/** The verbatim record. Nothing here is truncated. */
export function renderEvidence(outcomes: FeatureOutcome[]): string {
  return outcomes
    .map((o) => `${o.name}: ${o.ok ? `ok${o.note ? ` (${o.note})` : ""}` : o.error}`)
    .join("\n");
}

/**
 * `control: true` is the unpooled reference mode. Every feature MUST work
 * there; one that does not means the probe is broken, so the row fails rather
 * than quietly widening the matrix. A pooled row is always `info` - an
 * unsupported feature is the measurement being taken, not a defect.
 */
export function summariseRow(
  outcomes: FeatureOutcome[],
  opts: { control: boolean },
): { status: Status; detail: string } {
  const broken = outcomes.filter((o) => !o.ok).map((o) => o.name);
  if (opts.control) {
    return broken.length
      ? {
          status: "fail",
          detail: `control mode did not support ${broken.join(", ")} - the probe is suspect, not the pooler`,
        }
      : {
          status: "pass",
          detail: `control mode supports all ${outcomes.length} features`,
        };
  }
  return {
    status: "info",
    detail: broken.length
      ? `${broken.length}/${outcomes.length} unsupported: ${broken.join(", ")}`
      : `0/${outcomes.length} unsupported - behaved as a direct session on every feature`,
  };
}

/**
 * Compare one feature outcome against a result this repo already recorded.
 * A prior finding that flips is the loudest thing in a run; without this it
 * would land as one `info` cell in a wide table and be read past.
 */
export function regressionVerdict(
  outcome: FeatureOutcome | undefined,
  prior: { label: string; ok: boolean },
): { status: Status; detail: string } {
  if (!outcome)
    return {
      status: "skip",
      detail: `mode not probed - nothing to compare against ${prior.label}`,
    };
  if (prior.ok && outcome.ok)
    return { status: "pass", detail: `reproduces ${prior.label}: ${outcome.name} still works` };
  if (prior.ok && !outcome.ok)
    return {
      status: "fail",
      detail: `REGRESSION vs ${prior.label}: ${outcome.name} now fails with "${outcome.error}"`,
    };
  if (!prior.ok && outcome.ok)
    return {
      status: "info",
      detail: `${prior.label} recorded ${outcome.name} as broken; it works now`,
    };
  return { status: "pass", detail: `reproduces ${prior.label}: ${outcome.name} still fails` };
}

export interface Target {
  host: string;
  port: number;
}

/**
 * `"host"` / `"host:port"` / `"[v6addr]:port"` -> a target; absent or empty ->
 * null, so the mode self-skips with a reason instead of dialling "".
 *
 * A non-numeric port throws. Defaulting there would benchmark one port while
 * the report named another, which is worse than a crash at startup.
 */
export function parseTarget(value: string | undefined, defaultPort: number): Target | null {
  const v = (value ?? "").trim();
  if (!v) return null;

  const bracketed = v.match(/^\[([^\]]+)\](?::(.+))?$/);
  if (bracketed) return { host: bracketed[1]!, port: portOf(bracketed[2], defaultPort, v) };

  const i = v.lastIndexOf(":");
  // A bare IPv6 literal has several colons and no port; treat it as a host.
  if (i === -1 || v.indexOf(":") !== i) return { host: v, port: defaultPort };
  return { host: v.slice(0, i), port: portOf(v.slice(i + 1), defaultPort, v) };
}

function portOf(raw: string | undefined, fallback: number, whole: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535)
    throw new Error(`not a port in endpoint "${whole}": ${raw}`);
  return n;
}
