/**
 * The triage order for "our Edge Function deploys are breaking", as a pure
 * function: the error string, then how many deploys ran in parallel, then
 * whether anyone checked the functions actually landed rather than trusting
 * the exit code.
 *
 * A limit rejects deterministically with a named error. Intermittent
 * breakage, or a success that turns out not to have happened, points
 * somewhere else - and two of those somewhere-elses (a 413 under
 * parallelism, an exit 0 with functions missing) look exactly like a quota
 * conversation until the second and third questions are asked.
 *
 * Pure so it is unit-testable; EF04/EF05 feed it real observations so the
 * report carries the bucket next to the raw status.
 */
import { FUNCTION_SIZE_MB, SECRETS, planForFunctionCap } from "./docs";

export type Bucket =
  | "size-limit" // deterministic: the bundle exceeded the ceiling for its deploy path
  | "count-limit" // deterministic: functions per project, plan-gated
  | "secret-limit" // deterministic: one of the four secrets limits
  | "throttled" // 429 - a rate limit on the control plane, not a quota
  | "conflict" // 409 - a different failure from 429; do not merge them
  | "misleading-413" // 413 under parallelism: looks like size, may be parallelism
  | "silent-loss" // exit 0 / 2xx, function absent afterwards
  | "runtime-ceiling" // memory / CPU / wall clock at invocation time
  | "not-a-limit" // intermittent, no named error - look at concurrency and metadata
  | "unknown";

export interface Observation {
  /** Error text verbatim, from the response body or CLI stderr. */
  errorText?: string;
  /** HTTP status if there was one. */
  status?: number;
  /** Process exit code if the CLI was involved. */
  exitCode?: number;
  /** How many deploys were in flight at once. 1 = serial. */
  parallel?: number;
  /** Whether GET /functions/{slug} found the function afterwards. */
  landed?: boolean;
  /** A reported hard cap, if the error carried one. */
  capReported?: number;
}

export interface Triage {
  bucket: Bucket;
  /** Does this outcome reproduce on a retry of the same input? */
  deterministic: boolean;
  /** The next thing to ask or check. */
  next: string;
  /** Which secrets limit, when bucket is secret-limit. */
  secretLimit?: "count" | "value-size" | "name-length" | "reserved-prefix";
}

const SIZE_RE = /exceeds the maximum deployment size|too large|payload too large/i;
const THROTTLE_RE = /ThrottlerException|Too Many Requests|rate limit/i;
const COUNT_RE = /maximum number of functions|function(s)? limit|too many functions|max_count/i;
// WORKER_RESOURCE_LIMIT is the code the runtime actually returned (546) for
// both CPU and memory exhaustion on 2026-09-02; WORKER_LIMIT is kept for older
// text and IDLE_TIMEOUT is the 504 W13 measured.
const RUNTIME_RE = /WORKER_(RESOURCE_)?LIMIT|IDLE_TIMEOUT|not having enough compute resources|CPU time|memory limit|out of memory|wall.?clock/i;

export function triage(o: Observation): Triage {
  const text = o.errorText ?? "";

  // 1. Named errors first. A deterministic rejection names itself.
  if (SIZE_RE.test(text) && !(o.status === 413 && (o.parallel ?? 1) > 1)) {
    return {
      bucket: "size-limit",
      deterministic: true,
      next: `which bundling path? API/Dashboard/--use-api is ${FUNCTION_SIZE_MB.api} MB by construction; local CLI bundling is ${FUNCTION_SIZE_MB.cli} MB`,
    };
  }
  if (COUNT_RE.test(text) || o.capReported !== undefined) {
    const plan = o.capReported !== undefined ? planForFunctionCap(o.capReported) : undefined;
    return {
      bucket: "count-limit",
      deterministic: true,
      next: plan
        ? `a cap of exactly ${o.capReported} identifies the ${plan} plan - confirm the ORG before treating it as a platform limit; function.max_count is an entitlement, raisable without a plan change`
        : "read function.max_count from the org's entitlements; it is an override, not a fixed ceiling",
    };
  }
  const secret = secretLimitOf(text);
  if (secret) {
    return {
      bucket: "secret-limit",
      deterministic: true,
      secretLimit: secret,
      next:
        secret === "count"
          ? `${SECRETS.maxPerProject} per project - one secret per tenant in a shared project is an architecture conversation, not a quota one`
          : `four separate secrets limits exist; this one is ${secret}`,
    };
  }
  if (RUNTIME_RE.test(text)) {
    return {
      bucket: "runtime-ceiling",
      deterministic: true,
      next: "invocation-time ceiling (memory, CPU, wall clock) - unrelated to deploy limits; long-running work does not fit an Edge Function on any plan",
    };
  }

  // 2. Status codes that are not quotas.
  if (o.status === 429 || THROTTLE_RE.test(text)) {
    return {
      bucket: "throttled",
      deterministic: false,
      next: "control-plane rate limit - how many deploys ran in parallel? then check every function landed; the throttle explains only the failures that surfaced",
    };
  }
  if (o.status === 409) {
    return {
      bucket: "conflict",
      deterministic: false,
      next: "409 is not 429 - do not merge them; check for concurrent deploys of the SAME function",
    };
  }
  if (o.status === 413) {
    if ((o.parallel ?? 1) > 1) {
      return {
        bucket: "misleading-413",
        deterministic: false,
        next: "413 under parallel deploys can be the parallelism, not the size - retry the same bundle serially before quoting a size limit",
      };
    }
    return {
      bucket: "size-limit",
      deterministic: true,
      next: `serial 413 is a real size rejection - which bundling path? (${FUNCTION_SIZE_MB.api} MB server-side vs ${FUNCTION_SIZE_MB.cli} MB local)`,
    };
  }

  // 3. Success that was not.
  if ((o.exitCode === 0 || (o.status !== undefined && o.status < 300)) && o.landed === false) {
    return {
      bucket: "silent-loss",
      deterministic: false,
      next: "the exit code lied - query GET /functions/{slug} after every deploy round and retry the difference",
    };
  }

  if (o.landed === true && !text) {
    return { bucket: "unknown", deterministic: true, next: "the deploy succeeded and landed; there is nothing to triage" };
  }
  if (!text && o.status === undefined && o.exitCode === undefined) {
    return { bucket: "unknown", deterministic: false, next: "no error text, status, or exit code - collect the error string first" };
  }
  return {
    bucket: "not-a-limit",
    deterministic: false,
    next: "no named limit in the error - ask how many deploys ran in parallel, then whether anyone verified the functions landed",
  };
}

export function secretLimitOf(text: string): Triage["secretLimit"] | undefined {
  if (!text) return undefined;
  if (new RegExp(`${SECRETS.reservedPrefix}|reserved prefix`, "i").test(text)) return "reserved-prefix";
  if (/name.*(too long|length|256)/i.test(text)) return "name-length";
  if (/value.*(too long|length|24.?576|48 ?KiB)|24576/i.test(text)) return "value-size";
  if (/(maximum|max|too many).*secrets|secrets.*(limit|maximum)|maxItems|100 secrets/i.test(text)) return "count";
  return undefined;
}
