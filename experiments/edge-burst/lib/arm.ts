/**
 * One arm = one function: open-loop steps at rising request rates, then one
 * burst, each step a result row. Shared by EB02 (no-op) and EB03 (rpc).
 *
 * Knobs (environment, defaults in brackets): PVLAB_EB_RATES [25,50,100,200,400,800]
 * req/s, PVLAB_EB_STEP_S [120] s per step, PVLAB_EB_REST_S [20] s between
 * steps, PVLAB_EB_BURST [1000] requests, PVLAB_EB_BURST_REST_S [60] s before
 * the burst, PVLAB_EB_CAP [450] in-flight requests in a step,
 * PVLAB_EB_BURST_LANES [PVLAB_EB_CAP] in-flight requests in the burst (run 1
 * on 2026-11-04 opened 450 at once and 483 of 1,000 got no HTTP answer, so
 * later runs open fewer), PVLAB_EB_STOP_PCT [20]:
 * a step whose non-200 share is above this ends the ramp (the burst still
 * runs). PVLAB_EB_RAW_DIR, when set, receives one CSV per step with every
 * request (gitignored evidence; not published).
 */
import type { Ctx, TestResult } from "../../../harness/src/types.js";
import { REGION, ensureProject, fireFor, scrub, sleep } from "./eb.js";
import { burst, firstBodies, openLoop, summarise, type LoadRun } from "./load.js";

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== "" && process.env[k] !== undefined ? v : d;
};

export const RATES = (process.env.PVLAB_EB_RATES || "25,50,100,200,400,800").split(",").map(Number).filter((n) => n > 0);
export const STEP_S = num("PVLAB_EB_STEP_S", 120);
export const REST_S = num("PVLAB_EB_REST_S", 20);
export const BURST_N = num("PVLAB_EB_BURST", 1000);
export const BURST_REST_S = num("PVLAB_EB_BURST_REST_S", 60);
export const CAP = num("PVLAB_EB_CAP", 450);
export const BURST_LANES = num("PVLAB_EB_BURST_LANES", CAP);
export const STOP_PCT = num("PVLAB_EB_STOP_PCT", 20);

async function writeRaw(tag: string, run: LoadRun): Promise<void> {
  const dir = process.env.PVLAB_EB_RAW_DIR;
  if (!dir) return;
  const lines = ["sched_ms,send_ms,ms,status,cls,region,colo,rpc"];
  for (const s of run.shots) lines.push([s.schedMs, s.sendMs, s.ms, s.status, s.cls, s.region, s.colo, s.rpc].join(","));
  await Bun.write(`${dir}/${tag}.csv`, lines.join("\n") + "\n");
}

function row(id: string, title: string, run: LoadRun, rate: number, cap = CAP): { r: TestResult; share: number } {
  const s = summarise(run, rate, cap);
  const m = s.measurements;
  const lim = m.client_limited === "yes" ? ` CLIENT-LIMITED (${m.client_limit_reason})` : "";
  return {
    share: s.errorShare,
    r: {
      id,
      title,
      status: "info",
      detail:
        `${m.sent} sent at ${m.achieved_send_rps}/s (asked ${rate || "burst"}), ${m.rate_limit_exceeded} x 429 RATE_LIMIT_EXCEEDED, ` +
        `non-200 ${m.not_ok} (${m.error_share_pct} %); classes ${m.class_histogram}; p50/p95/p99 ${m.p50_ms}/${m.p95_ms}/${m.p99_ms} ms; ` +
        `x-sb-edge-region ${m.edge_region}; colo ${m.cf_colo}${lim}`,
      measurements: m,
      evidence: firstBodies(run.shots, scrub) || undefined,
    },
  };
}

export async function runArm(ctx: Ctx, id: string, slug: string, label: string): Promise<TestResult[]> {
  const p = await ensureProject(ctx);
  const fire = fireFor(p, slug);
  const out: TestResult[] = [];
  // Warm the function so the first step does not measure a cold start alone.
  for (let i = 0; i < 5; i++) await fire();

  let stoppedAt = 0;
  for (const [i, rate] of RATES.entries()) {
    if (i > 0) await sleep(REST_S * 1000);
    ctx.log(`${id} ${label}: ${rate} req/s for ${STEP_S} s`);
    const run = await openLoop({ rate, durationMs: STEP_S * 1000, maxInFlight: CAP, fire });
    const tag = `${id}-r${String(rate).padStart(3, "0")}`;
    await writeRaw(tag, run);
    const { r, share } = row(tag, `${label}: open loop ${rate} req/s for ${STEP_S} s against one function, x-region ${REGION}`, run, rate);
    out.push(r);
    ctx.log(`${tag}: ${r.detail}`);
    if (share * 100 > STOP_PCT) {
      stoppedAt = rate;
      break;
    }
  }
  if (stoppedAt) {
    out.push({
      id: `${id}-stop`,
      title: `${label}: ramp stopped by the ${STOP_PCT} % non-200 rule`,
      status: "info",
      detail: `non-200 share above ${STOP_PCT} % at ${stoppedAt} req/s; higher rates not run`,
      measurements: { stopped_at_rps: stoppedAt, stop_pct: STOP_PCT },
    });
  }

  await sleep(BURST_REST_S * 1000);
  ctx.log(`${id} ${label}: burst of ${BURST_N} through ${BURST_LANES} sockets`);
  const b = await burst({ n: BURST_N, maxInFlight: BURST_LANES, fire });
  await writeRaw(`${id}-burst`, b);
  const { r } = row(`${id}-burst`, `${label}: ${BURST_N} requests at once through at most ${BURST_LANES} in flight, x-region ${REGION}`, b, 0, BURST_LANES);
  out.push(r);
  ctx.log(`${id}-burst: ${r.detail}`);
  return out;
}
