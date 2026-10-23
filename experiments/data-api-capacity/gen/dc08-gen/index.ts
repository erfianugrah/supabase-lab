// DC08 load generator: one invocation = one closed-loop client running `k`
// workers against the Data API for one round (PVLAB_DC08_ROUND_S, 8 s by default), started at an
// agreed wall-clock time so every invocation of a round runs together.
// Deployed by tests/dc08-inregion-mix.ts as an Edge Function and invoked
// with `x-region` set to the project's region, so the client sits in the
// project's AWS region. Rounds are short because an invocation has 2 s of
// CPU (functions/limits docs); the caller chains rounds into a step.
//
// Deno source, outside the harness tsconfig on purpose (Deno.serve).
//
// Target: the project this function is deployed in (SUPABASE_URL, "the API
// gateway for your Supabase project" in the functions secrets docs), never a
// host from the request, so a copied deployment cannot be pointed at a third
// party. Added after the 2026-10-23 run, which sent the same project's host
// in the body.
//
// Request body: { key, k, startAt, durS, mix }
//   mix: [[op, weight], ...] with op in point|range50|rpc|insert|countExact
// Response: per-op status counts and sparse latency histograms, errors,
// one body sample per non-2xx status, event-loop lag (50 ms timer drift),
// the isolate id, and the Cloudflare colo of sampled responses (cf-ray).

const ISOLATE = crypto.randomUUID().slice(0, 8);
const ROWS = 100_000;

// Histogram buckets: 0.1 ms to 100 ms, 1 ms to 2 s, 100 ms to 60 s.
function bucket(ms: number): number {
  if (ms < 100) return Math.floor(ms * 10);
  if (ms < 2000) return 1000 + Math.floor(ms - 100);
  return 2900 + Math.min(580, Math.floor((ms - 2000) / 100));
}

type Op = "point" | "range50" | "rpc" | "insert" | "countExact";

interface OpStats {
  n: number;
  status: Record<string, number>;
  hist: Record<number, number>;
}

const PROJECT_URL = Deno.env.get("SUPABASE_URL") ?? "";

Deno.serve(async (req) => {
  if (!PROJECT_URL) return Response.json({ error: "SUPABASE_URL not set" }, { status: 500 });
  const b = (await req.json()) as { key: string; k: number; startAt: number; durS: number; mix: [Op, number][] };
  const base = `${new URL(PROJECT_URL).origin}/rest/v1`;
  const h = { apikey: b.key, Authorization: `Bearer ${b.key}` };
  const total = b.mix.reduce((a, [, w]) => a + w, 0);
  const pick = (): Op => {
    let r = Math.random() * total;
    for (const [op, w] of b.mix) if ((r -= w) < 0) return op;
    return b.mix[0][0];
  };
  const rid = () => 1 + Math.floor(Math.random() * ROWS);
  const build = (op: Op): [string, RequestInit] => {
    switch (op) {
      case "point":
        return [`${base}/dc_items?id=eq.${rid()}&select=id,payload`, { headers: h }];
      case "range50": {
        const x = 1 + Math.floor(Math.random() * (ROWS - 50));
        return [`${base}/dc_items?id=gte.${x}&id=lt.${x + 50}&select=id,payload&order=id`, { headers: h }];
      }
      case "rpc":
        return [`${base}/rpc/dc08_lookup`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: `{"p_id":${rid()}}` }];
      case "insert":
        return [`${base}/dc08_events`, { method: "POST", headers: { ...h, "Content-Type": "application/json", Prefer: "return=minimal" }, body: `{"item_id":${rid()},"note":"dc08 insert ${ISOLATE}"}` }];
      case "countExact": {
        const x = 1 + Math.floor(Math.random() * (ROWS - 10_000));
        return [`${base}/dc_items?id=gte.${x}&id=lt.${x + 10_000}&select=id,payload&order=id&limit=20`, { headers: { ...h, Prefer: "count=exact" } }];
      }
    }
  };

  const stats: Record<string, OpStats> = {};
  const errors: Record<string, number> = {};
  const samples: Record<string, string> = {};
  const colos: Record<string, number> = {};
  const lags: number[] = [];
  let seq = 0;

  const wait = b.startAt - Date.now();
  const lateMs = wait < 0 ? -wait : 0;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const end = b.startAt + b.durS * 1000;

  let last = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    lags.push(now - last - 50);
    last = now;
  }, 50);

  const worker = async () => {
    while (Date.now() < end) {
      const op = pick();
      const [url, init] = build(op);
      const t0 = performance.now();
      try {
        const res = await fetch(url, init);
        const body = await res.text();
        const ms = performance.now() - t0;
        if (Date.now() > end) break;
        const s = (stats[op] ??= { n: 0, status: {}, hist: {} });
        s.n++;
        s.status[res.status] = (s.status[res.status] ?? 0) + 1;
        const bk = bucket(ms);
        s.hist[bk] = (s.hist[bk] ?? 0) + 1;
        if (res.status >= 300 && !samples[res.status]) samples[res.status] = `${op}: ${body.replace(/\s+/g, " ").slice(0, 300)}`;
        if (++seq % 50 === 0) {
          const colo = (res.headers.get("cf-ray") ?? "").split("-")[1] ?? "none";
          colos[colo] = (colos[colo] ?? 0) + 1;
        }
      } catch (e) {
        if (Date.now() > end) break;
        const m = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 120);
        errors[m] = (errors[m] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: b.k }, worker));
  clearInterval(lagTimer);
  lags.sort((a, z) => a - z);
  return Response.json({
    isolate: ISOLATE,
    region: Deno.env.get("SB_REGION") ?? null,
    lateMs,
    stats,
    errors,
    samples,
    colos,
    lagP99: Math.round(lags[Math.floor(lags.length * 0.99)] ?? -1),
    lagMax: Math.round(lags[lags.length - 1] ?? -1),
  });
});
