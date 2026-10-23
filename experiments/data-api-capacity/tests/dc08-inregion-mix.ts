/**
 * DC08 - With load generated in the project's own region and a request mix
 * closer to an application than one point read, does the Data API
 * (PostgREST) queue requests for a pool connection while open connections
 * sit idle, on a 16-vCPU 4XL, and does `db_pool` 70 / 150 / 250 change the
 * throughput or the queueing once it does?
 *
 * DC04 drove one indexed point read from one Mac in Singapore: 4XL scaled to
 * 3,158 req/s at c=512, then the client (os error 51) and edge 403s ended the
 * measurement. Here the clients are Edge Function invocations pinned with
 * `x-region` to the project's region (gen/dc08-gen/index.ts): each
 * invocation is one closed-loop client with PVLAB_DC08_K workers for one
 * round of PVLAB_DC08_ROUND_S seconds (an invocation has 2 s of CPU per the
 * functions limits docs, so rounds are short and chained into a step), all
 * invocations of a round starting at the same wall-clock time.
 *
 * Mix (weights, every request with the legacy anon key):
 *   point 50       GET  dc_items?id=eq.<random>&select=id,payload
 *   range50 15     GET  dc_items?id=gte.X&id=lt.X+50&select=id,payload&order=id (50 rows)
 *   rpc 15         POST rpc/dc08_lookup {p_id} (sql stable, one indexed row as json)
 *   insert 10      POST dc08_events {item_id, note}, Prefer: return=minimal
 *   countExact 10  GET  dc_items?id=gte.X&id=lt.X+10000&select=id,payload&order=id&limit=20,
 *                       Prefer: count=exact (counts 10,000 index rows, returns 20)
 *
 * Competing hypotheses and what separates them (same as DC04):
 *   - PostgREST queues for the pool while open connections are idle:
 *     `waiting - (max - available) > 0` with `available > 0` in a metrics
 *     snapshot (waiting counts queued plus holding, DC05; in-use is at most
 *     max - available, so that difference is a lower bound on queued), and
 *     `authenticator` backends idle in pg_stat_activity while client latency
 *     climbs and Postgres executor time per second stays flat.
 *   - Postgres is the limit: backends mostly active, executor ms per second
 *     approaching (cores x 1000), waiting only once available is 0.
 *   - The generator is the limit: invocation event-loop lag high, achieved
 *     rate per invocation falling, invocations failing (546 is the CPU limit).
 *
 * Pool series are snapshots that refresh rarely (DC05), so every step also
 * samples pg_stat_activity about every 4 s and pg_stat_statements /
 * pg_stat_database at its start and end.
 *
 *   DC08a  setup: tables, function deploy, served region, sizes, pool
 *   DC08b  ramp on the target size (default ci_4xlarge) at PVLAB_DC08_STEPS
 *          aggregate concurrency until throughput gains under 10 % or the
 *          success share drops under 95 % (the stop rule of this module)
 *   DC08c  `db_pool` PVLAB_DC08_POOLS (default 150,250,70) PATCHed in turn,
 *          then one step at the knee concurrency
 *
 * DESTRUCTIVE: creates or reuses the shared project (lib/dc.ts), resizes it,
 * PATCHes PostgREST config, deploys an Edge Function; DC99 deletes the
 * project. Opt-in: `make run ONLY=DC08,DC99`.
 */
import { readFileSync } from "node:fs";
import { mgmtBase } from "../../../harness/src/mgmt.js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { scrapeMetrics, type PoolScrape } from "../lib/metrics.js";
import { ensureItems, ensureProject, errText, fmtCounts, patchPostgrest, postgrestConfig, redact, REGION, resize, skipWithoutPro, sleep, sql, waitRestart, type DcProject } from "../lib/dc.js";

const SIZE = process.env.PVLAB_DC08_SIZE || "ci_4xlarge";
const STEPS = (process.env.PVLAB_DC08_STEPS || "64,128,256,512,1024,2048,3072").split(",").map(Number);
const POOLS = (process.env.PVLAB_DC08_POOLS || "150,250,70").split(",").filter((x) => x && x !== "none").map(Number);
const K = Number(process.env.PVLAB_DC08_K || 8);
const ROUND_S = Number(process.env.PVLAB_DC08_ROUND_S || 8);
const ROUNDS = Number(process.env.PVLAB_DC08_ROUNDS || 6);
const MIN_SUCCESS = 0.95;
const SLUG = "dc08-gen";

export const MIX: [string, number][] = [
  ["point", 50],
  ["range50", 15],
  ["rpc", 15],
  ["insert", 10],
  ["countExact", 10],
];

const MIX_SQL = `
create table if not exists public.dc08_events (id bigint generated always as identity primary key, item_id int not null, note text, created_at timestamptz not null default now());
grant insert on public.dc08_events to anon, authenticated, service_role;
create or replace function public.dc08_lookup(p_id int) returns json language sql stable as $$
  select json_build_object('id', id, 'payload', payload) from public.dc_items where id = p_id $$;
grant execute on function public.dc08_lookup(int) to anon, authenticated, service_role;
create extension if not exists pg_stat_statements with schema extensions;
notify pgrst, 'reload schema';`;

interface InvOut {
  isolate: string;
  region: string | null;
  lateMs: number;
  stats: Record<string, { n: number; status: Record<string, number>; hist: Record<string, number> }>;
  errors: Record<string, number>;
  samples: Record<string, string>;
  colos: Record<string, number>;
  lagP99: number;
  lagMax: number;
}

interface Inv {
  status: number;
  served: string;
  body?: InvOut;
  err: string;
  /** One body per failed attempt's status, and the failed attempts per status, before this result. */
  failed: Record<string, string>;
  failCounts?: Record<string, number>;
}

async function deployGen(ctx: Ctx, ref: string): Promise<{ status: number; text: string }> {
  const src = readFileSync(new URL("../gen/dc08-gen/index.ts", import.meta.url), "utf8");
  const form = new FormData();
  form.append("file", new Blob([src]), "index.ts");
  // verify_jwt: only callers holding a project key can make it generate load.
  form.append("metadata", JSON.stringify({ name: SLUG, entrypoint_path: "index.ts", verify_jwt: true }));
  try {
    const res = await fetch(`${mgmtBase(ctx)}/projects/${ref}/functions/deploy?slug=${SLUG}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.pat}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    return { status: res.status, text: (await res.text()).replace(/\s+/g, " ").slice(0, 200) };
  } catch (e) {
    return { status: 0, text: errText(e) };
  }
}

/** One attempt; status 0 is a client-side failure. */
async function invokeOnce(p: DcProject, k: number, startAt: number, durS: number): Promise<Inv> {
  try {
    const res = await fetch(`https://${p.host}/functions/v1/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.keys.service}`, "x-region": REGION },
      // The generator targets its own project (SUPABASE_URL); no host is sent.
      body: JSON.stringify({ key: p.keys.anon, k, startAt, durS, mix: MIX }),
      signal: AbortSignal.timeout((durS + 60) * 1000),
    });
    const text = await res.text();
    const served = res.headers.get("x-sb-edge-region") ?? "";
    if (res.status !== 200) return { status: res.status, served, err: text.replace(/\s+/g, " ").slice(0, 200), failed: {} };
    return { status: 200, served, body: JSON.parse(text) as InvOut, err: "", failed: {} };
  } catch (e) {
    return { status: 0, served: "", err: errText(e), failed: {} };
  }
}

/**
 * Invoke, and on a failed invocation (the dev run on 2026-10-23 met 503
 * BOOT_ERROR and 546 on up to 40 % of invocations in a burst) try again
 * while at least 2 s of the round remain. A retried client starts late and
 * runs only the rest of the round; the failures are counted per status.
 */
async function invoke(p: DcProject, k: number, startAt: number, durS: number): Promise<Inv> {
  const failed: Record<string, string> = {};
  const failCounts: Record<string, number> = {};
  for (;;) {
    const r = await invokeOnce(p, k, startAt, durS);
    if (r.status === 200 || Date.now() > startAt + (durS - 2) * 1000) return { ...r, failed, failCounts };
    failCounts[String(r.status)] = (failCounts[String(r.status)] ?? 0) + 1;
    failed[String(r.status)] ??= r.err;
    await sleep(200);
  }
}

/** Upper edge (ms) of a histogram bucket from the generator. */
function bucketMs(i: number): number {
  if (i < 1000) return (i + 1) / 10;
  if (i < 2900) return 100 + (i - 1000) + 1;
  return 2000 + (i - 2900 + 1) * 100;
}

function pctFromHist(h: Map<number, number>, q: number): number {
  const total = [...h.values()].reduce((a, b) => a + b, 0);
  if (!total) return -1;
  const keys = [...h.keys()].sort((a, b) => a - b);
  let acc = 0;
  for (const k of keys) {
    acc += h.get(k)!;
    if (acc >= total * q) return Math.round(bucketMs(k) * 10) / 10;
  }
  return -1;
}

interface DbSnap {
  execMs: number;
  calls: number;
  xact: number;
  t: number;
}

async function dbSnap(ctx: Ctx, ref: string): Promise<DbSnap | null> {
  const r = await sql(
    ctx,
    ref,
    `select (select coalesce(sum(total_exec_time),0) from extensions.pg_stat_statements)::float8 as exec_ms,
            (select coalesce(sum(calls),0) from extensions.pg_stat_statements)::float8 as calls,
            (select sum(xact_commit + xact_rollback) from pg_stat_database)::float8 as xact`,
    20_000,
  );
  const row = r.rows?.[0];
  if (!row) return null;
  return { execMs: Number(row.exec_ms), calls: Number(row.calls), xact: Number(row.xact), t: Date.now() };
}

interface ActSample {
  t: number;
  active: number;
  idle: number;
  idleTx: number;
  other: number;
  waits: string;
}

async function actSample(ctx: Ctx, ref: string): Promise<ActSample | null> {
  const r = await sql(
    ctx,
    ref,
    `select count(*) filter (where state = 'active')::int as active,
            count(*) filter (where state = 'idle')::int as idle,
            count(*) filter (where state like 'idle in transaction%')::int as idle_tx,
            count(*) filter (where state is null or state not in ('active','idle') and state not like 'idle in transaction%')::int as other,
            coalesce((select string_agg(w || ':' || n, ' ' order by n desc) from (select coalesce(wait_event_type || '/' || wait_event, 'cpu') as w, count(*) as n
               from pg_stat_activity where usename = 'authenticator' and state = 'active' group by 1) x), '') as waits
       from pg_stat_activity where usename = 'authenticator'`,
    15_000,
  );
  const row = r.rows?.[0];
  if (!row) return null;
  return { t: Date.now(), active: Number(row.active), idle: Number(row.idle), idleTx: Number(row.idle_tx), other: Number(row.other), waits: String(row.waits) };
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : -1);

export interface StepOut {
  c: number;
  res: TestResult;
  rps: number;
  success: number;
}

export async function mixStep(ctx: Ctx, p: DcProject, c: number, id: string, label: string): Promise<StepOut> {
  const n = Math.max(1, Math.ceil(c / K));
  // Boot the isolates before the measured rounds: one 1 s, 1-worker call per client.
  const warm = await Promise.all(Array.from({ length: n }, () => invokeOnce(p, 1, Date.now(), 1)));
  const warmOk = warm.filter((w) => w.status === 200).length;
  const db0 = await dbSnap(ctx, p.ref);
  const t0 = Date.now() + 3_000;
  const scrapes: PoolScrape[] = [];
  const acts: ActSample[] = [];
  let stop = false;
  const mLoop = (async () => {
    while (!stop) {
      const r = await scrapeMetrics(p);
      if (r.s) scrapes.push(r.s);
      await sleep(2_000);
    }
  })();
  const aLoop = (async () => {
    await sleep(Math.max(0, t0 - Date.now()) + 2_000);
    while (!stop) {
      const s = await actSample(ctx, p.ref);
      if (s) acts.push(s);
      await sleep(3_000);
    }
  })();
  const rounds: Promise<Inv[]>[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const startAt = t0 + r * ROUND_S * 1000;
    const fireIn = Math.max(0, startAt - 2_500 - Date.now());
    rounds.push(sleep(fireIn).then(() => Promise.all(Array.from({ length: n }, () => invoke(p, K, startAt, ROUND_S)))));
  }
  const invs = (await Promise.all(rounds)).flat();
  const db1 = await dbSnap(ctx, p.ref);
  stop = true;
  await Promise.all([mLoop, aLoop]);

  // Aggregate the generator side.
  const hist = new Map<number, number>();
  const opHist: Record<string, Map<number, number>> = {};
  const opStatus: Record<string, Record<string, number>> = {};
  const status: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const samples: Record<string, string> = {};
  const colos: Record<string, number> = {};
  const isolates = new Set<string>();
  const invStatus: Record<string, number> = {};
  const served: Record<string, number> = {};
  const perInvRps: number[] = [];
  const lagP99: number[] = [];
  let lagMax = 0;
  let lateMax = 0;
  const failCounts: Record<string, number> = {};
  const failSamples: Record<string, string> = {};
  let okInv = 0;
  let invErr = "";
  for (const v of invs) {
    invStatus[String(v.status)] = (invStatus[String(v.status)] ?? 0) + 1;
    for (const [st, cnt] of Object.entries(v.failCounts ?? {})) failCounts[st] = (failCounts[st] ?? 0) + cnt;
    for (const [st, body] of Object.entries(v.failed)) failSamples[st] ??= body;
    if (v.served) served[v.served] = (served[v.served] ?? 0) + 1;
    if (!v.body) {
      if (!invErr) invErr = `${v.status} ${v.err}`;
      continue;
    }
    const b = v.body;
    isolates.add(b.isolate);
    lagP99.push(b.lagP99);
    lagMax = Math.max(lagMax, b.lagMax);
    lateMax = Math.max(lateMax, b.lateMs);
    okInv++;
    let invN = 0;
    for (const [op, s] of Object.entries(b.stats)) {
      invN += s.n;
      const oh = (opHist[op] ??= new Map());
      for (const [k, cnt] of Object.entries(s.hist)) {
        hist.set(Number(k), (hist.get(Number(k)) ?? 0) + cnt);
        oh.set(Number(k), (oh.get(Number(k)) ?? 0) + cnt);
      }
      const os = (opStatus[op] ??= {});
      for (const [st, cnt] of Object.entries(s.status)) {
        os[st] = (os[st] ?? 0) + cnt;
        status[st] = (status[st] ?? 0) + cnt;
      }
    }
    perInvRps.push(invN / ROUND_S);
    for (const [m, cnt] of Object.entries(b.errors)) errors[m] = (errors[m] ?? 0) + cnt;
    for (const [st, body] of Object.entries(b.samples)) samples[st] ??= body;
    for (const [co, cnt] of Object.entries(b.colos)) colos[co] = (colos[co] ?? 0) + cnt;
  }
  const answered = Object.values(status).reduce((a, b) => a + b, 0);
  const ok = Object.entries(status)
    .filter(([s]) => Number(s) >= 200 && Number(s) < 300)
    .reduce((a, [, v]) => a + v, 0);
  const clientErr = Object.values(errors).reduce((a, b) => a + b, 0);
  const durS = ROUNDS * ROUND_S;
  const rps = Math.round(answered / durS);
  const success = answered + clientErr ? Math.round((1000 * ok) / (answered + clientErr)) / 1000 : 0;

  // Server side.
  const s = scrapes.length > 2 ? scrapes.slice(1) : scrapes;
  const tuples = [...new Set(s.filter((x) => x.waiting >= 0).map((x) => `${x.waiting}/${x.available}/${x.max}`))];
  // waiting - (max - available) is a lower bound on requests queued for a connection (waiting = queued + in use; in use <= max - available).
  const queuedLb = s.filter((x) => x.waiting >= 0).map((x) => ({ q: x.waiting - (x.max - x.available), a: x.available }));
  const queuedWithFree = queuedLb.filter((x) => x.q > 0 && x.a > 0);
  const first = s[0];
  const last = s[s.length - 1];
  const db = first && last ? last.busy - first.busy : 0;
  const di = first && last ? last.idle - first.idle : 0;
  const cpuPct = db + di > 0 ? Math.round((1000 * db) / (db + di)) / 10 : -1;
  const dbS = db0 && db1 ? (db1.t - db0.t) / 1000 : 0;
  const execMsPerS = db0 && db1 && dbS > 0 ? Math.round((db1.execMs - db0.execMs) / dbS) : -1;
  const callsPerS = db0 && db1 && dbS > 0 ? Math.round((db1.calls - db0.calls) / dbS) : -1;
  const xactPerS = db0 && db1 && dbS > 0 ? Math.round((db1.xact - db0.xact) / dbS) : -1;
  const actives = acts.map((a) => a.active);
  const idles = acts.map((a) => a.idle);
  const idleTx = acts.map((a) => a.idleTx);
  const waitsTop = acts.map((a) => a.waits).filter(Boolean);

  const opLine = Object.keys(opHist)
    .sort()
    .map((op) => `${op} p50 ${pctFromHist(opHist[op]!, 0.5)} p99 ${pctFromHist(opHist[op]!, 0.99)} [${fmtCounts(opStatus[op]!)}]`)
    .join("; ");
  const res: TestResult = {
    id,
    title: `${label}: c=${c} (${n} clients x ${K})`,
    status: "info",
    detail:
      `${rps} req/s, p50 ${pctFromHist(hist, 0.5)} ms, p95 ${pctFromHist(hist, 0.95)} ms, p99 ${pctFromHist(hist, 0.99)} ms, success ${success}; ` +
      `pool snapshots ${tuples.join(",") || "none"}; queued-with-free max ${queuedWithFree.length ? Math.max(...queuedWithFree.map((x) => x.q)) : 0}; ` +
      `authenticator active med ${median(actives)} max ${actives.length ? Math.max(...actives) : -1}, idle med ${median(idles)}; ` +
      `exec ${execMsPerS} ms/s; node CPU ${cpuPct} %; isolates ${isolates.size}; lag p99 med ${median(lagP99)} ms`,
    measurements: {
      concurrency: c,
      clients: n,
      workers_per_client: K,
      round_s: ROUND_S,
      rounds: ROUNDS,
      rps,
      p50_ms: pctFromHist(hist, 0.5),
      p95_ms: pctFromHist(hist, 0.95),
      p99_ms: pctFromHist(hist, 0.99),
      success_rate: success,
      statuses: fmtCounts(status) || "none",
      client_errors: (fmtCounts(errors) || "none").slice(0, 300),
      per_op: opLine,
      pool_snapshots: tuples.join(",") || "none",
      pool_scrapes: s.length,
      queued_with_free_snapshots: queuedWithFree.length,
      queued_with_free_max: queuedWithFree.length ? Math.max(...queuedWithFree.map((x) => x.q)) : 0,
      auth_samples: acts.length,
      auth_active_med: median(actives),
      auth_active_max: actives.length ? Math.max(...actives) : -1,
      auth_idle_med: median(idles),
      auth_idle_min: idles.length ? Math.min(...idles) : -1,
      auth_idle_tx_max: idleTx.length ? Math.max(...idleTx) : -1,
      auth_active_waits: waitsTop.slice(0, 3).join(" | ").slice(0, 300) || "none",
      pg_exec_ms_per_s: execMsPerS,
      pg_calls_per_s: callsPerS,
      pg_xact_per_s: xactPerS,
      node_cpu_pct: cpuPct,
      gen_invocations: invs.length,
      gen_warmup_ok: `${warmOk} of ${n}`,
      gen_invocation_statuses: fmtCounts(invStatus),
      gen_served_region: fmtCounts(served) || "none",
      gen_isolates: isolates.size,
      gen_rps_per_client_min: perInvRps.length ? Math.round(Math.min(...perInvRps)) : -1,
      gen_rps_per_client_med: Math.round(median(perInvRps)),
      gen_rps_per_client_max: perInvRps.length ? Math.round(Math.max(...perInvRps)) : -1,
      gen_lag_p99_med_ms: median(lagP99),
      gen_lag_max_ms: lagMax,
      gen_late_start_max_ms: lateMax,
      gen_failed_attempts: fmtCounts(failCounts) || "none",
      gen_clients_ok_per_round: Math.round((10 * okInv) / ROUNDS) / 10,
      gen_colos: fmtCounts(colos) || "none",
    },
    evidence: redact(
      [
        ...Object.entries(samples).map(([st, b]) => `HTTP ${st} sample (${b})`),
        invErr ? `invocation failure sample: ${invErr}` : "",
        ...Object.entries(failSamples).map(([st, b]) => `failed invocation attempt ${st}: ${b}`),
        `metrics snapshots ${scrapes.map((x) => `${Math.round((x.t - t0) / 1000)}s:${x.waiting}/${x.available}/${x.max}`).join(" ")}`,
        `authenticator samples ${acts.map((a) => `${Math.round((a.t - t0) / 1000)}s:a${a.active}/i${a.idle}/t${a.idleTx}`).join(" ")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  };
  ctx.log(`${id} c=${c}: ${res.detail}`);
  return { c, res, rps, success };
}

const mod: TestModule = {
  id: "DC08",
  title: "In-region clients, application-like mix: does the Data API queue for the pool with idle connections on 4XL?",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC08");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      await ensureItems(ctx, p);
      const setup = await sql(ctx, p.ref, MIX_SQL, 60_000);
      if (setup.error) throw new Error(`mix setup: ${setup.error}`);
      const dep = await deployGen(ctx, p.ref);
      if (dep.status >= 300 || dep.status === 0) throw new Error(`deploy ${SLUG}: ${dep.status} ${dep.text}`);

      if (SIZE !== "none") {
        const before = await sql(ctx, p.ref, "select current_setting('max_connections')::int as m");
        const fromMax = Number(before.rows?.[0]?.m ?? -1);
        const rz = await resize(ctx, p, SIZE, -1, 25 * 60_000, 60, fromMax);
        out.push({
          id: "DC08a",
          title: `Resize to ${SIZE}`,
          status: rz.settledS >= 0 ? "info" : "fail",
          detail: `PATCH ${rz.status}; settled ${rz.settledS} s; max_connections ${fromMax} -> ${rz.maxConn}; watch failures ${rz.watch?.failed ?? -1} of ${rz.watch?.samples ?? -1}; ${rz.text}`,
          measurements: { resize_status: rz.status, settled_s: rz.settledS, max_connections_from: fromMax, max_connections: rz.maxConn, watch_failed: rz.watch?.failed ?? -1 },
        });
        if (rz.settledS < 0) return out;
      }

      // Smoke: one short round from one client, to read the served region and the mix's statuses.
      let smoke: Inv = { status: 0, served: "", err: "not run", failed: {} };
      for (let i = 0; i < 12; i++) {
        smoke = await invoke(p, 2, Date.now() + 1_500, 3);
        if (smoke.status === 200) break;
        await sleep(5_000);
      }
      const m = await scrapeMetrics(p);
      const cfg = await postgrestConfig(ctx, p.ref);
      const mc = await sql(ctx, p.ref, "select current_setting('max_connections')::int as m, (select application_name from pg_stat_activity where usename = 'authenticator' limit 1) as app, (select count(*) from public.dc08_events)::int as ev");
      const smokeStatus = smoke.body ? Object.entries(smoke.body.stats).map(([op, s]) => `${op}[${fmtCounts(s.status)}]`).join(" ") : `invocation ${smoke.status} ${smoke.err}`;
      out.push({
        id: "DC08a",
        title: "Setup: mix, generator region, pool",
        status: smoke.status === 200 ? "info" : "fail",
        detail: `served ${smoke.served} (SB_REGION ${smoke.body?.region ?? "?"}); smoke ${smokeStatus}; pool max ${m.s?.max ?? -1}; db_pool ${cfg.dbPool}; max_connections ${mc.rows?.[0]?.m ?? "?"}; ${mc.rows?.[0]?.app ?? "?"}`,
        measurements: {
          mix: MIX.map(([o, w]) => `${o}:${w}`).join(","),
          workers_per_client: K,
          round_s: ROUND_S,
          rounds_per_step: ROUNDS,
          project_region_requested: REGION,
          gen_served_region: smoke.served,
          gen_sb_region: String(smoke.body?.region ?? ""),
          gen_colos: smoke.body ? fmtCounts(smoke.body.colos) || "none" : "none",
          smoke: smokeStatus,
          pool_max: m.s?.max ?? -1,
          db_pool: cfg.dbPool,
          max_connections: String(mc.rows?.[0]?.m ?? ""),
          postgrest_app: String(mc.rows?.[0]?.app ?? ""),
          pg_version: p.pgVersion,
          events_rows_after_smoke: Number(mc.rows?.[0]?.ev ?? -1),
        },
        evidence: smoke.body ? redact(Object.entries(smoke.body.samples).map(([s, b]) => `HTTP ${s}: ${b}`).join("\n")) : undefined,
      });
      if (smoke.status !== 200) return out;

      const ramp: StepOut[] = [];
      for (const c of STEPS) {
        const r = await mixStep(ctx, p, c, "DC08b", `${SIZE === "none" ? "start size" : SIZE}, db_pool ${cfg.dbPool}`);
        out.push(r.res);
        ramp.push(r);
        const prev = ramp[ramp.length - 2];
        if (r.success < MIN_SUCCESS) break;
        if (prev && r.rps < prev.rps * 1.1) break;
        await sleep(10_000);
      }
      // Knee: the first step whose throughput did not rise 10 % over the one before (or the top step).
      const knee = ramp.length >= 2 ? ramp[ramp.length - 1]!.c : ramp[0]!.c;

      for (const pool of POOLS) {
        const t0 = Date.now();
        const patch = await patchPostgrest(ctx, p.ref, { db_pool: pool });
        const rs = await waitRestart(ctx, p.ref, t0);
        const cfgA = await postgrestConfig(ctx, p.ref);
        await sleep(20_000);
        const r = await mixStep(ctx, p, knee, "DC08c", `db_pool ${pool} (PATCH ${patch.status}, readback ${cfgA.dbPool}, restart ${rs.delayS} s)`);
        r.res.measurements = { ...r.res.measurements, db_pool_set: pool, db_pool_readback: cfgA.dbPool, patch_status: patch.status, restart_delay_s: rs.delayS };
        if (patch.status >= 300) r.res.evidence = `${r.res.evidence ?? ""}\nPATCH body: ${redact(patch.text)}`;
        out.push(r.res);
      }
    } catch (e) {
      out.push({ id: "DC08", title: "DC08", status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
