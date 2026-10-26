/**
 * DC12 - Where the extra attempts after a PGRST003 come from, and how the
 * acquisition timeout sets the client's wait.
 *
 * DC01b and DC02b: a request queued behind a full pool answered 504 PGRST003
 * after about 6 x `db_pool_acquisition_timeout` (61 s at 10, 13.8 s at 2,
 * 25 s at 4) and its User-Agent was on 6 PostgREST access-log lines. Which
 * component sends it again was not identified. This module counts, per
 * client request, the PostgREST access-log lines and the API gateway's
 * `edge_logs` rows, keeps the response headers, and diffs PostgREST's own
 * `pgrst_db_pool_timeouts_total` across a known number of failed requests.
 * Readings it separates:
 *   - one edge_logs row and 6 PostgREST lines per request: the resends happen
 *     between the logged gateway hop and PostgREST;
 *   - 6 edge_logs rows: something in front of the logged hop resends;
 *   - timeouts_total + 6 per request: PostgREST timed out each attempt.
 *
 * Method: per arm, PATCH `db_pool` (a distinct size per arm, so a metrics
 * snapshot names its PostgREST process by `pgrst_db_pool_max`) and the
 * acquisition timeout, wait for the restart log line, hold every pooled
 * connection with service_role `dc12_hold` sleeps (function timeout 900 s),
 * then send single GET, HEAD, PATCH and POST /rpc requests concurrently, each
 * with its own User-Agent (service_role key), cancel the holders through
 * `pg_cancel_backend` once all probes have answered, and read the metrics
 * snapshot until it has refreshed twice after the last answer.
 *
 *   DC12a  acquisition timeout 1 s, pool 10, two rounds of the four methods.
 *   DC12b  5 s, pool 11, two rounds.
 *   DC12c  20 s, pool 12, one round.
 *   DC12d  60 s, pool 13, one round (does an edge or gateway timeout fire
 *          before 6 x 60 s?).
 *   DC12e  burst: 5 s, pool 14 held, 42 concurrent POST /rpc dc_ping (3 x
 *          pool), attempts per request.
 *
 * Not settled by this module: the gateway's configuration (not readable from
 * a project); other regions or sizes; requests that time out in Postgres
 * rather than in the pool (DC03d: 500 not resent).
 *
 * DESTRUCTIVE: PATCHes the PostgREST config of the shared project (left at
 * pool 14, timeout 5); DC99 deletes the project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { scrapeMetrics } from "../lib/metrics.js";
import {
  authenticatorCounts,
  ensureProject,
  errText,
  fmtCounts,
  logLinesByUaPrefix,
  patchPostgrest,
  redact,
  request,
  rpc,
  skipWithoutPro,
  sleep,
  sql,
  untilHealthy,
  waitRestart,
  type DcProject,
  type HttpResult,
  type UaLogLine,
} from "../lib/dc.js";

const SETUP = `
create table if not exists public.dc12_t (id int primary key, note text);
insert into public.dc12_t values (1, 'x') on conflict do nothing;
grant select, update on public.dc12_t to anon, authenticated, service_role;
create or replace function public.dc12_hold(s double precision) returns double precision
  language plpgsql set statement_timeout = '900s' as $$ begin perform pg_sleep(s); return s; end $$;
grant execute on function public.dc12_hold(double precision) to service_role;
notify pgrst, 'reload schema';`;

type Method = "GET" | "HEAD" | "PATCH" | "RPC";
const METHODS: Method[] = ["GET", "HEAD", "PATCH", "RPC"];

function probe(p: DcProject, m: Method, ua: string, timeoutMs: number): Promise<HttpResult> {
  const h = { apikey: p.keys.service, Authorization: `Bearer ${p.keys.service}`, "User-Agent": ua };
  if (m === "GET") return request(p.host, "GET", "/rest/v1/dc12_t?id=eq.1", h, undefined, timeoutMs);
  if (m === "HEAD") return request(p.host, "HEAD", "/rest/v1/dc12_t?id=eq.1", h, undefined, timeoutMs);
  if (m === "PATCH") return request(p.host, "PATCH", "/rest/v1/dc12_t?id=eq.1", { ...h, Prefer: "return=minimal" }, { note: ua }, timeoutMs);
  return request(p.host, "POST", "/rest/v1/rpc/dc_ping", h, {}, timeoutMs);
}

interface MetricRead {
  atS: number;
  max: number;
  timeouts: number;
  waiting: number;
  cpu: number;
}

async function readMetrics(p: DcProject, t0: number): Promise<MetricRead | null> {
  const r = await scrapeMetrics(p);
  if (!r.s) return null;
  return { atS: Math.round((Date.now() - t0) / 1000), max: r.s.max, timeouts: r.s.timeouts, waiting: r.s.waiting, cpu: Math.round((r.s.busy + r.s.idle) * 100) / 100 };
}

/** Poll until `pgrst_db_pool_max` reads `pool` (the snapshot belongs to this arm's process). */
async function metricsFor(p: DcProject, pool: number, t0: number, maxS = 180): Promise<{ first: MetricRead | null; status: number }> {
  const s0 = Date.now();
  let status = 0;
  while (Date.now() - s0 < maxS * 1000) {
    const r = await scrapeMetrics(p);
    status = r.status;
    if (r.s && r.s.max === pool) return { first: { atS: Math.round((Date.now() - t0) / 1000), max: r.s.max, timeouts: r.s.timeouts, waiting: r.s.waiting, cpu: Math.round((r.s.busy + r.s.idle) * 100) / 100 }, status };
    await sleep(5_000);
  }
  return { first: null, status };
}

/** After the last answer: scrape every 5 s until the payload has refreshed twice (node CPU moved) or maxS. */
async function metricsAfter(p: DcProject, t0: number, maxS = 200): Promise<{ reads: MetricRead[]; refreshes: number; final: MetricRead | null }> {
  const s0 = Date.now();
  const reads: MetricRead[] = [];
  let refreshes = 0;
  let prevCpu = -1;
  while (Date.now() - s0 < maxS * 1000 && refreshes < 2) {
    const m = await readMetrics(p, t0);
    if (m) {
      if (prevCpu >= 0 && m.cpu !== prevCpu) {
        refreshes++;
        reads.push(m);
      } else if (prevCpu < 0) reads.push(m);
      prevCpu = m.cpu;
    }
    await sleep(5_000);
  }
  return { reads, refreshes, final: reads.length ? reads[reads.length - 1]! : null };
}

async function cancelHolders(ctx: Ctx, ref: string): Promise<number> {
  const r = await sql(ctx, ref, "select count(pg_cancel_backend(pid))::int as n from pg_stat_activity where usename = 'authenticator' and query like '%dc12_hold%' and state = 'active'", 30_000);
  return Number(r.rows?.[0]?.n ?? -1);
}

const by = (xs: UaLogLine[], k: (l: UaLogLine) => string) => xs.reduce((m, l) => ({ ...m, [k(l)]: (m[k(l)] ?? 0) + 1 }), {} as Record<string, number>);

/** Per UA: count, statuses, first-to-last span and the gaps between consecutive rows (s). */
function perUa(lines: UaLogLine[], ua: string): { n: number; statuses: string; spanS: number; gaps: string; addrs: number } {
  const mine = lines.filter((l) => l.ua === ua).sort((a, b) => a.t - b.t);
  const gaps = mine.slice(1).map((l, i) => ((l.t - mine[i]!.t) / 1000).toFixed(1));
  return {
    n: mine.length,
    statuses: fmtCounts(by(mine, (l) => l.status)) || "none",
    spanS: mine.length > 1 ? Math.round((mine[mine.length - 1]!.t - mine[0]!.t) / 100) / 10 : 0,
    gaps: gaps.join(",") || "-",
    addrs: new Set(mine.map((l) => l.extra)).size,
  };
}

const mod: TestModule = {
  id: "DC12",
  title: "PGRST003 resends: attempts per request by log layer, response headers, pool timeout counter, per acquisition timeout",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC12");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      if ((await untilHealthy(p, 10, 600)) < 0) throw new Error("Data API not answering 10 consecutive pings within 600 s");
      const setup = await sql(ctx, p.ref, SETUP);
      if (setup.error) throw new Error(`setup: ${setup.error}`);
      const runId = Date.now().toString(36);

      const arms: { id: string; acq: number; pool: number; rounds: number; burst: number }[] = [
        { id: "DC12a", acq: 1, pool: 10, rounds: 2, burst: 0 },
        { id: "DC12b", acq: 5, pool: 11, rounds: 2, burst: 0 },
        { id: "DC12c", acq: 20, pool: 12, rounds: 1, burst: 0 },
        { id: "DC12d", acq: 60, pool: 13, rounds: 1, burst: 0 },
        { id: "DC12e", acq: 5, pool: 14, rounds: 1, burst: 42 },
      ];
      for (const a of arms) {
        const m: Record<string, number | string> = { acquisition_timeout_s: a.acq, db_pool: a.pool };
        const det: string[] = [];
        try {
          const tPatch = Date.now();
          const pr = await patchPostgrest(ctx, p.ref, { db_pool: a.pool, db_pool_acquisition_timeout: a.acq });
          m.patch_status = pr.status;
          if (pr.status >= 300) throw new Error(`PATCH ${pr.status} ${pr.text}`);
          m.restart_delay_s = (await waitRestart(ctx, p.ref, tPatch)).delayS;
          await untilHealthy(p, 5, 300);
          // Schema cache must serve dc12_t before the pool is held.
          for (let i = 0; i < 20; i++) {
            const r = await request(p.host, "GET", "/rest/v1/dc12_t?id=eq.1", { apikey: p.keys.service, Authorization: `Bearer ${p.keys.service}` });
            if (r.status === 200) break;
            await sleep(2_000);
          }
          const t0 = Date.now();
          const mb = await metricsFor(p, a.pool, t0);
          m.metrics_status = mb.status;
          m.metrics_before_timeouts = mb.first?.timeouts ?? -1;
          m.metrics_before_waiting = mb.first?.waiting ?? -1;
          m.metrics_before_read_s = mb.first?.atS ?? -1;

          const probeTimeoutMs = Math.min(6 * a.acq + 150, 700) * 1000;
          const holdS = Math.min(6 * a.acq + 120, 800);
          const holders = Array.from({ length: a.pool }, () => rpc(p.host, "dc12_hold", { s: holdS }, p.keys.service, p.keys.service, (holdS + 60) * 1000));
          await sleep(6_000);
          const atProbe = await authenticatorCounts(ctx, p.ref);
          m.sleeping_at_probe = atProbe?.sleeping ?? -1;

          const prefix = `pvlab-dc12-${runId}-${a.id.toLowerCase()}`;
          const results: { ua: string; method: string; r: HttpResult }[] = [];
          if (a.burst > 0) {
            const rs = await Promise.all(Array.from({ length: a.burst }, async (_, i) => {
              const ua = `${prefix}-rpc-${i}`;
              return { ua, method: "RPC", r: await probe(p, "RPC", ua, probeTimeoutMs) };
            }));
            results.push(...rs);
          } else {
            for (let round = 1; round <= a.rounds; round++) {
              const rs = await Promise.all(METHODS.map(async (meth) => {
                const ua = `${prefix}-${meth.toLowerCase()}-r${round}`;
                return { ua, method: meth, r: await probe(p, meth, ua, probeTimeoutMs) };
              }));
              results.push(...rs);
            }
          }
          const lastAnswerS = Math.round((Date.now() - t0) / 1000);
          const beforeCancel = await authenticatorCounts(ctx, p.ref);
          m.sleeping_after_probes = beforeCancel?.sleeping ?? -1;
          m.holders_cancelled = await cancelHolders(ctx, p.ref);
          const hs = await Promise.all(holders);
          m.holder_outcomes = fmtCounts(by(hs.map((h) => ({ ua: "", t: 0, status: `${h.status}${h.code ? `/${h.code}` : ""}`, extra: "" })), (l) => l.status));

          const ma = await metricsAfter(p, t0);
          m.metrics_after_refreshes = ma.refreshes;
          m.metrics_after_reads = ma.reads.map((r) => `${r.atS}s:max${r.max}/to${r.timeouts}/w${r.waiting}`).join(" ").slice(0, 400);
          m.metrics_after_timeouts = ma.final?.timeouts ?? -1;
          m.metrics_after_max = ma.final?.max ?? -1;
          m.metrics_timeouts_delta = mb.first && ma.final && ma.final.max === a.pool ? ma.final.timeouts - mb.first.timeouts : -1;
          m.failed_client_requests = results.filter((x) => x.r.status !== 200 && x.r.status !== 204).length;

          const pl = await logLinesByUaPrefix(ctx, p.ref, "postgrest_logs", prefix);
          const el = await logLinesByUaPrefix(ctx, p.ref, "edge_logs", prefix);
          m.postgrest_lines_total = pl.lines.length;
          m.edge_rows_total = el.lines.length;
          if (pl.error) m.postgrest_logs_error = pl.error.slice(0, 120);
          if (el.error) m.edge_logs_error = el.error.slice(0, 120);

          if (a.burst > 0) {
            const ms = results.map((x) => x.r.ms).sort((x, y) => x - y);
            m.burst_statuses = fmtCounts(by(results.map((x) => ({ ua: "", t: 0, status: `${x.r.status}${x.r.code && x.r.code !== "client" ? `/${x.r.code}` : ""}`, extra: "" })), (l) => l.status));
            m.burst_ms_min = ms[0] ?? -1;
            m.burst_ms_med = ms[Math.floor(ms.length / 2)] ?? -1;
            m.burst_ms_max = ms[ms.length - 1] ?? -1;
            const pc = results.map((x) => perUa(pl.lines, x.ua).n);
            const ec = results.map((x) => perUa(el.lines, x.ua).n);
            m.burst_postgrest_lines_per_request = fmtCounts(by(pc.map((n) => ({ ua: "", t: 0, status: String(n), extra: "" })), (l) => l.status));
            m.burst_edge_rows_per_request = fmtCounts(by(ec.map((n) => ({ ua: "", t: 0, status: String(n), extra: "" })), (l) => l.status));
            m.response_headers_sample = redact(JSON.stringify(results.find((x) => x.r.status >= 500)?.r.headers ?? {})).slice(0, 600);
            det.push(
              `${a.burst} requests: ${m.burst_statuses}, ${m.burst_ms_min}/${m.burst_ms_med}/${m.burst_ms_max} ms min/med/max; PostgREST lines per request ${m.burst_postgrest_lines_per_request}; edge rows per request ${m.burst_edge_rows_per_request}`,
            );
          } else {
            for (const x of results) {
              const k = x.ua.slice(prefix.length + 1);
              const pu = perUa(pl.lines, x.ua);
              const eu = perUa(el.lines, x.ua);
              m[`${k}_status`] = x.r.status;
              m[`${k}_code`] = x.r.code || "none";
              m[`${k}_ms`] = x.r.ms;
              m[`${k}_postgrest_lines`] = pu.n;
              m[`${k}_postgrest_by_status`] = pu.statuses;
              m[`${k}_postgrest_gaps_s`] = pu.gaps;
              m[`${k}_postgrest_remote_addrs`] = pu.addrs;
              m[`${k}_edge_rows`] = eu.n;
              m[`${k}_edge_by_status`] = eu.statuses;
              if (x.r.status === 0) m[`${k}_client_error`] = redact(x.r.message).slice(0, 120);
              det.push(`${k}: ${x.r.status} ${x.r.code} ${x.r.ms} ms, PostgREST ${pu.n} (${pu.statuses}, gaps ${pu.gaps} s), edge ${eu.n} (${eu.statuses})`);
            }
            m.response_headers_sample = redact(JSON.stringify(results.find((x) => x.r.status >= 500 && x.method === "RPC")?.r.headers ?? results[0]?.r.headers ?? {})).slice(0, 600);
          }
          det.push(
            `holders ${m.sleeping_at_probe} sleeping at probe, ${m.sleeping_after_probes} after; last answer ${lastAnswerS} s; timeouts_total ${m.metrics_before_timeouts} -> ${m.metrics_after_timeouts} (delta ${m.metrics_timeouts_delta}, ${m.metrics_after_refreshes} refreshes) for ${m.failed_client_requests} failed client requests`,
          );
          out.push({
            id: a.id,
            title: a.burst ? `burst: ${a.burst} requests with pool ${a.pool} held, acquisition timeout ${a.acq} s` : `acquisition timeout ${a.acq} s, pool ${a.pool} held: GET, HEAD, PATCH, POST /rpc (${a.rounds} round${a.rounds > 1 ? "s" : ""})`,
            status: "info",
            detail: det.join("; "),
            measurements: m,
            evidence: redact(results.find((x) => x.r.status >= 500)?.r.body ?? ""),
          });
        } catch (e) {
          await cancelHolders(ctx, p.ref).catch(() => -1);
          out.push({ id: a.id, title: `acquisition timeout ${a.acq} s`, status: "fail", detail: `threw: ${redact(errText(e))}`, measurements: m });
        }
        await sleep(5_000);
      }
    } catch (e) {
      out.push({ id: "DC12", title: this.title, status: "fail", detail: `threw: ${redact(errText(e))}` });
    }
    return out;
  },
};
export default mod;
