/**
 * DC19 - How many Data API requests can be in flight to one project before
 * the API gateway answers 503 "upstream connect error or disconnect/reset
 * before headers. reset reason: overflow"?
 *
 * "overflow" is the wording of Envoy (the gateway, DC12) when an upstream
 * circuit breaker is full; its cluster breakers are max_connections,
 * max_pending_requests and max_requests, 1024 each when not set
 * (https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/circuit_breaker.proto,
 * read 2026-10-27; the gateway's own values are not readable). So the answer
 * is expected fast and from the gateway, not from PostgREST. Readings it
 * separates:
 *   - a per-project limit on requests in flight: below some K every request
 *     reaches PostgREST (200, or a client timeout while queued for the
 *     pool); above it a share of the burst is answered 503 quickly;
 *   - no limit reached from one client up to the largest K: no fast 503 at
 *     any step (the limit is above K, or applies per gateway instance and
 *     this client's requests spread over several);
 *   - something in front of the gateway refuses first (Cloudflare 429/1015,
 *     client-side connect errors): the limit is not measured.
 *
 * Method: `db_pool_acquisition_timeout` PATCHed to 60 s (the most allowed,
 * DC02c) so requests queued for the Small pool (30) stay in flight at
 * PostgREST instead of answering PGRST003 at 10 s; per step K concurrent
 * POST /rpc/dc_sleep_xl {"s": SLEEP_S} (anon key) from one oha run over
 * HTTP/2 (K / P connections x P streams, so the Mac does not open K
 * sockets), client timeout CLIENT_T_S; every answered request recorded
 * (lib/oha.ts). Three HTTP/1.1 probes 3 s into the step keep status, body
 * and headers. Per step: statuses, answers within 2 s by status, client
 * errors (requests unanswered at CLIENT_T_S), `authenticator` backends 5 s
 * in. Steps PVLAB_DC19_STEPS; after the second step whose fast 503s reach
 * PVLAB_DC19_STOP_SHARE of K, stop.
 *
 * Not settled here: which breaker trips, other sizes and regions, whether the
 * limit is per gateway instance, a slow-but-not-queued PostgREST.
 *
 * DESTRUCTIVE: PATCHes the shared project's PostgREST config (left at
 * acquisition timeout 60); DC99 deletes the project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { errorsText, pct, runOhaRecorded } from "../lib/oha.js";
import { ensureProject, errText, fmtCounts, patchPostgrest, postgrestConfig, redact, request, skipWithoutPro, sleep, sql, untilHealthy, waitRestart, type DcProject, type HttpResult } from "../lib/dc.js";

const STEPS = (process.env.PVLAB_DC19_STEPS || "250,500,1000,1500,2000,3000").split(",").filter(Boolean).map(Number);
const P = Number(process.env.PVLAB_DC19_P || 100);
const SLEEP_S = Number(process.env.PVLAB_DC19_SLEEP_S || 1);
const CLIENT_T_S = Number(process.env.PVLAB_DC19_CLIENT_T_S || 20);
const STOP_SHARE = Number(process.env.PVLAB_DC19_STOP_SHARE || 0.05);
const FAST_MS = 2_000;

async function authBackends(ctx: Ctx, ref: string): Promise<string> {
  const r = await sql(ctx, ref, "select count(*) filter (where state = 'active')::int as a, count(*)::int as n from pg_stat_activity where usename = 'authenticator'", 15_000);
  return r.rows?.[0] ? `${r.rows[0].a} active of ${r.rows[0].n}` : `error ${r.error ?? r.status}`;
}

const probeText = (h: HttpResult) => `${h.status} ${h.ms} ms ${h.code} body "${h.body.slice(0, 160)}" headers ${JSON.stringify(h.headers)}`;

async function step(ctx: Ctx, p: DcProject, k: number): Promise<{ res: TestResult; fastShare: number }> {
  const conns = Math.max(1, Math.ceil(k / P));
  const par = Math.ceil(k / conns);
  const hdr = { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` };
  const ohaP = runOhaRecorded(
    `https://${p.host}/rest/v1/rpc/dc_sleep_xl`,
    ["--http2", "-c", String(conns), "-p", String(par), "-n", String(k), "-t", `${CLIENT_T_S}s`, "-m", "POST", "-T", "application/json", "-d", JSON.stringify({ s: SLEEP_S })],
    hdr,
  );
  await sleep(3_000);
  const probes = await Promise.all([0, 1, 2].map(() => request(p.host, "POST", "/rest/v1/rpc/dc_sleep_xl", hdr, { s: SLEEP_S }, (CLIENT_T_S + 5) * 1000)));
  await sleep(2_000);
  const backends = await authBackends(ctx, p.ref);
  const run = await ohaP;

  const all: Record<string, number> = {};
  const fast: Record<string, number> = {};
  for (const r of run.rows) {
    all[String(r.status)] = (all[String(r.status)] ?? 0) + 1;
    if (r.duration * 1000 < FAST_MS) fast[String(r.status)] = (fast[String(r.status)] ?? 0) + 1;
  }
  const d503 = run.rows.filter((r) => r.status === 503).map((r) => r.duration * 1000);
  const fastShare = (fast["503"] ?? 0) / k;
  const odd = probes.find((h) => h.status === 503) ?? probes.find((h) => h.status !== 200);
  return {
    fastShare,
    res: {
      id: "DC19",
      title: `${k} concurrent requests (${conns} HTTP/2 connections x ${par} streams)`,
      status: run.rps < 0 ? "fail" : "info",
      detail:
        `answered ${run.rows.length} of ${k}: ${fmtCounts(all) || "none"}; within ${FAST_MS} ms ${fmtCounts(fast) || "none"}; ` +
        `503 p50 ${Math.round(pct(d503, 0.5))} ms (n ${d503.length}); unanswered ${k - run.rows.length} (client errors ${errorsText(run.errors)}); ` +
        `authenticator ${backends} 5 s in; probes ${probes.map((h) => `${h.status}/${h.ms}ms`).join(" ")}`,
      measurements: {
        k,
        connections: conns,
        streams_per_connection: par,
        answered: run.rows.length,
        statuses: fmtCounts(all) || "none",
        fast_statuses: fmtCounts(fast) || "none",
        fast_503: fast["503"] ?? 0,
        fast_503_share: Math.round(fastShare * 1000) / 1000,
        p50_503_ms: Math.round(pct(d503, 0.5)),
        unanswered: k - run.rows.length,
        client_errors: errorsText(run.errors),
        authenticator_5s: backends,
        probes: probes.map((h) => `${h.status}/${h.ms}ms`).join(" "),
      },
      evidence: redact(`${odd ? `probe: ${probeText(odd)}` : `probes all 200: ${probeText(probes[0]!)}`}${run.raw ? ` || oha: ${run.raw}` : ""}`),
    },
  };
}

const mod: TestModule = {
  id: "DC19",
  title: "Data API requests in flight before the API gateway answers 503 overflow",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC19");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      const t0 = Date.now();
      const patch = await patchPostgrest(ctx, p.ref, { db_pool_acquisition_timeout: 60 });
      const rs = await waitRestart(ctx, p.ref, t0);
      await sleep(15_000);
      const cfg = await postgrestConfig(ctx, p.ref);
      const healthy = await untilHealthy(p);
      out.push({
        id: "DC19a",
        title: "Acquisition timeout 60 s",
        status: patch.status === 200 && rs.delayS >= 0 ? "info" : "fail",
        detail: `PATCH ${patch.status}; restart line ${rs.delayS} s after; read back db_pool ${cfg.dbPool}, acquisition timeout ${cfg.acqTimeout}; healthy after ${healthy} s`,
        measurements: { patch_status: patch.status, restart_delay_s: rs.delayS, db_pool: cfg.dbPool, acquisition_timeout: cfg.acqTimeout },
      });
      let crossed = 0;
      for (const k of STEPS) {
        const { res, fastShare } = await step(ctx, p, k);
        out.push(res);
        ctx.log(`DC19 k=${k}: ${(res.detail ?? "").slice(0, 300)}`);
        if (fastShare >= STOP_SHARE) crossed += 1;
        if (crossed >= 2) break;
        // Queued requests the client gave up on can wait out the 60 s acquisition timeout.
        await sleep(70_000);
        await untilHealthy(p);
      }
    } catch (e) {
      out.push({ id: "DC19", title: "DC19", status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
