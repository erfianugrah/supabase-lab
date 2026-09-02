/**
 * EF07 - runtime ceilings, for completeness: these are invocation-time
 * limits and a separate conversation from anything about deploys.
 *
 *   EF07a  CPU time: a 500 ms busy loop answers; a 3 s one does not (docs: 2 s
 *          CPU per request, async I/O excluded)
 *   EF07b  memory: 64 MB allocates; 400 MB does not (docs: 256 MB)
 *   EF07c  wall clock / idle timeout - NOT re-measured here; the sibling
 *          edge-resilience W13 measured 504 IDLE_TIMEOUT at 150 s and W18 the
 *          cold-start shape. Recorded as a pointer so the report is complete.
 *
 * The over-limit response is recorded verbatim (status + body), because the
 * runtime's own code for it is what a customer will quote.
 *
 * DESTRUCTIVE: deploys one function under pvlab-ef07-, deletes in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { RUNTIME } from "../lib/docs";
import { cleanupPrefix, deployViaApi, invokeWhenLive } from "../lib/ef";

const P = "pvlab-ef07-";

const BURN_SRC = `
Deno.serve((req) => {
  const u = new URL(req.url);
  const mode = u.searchParams.get("mode") ?? "cpu";
  if (mode === "cpu") {
    const ms = Number(u.searchParams.get("ms") ?? "100");
    const t0 = performance.now();
    let x = 0;
    while (performance.now() - t0 < ms) { x = (x * 1103515245 + 12345) % 2147483648; }
    return Response.json({ mode, ms, elapsed: Math.round(performance.now() - t0), x });
  }
  const mb = Number(u.searchParams.get("mb") ?? "16");
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < mb; i++) { const c = new Uint8Array(1024 * 1024); c.fill(i & 255); chunks.push(c); }
  return Response.json({ mode, mb, allocated: chunks.length, sample: chunks[chunks.length - 1]?.[7] ?? -1 });
});
`;

const mod: TestModule = {
  id: "EF07",
  title: "Runtime ceilings: CPU time and memory at invocation",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF07", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    const slug = `${P}burn`;
    try {
      await cleanupPrefix(ctx, P);
      const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: BURN_SRC }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
      if (dep.status >= 300) {
        out.push({ id: "EF07", title: this.title, status: "fail", detail: `deploy HTTP ${dep.status} "${dep.error}"` });
        return out;
      }
      const hit = (path: string) => invokeWhenLive(ctx, slug, 90_000, { path, timeoutMs: 120_000 });

      // EF07a - CPU.
      const cpuControl = await hit("?mode=cpu&ms=500");
      const cpuOver = await hit(`?mode=cpu&ms=${RUNTIME.cpuMs + 1000}`);
      out.push({
        id: "EF07a",
        title: `CPU time: ${RUNTIME.cpuMs} ms per request`,
        status: cpuControl.status === 200 && cpuOver.status !== 200 ? "pass" : "fail",
        detail: `500 ms -> ${cpuControl.status}; ${RUNTIME.cpuMs + 1000} ms -> ${cpuOver.status} ${cpuOver.text.trim().slice(0, 160) || cpuOver.error || ""}`,
        measurements: {
          docs_cpu_ms: RUNTIME.cpuMs,
          control_status: cpuControl.status,
          control_ms: cpuControl.ms,
          over_status: cpuOver.status,
          over_ms: cpuOver.ms,
          over_body: cpuOver.text.trim().slice(0, 120) || cpuOver.error || "none",
        },
      });

      // EF07b - memory. A worker killed by the CPU probe may need a moment; poll through 404/0.
      const memControl = await hit("?mode=mem&mb=64");
      const memOver = await hit("?mode=mem&mb=400");
      out.push({
        id: "EF07b",
        title: `memory: ${RUNTIME.memoryMb} MB`,
        status: memControl.status === 200 && memOver.status !== 200 ? "pass" : "fail",
        detail: `64 MB -> ${memControl.status}; 400 MB -> ${memOver.status} ${memOver.text.trim().slice(0, 160) || memOver.error || ""}`,
        measurements: {
          docs_memory_mb: RUNTIME.memoryMb,
          control_status: memControl.status,
          control_ms: memControl.ms,
          over_status: memOver.status,
          over_ms: memOver.ms,
          over_body: memOver.text.trim().slice(0, 120) || memOver.error || "none",
        },
      });

      out.push({
        id: "EF07c",
        title: "wall clock and idle timeout",
        status: "info",
        detail: `not re-measured here - edge-resilience W13 measured the ${RUNTIME.idleTimeoutS} s idle timeout (504 IDLE_TIMEOUT); docs: wall clock ${RUNTIME.wallClockS.free} s free / ${RUNTIME.wallClockS.paid} s paid, recursive calls ~${RUNTIME.recursiveRequestsPerMinute}/min`,
        measurements: {
          docs_idle_timeout_s: RUNTIME.idleTimeoutS,
          docs_wall_clock_free_s: RUNTIME.wallClockS.free,
          docs_wall_clock_paid_s: RUNTIME.wallClockS.paid,
          docs_recursive_per_minute: RUNTIME.recursiveRequestsPerMinute,
          measured_in: "edge-resilience/W13",
        },
      });
    } catch (e) {
      out.push({ id: "EF07", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const c = await cleanupPrefix(ctx, P).catch((e) => ({ deleted: 0, left: [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`] }));
      out.push({
        id: "EF07z",
        title: "cleanup: delete pvlab-ef07-* functions",
        status: c.left.length ? "fail" : "pass",
        detail: c.left.length ? `LEFT DEPLOYED: ${c.left.join(", ")}` : `deleted ${c.deleted}`,
        measurements: { deleted: c.deleted, left: c.left.length },
      });
    }
    return out;
  },
};
export default mod;
