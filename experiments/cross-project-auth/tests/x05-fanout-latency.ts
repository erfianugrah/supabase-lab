/**
 * X05 - what the fan-out costs: merged two-project read vs a single-project
 * read of the same rows, from the client and from an Edge Function on A.
 *
 * SIDE: the X04 pair (lib/fanout.ts), trust already in place. Every cell runs
 * `fanout()` from lib/merge.ts, the same code in Bun (client) and Deno (Edge
 * Function), so the single-project cells pay the same merge and sort cost on
 * one leg.
 *
 *   single  = one leg: A's `fan_all` (the union of both projects' rows), newest 50.
 *   fan-out = two legs in parallel: A's and B's `fan_items`, newest 50 each,
 *             merged by (created_at, id) microsecond-exact, first 50 kept.
 *
 * Cells, interleaved round-robin (one sample of each cell per round, so drift
 * lands on all four equally), WARMUP rounds discarded, then N rounds:
 *   client_single, client_fanout  - measured on the local orchestrator around fanout()
 *   edge_single, edge_fanout      - client round trip to the function on A
 *                                   (`ms`) and the function's own timing (`inner_ms`)
 * Every sample's page is compared with the ground truth's first 50 ids.
 *
 * Connections are warm (keep-alive) in both vantages after the warm-up; these
 * are steady-state numbers, not cold-start ones.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { callFn, currentPair, skipWithoutPro, summary } from "../lib/fanout.js";
import { fanout, pageQuery, type Target } from "../lib/merge.js";

const N = Number(process.env.PVLAB_XF_N || 200);
const WARMUP = 5;
const LIMIT = 50;

const mod: TestModule = {
  id: "X05",
  title: "Fan-out latency: merged two-project read vs single-project read, client and Edge Function",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "X05");
    if (skip) return skip;
    const p = currentPair();
    if (!p || !p.tpaId) return [{ id: "X05", title: this.title, status: "skip", detail: "X04 did not set up the pair and trust in this process" }];

    const single: Target[] = [{ name: "a", url: p.a.url, anon: p.a.anon, table: "fan_all" }];
    const fan: Target[] = [
      { name: "a", url: p.a.url, anon: p.a.anon, table: "fan_items" },
      { name: "b", url: p.b.url, anon: p.b.anon, table: "fan_items" },
    ];
    const qs = pageQuery(LIMIT);
    const truth = p.truth.slice(0, LIMIT).map((r) => r.id).join(",");
    const opts = { policy: "all" as const, timeoutMs: 10_000 };

    type Cell = { ms: number[]; inner: number[]; legA: number[]; legB: number[]; wrong: number; errors: number; regions: Set<string> };
    const mk = (): Cell => ({ ms: [], inner: [], legA: [], legB: [], wrong: 0, errors: 0, regions: new Set() });
    const cells: Record<string, Cell> = { client_single: mk(), client_fanout: mk(), edge_single: mk(), edge_fanout: mk() };

    const t0 = Date.now();
    for (let round = 0; round < WARMUP + N; round++) {
      const keep = round >= WARMUP;
      for (const [name, targets] of [
        ["client_single", single],
        ["client_fanout", fan],
      ] as const) {
        const r = await fanout(targets, p.tokA, qs, LIMIT, opts);
        if (!keep) continue;
        const c = cells[name] as Cell;
        if (!r.ok) {
          c.errors++;
          continue;
        }
        c.ms.push(r.ms);
        const la = r.legs.find((l) => l.name === "a")?.ms;
        const lb = r.legs.find((l) => l.name === "b")?.ms;
        if (la !== undefined) c.legA.push(la);
        if (lb !== undefined) c.legB.push(lb);
        if (r.rows.map((x) => x.id).join(",") !== truth) c.wrong++;
      }
      for (const [name, targets] of [
        ["edge_single", single],
        ["edge_fanout", fan],
      ] as const) {
        const r = await callFn(p.a, p.tokA, { targets, qs, limit: LIMIT, ...opts });
        if (!keep) continue;
        const c = cells[name] as Cell;
        if (!r.ok) {
          c.errors++;
          continue;
        }
        c.ms.push(r.ms);
        c.inner.push(r.inner_ms);
        c.regions.add(`${r.region || "?"}/${r.servedBy || "?"}`);
        const la = r.legs.find((l) => l.name === "a")?.ms;
        const lb = r.legs.find((l) => l.name === "b")?.ms;
        if (la !== undefined) c.legA.push(la);
        if (lb !== undefined) c.legB.push(lb);
        if (r.rows.map((x) => x.id).join(",") !== truth) c.wrong++;
      }
    }
    const wallS = Math.round((Date.now() - t0) / 1000);

    const out: TestResult[] = [];
    for (const [name, c] of Object.entries(cells)) {
      const edge = name.startsWith("edge");
      out.push({
        id: `X05-${name}`,
        title: `${name}: ${name.endsWith("single") ? "one leg, A fan_all" : "two legs, A + B fan_items, merged"}${edge ? " (Edge Function on A)" : " (local client)"}`,
        status: c.errors === 0 && c.wrong === 0 && c.ms.length === N ? "info" : "fail",
        detail: `n=${c.ms.length}, p50 ${summary("", c.ms).p50_ms} ms, p95 ${summary("", c.ms).p95_ms} ms, p99 ${summary("", c.ms).p99_ms} ms; wrong pages ${c.wrong}, errors ${c.errors}${edge ? `; region/edge ${[...c.regions].join(" ")}` : ""}`,
        measurements: {
          ...summary("", c.ms),
          ...(edge ? summary("inner_", c.inner) : {}),
          ...summary("leg_a_", c.legA),
          ...(c.legB.length ? summary("leg_b_", c.legB) : {}),
          wrong_pages: c.wrong,
          errors: c.errors,
          warmup_rounds: WARMUP,
          ...(edge ? { region_edge: [...c.regions].join(" ") } : {}),
        },
      });
    }
    out.push({ id: "X05z", title: "Run shape", status: "info", detail: `${N} rounds x 4 cells interleaved, ${wallS} s wall`, measurements: { rounds: N, wall_s: wallS, page_size: LIMIT } });
    return out;
  },
};
export default mod;
