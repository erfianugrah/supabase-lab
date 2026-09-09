/**
 * The op runner shared by Z01 and Z02.
 *
 * One function rather than two near-copies, because the awake and paused
 * passes have to be IDENTICAL in everything except project state - if they
 * differ in request shape, latency accounting or ordering, the diff between
 * them measures our own inconsistency instead of the platform's.
 *
 * Captured ids are passed IN rather than rediscovered per pass. While a
 * project is parked, the list endpoints that would supply an id are themselves
 * the ones failing, so a paused pass that captures its own ids skips every
 * parameterised route. Capture awake, carry into paused.
 */
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import type { WriteOp } from "./write-ops.js";
import { projectStatus } from "./surface.js";

export interface OpReading {
  tier: number;
  verb: string;
  path: string;
  http: number | "SKIP";
  ms: number;
  bytes: number;
  bodyHead: string;
  statusAfter?: string;
  /** Set when http is "SKIP". */
  skipReason?: string;
}

export type Captures = Record<string, string>;

/** Dotted path into a JSON value; numeric segments index arrays. */
function dig(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    if (/^\d+$/.test(part)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(part)];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

const PLACEHOLDER = /\{([A-Z_]+)\}/g;

/** Substitute {REF}/{ORG}/captured ids; report the first unresolved name. */
function resolve(
  s: string,
  ref: string,
  org: string,
  caps: Captures,
): { out: string; missing?: string } {
  const out = s.replace(/\{REF\}/g, ref).replace(/\{ORG\}/g, org);
  let missing: string | undefined;
  const done = out.replace(PLACEHOLDER, (m, name: string) => {
    const v = caps[name];
    if (v === undefined) {
      missing ??= name;
      return m;
    }
    return v;
  });
  return missing ? { out: done, missing } : { out: done };
}

export interface SweepOpts {
  ref: string;
  org: string;
  /** Read project status back after each call - the wake check. */
  checkWake?: boolean;
  /** Seconds to wait before reading status back, so an async wake registers. */
  settleS?: number;
  /** Include operations flagged terminal (billable or project-ending). */
  includeTerminal?: boolean;
  /** Ids from a previous pass. Mutated in place as new ones are captured. */
  caps?: Captures;
  log?: (m: string) => void;
}

export async function sweepOps(
  ctx: Ctx,
  ops: WriteOp[],
  opts: SweepOpts,
): Promise<{ readings: OpReading[]; caps: Captures }> {
  const caps: Captures = opts.caps ?? {};
  const readings: OpReading[] = [];
  for (const op of ops) {
    if (op.terminal && !opts.includeTerminal) continue;
    const rawBody = op.body === undefined ? undefined : JSON.stringify(op.body);
    const p = resolve(op.path, opts.ref, opts.org, caps);
    const b = rawBody === undefined ? undefined : resolve(rawBody, opts.ref, opts.org, caps);
    const missing = p.missing ?? b?.missing;
    if (missing) {
      readings.push({
        tier: op.tier,
        verb: op.verb,
        path: op.path,
        http: "SKIP",
        ms: 0,
        bytes: 0,
        bodyHead: "",
        skipReason: `no ${missing} captured`,
      });
      continue;
    }
    let payload: unknown = b === undefined ? undefined : JSON.parse(b.out);
    // backups/restore takes a NUMBER; string substitution into JSON stringifies it.
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const rec = payload as Record<string, unknown>;
      if (p.out.endsWith("/backups/restore") && typeof rec.id === "string") {
        const n = Number(rec.id);
        if (Number.isFinite(n)) rec.id = n;
      }
    }
    const t0 = Date.now();
    const r = await mgmt(ctx, op.verb, p.out, payload, 120_000).catch(() => null);
    const ms = Date.now() - t0;
    if (op.capture && r?.json !== undefined) {
      for (const [name, jp] of op.capture) {
        const v = dig(r.json, jp);
        if (v !== undefined && v !== null) caps[name] = String(v);
      }
    }
    const reading: OpReading = {
      tier: op.tier,
      verb: op.verb,
      path: op.path,
      http: r?.status ?? 0,
      ms,
      bytes: r?.text.length ?? 0,
      bodyHead: (r?.text ?? "").replace(/\s+/g, " ").slice(0, 160),
    };
    if (opts.checkWake) {
      if (opts.settleS) await new Promise((res) => setTimeout(res, opts.settleS! * 1000));
      reading.statusAfter = await projectStatus(ctx, opts.org, opts.ref);
    }
    readings.push(reading);
    opts.log?.(
      `T${op.tier} ${op.verb} ${op.path} -> ${reading.http}` +
        (reading.statusAfter ? ` [${reading.statusAfter}]` : ""),
    );
  }
  return { readings, caps };
}

export const opsTsv = (rows: OpReading[]) =>
  ["tier\tverb\tpath\thttp\tms\tbytes\tstatus_after\tnote"]
    .concat(
      rows.map((r) =>
        [
          r.tier,
          r.verb,
          r.path,
          r.http,
          r.ms,
          r.bytes,
          r.statusAfter ?? "-",
          r.skipReason ?? r.bodyHead,
        ].join("\t"),
      ),
    )
    .join("\n");
