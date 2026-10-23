/**
 * EF09 - the wall-clock ceiling, measured on an ACTIVE request.
 *
 * edge-resilience W13 measured the 150 s idle timeout (504 IDLE_TIMEOUT) with
 * a sleeper that sent nothing. The docs also give a wall-clock limit of 150 s
 * on Free and 400 s on paid plans, and the idle probe cannot reach it because
 * idleness kills the request first. This module streams a byte every 5 s so
 * the connection is never idle, asks for 450 s, and records where the stream
 * actually ends.
 *
 *   EF09a   control: 30 s stream completes (ticks received, clean end)
 *   EF09b1-3  450 s stream, three times in a row: last tick time, how the body
 *           ended (clean close, reset, HTTP error), and which plan's figure the
 *           cut sits near. The plan is read from the Management API, so the
 *           same module measures a Free project and a paid one.
 *
 * Since 2026-10-23 the function stamps every stream with a per-isolate id and
 * the isolate's age when the request arrived. The docs define the figure as
 * how long a WORKER stays active, so a request that lands on a warm worker
 * should be cut sooner into itself; age + last tick is the worker's life at
 * the cut, and that is the number to compare with the docs.
 *
 * DESTRUCTIVE: deploys one function under pvlab-ef09-, deletes in finally.
 * Takes about 21 minutes on a paid project and 8 on Free.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { RUNTIME } from "../lib/docs";
import { cleanupPrefix, deployViaApi, invokeWhenLive, projectPlan } from "../lib/ef";

const P = "pvlab-ef09-";
const TICK_S = 5;
const REPS = 3;

const SRC = `
const WID = crypto.randomUUID().slice(0, 8);
const BOOT = Date.now();
Deno.serve((req) => {
  const s = Number(new URL(req.url).searchParams.get("s") ?? "30");
  const enc = new TextEncoder();
  let n = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode("start " + WID + " " + (Date.now() - BOOT) + "\\n"));
      const id = setInterval(() => {
        n += ${TICK_S};
        controller.enqueue(enc.encode("tick " + n + "\\n"));
        if (n >= s) { clearInterval(id); controller.enqueue(enc.encode("end\\n")); controller.close(); }
      }, ${TICK_S * 1000});
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/plain" } });
});
`;

interface StreamResult {
  status: number;
  ticks: number;
  lastTickS: number;
  elapsedS: number;
  ended: "clean" | "error" | "timeout" | "http-error";
  error: string;
  /** Per-isolate id stamped by the function, and the isolate's age in ms when the request arrived. */
  workerId: string;
  workerAgeMs: number;
}

async function stream(ctx: Ctx, slug: string, seconds: number, budgetMs: number): Promise<StreamResult> {
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budgetMs);
  let ticks = 0;
  let lastTickS = 0;
  let sawEnd = false;
  let workerId = "";
  let workerAgeMs = -1;
  try {
    const res = await fetch(`https://${ctx.apiHost}/functions/v1/${slug}?s=${seconds}`, {
      headers: ctx.anonKey ? { apikey: ctx.anonKey, Authorization: `Bearer ${ctx.anonKey}` } : {},
      signal: ctl.signal,
    });
    if (res.status !== 200 || !res.body) {
      const text = await res.text().catch(() => "");
      return { status: res.status, ticks: 0, lastTickS: 0, elapsedS: Math.round((performance.now() - t0) / 1000), ended: "http-error", error: text.slice(0, 200), workerId, workerAgeMs };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith("tick ")) {
          ticks++;
          lastTickS = Math.round((performance.now() - t0) / 1000);
        }
        if (line === "end") sawEnd = true;
        if (line.startsWith("start ")) {
          const [, id, age] = line.split(" ");
          workerId = id ?? "";
          workerAgeMs = Number(age ?? -1);
        }
      }
    }
    return { status: 200, ticks, lastTickS, elapsedS: Math.round((performance.now() - t0) / 1000), ended: sawEnd ? "clean" : "error", error: sawEnd ? "" : "body ended without the end marker", workerId, workerAgeMs };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: 200,
      ticks,
      lastTickS,
      elapsedS: Math.round((performance.now() - t0) / 1000),
      ended: ctl.signal.aborted ? "timeout" : "error",
      error: msg.slice(0, 200),
      workerId,
      workerAgeMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

const mod: TestModule = {
  id: "EF09",
  title: "Wall clock on an active (streaming) request",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF09", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    const slug = `${P}stream`;
    try {
      await cleanupPrefix(ctx, P);
      const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: SRC }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
      if (dep.status >= 300) return [{ id: "EF09", title: this.title, status: "fail", detail: `deploy HTTP ${dep.status} "${dep.error}"` }];
      const live = await invokeWhenLive(ctx, slug, 90_000, { path: "?s=5", timeoutMs: 30_000 });
      if (live.status !== 200) return [{ id: "EF09", title: this.title, status: "fail", detail: `function not live: ${live.status}` }];

      const plan = await projectPlan(ctx);
      const docsFigure = plan === "free" ? RUNTIME.wallClockS.free : RUNTIME.wallClockS.paid;

      // EF09a - control.
      const a = await stream(ctx, slug, 30, 90_000);
      out.push({
        id: "EF09a",
        title: "30 s stream completes",
        status: a.ended === "clean" && a.ticks >= 5 ? "pass" : "fail",
        detail: `${a.ticks} ticks, last at ${a.lastTickS} s, ended ${a.ended}${a.error ? ` (${a.error})` : ""}; plan ${plan}`,
        measurements: { plan, ticks: a.ticks, last_tick_s: a.lastTickS, elapsed_s: a.elapsedS, ended: a.ended, worker_id: a.workerId || "none", worker_age_at_start_ms: a.workerAgeMs },
      });

      // EF09b1..3 - past the documented ceiling for this plan, three times in a row.
      for (let rep = 1; rep <= REPS; rep++) {
        const b = await stream(ctx, slug, 450, 480_000);
        const nearPaid = Math.abs(b.lastTickS - RUNTIME.wallClockS.paid) <= 15;
        const nearFree = Math.abs(b.lastTickS - RUNTIME.wallClockS.free) <= 15;
        const workerLifeS = b.workerAgeMs >= 0 ? Math.round(b.workerAgeMs / 1000) + b.lastTickS : -1;
        out.push({
          id: `EF09b${rep}`,
          title: `450 s stream #${rep}: where the request is cut (${plan})`,
          status: b.ended !== "clean" ? "pass" : "info",
          detail:
            b.ended === "clean"
              ? `stream ran to completion (${b.ticks} ticks, ${b.elapsedS} s) - no wall-clock cut below 450 s observed`
              : `cut after ${b.lastTickS} s (${b.ticks} ticks), body ended by ${b.ended}${b.error ? ` "${b.error}"` : ""}; worker ${b.workerId || "?"} was ${b.workerAgeMs} ms old at the request${nearPaid ? " - within 15 s of the documented paid figure" : nearFree ? " - within 15 s of the documented FREE figure" : ""}`,
          measurements: {
            plan,
            docs_wall_clock_s: docsFigure,
            docs_wall_clock_paid_s: RUNTIME.wallClockS.paid,
            docs_wall_clock_free_s: RUNTIME.wallClockS.free,
            ticks: b.ticks,
            last_tick_s: b.lastTickS,
            elapsed_s: b.elapsedS,
            ended: b.ended,
            error: b.error || "none",
            worker_id: b.workerId || "none",
            worker_age_at_start_ms: b.workerAgeMs,
            worker_life_at_last_tick_s: workerLifeS,
            near_paid_figure: nearPaid ? 1 : 0,
            near_free_figure: nearFree ? 1 : 0,
          },
        });
      }
    } catch (e) {
      out.push({ id: "EF09", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const c = await cleanupPrefix(ctx, P).catch((e) => ({ deleted: 0, left: [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`] }));
      out.push({ id: "EF09z", title: "cleanup: delete pvlab-ef09-* functions", status: c.left.length ? "fail" : "pass", detail: c.left.length ? `LEFT DEPLOYED: ${c.left.join(", ")}` : `deleted ${c.deleted}`, measurements: { deleted: c.deleted, left: c.left.length } });
    }
    return out;
  },
};
export default mod;
