/**
 * L02 - which Management API endpoints and burst shapes get the edge's HTML
 * page instead of the API's JSON 429 (work-supabase-lab#42).
 *
 * L01c burst one cheap scoped read serially and met the JSON throttler at
 * request 118 (`retry-after: 60`). Earlier experiments met an HTML page on
 * aggressive polling instead. This module runs a matrix: five read-only GET
 * endpoints x three shapes (serial, 20 in parallel, 150 at once), each cell
 * until the first non-2xx (the spike sends all 150 regardless), and records
 * the status, the body class (`lib/burst.ts`), `retry-after`, and whether the
 * endpoint answers 2xx again after a 65 s cooldown.
 *
 * DESTRUCTIVE in the L01 sense: it exhausts the PAT's rate budget ~15 times
 * over about 20 minutes. Nothing on any project changes. Do not run anything
 * else with the same token meanwhile. Project-scoped rows read
 * ctx.peers.scoped (PVLAB_PEER_SCOPED), else the run's own ref, and skip
 * without one. Only non-2xx bodies are kept (a 2xx body names projects).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmtBase } from "../../../harness/src/mgmt";
import { SHAPES, summariseCell, type Sample, type Shape } from "../lib/burst";

const COOLDOWN_MS = 65_000;
const RECOVER_MAX_MS = 120_000;

interface Target {
  key: string;
  path: (ref: string) => string;
  needsRef: boolean;
}

const TARGETS: Target[] = [
  { key: "projects_list", path: () => "/projects", needsRef: false },
  { key: "orgs_list", path: () => "/organizations", needsRef: false },
  { key: "project_get", path: (r) => `/projects/${r}`, needsRef: true },
  { key: "functions_list", path: (r) => `/projects/${r}/functions`, needsRef: true },
  { key: "health", path: (r) => `/projects/${r}/health?services=rest`, needsRef: true },
];

async function fire(ctx: Ctx, url: string, n: number): Promise<Sample> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ctx.pat}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const ok = res.status >= 200 && res.status < 300;
    return {
      n,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      retryAfter: res.headers.get("retry-after") ?? "",
      rateLimitRemaining: res.headers.get("x-ratelimit-remaining") ?? "",
      body: ok ? "" : text.slice(0, 200),
    };
  } catch (e) {
    return { n, status: 0, contentType: "", retryAfter: "", rateLimitRemaining: "", body: e instanceof Error ? e.name : String(e) };
  }
}

async function runCell(ctx: Ctx, url: string, shape: Shape): Promise<Sample[]> {
  const { max, concurrency, stopOnFirstNon2xx } = SHAPES[shape];
  const samples: Sample[] = [];
  let issued = 0;
  let stop = false;
  const worker = async () => {
    while (!stop && issued < max) {
      const n = ++issued;
      const one = await fire(ctx, url, n);
      samples.push(one);
      if (stopOnFirstNon2xx && (one.status < 200 || one.status >= 300)) stop = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, max) }, () => worker()));
  return samples;
}

/** Seconds from the end of the cell until a 2xx again; the first read is after the full cooldown. */
async function recover(ctx: Ctx, url: string): Promise<number | "timeout"> {
  const t0 = Date.now();
  await Bun.sleep(COOLDOWN_MS);
  while (Date.now() - t0 < COOLDOWN_MS + RECOVER_MAX_MS) {
    const one = await fire(ctx, url, 0);
    if (one.status >= 200 && one.status < 300) return Math.round((Date.now() - t0) / 1000);
    await Bun.sleep(10_000);
  }
  return "timeout";
}

const mod: TestModule = {
  id: "L02",
  title: "Rate-limit breach shape per endpoint and burst shape (JSON 429 vs edge HTML)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ref = ctx.peers.scoped ?? ctx.ref;
    const base = mgmtBase(ctx);
    const out: TestResult[] = [];
    for (const t of TARGETS) {
      for (const shape of Object.keys(SHAPES) as Shape[]) {
        const id = `L02-${t.key}-${shape}`;
        const title = `${t.key} x ${shape}`;
        if (t.needsRef && !ref) {
          out.push({ id, title, status: "skip", detail: "no project ref (PVLAB_PEER_SCOPED or PVLAB_REF)" });
          continue;
        }
        const url = `${base}${t.path(ref)}`;
        ctx.log(`${id}: bursting`);
        const t0 = Date.now();
        const samples = await runCell(ctx, url, shape);
        const burstMs = Date.now() - t0;
        const c = summariseCell(samples);
        const recovered = await recover(ctx, url);
        const first = [...samples].sort((a, b) => a.n - b.n).find((x) => x.status < 200 || x.status >= 300);
        out.push({
          id,
          title,
          status: "info",
          detail:
            c.first_non2xx_at === "none"
              ? `${c.requests_sent} requests, no non-2xx`
              : `first non-2xx at request ${c.first_non2xx_at}: ${c.first_non2xx_status} ${c.first_non2xx_class}, retry-after ${c.retry_after}; 2xx again after ${recovered} s`,
          measurements: { endpoint: t.key, shape, burst_ms: burstMs, ...c, recovered_s: recovered },
          evidence: first ? `${first.status} ${first.contentType}\n${first.body}` : "",
        });
      }
    }
    return out;
  },
};
export default mod;
