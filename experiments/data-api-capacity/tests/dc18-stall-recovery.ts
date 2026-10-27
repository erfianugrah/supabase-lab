/**
 * DC18 - After a short write stall under a steady request RATE, does Data API
 * latency come back when the stall ends, or does it stay high until the
 * clients back off?
 *
 * The question: a write stall from outside the Data API (a lock, a batch
 * UPDATE) slows Data API reads; when the stall ends, does latency follow it
 * back down? Two readings:
 *   - stall only: the batch (locks, I/O, CPU) slows queries while it runs;
 *     once it ends, PostgREST drains its queue at its normal ceiling and
 *     latency returns within backlog / (ceiling - rate) seconds.
 *   - stall plus queue collapse: requests queued for a pool connection cost
 *     PostgREST CPU (https://github.com/PostgREST/postgrest/issues/5336), so
 *     with a queue PostgREST serves fewer requests a second than the
 *     arrival rate, and the queue outlives the stall until load is shed.
 * DC06 locked the table with fewer workers than pool slots, so nothing ever
 * queued for a connection; this module keeps requests arriving at a fixed
 * rate with room for a queue.
 *
 * Load: `oha -q RATE -c C` (rate-limited, at most C in flight: open loop up
 * to C, so a full C stops new sends and the offered rate falls; the answered
 * count per bucket shows when), GET point reads on dc_items, anon key, for
 * PRE + STALL + POST seconds, every answered request recorded (lib/oha.ts;
 * client-side errors counted, not timed). Arms, in
 * order:
 *   control  no stall
 *   lock     `lock table dc_items in access exclusive mode` for STALL_S
 *            (every read blocked; anon's 3 s timeout ends the waiting ones)
 *   batch    one `update dc18_users set n = n + 1` over
 *            PVLAB_DC18_ROWS rows, a table no request reads (unrelated
 *            reads slowed by a batch); the stall is however long the
 *            UPDATE takes
 * Per arm: 2xx per second and p50/p95 latency in 5 s buckets, statuses per
 * phase, recovery time (first bucket after the stall where 2xx per second is
 * at least 90 % of the rate and p50 at most twice the pre-stall p50, or
 * pre-stall p50 + 50 ms), pool series and `authenticator` states sampled
 * through the arm.
 *
 * Not settled here: sizes other than PVLAB_DC_SIZE (8XL and above never
 * run), client retries (oha does not retry), more than one client vantage.
 * One run per arm.
 *
 * DESTRUCTIVE: uses the shared project (lib/dc.ts); DC99 deletes it.
 */
import { loadavg } from "node:os";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { scrapeMetrics, type PoolScrape } from "../lib/metrics.js";
import { errorsText, pct, runOhaRecorded, type OhaRow } from "../lib/oha.js";
import { ensureItems, ensureProject, errText, fmtCounts, redact, skipWithoutPro, sleep, sql, untilHealthy, type DcProject } from "../lib/dc.js";

const RATE = Number(process.env.PVLAB_DC18_RATE || 500);
const C = Number(process.env.PVLAB_DC18_C || 1024);
const PRE_S = Number(process.env.PVLAB_DC18_PRE_S || 60);
const STALL_S = Number(process.env.PVLAB_DC18_STALL_S || 30);
const POST_S = Number(process.env.PVLAB_DC18_POST_S || 180);
const ROWS = Number(process.env.PVLAB_DC18_ROWS || 2_000_000);
const ARMS = (process.env.PVLAB_DC18_ARMS || "control,lock,batch").split(",").filter(Boolean);
const BUCKET_S = 5;

const USERS_SQL = `
set statement_timeout = '600s';
create table if not exists public.dc18_users (id int primary key, n bigint not null default 0, pad text not null);
insert into public.dc18_users select g, 0, md5(g::text) from generate_series(1, ${ROWS}) g on conflict do nothing;
analyze public.dc18_users;`;

interface Bucket {
  /** Seconds from stall start (negative before it). */
  t: number;
  ok: number;
  other: number;
  p50: number;
  p95: number;
  sent: number;
}

/** 2xx and other answers by END time (throughput), p50/p95 and sends by START time (what a request sent then met). */
function buckets(rows: OhaRow[], stallAtS: number, totalS: number): Bucket[] {
  const n = Math.ceil(totalS / BUCKET_S) + 8;
  const ok = new Array<number>(n).fill(0);
  const other = new Array<number>(n).fill(0);
  const durs: number[][] = Array.from({ length: n }, () => []);
  const sent = new Array<number>(n).fill(0);
  for (const r of rows) {
    const be = Math.min(n - 1, Math.floor(r.end / BUCKET_S));
    if (r.status >= 200 && r.status < 300) ok[be]! += 1;
    else other[be]! += 1;
    const bs = Math.min(n - 1, Math.floor(r.start / BUCKET_S));
    durs[bs]!.push(r.duration * 1000);
    sent[bs]! += 1;
  }
  const out: Bucket[] = [];
  for (let i = 0; i < n; i++) {
    if (!ok[i] && !other[i] && !sent[i]) continue;
    out.push({ t: i * BUCKET_S - stallAtS, ok: ok[i]! / BUCKET_S, other: other[i]! / BUCKET_S, p50: Math.round(pct(durs[i]!, 0.5)), p95: Math.round(pct(durs[i]!, 0.95)), sent: sent[i]! / BUCKET_S });
  }
  return out;
}

const statusCounts = (rows: OhaRow[]) => {
  const c: Record<string, number> = {};
  for (const r of rows) c[String(r.status)] = (c[String(r.status)] ?? 0) + 1;
  return fmtCounts(c) || "none";
};

async function authStates(ctx: Ctx, ref: string): Promise<string> {
  const r = await sql(
    ctx,
    ref,
    `select coalesce(string_agg(state || ':' || n, ' ' order by state), 'none') as s
       from (select coalesce(state, 'null') as state, count(*) as n from pg_stat_activity where usename = 'authenticator' group by 1) x`,
    15_000,
  );
  return String(r.rows?.[0]?.s ?? `error ${r.error ?? r.status}`);
}

async function arm(ctx: Ctx, p: DcProject, kind: string): Promise<TestResult> {
  const total = PRE_S + STALL_S + POST_S;
  const url = `https://${p.host}/rest/v1/dc_items?id=eq.4242&select=id,payload`;
  const ohaP = runOhaRecorded(url, ["-q", String(RATE), "-c", String(C), "-z", `${total}s`, "-t", "30s", "-w"], { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` });
  const t0 = Date.now();

  let stop = false;
  const pools: PoolScrape[] = [];
  const states: { t: number; s: string }[] = [];
  const loads: number[] = [];
  const sampler = (async () => {
    while (!stop) {
      const [m, s] = await Promise.all([scrapeMetrics(p), authStates(ctx, p.ref)]);
      if (m.s) pools.push(m.s);
      states.push({ t: Date.now(), s });
      loads.push(Math.round(loadavg()[0]! * 10) / 10);
      await sleep(5_000);
    }
  })();

  await sleep(PRE_S * 1000);
  const stallStart = Date.now();
  let stallStatus = 0;
  let stallErr = "";
  if (kind === "lock") {
    const r = await sql(ctx, p.ref, `begin; lock table public.dc_items in access exclusive mode; select pg_sleep(${STALL_S}); commit;`, (STALL_S + 60) * 1000);
    stallStatus = r.status;
    stallErr = r.error ?? "";
  } else if (kind === "batch") {
    const r = await sql(ctx, p.ref, "set statement_timeout = '600s'; update public.dc18_users set n = n + 1;", 600_000);
    stallStatus = r.status;
    stallErr = r.error ?? "";
  } else {
    await sleep(STALL_S * 1000);
  }
  const stallEnd = Date.now();
  const run = await ohaP;
  stop = true;
  await sampler;
  // A request still failing when the load stops: how long until the API answers cleanly with no load.
  const shedToHealthyS = await untilHealthy(p, 5, 300);

  // Row times are relative to oha's own start, about t0.
  const stallAtS = (stallStart - t0) / 1000;
  const stallEndS = (stallEnd - t0) / 1000;
  const bs = buckets(run.rows, stallAtS, total);
  const pre = bs.filter((b) => b.t + stallAtS >= 10 && b.t < 0);
  const preP50 = pct(pre.map((b) => b.p50).filter((x) => x >= 0), 0.5);
  const preOk = pct(pre.map((b) => b.ok), 0.5);
  const stallLen = stallEndS - stallAtS;
  const after = bs.filter((b) => b.t >= stallLen);
  const okBar = 0.9 * RATE;
  const p50Bar = Math.max(2 * preP50, preP50 + 50);
  const rec = after.find((b) => b.ok >= okBar && b.p50 >= 0 && b.p50 <= p50Bar);
  const recoveryS = rec ? Math.round((rec.t - stallLen) * 10) / 10 : -1;
  // While the backlog drains (stall end to recovery) the client is at its in-flight cap, so 2xx per second there is the server's drain rate.
  const drain = after.filter((b) => b.t >= stallLen + BUCKET_S && (!rec || b.t < rec.t));
  const drainOk = Math.round(pct(drain.map((b) => b.ok), 0.5));
  const worst = bs.filter((b) => b.t >= 0).reduce<Bucket | null>((a, b) => (!a || b.p50 > a.p50 ? b : a), null);

  const rowsPre = run.rows.filter((r) => r.start < stallAtS);
  const rowsStall = run.rows.filter((r) => r.start >= stallAtS && r.start < stallEndS);
  const rowsPost = run.rows.filter((r) => r.start >= stallEndS);
  const poolAfter = pools.filter((x) => x.t >= stallStart);
  const wTop = poolAfter.reduce<PoolScrape | null>((a, b) => (!a || b.waiting > a.waiting ? b : a), null);
  const rel = (t: number) => Math.round((t - stallStart) / 100) / 10;
  const series = bs.map((b) => `${b.t}s ok/s ${b.ok} other/s ${b.other} sent/s ${b.sent} p50 ${b.p50} p95 ${b.p95}`).join(" | ");

  return {
    id: "DC18",
    title: `${kind} arm: ${RATE} req/s, at most ${C} in flight, stall at ${Math.round(stallAtS)} s`,
    status: stallErr ? "fail" : "info",
    detail:
      `stall ${kind === "control" ? "none (sleep)" : `${kind} query ${stallStatus}${stallErr ? ` ${stallErr}` : ""}`}, ${Math.round(stallLen * 10) / 10} s; ` +
      `oha ${run.rps} req/s, success ${run.successRate}, client errors ${errorsText(run.errors)}; ` +
      `pre-stall p50 ${preP50} ms, 2xx/s ${preOk}; worst bucket ${worst ? `${worst.t} s p50 ${worst.p50} ms 2xx/s ${worst.ok}` : "none"}; ` +
      `recovery ${recoveryS >= 0 ? `${recoveryS} s after the stall ended` : `none within ${POST_S} s`}, median 2xx/s while draining ${drainOk} (${drain.length} buckets); ` +
      `statuses pre ${statusCounts(rowsPre)}, stall ${statusCounts(rowsStall)}, post ${statusCounts(rowsPost)}; ` +
      `pool waiting max after stall start ${wTop?.waiting ?? -1} (available ${wTop?.available ?? -1} of ${wTop?.max ?? -1}); healthy ${shedToHealthyS} s after the load stopped`,
    measurements: {
      arm: kind,
      rate: RATE,
      max_in_flight: C,
      stall_s: Math.round(stallLen * 10) / 10,
      stall_status: stallStatus,
      oha_rps: run.rps,
      success_rate: run.successRate,
      client_errors: errorsText(run.errors),
      pre_p50_ms: preP50,
      pre_ok_per_s: preOk,
      worst_p50_ms: worst?.p50 ?? -1,
      worst_bucket_s: worst?.t ?? -1,
      recovery_s: recoveryS,
      drain_ok_per_s: drainOk,
      drain_buckets: drain.length,
      statuses_pre: statusCounts(rowsPre),
      statuses_stall: statusCounts(rowsStall),
      statuses_post: statusCounts(rowsPost),
      pool_waiting_max: wTop?.waiting ?? -1,
      pool_available_at_waiting_max: wTop?.available ?? -1,
      pool_max: wTop?.max ?? -1,
      healthy_after_load_s: shedToHealthyS,
      client_load1_max: loads.length ? Math.max(...loads) : -1,
    },
    evidence: redact(`5 s buckets (t from stall start): ${series} || authenticator (t from stall start): ${states.map((s) => `${rel(s.t)}s ${s.s}`).join(" | ")}${run.raw ? ` || oha: ${run.raw}` : ""}`),
  };
}

const mod: TestModule = {
  id: "DC18",
  title: "After a short write stall under a fixed request rate: does Data API latency recover on its own?",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC18");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      await ensureItems(ctx, p);
      if (ARMS.includes("batch")) {
        const t = Date.now();
        const u = await sql(ctx, p.ref, USERS_SQL, 600_000);
        const n = await sql(ctx, p.ref, "select count(*)::int as n, pg_size_pretty(pg_total_relation_size('public.dc18_users')) as size from public.dc18_users");
        out.push({
          id: "DC18a",
          title: "Setup: dc18_users for the batch arm",
          status: u.error ? "fail" : "info",
          detail: `setup ${u.status}${u.error ? ` ${u.error}` : ""} in ${Math.round((Date.now() - t) / 1000)} s; rows ${n.rows?.[0]?.n ?? "?"}, size ${n.rows?.[0]?.size ?? "?"}; ${p.pgVersion}`,
          measurements: { setup_status: u.status, rows: Number(n.rows?.[0]?.n ?? -1), size: String(n.rows?.[0]?.size ?? ""), pg_version: p.pgVersion },
        });
        if (u.error) return out;
      }
      for (const kind of ARMS) {
        const r = await arm(ctx, p, kind);
        out.push(r);
        ctx.log(`DC18 ${kind}: ${(r.detail ?? "").slice(0, 400)}`);
        await sleep(30_000);
      }
    } catch (e) {
      out.push({ id: "DC18", title: "DC18", status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
