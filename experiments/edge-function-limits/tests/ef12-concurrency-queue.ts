/**
 * EF12 - concurrency and the queued-request casualty. There is no published
 * per-project or per-function concurrency limit; the platform runs the
 * per_worker policy, so several requests share one isolate and a new isolate
 * spins up when the existing ones are busy. The sharp edge: if one request
 * exhausts the isolate's CPU or memory, the OTHER requests queued on that
 * isolate are cancelled and come back as 546 - a resource-limit code for
 * requests that never got to use a resource.
 *
 *   EF12a  control: N light requests fired concurrently, alone. All should
 *          answer 200 - a light request is nowhere near the CPU ceiling, so
 *          concurrency on its own is not the thing that fails. PASS if every
 *          light request in the control succeeds.
 *   EF12b  N light requests fired concurrently WITH one CPU-exhausting request
 *          in the same burst. Count how many lights come back 546 vs 200. INFO:
 *          co-tenancy ALONE need not cancel the lights - if the runtime has
 *          spare isolates it serves them while the heavy one dies. Measured on
 *          Pro 2026-09-08: heavy 546, all 12 lights 200. So this row records
 *          whether co-tenancy was enough, and usually it is not.
 *   EF12c  a SATURATING burst: many CPU-exhausting requests fired at once, so
 *          the isolate pool cannot give each its own and requests queue on a
 *          dying isolate. Count the 546 rate. This is where the queued-casualty
 *          actually shows - when the heavy concurrency exceeds the isolates the
 *          platform will spin up. INFO with the 546 count and rate.
 *
 * Not settled by this module: how many isolates the platform gave this function
 * (not observable from the client), or whether a 546 was queued-then-cancelled
 * vs assigned to an already-dying isolate - both surface identically as 546
 * (the runtime cannot distinguish them either). EF12c shows the cancellation
 * happens under saturation; it cannot count exactly which requests were
 * casualties vs which exhausted a resource themselves.
 *
 * DESTRUCTIVE: deploys one function under pvlab-ef12-, deletes in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { cleanupPrefix, deployViaApi, invoke, invokeWhenLive } from "../lib/ef";

const P = "pvlab-ef12-";
const LIGHT = 12;

// One function, two modes. `cpu` burns for `ms` of CPU (well past the 2 s
// ceiling when asked); `light` returns immediately.
const SRC = `
Deno.serve((req) => {
  const u = new URL(req.url);
  if (u.searchParams.get("mode") === "cpu") {
    const ms = Number(u.searchParams.get("ms") ?? "5000");
    const t0 = performance.now();
    let x = 0;
    while (performance.now() - t0 < ms) { x = (x * 1103515245 + 12345) % 2147483648; }
    return Response.json({ mode: "cpu", ms, x });
  }
  return Response.json({ ok: true });
});
`;

function classify(results: { status: number; text: string }[]) {
  let ok = 0;
  let r546 = 0;
  let other = 0;
  for (const r of results) {
    if (r.status === 200) ok++;
    else if (r.status === 546 || /WORKER_RESOURCE_LIMIT/.test(r.text)) r546++;
    else other++;
  }
  return { ok, r546, other };
}

const mod: TestModule = {
  id: "EF12",
  title: "Concurrency: a resource-exhausting request takes queued light requests down with it (546)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF12", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    const slug = `${P}burn`;
    try {
      await cleanupPrefix(ctx, P);
      const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: SRC }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
      if (dep.status >= 300) {
        return [{ id: "EF12", title: this.title, status: "fail", detail: `deploy HTTP ${dep.status} "${dep.error}"` }];
      }
      // Warm one isolate and confirm it is live before timing anything.
      await invokeWhenLive(ctx, slug, 90_000, { path: "?mode=light", timeoutMs: 30_000 });

      // EF12a - control: light requests alone.
      const control = await Promise.all(
        Array.from({ length: LIGHT }, () => invoke(ctx, slug, { path: "?mode=light", timeoutMs: 30_000 })),
      );
      const c = classify(control);
      out.push({
        id: "EF12a",
        title: `control: ${LIGHT} light requests fired concurrently, alone`,
        status: c.ok === LIGHT ? "pass" : "fail",
        detail: `200:${c.ok} 546:${c.r546} other:${c.other} - light requests alone should all succeed`,
        measurements: { fired: LIGHT, ok: c.ok, r546: c.r546, other: c.other },
      });

      // EF12b - one CPU-exhausting request in the same burst as the lights.
      const burst = await Promise.all([
        invoke(ctx, slug, { path: "?mode=cpu&ms=8000", timeoutMs: 60_000 }),
        ...Array.from({ length: LIGHT }, () => invoke(ctx, slug, { path: "?mode=light", timeoutMs: 60_000 })),
      ]);
      const heavy = burst[0];
      const lights = classify(burst.slice(1));
      out.push({
        id: "EF12b",
        title: "light requests sharing an isolate with one CPU-exhausting request (co-tenancy alone)",
        status: "info",
        detail: `heavy -> ${heavy?.status ?? "n/a"}; lights 200:${lights.ok} 546:${lights.r546} other:${lights.other} - co-tenancy cancels lights only if there were no spare isolates`,
        measurements: {
          lights_fired: LIGHT,
          heavy_status: heavy?.status ?? 0,
          lights_ok: lights.ok,
          lights_546: lights.r546,
          lights_other: lights.other,
        },
      });

      // EF12c - saturate: many heavies at once so the isolate pool cannot give
      // each its own and requests queue on a dying isolate.
      const HEAVY = 40;
      const flood = await Promise.all(
        Array.from({ length: HEAVY }, () => invoke(ctx, slug, { path: "?mode=cpu&ms=6000", timeoutMs: 90_000 })),
      );
      const f = classify(flood);
      out.push({
        id: "EF12c",
        title: `saturating burst: ${HEAVY} CPU-exhausting requests at once`,
        status: "info",
        detail: `200:${f.ok} 546:${f.r546} other:${f.other} - 546 rate ${Math.round((100 * f.r546) / HEAVY)}% (resource-limit cancellation under isolate-pool saturation)`,
        measurements: { fired: HEAVY, ok: f.ok, r546: f.r546, other: f.other, rate_546_pct: Math.round((100 * f.r546) / HEAVY) },
      });
    } catch (e) {
      out.push({ id: "EF12", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const cl = await cleanupPrefix(ctx, P).catch((e) => ({ deleted: 0, left: [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`] }));
      out.push({
        id: "EF12z",
        title: "cleanup: delete pvlab-ef12-* functions",
        status: cl.left.length ? "fail" : "pass",
        detail: cl.left.length ? `LEFT DEPLOYED: ${cl.left.join(", ")}` : `deleted ${cl.deleted}`,
        measurements: { deleted: cl.deleted, left: cl.left.length },
      });
    }
    return out;
  },
};

export default mod;
