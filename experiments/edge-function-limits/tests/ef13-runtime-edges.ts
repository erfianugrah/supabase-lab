/**
 * EF13 - the CPU and memory ceilings measured to the edge.
 *
 * EF07 showed a 500 ms busy loop and a 64 MB allocation answer, and 3 s and
 * 400 MB do not; the docs put the limits at 2 s CPU per request and 256 MB.
 * This module walks a ladder of rungs either side of each documented figure,
 * three requests per rung, and records the highest rung where every request
 * answered and the lowest where none did, with the over-limit status and
 * body verbatim.
 *
 *   EF13a  CPU: a busy loop of N ms (wall time inside a tight loop, which on
 *          an unloaded isolate is CPU time), N on the CPU ladder below
 *   EF13b  memory, ArrayBuffer: N chunks of 1 MiB Uint8Array, each filled so
 *          the pages are touched (counted by V8 as external memory)
 *   EF13c  memory, JS heap: N chunks of 131,072 doubles in a plain array
 *          (about 1 MiB each on the V8 heap)
 *
 * Every response carries the isolate's id, how many requests it had served
 * and its accumulated busy-loop ms, because the docs describe soft and hard
 * CPU limits per isolate (https://supabase.com/docs/guides/troubleshooting/
 * edge-function-cpu-limits): a rung that fails only on a warm isolate is a
 * different finding from one that fails on a fresh one. Successful memory
 * responses carry Deno.memoryUsage() so the runtime's own baseline is in the
 * artifact next to the allocated MiB.
 *
 * DESTRUCTIVE: deploys one function under pvlab-ef13-, deletes in finally.
 * About 100 requests, a few minutes.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { RUNTIME } from "../lib/docs";
import { cleanupPrefix, deployViaApi, invoke, invokeWhenLive, projectPlan } from "../lib/ef";

const P = "pvlab-ef13-";
const REPS = 3;
const CPU_LADDER_MS = [1000, 1500, 1750, 1900, 1950, 2000, 2050, 2100, 2250, 2500, 3000];
const MEM_LADDER_MB = [128, 160, 192, 208, 224, 240, 248, 256, 264, 272, 288, 320, 400];

const SRC = `
const WID = crypto.randomUUID().slice(0, 8);
const BOOT = Date.now();
let served = 0;
let busyTotal = 0;
function usage() {
  try {
    const m = Deno.memoryUsage();
    return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external };
  } catch (e) {
    return { error: String(e).slice(0, 80) };
  }
}
Deno.serve((req) => {
  served++;
  const u = new URL(req.url);
  const mode = u.searchParams.get("mode") ?? "cpu";
  const iso = { wid: WID, served, age_ms: Date.now() - BOOT };
  if (mode === "cpu") {
    const ms = Number(u.searchParams.get("ms") ?? "100");
    const t0 = performance.now();
    let x = 0;
    while (performance.now() - t0 < ms) { x = (x * 1103515245 + 12345) % 2147483648; }
    const elapsed = Math.round(performance.now() - t0);
    busyTotal += elapsed;
    return Response.json({ mode, ms, elapsed, busy_total_ms: busyTotal, x, ...iso });
  }
  const mb = Number(u.searchParams.get("mb") ?? "16");
  const t0 = performance.now();
  if (mode === "buf") {
    const chunks = [];
    for (let i = 0; i < mb; i++) { const c = new Uint8Array(1024 * 1024); c.fill((i % 250) + 1); chunks.push(c); }
    const mem = usage();
    return Response.json({ mode, mb, allocated: chunks.length, check: chunks[chunks.length - 1][7], alloc_ms: Math.round(performance.now() - t0), mem, ...iso });
  }
  const chunks = [];
  for (let i = 0; i < mb; i++) { const a = new Array(131072); for (let j = 0; j < 131072; j++) a[j] = j + 0.5 + i; chunks.push(a); }
  const mem = usage();
  return Response.json({ mode, mb, allocated: chunks.length, check: chunks[chunks.length - 1][7], alloc_ms: Math.round(performance.now() - t0), mem, ...iso });
});
`;

interface Shot {
  rung: number;
  rep: number;
  status: number;
  ok: boolean;
  ms: number;
  body: string;
  wid: string;
  served: number;
  busyTotalMs: number;
  elapsedMs: number;
  mem: string;
}

async function shoot(ctx: Ctx, slug: string, mode: string, rung: number, rep: number): Promise<Shot> {
  const q = mode === "cpu" ? `?mode=cpu&ms=${rung}` : `?mode=${mode}&mb=${rung}`;
  const r = await invoke(ctx, slug, { path: q, timeoutMs: 60_000 });
  let j: Record<string, unknown> | undefined;
  try {
    j = JSON.parse(r.text) as Record<string, unknown>;
  } catch {
    j = undefined;
  }
  const ok = r.status === 200 && j !== undefined && (mode === "cpu" ? typeof j.elapsed === "number" : j.allocated === rung);
  const mem = j?.mem as Record<string, number> | undefined;
  return {
    rung,
    rep,
    status: r.status,
    ok,
    ms: r.ms,
    body: ok ? "" : (r.text || r.error || "").trim().slice(0, 200),
    wid: String(j?.wid ?? ""),
    served: Number(j?.served ?? 0),
    busyTotalMs: Number(j?.busy_total_ms ?? 0),
    elapsedMs: Number(j?.elapsed ?? j?.alloc_ms ?? 0),
    mem: mem && typeof mem.heapUsed === "number" ? `rss ${Math.round((mem.rss ?? 0) / 1048576)} heap ${Math.round(mem.heapUsed / 1048576)} ext ${Math.round((mem.external ?? 0) / 1048576)} MiB` : "",
  };
}

/** Walk the ladder REPS times, ascending each time, and summarise per rung. */
async function ladder(ctx: Ctx, slug: string, mode: string, rungs: number[]): Promise<{ shots: Shot[]; result: Record<string, string | number> }> {
  const shots: Shot[] = [];
  for (let rep = 1; rep <= REPS; rep++) {
    for (const rung of rungs) {
      shots.push(await shoot(ctx, slug, mode, rung, rep));
      await Bun.sleep(1_000);
    }
  }
  const m: Record<string, string | number> = {};
  let highestAllPass = -1;
  let lowestAllFail = -1;
  const mixed: number[] = [];
  for (const rung of rungs) {
    const at = shots.filter((s) => s.rung === rung);
    const okN = at.filter((s) => s.ok).length;
    m[`rung_${rung}`] = `${okN}/${at.length} ok; ${at.map((s) => s.status).join(",")}`;
    if (okN === at.length) highestAllPass = rung;
    if (okN === 0 && lowestAllFail < 0) lowestAllFail = rung;
    if (okN > 0 && okN < at.length) mixed.push(rung);
  }
  // Lowest rung where every request failed AND every rung above it also failed.
  let edgeFail = -1;
  for (let i = rungs.length - 1; i >= 0; i--) {
    const rung = rungs[i] ?? -1;
    const at = shots.filter((s) => s.rung === rung);
    if (at.every((s) => !s.ok)) edgeFail = rung;
    else break;
  }
  // Highest rung where every request passed AND every rung below it also passed.
  let edgePass = -1;
  for (const rung of rungs) {
    const at = shots.filter((s) => s.rung === rung);
    if (at.every((s) => s.ok)) edgePass = rung;
    else break;
  }
  const firstFail = shots.find((s) => !s.ok);
  m.reps_per_rung = REPS;
  m.highest_rung_all_ok_contiguous = edgePass;
  m.lowest_rung_all_failed_contiguous = edgeFail;
  m.highest_rung_all_ok_any = highestAllPass;
  m.lowest_rung_all_failed_any = lowestAllFail;
  m.mixed_rungs = mixed.join(",") || "none";
  m.over_status = firstFail ? firstFail.status : "none";
  m.over_body = firstFail ? firstFail.body : "none";
  const distinct = [...new Set(shots.filter((s) => !s.ok).map((s) => `${s.status} ${s.body}`))];
  m.over_bodies_distinct = distinct.length;
  // Every distinct refusal verbatim: the 2026-10-23 Free run had one 503 among
  // the 546s and only the count of distinct bodies was recorded.
  m.over_bodies = distinct.map((b) => b.slice(0, 160)).join(" || ") || "none";
  return { shots, result: m };
}

function shotLog(shots: Shot[]): string {
  return shots
    .map((s) => `${s.rung}#${s.rep}:${s.status}${s.ok ? "" : "x"} ${s.wid}/${s.served}${s.busyTotalMs ? `/busy${s.busyTotalMs}` : ""}${s.mem ? ` (${s.mem})` : ""} ${s.ms}ms`)
    .join("; ");
}

const mod: TestModule = {
  id: "EF13",
  title: "Runtime ceilings to the edge: CPU-time and memory ladders, n=3 per rung",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF13", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    const slug = `${P}burn`;
    try {
      await cleanupPrefix(ctx, P);
      const plan = await projectPlan(ctx);
      const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: SRC }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
      if (dep.status >= 300) return [{ id: "EF13", title: this.title, status: "fail", detail: `deploy HTTP ${dep.status} "${dep.error}"` }];
      const live = await invokeWhenLive(ctx, slug, 90_000, { path: "?mode=cpu&ms=10", timeoutMs: 30_000 });
      if (live.status !== 200) return [{ id: "EF13", title: this.title, status: "fail", detail: `function not live: ${live.status}` }];

      const rows: [string, string, string, number[], number][] = [
        ["EF13a", "cpu", "CPU busy loop, ms", CPU_LADDER_MS, RUNTIME.cpuMs],
        ["EF13b", "buf", "memory, ArrayBuffer MiB", MEM_LADDER_MB, RUNTIME.memoryMb],
        ["EF13c", "heap", "memory, JS heap MiB", MEM_LADDER_MB, RUNTIME.memoryMb],
      ];
      for (const [id, mode, label, rungs, docs] of rows) {
        const { shots, result } = await ladder(ctx, slug, mode, rungs);
        const pass = Number(result.highest_rung_all_ok_contiguous);
        const fail = Number(result.lowest_rung_all_failed_contiguous);
        out.push({
          id,
          title: `${label}: ladder ${rungs[0]}-${rungs[rungs.length - 1]}, ${REPS} per rung (docs ${docs})`,
          status: "info",
          detail: `all ok up to ${pass}, all failed from ${fail}, mixed ${result.mixed_rungs}; first refusal ${result.over_status} ${result.over_body}`,
          measurements: { plan, docs_figure: docs, ...result, shots: shotLog(shots) },
        });
      }
    } catch (e) {
      out.push({ id: "EF13", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const c = await cleanupPrefix(ctx, P).catch((e) => ({ deleted: 0, left: [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`] }));
      out.push({ id: "EF13z", title: "cleanup: delete pvlab-ef13-* functions", status: c.left.length ? "fail" : "pass", detail: c.left.length ? `LEFT DEPLOYED: ${c.left.join(", ")}` : `deleted ${c.deleted}`, measurements: { deleted: c.deleted, left: c.left.length } });
    }
    return out;
  },
};
export default mod;
