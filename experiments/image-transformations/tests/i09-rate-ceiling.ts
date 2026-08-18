/**
 * I09 - where does the render endpoint start refusing? Waves of parallel
 * fresh renders (each a distinct width, so each a cold render, not a cache
 * hit). 200 parallel was clean in the ad-hoc probe; this finds the ceiling
 * and whether refusal is per-IP (this vantage) or per-project. Destructive:
 * it deliberately pushes the endpoint hard, so it only runs under
 * --destructive. A measured fail is data.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { storageBase } from "../lib";

async function wave(ctx: Ctx, n: number, widthBase: number): Promise<{ ok: number; statuses: Record<string, number> }> {
  const B = storageBase(ctx);
  const statuses: Record<string, number> = {};
  let ok = 0;
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      try {
        const res = await fetch(`${B}/render/image/public/pub/small.png?width=${widthBase + i}`);
        await res.arrayBuffer();
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        if (res.status === 200) ok++;
      } catch {
        statuses["fetch-error"] = (statuses["fetch-error"] ?? 0) + 1;
      }
    }),
  );
  return { ok, statuses };
}

const mod: TestModule = {
  id: "I09",
  title: "Render endpoint rate ceiling",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    let widthBase = 1100;
    for (const n of [500, 1000, 2000]) {
      const { ok, statuses } = await wave(ctx, n, widthBase);
      widthBase += n;
      out.push({
        id: `I09-wave-${n}`,
        title: `${n} parallel fresh renders`,
        status: ok === n ? "pass" : "info",
        measurements: {
          ok,
          ...Object.fromEntries(Object.entries(statuses).map(([k, v]) => [`status_${k}`, v])),
        },
      });
      // if the endpoint is already refusing, bigger waves add no information
      if (ok < n * 0.95) break;
    }
    return out;
  },
};
export default mod;
