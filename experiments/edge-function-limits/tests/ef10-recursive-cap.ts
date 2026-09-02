/**
 * EF10 - the recursive-call cap, "~5000 requests per minute".
 *
 * A function that calls itself (or another function) through the project's
 * own /functions/v1 URL. The docs put a cap of about 5000 such requests per
 * minute with no error shape given. This module drives nested calls hard for
 * one minute and records what, if anything, refuses them and how.
 *
 *   EF10a  control: one chain at depth 2 (three invocations, two nested) -> 200
 *   EF10b  one minute at concurrency 100, depth 2: chains attempted, nested
 *          calls implied, status histogram of the outer and inner responses,
 *          first non-200 body verbatim, and the minute's achieved rate
 *
 * The function reports the inner status it received so a refusal at depth is
 * visible from the outside. DESTRUCTIVE: deploys one function under
 * pvlab-ef10-, deletes in finally. Costs on the order of 180,000 invocations
 * at concurrency 100 (59,562 chains x 3 on 2026-09-02).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { RUNTIME } from "../lib/docs";
import { cleanupPrefix, deployViaApi, invoke, invokeWhenLive } from "../lib/ef";

const P = "pvlab-ef10-";
const CONCURRENCY = 100;
const WINDOW_MS = 60_000;
const DEPTH = 2;

const SRC = `
Deno.serve(async (req) => {
  const u = new URL(req.url);
  const depth = Number(u.searchParams.get("depth") ?? "0");
  if (depth <= 0) return Response.json({ depth, inner: null });
  const self = Deno.env.get("SUPABASE_URL") + "/functions/v1/${P}recurse?depth=" + (depth - 1);
  const key = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  try {
    const r = await fetch(self, { headers: { apikey: key, Authorization: "Bearer " + key } });
    const text = await r.text();
    return Response.json({ depth, inner: r.status, innerBody: r.status === 200 ? undefined : text.slice(0, 160) });
  } catch (e) {
    return Response.json({ depth, inner: 0, innerBody: String(e).slice(0, 160) });
  }
});
`;

function histogram(values: (number | string)[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, n]) => `${k}:${n}`).join("|") || "none";
}

const mod: TestModule = {
  id: "EF10",
  title: "Recursive-call cap: one minute of nested invocations at concurrency 100",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF10", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    const slug = `${P}recurse`;
    try {
      await cleanupPrefix(ctx, P);
      const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: SRC }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
      if (dep.status >= 300) return [{ id: "EF10", title: this.title, status: "fail", detail: `deploy HTTP ${dep.status} "${dep.error}"` }];

      // EF10a - control chain.
      const ctrl = await invokeWhenLive(ctx, slug, 90_000, { path: `?depth=${DEPTH}`, timeoutMs: 30_000 });
      let inner: unknown = "?";
      try {
        inner = (JSON.parse(ctrl.text) as { inner?: unknown }).inner;
      } catch {
        inner = "unparsed";
      }
      out.push({
        id: "EF10a",
        title: `control: one chain at depth ${DEPTH}`,
        status: ctrl.status === 200 && inner === 200 ? "pass" : "fail",
        detail: `outer ${ctrl.status}, inner ${String(inner)}, ${ctrl.ms} ms`,
        measurements: { outer_status: ctrl.status, inner_status: String(inner), ms: ctrl.ms },
      });
      if (ctrl.status !== 200) return out;

      // EF10b - one minute at concurrency.
      const outer: number[] = [];
      const innerStatuses: (number | string)[] = [];
      let firstNon200 = "";
      const t0 = Date.now();
      const worker = async () => {
        while (Date.now() - t0 < WINDOW_MS) {
          const r = await invoke(ctx, slug, { path: `?depth=${DEPTH}`, timeoutMs: 30_000 });
          outer.push(r.status);
          let innerS: number | string = "?";
          let innerBody = "";
          try {
            const j = JSON.parse(r.text) as { inner?: number; innerBody?: string };
            innerS = j.inner ?? "?";
            innerBody = j.innerBody ?? "";
          } catch {
            innerS = r.status === 200 ? "unparsed" : r.status;
          }
          innerStatuses.push(innerS);
          if (!firstNon200 && (r.status !== 200 || innerS !== 200)) {
            firstNon200 = r.status !== 200 ? `outer ${r.status}: ${(r.text || r.error || "").slice(0, 200)}` : `inner ${String(innerS)}: ${innerBody.slice(0, 200)}`;
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      const elapsedS = (Date.now() - t0) / 1000;
      const chains = outer.length;
      const nestedCalls = chains * DEPTH;
      const outerOk = outer.filter((s) => s === 200).length;
      const innerOk = innerStatuses.filter((s) => s === 200).length;
      const refused = chains - Math.min(outerOk, innerOk);
      out.push({
        id: "EF10b",
        title: `one minute at concurrency ${CONCURRENCY}, depth ${DEPTH}`,
        status: "info",
        detail:
          `${chains} chains in ${elapsedS.toFixed(0)} s = ${Math.round((nestedCalls / elapsedS) * 60)} nested calls/min (docs cap ~${RUNTIME.recursiveRequestsPerMinute}); ` +
          `outer ${histogram(outer)}; inner ${histogram(innerStatuses)}` +
          (firstNon200 ? `; first refusal: ${firstNon200}` : "; no refusal seen"),
        measurements: {
          concurrency: CONCURRENCY,
          depth: DEPTH,
          chains,
          nested_calls: nestedCalls,
          nested_per_minute: Math.round((nestedCalls / elapsedS) * 60),
          docs_cap_per_minute: RUNTIME.recursiveRequestsPerMinute,
          outer_histogram: histogram(outer),
          inner_histogram: histogram(innerStatuses),
          refused_chains: refused,
          first_refusal: firstNon200 || "none",
        },
      });
    } catch (e) {
      out.push({ id: "EF10", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const c = await cleanupPrefix(ctx, P).catch((e) => ({ deleted: 0, left: [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`] }));
      out.push({ id: "EF10z", title: "cleanup: delete pvlab-ef10-* functions", status: c.left.length ? "fail" : "pass", detail: c.left.length ? `LEFT DEPLOYED: ${c.left.join(", ")}` : `deleted ${c.deleted}`, measurements: { deleted: c.deleted, left: c.left.length } });
    }
    return out;
  },
};
export default mod;
