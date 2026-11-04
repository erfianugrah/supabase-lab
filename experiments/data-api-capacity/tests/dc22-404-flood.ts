/**
 * DC22 - Does a steady stream of Data API requests for tables and functions
 * that do not exist (every answer a 404) slow the project's OTHER Data API
 * requests while the connection pool sits free?
 *
 * The platform question: a client sending about 110 requests a second for
 * missing tables and functions with the legacy anon key; is that enough to
 * queue a project's valid requests behind it, with Postgres idle and the pool
 * mostly free? Readings it separates:
 *   H1  the 404 path is expensive inside PostgREST: the "Perhaps you meant"
 *       hint is a fuzzy search over the schema cache (PostgREST v14.18
 *       src/PostgREST/Error.hs: tables use an index memoised in the schema
 *       cache since PR #4472; functions build a FuzzySet of every function in
 *       the schema on each PGRST202). Predicts: probe latency degrades under a
 *       404 flood and not under the same rate of 200 reads, more so with many
 *       tables/functions in the exposed schema.
 *   H2  it is request rate (gateway, JWT verification), not the 404 path.
 *       Predicts: a 200 flood at the same rate hurts as much.
 *   H3  with legacy API keys disabled, the same flood is refused before
 *       PostgREST and probes with the other keys are unaffected.
 * PostgREST v14.18 App.hs plans a request from the schema cache before
 * `usePool`, so a 404 should never take a pool connection (source-read).
 *
 * Method: per arm, three probes (`oha -q PROBE_Q`, keep-alive, one indexed
 * point read on dc_items) with the legacy anon key, the `sb_secret_` key and
 * the `sb_publishable_` key run PRE_S + FLOOD_S + POST_S; the flood
 * (`oha -q RATE -c C --rand-regex-url`, legacy anon key in apikey and
 * Authorization) starts after PRE_S:
 *   table  GET /rest/v1/zz_<6>_<8>?select=id     (PGRST205)
 *   rpc    POST /rest/v1/rpc/zz_<6>_<8> {}       (PGRST202)
 *   valid  GET /rest/v1/dc_items?id=eq.<4 digits> (200)
 * Arms: control (probes only), then each kind at each of RATES (a kind whose
 * anon probe p50 under flood passes SLOW_MS skips its higher rates).
 * D: create D_TABLES tables and D_FUNCS functions in public, reload the
 * schema cache, wait until the last of each is served, then control and the
 * table and rpc floods at the top rate. E: PUT api-keys/legacy?enabled=false,
 * poll until the anon probe answers 401, then the flood that hurt most (by
 * anon probe p95 under flood; table at the top rate if none did) with the old
 * anon key. Per arm: probe statuses and p50/p95/max per window, flood
 * statuses, achieved rate and latency, pool/JWT-cache/schema-cache series
 * and node CPU from the metrics endpoint (stale snapshots, DC05),
 * `authenticator` states. Sample 404 and 401 bodies with all headers.
 * PVLAB_DC22_PHASES picks base, D, E (above) and two more:
 *   curve  functions added to public in FN_STEPS, then 20 sequential
 *          requests per shape at rest: the gateway's upstream time
 *   S      S_FUNCS functions, one S_RATE flood of S_KIND across S_PERIODS:
 *          probes only, flood, flood after a no-change db_pool PATCH
 *          (restart), flood after legacy keys off, flood stopped; 15 s
 *          buckets of probe and flood statuses, CPU per metrics refresh
 *
 * Not settled here: sizes other than the project's (Small by default),
 * other client vantages (the Mac in Singapore), HTTP/2 floods,
 * PostgREST's own CPU (the metrics endpoint has node CPU only).
 *
 * DESTRUCTIVE: uses the shared project (lib/dc.ts), disables its legacy API
 * keys in E; DC99 deletes the project.
 */
import { loadavg } from "node:os";
import { mgmt } from "../../../harness/src/mgmt.js";
import { logsQuery } from "../../../harness/src/platform.js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { errorsText, pct, runOhaRecorded, type OhaRow, type OhaRun } from "../lib/oha.js";
import { ensureItems, ensureProject, errText, fmtCounts, patchPostgrest, postgrestStarts, redact, skipWithoutPro, sleep, sql, type DcProject } from "../lib/dc.js";

const RATES = (process.env.PVLAB_DC22_RATES || "110,220,440").split(",").filter(Boolean).map(Number);
const KINDS = (process.env.PVLAB_DC22_KINDS || "table,rpc,valid").split(",").filter(Boolean) as Kind[];
const PRE_S = Number(process.env.PVLAB_DC22_PRE_S || 30);
const FLOOD_S = Number(process.env.PVLAB_DC22_FLOOD_S || 150);
const POST_S = Number(process.env.PVLAB_DC22_POST_S || 20);
const GAP_S = Number(process.env.PVLAB_DC22_GAP_S || 20);
const PROBE_Q = Number(process.env.PVLAB_DC22_PROBE_Q || 2);
const C = Number(process.env.PVLAB_DC22_C || 2048);
const SLOW_MS = Number(process.env.PVLAB_DC22_SLOW_MS || 2000);
const D_TABLES = Number(process.env.PVLAB_DC22_D_TABLES || 1000);
const D_FUNCS = Number(process.env.PVLAB_DC22_D_FUNCS || 2000);
const PHASES = (process.env.PVLAB_DC22_PHASES || "base,D,E").split(",");
// Run 2 phases: "curve" (per-request cost against the number of functions in
// public) and "S" (one sustained flood: restart, legacy keys off, flood off).
const FN_STEPS = (process.env.PVLAB_DC22_FN_STEPS || "0,100,250,500,1000,2000").split(",").filter(Boolean).map(Number);
const S_FUNCS = Number(process.env.PVLAB_DC22_S_FUNCS || 500);
const S_RATE = Number(process.env.PVLAB_DC22_S_RATE || 110);
const S_KIND = (process.env.PVLAB_DC22_S_KIND || "rpc") as Kind;
/** Seconds per S period: probes only, flood, flood after a no-change PATCH (restart), flood after legacy keys off, probes only. */
const S_PERIODS = (process.env.PVLAB_DC22_S_PERIODS || "30,120,120,180,300").split(",").map(Number);

type Kind = "table" | "rpc" | "valid";
type Probe = "anon" | "secret" | "publishable";

interface NewKeys {
  secret: string;
  publishable: string;
}

const PROBE_PATH = "/rest/v1/dc_items?id=eq.4242&select=id,payload";

function floodSpec(p: DcProject, kind: Kind): { url: string; extra: string[] } {
  if (kind === "table") return { url: `https://${p.host}/rest/v1/zz_[a-z]{6}_[a-z]{8}\\?select=id`, extra: [] };
  if (kind === "rpc") return { url: `https://${p.host}/rest/v1/rpc/zz_[a-z]{6}_[a-z]{8}`, extra: ["-m", "POST", "-T", "application/json", "-d", "{}"] };
  return { url: `https://${p.host}/rest/v1/dc_items\\?id=eq.[1-9][0-9]{3}&select=id,payload`, extra: [] };
}

function probeHeaders(p: DcProject, k: NewKeys, probe: Probe): Record<string, string> {
  if (probe === "anon") return { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` };
  return { apikey: probe === "secret" ? k.secret : k.publishable };
}

async function newKeys(ctx: Ctx, ref: string): Promise<NewKeys> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const rows = (Array.isArray(r.json) ? r.json : []) as { name?: string; type?: string; api_key?: string }[];
  const pick = (t: string) => rows.find((x) => x.type === t && (x.api_key ?? "").startsWith(`sb_${t}_`))?.api_key ?? "";
  return { secret: pick("secret"), publishable: pick("publishable") };
}

const KEEP = /^(server|via|cf-ray|cf-cache-status|x-|sb-|proxy-status|content-type|content-profile|server-timing|www-authenticate|retry-after)/;
const ipv4 = /\b\d{1,3}(\.\d{1,3}){3}\b/g;

/** One request with every useful response header (server-timing included), for sample bodies. */
async function sample(host: string, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<string> {
  const t0 = performance.now();
  try {
    const res = await fetch(`https://${host}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = (await res.text()).replace(/\s+/g, " ").slice(0, 400);
    const ms = Math.round(performance.now() - t0);
    const h: string[] = [];
    res.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (KEEP.test(lk) && lk !== "sb-jwt-sub") h.push(`${lk}=${v}`);
    });
    return redact(`${method} ${path.replace(/\?.*/, "")} -> ${res.status} ${ms} ms body ${text} headers ${h.sort().join("; ")}`).replace(ipv4, "<ip>");
  } catch (e) {
    return `${method} ${path} -> client error ${errText(e)}`;
  }
}

interface Up {
  t: number;
  status: number;
  /** Body and headers when the status is not 200/404/401. */
  note?: string;
  ms: number;
  /** x-envoy-upstream-service-time: the gateway's time to the upstream's response headers, -1 when absent. */
  up: number;
}

/** One request, keeping status, client time and the gateway's upstream time. */
async function timed(host: string, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Up> {
  const t0 = performance.now();
  try {
    const res = await fetch(`https://${host}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    const u = res.headers.get("x-envoy-upstream-service-time");
    let note: string | undefined;
    if (![200, 401, 404].includes(res.status)) {
      const h: string[] = [];
      res.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (KEEP.test(lk) && lk !== "sb-jwt-sub") h.push(`${lk}=${v}`);
      });
      note = redact(`${method} ${path.replace(/\?.*/, "")} -> ${res.status} body ${text.replace(/\s+/g, " ").slice(0, 300)} headers ${h.sort().join("; ")}`).replace(ipv4, "<ip>");
    }
    return { t: Date.now(), status: res.status, ms: Math.round(performance.now() - t0), up: u === null ? -1 : Number(u), note };
  } catch (e) {
    return { t: Date.now(), status: 0, ms: Math.round(performance.now() - t0), up: -1, note: `client error ${errText(e)}` };
  }
}

const rnd = () => `zz_${Math.random().toString(36).slice(2, 8)}_${Math.random().toString(36).slice(2, 10)}`;

function shapeReq(p: DcProject, kind: Kind, h: Record<string, string>): Promise<Up> {
  if (kind === "table") return timed(p.host, "GET", `/rest/v1/${rnd()}?select=id`, h);
  if (kind === "rpc") return timed(p.host, "POST", `/rest/v1/rpc/${rnd()}`, h, {});
  return timed(p.host, "GET", `/rest/v1/dc_items?id=eq.${1000 + Math.floor(Math.random() * 9000)}&select=id,payload`, h);
}

const upTxt = (xs: Up[]) => {
  const u = xs.filter((x) => x.up >= 0).map((x) => x.up);
  const c: Record<string, number> = {};
  for (const x of xs) c[String(x.status)] = (c[String(x.status)] ?? 0) + 1;
  return { n: xs.length, statuses: fmtCounts(c) || "none", p50: Math.round(pct(u, 0.5)), p95: Math.round(pct(u, 0.95)), max: u.length ? Math.max(...u) : -1, withUp: u.length };
};

/** N sequential requests of each shape at rest: the gateway's upstream time per shape (H1's per-request cost, single request). */
async function atRest(p: DcProject, n: number): Promise<{ text: string; m: Record<string, number> }> {
  const h = { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` };
  const parts: string[] = [];
  const m: Record<string, number> = {};
  for (const kind of ["valid", "table", "rpc"] as Kind[]) {
    const xs: Up[] = [];
    for (let i = 0; i < n; i++) xs.push(await shapeReq(p, kind, h));
    const t = upTxt(xs);
    m[`rest_${kind}_upstream_p50_ms`] = t.p50;
    m[`rest_${kind}_upstream_max_ms`] = t.max;
    m[`rest_${kind}_client_p50_ms`] = Math.round(pct(xs.map((x) => x.ms), 0.5));
    parts.push(`${kind}: ${t.statuses} upstream p50/p95/max ${t.p50}/${t.p95}/${t.max} ms (n ${t.withUp}), client p50 ${m[`rest_${kind}_client_p50_ms`]} ms`);
  }
  return { text: parts.join("; "), m };
}

/** Statuses per 30 s of send time, from `fromMs`. */
function timeline(run: OhaRun, fromMs: number): string {
  const b = new Map<number, Record<string, number>>();
  for (const r of run.rows) {
    const k = Math.floor((run.t0 + r.start * 1000 - fromMs) / 30_000) * 30;
    const o = b.get(k) ?? {};
    o[String(r.status)] = (o[String(r.status)] ?? 0) + 1;
    b.set(k, o);
  }
  return [...b.entries()].sort((a, c) => a[0] - c[0]).map(([k, o]) => `+${k}s ${fmtCounts(o)}`).join(", ");
}

interface Scrape {
  t: number;
  waiting: number;
  available: number;
  max: number;
  timeouts: number;
  jwtReq: number;
  jwtHits: number;
  schemaLoads: number;
  schemaQueryS: number;
  busy: number;
  idle: number;
}

/** The metrics endpoint with a chosen Basic password (legacy service_role, or the secret key once legacy keys are off). */
async function scrape(host: string, pass: string): Promise<{ status: number; s: Scrape | null }> {
  try {
    const res = await fetch(`https://${host}/customer/v1/privileged/metrics`, {
      headers: { Authorization: `Basic ${Buffer.from(`service_role:${pass}`).toString("base64")}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { status: res.status, s: null };
    const s: Scrape = { t: Date.now(), waiting: 0, available: 0, max: 0, timeouts: 0, jwtReq: 0, jwtHits: 0, schemaLoads: 0, schemaQueryS: 0, busy: 0, idle: 0 };
    for (const line of (await res.text()).split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const name = line.split(/[{ ]/)[0] ?? "";
      const v = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (name === "pgrst_db_pool_waiting") s.waiting += v;
      else if (name === "pgrst_db_pool_available") s.available += v;
      else if (name === "pgrst_db_pool_max") s.max += v;
      else if (name === "pgrst_db_pool_timeouts_total") s.timeouts += v;
      else if (name === "pgrst_jwt_cache_requests_total") s.jwtReq += v;
      else if (name === "pgrst_jwt_cache_hits_total") s.jwtHits += v;
      else if (name === "pgrst_schema_cache_loads_total") s.schemaLoads += v;
      else if (name === "pgrst_schema_cache_query_time_seconds") s.schemaQueryS += v;
      else if (name === "node_cpu_seconds_total") {
        if (line.includes('mode="idle"')) s.idle += v;
        else if (!line.includes('mode="steal"') && !line.includes('mode="guest')) s.busy += v;
      }
    }
    return { status: res.status, s };
  } catch {
    return { status: 0, s: null };
  }
}

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

interface Win {
  n: number;
  statuses: string;
  p50: number;
  p95: number;
  max: number;
}

/** Rows whose send time falls in [fromMs, toMs) of wall clock. */
function win(run: OhaRun, fromMs: number, toMs: number): Win {
  const rows = run.rows.filter((r: OhaRow) => {
    const t = run.t0 + r.start * 1000;
    return t >= fromMs && t < toMs;
  });
  const c: Record<string, number> = {};
  for (const r of rows) c[String(r.status)] = (c[String(r.status)] ?? 0) + 1;
  const d = rows.map((r) => r.duration * 1000);
  return { n: rows.length, statuses: fmtCounts(c) || "none", p50: Math.round(pct(d, 0.5)), p95: Math.round(pct(d, 0.95)), max: d.length ? Math.round(Math.max(...d)) : -1 };
}

const wtxt = (w: Win) => `n ${w.n} ${w.statuses} p50/p95/max ${w.p50}/${w.p95}/${w.max} ms`;

interface ArmOut {
  res: TestResult;
  anonFloodP50: number;
  anonFloodP95: number;
}

async function arm(ctx: Ctx, p: DcProject, k: NewKeys, label: string, kind: Kind | null, rate: number, metricsPass: string): Promise<ArmOut> {
  const total = PRE_S + FLOOD_S + POST_S;
  const probes: Probe[] = ["anon", "secret", "publishable"];
  const probeRuns = probes.map((pr) =>
    runOhaRecorded(`https://${p.host}${PROBE_PATH}`, ["-q", String(PROBE_Q), "-c", "16", "-z", `${total}s`, "-t", "60s", "-w"], probeHeaders(p, k, pr)),
  );
  const tStart = Date.now();
  let stop = false;
  const scrapes: Scrape[] = [];
  let scrapeStatus = 0;
  const states: string[] = [];
  const loads: number[] = [];
  const sampler = (async () => {
    let i = 0;
    while (!stop) {
      const m = await scrape(p.host, metricsPass);
      scrapeStatus = m.status;
      if (m.s) scrapes.push(m.s);
      if (i % 3 === 0) states.push(await authStates(ctx, p.ref));
      loads.push(Math.round(loadavg()[0]! * 10) / 10);
      i++;
      await sleep(5_000);
    }
  })();

  await sleep(PRE_S * 1000);
  const floodStart = Date.now();
  let flood: OhaRun | null = null;
  let samples = "";
  let upStats: Record<string, number> = {};
  if (kind) {
    const spec = floodSpec(p, kind);
    const fP = runOhaRecorded(spec.url, ["--rand-regex-url", ...spec.extra, "-q", String(rate), "-c", String(C), "-z", `${FLOOD_S}s`, "-t", "60s", "-w"], {
      apikey: p.keys.anon,
      Authorization: `Bearer ${p.keys.anon}`,
    });
    const upProbe: Up[] = [];
    const upFlood: Up[] = [];
    let upStop = false;
    const upLoop = (async () => {
      const ah = { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` };
      while (!upStop && Date.now() < floodStart + FLOOD_S * 1000 - 3_000) {
        const [a, b] = await Promise.all([timed(p.host, "GET", PROBE_PATH, ah), shapeReq(p, kind, ah)]);
        upProbe.push(a);
        upFlood.push(b);
        await sleep(3_000);
      }
    })();
    await sleep(20_000);
    // One request of the flood's shape and one probe, with headers, 20 s into the flood.
    const nm = `zz_sample_${Date.now() % 100000}`;
    const anonH = { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` };
    const s1 =
      kind === "table" ? await sample(p.host, "GET", `/rest/v1/${nm}?select=id`, anonH) : kind === "rpc" ? await sample(p.host, "POST", `/rest/v1/rpc/${nm}`, anonH, {}) : await sample(p.host, "GET", PROBE_PATH, anonH);
    const s2 = await sample(p.host, "GET", PROBE_PATH, { apikey: k.secret });
    flood = await fP;
    upStop = true;
    await upLoop;
    const a = upTxt(upProbe);
    const b = upTxt(upFlood);
    upStats = { probe_upstream_p50_ms: a.p50, probe_upstream_p95_ms: a.p95, probe_upstream_max_ms: a.max, probe_upstream_n: a.withUp, shape_upstream_p50_ms: b.p50, shape_upstream_p95_ms: b.p95, shape_upstream_max_ms: b.max, shape_upstream_n: b.withUp };
    samples = `flood-shape: ${s1} || secret probe: ${s2} || every 3 s under the flood: anon probe ${a.statuses} upstream p50/p95/max ${a.p50}/${a.p95}/${a.max} ms; flood-shape ${b.statuses} upstream p50/p95/max ${b.p50}/${b.p95}/${b.max} ms || flood statuses by send time: ${timeline(flood, floodStart)} || anon probe statuses by send time: ${"PROBE_TL"}`;
  } else {
    const upProbe: Up[] = [];
    const ah = { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` };
    while (Date.now() < floodStart + FLOOD_S * 1000 - 3_000) {
      upProbe.push(await timed(p.host, "GET", PROBE_PATH, ah));
      await sleep(3_000);
    }
    const a = upTxt(upProbe);
    upStats = { probe_upstream_p50_ms: a.p50, probe_upstream_p95_ms: a.p95, probe_upstream_max_ms: a.max, probe_upstream_n: a.withUp };
    samples = `every 3 s: anon probe ${a.statuses} upstream p50/p95/max ${a.p50}/${a.p95}/${a.max} ms`;
    await sleep(Math.max(0, floodStart + FLOOD_S * 1000 - Date.now()));
  }
  const floodEnd = floodStart + FLOOD_S * 1000;
  const pr = await Promise.all(probeRuns);
  stop = true;
  await sampler;

  samples = samples.replace("PROBE_TL", timeline(pr[0]!, floodStart));
  const m: Record<string, number | string> = { arm: label, kind: kind ?? "none", rate: kind ? rate : 0, ...upStats };
  const parts: string[] = [];
  probes.forEach((name, i) => {
    const run = pr[i]!;
    const pre = win(run, tStart, floodStart);
    const fl = win(run, floodStart, floodEnd);
    const post = win(run, floodEnd, floodEnd + POST_S * 1000 + 60_000);
    m[`${name}_pre_p50_ms`] = pre.p50;
    m[`${name}_flood_n`] = fl.n;
    m[`${name}_flood_statuses`] = fl.statuses;
    m[`${name}_flood_p50_ms`] = fl.p50;
    m[`${name}_flood_p95_ms`] = fl.p95;
    m[`${name}_flood_max_ms`] = fl.max;
    m[`${name}_post_p50_ms`] = post.p50;
    m[`${name}_client_errors`] = errorsText(run.errors);
    parts.push(`${name}: pre ${wtxt(pre)}; flood ${wtxt(fl)}; post ${wtxt(post)}`);
  });
  if (flood) {
    const d = flood.rows.map((r) => r.duration * 1000);
    m.flood_answered = flood.rows.length;
    m.flood_rps = flood.rps;
    m.flood_statuses = flood.statuses;
    m.flood_p50_ms = Math.round(pct(d, 0.5));
    m.flood_p95_ms = Math.round(pct(d, 0.95));
    m.flood_max_ms = d.length ? Math.round(Math.max(...d)) : -1;
    m.flood_client_errors = errorsText(flood.errors);
    parts.push(`flood: ${flood.rows.length} answered, ${flood.rps} req/s, ${flood.statuses}, p50/p95/max ${m.flood_p50_ms}/${m.flood_p95_ms}/${m.flood_max_ms} ms, client errors ${m.flood_client_errors}`);
  }
  // Pool and caches over the flood window; CPU between the first and last distinct snapshots.
  const inFlood = scrapes.filter((s) => s.t >= floodStart && s.t <= floodEnd + 10_000);
  const distinct = scrapes.filter((s, i) => i === 0 || s.busy !== scrapes[i - 1]!.busy || s.idle !== scrapes[i - 1]!.idle);
  const first = distinct[0];
  const last = distinct[distinct.length - 1];
  const cpu = first && last && last !== first ? Math.round((1000 * (last.busy - first.busy)) / (last.busy - first.busy + last.idle - first.idle)) / 10 : -1;
  m.metrics_status = scrapeStatus;
  m.pool_waiting_max = inFlood.length ? Math.max(...inFlood.map((s) => s.waiting)) : -1;
  m.pool_available_min = inFlood.length ? Math.min(...inFlood.map((s) => s.available)) : -1;
  m.pool_max = scrapes.at(-1)?.max ?? -1;
  m.pool_timeouts_delta = scrapes.length > 1 ? scrapes.at(-1)!.timeouts - scrapes[0]!.timeouts : -1;
  m.jwt_cache_requests_delta = scrapes.length > 1 ? scrapes.at(-1)!.jwtReq - scrapes[0]!.jwtReq : -1;
  m.jwt_cache_hits_delta = scrapes.length > 1 ? scrapes.at(-1)!.jwtHits - scrapes[0]!.jwtHits : -1;
  m.schema_cache_loads = scrapes.at(-1)?.schemaLoads ?? -1;
  m.metric_refreshes = distinct.length;
  m.node_cpu_busy_pct = cpu;
  m.cpu_window_s = first && last ? Math.round((last.t - first.t) / 1000) : -1;
  m.authenticator_states = states.join(" | ").slice(0, 400);
  m.mac_load1_max = loads.length ? Math.max(...loads) : -1;
  parts.push(
    `pool waiting max ${m.pool_waiting_max}, available min ${m.pool_available_min} of ${m.pool_max}; jwt cache +${m.jwt_cache_requests_delta} req +${m.jwt_cache_hits_delta} hits; node CPU ${cpu}% over ${m.cpu_window_s} s (${distinct.length} refreshes); authenticator ${m.authenticator_states}; Mac load1 max ${m.mac_load1_max}`,
  );
  const anonFl = win(pr[0]!, floodStart, floodEnd);
  return {
    anonFloodP50: anonFl.p50,
    anonFloodP95: anonFl.p95,
    res: {
      id: "DC22",
      title: `${label}: ${kind ? `${kind} flood at ${rate} req/s` : "probes only"}`,
      status: "info",
      detail: redact(parts.join(" || ")).replace(ipv4, "<ip>"),
      measurements: m,
      evidence: samples || undefined,
    },
  };
}

const D_SQL = `
set statement_timeout = '600s';
do $$ begin
  for i in 1..${D_TABLES} loop
    execute format('create table if not exists public.dc22_t_%s (id int primary key, v text)', lpad(i::text, 5, '0'));
  end loop;
  for i in 1..${D_FUNCS} loop
    execute format('create or replace function public.dc22_f_%s(a int) returns int language sql immutable as ''select a + %s''', lpad(i::text, 5, '0'), i);
  end loop;
end $$;
grant select on all tables in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
notify pgrst, 'reload schema';`;

async function counts(ctx: Ctx, ref: string): Promise<string> {
  const r = await sql(
    ctx,
    ref,
    `select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','v','m','p','f'))::int as rels,
            (select count(*) from pg_proc where pronamespace = 'public'::regnamespace)::int as procs`,
  );
  const row = r.rows?.[0];
  return row ? `public: ${row.rels} relations, ${row.procs} functions` : `error ${r.error ?? r.status}`;
}

async function untilServed(p: DcProject, path: string, method: string, maxS = 300): Promise<{ s: number; status: number }> {
  const t0 = Date.now();
  let st = 0;
  while (Date.now() - t0 < maxS * 1000) {
    const res = await fetch(`https://${p.host}${path}`, {
      method,
      headers: { apikey: p.keys.service, Authorization: `Bearer ${p.keys.service}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      body: method === "POST" ? JSON.stringify({ a: 1 }) : undefined,
    }).catch(() => null);
    st = res?.status ?? 0;
    await res?.text().catch(() => "");
    if (st && st !== 404) return { s: Math.round((Date.now() - t0) / 1000), status: st };
    await sleep(2_000);
  }
  return { s: -1, status: st };
}

async function setFunctions(ctx: Ctx, p: DcProject, n: number, have: number): Promise<{ ddlS: number; servedS: number; error: string }> {
  const t0 = Date.now();
  const q =
    n >= have
      ? `set statement_timeout = '600s'; do $$ begin for i in ${have + 1}..${n} loop execute format('create or replace function public.dc22_f_%s(a int) returns int language sql immutable as ''select a + %s''', lpad(i::text, 5, '0'), i); end loop; end $$; grant execute on all functions in schema public to anon, authenticated, service_role; notify pgrst, 'reload schema';`
      : `set statement_timeout = '600s'; do $$ begin for i in ${n + 1}..${have} loop execute format('drop function if exists public.dc22_f_%s(int)', lpad(i::text, 5, '0')); end loop; end $$; notify pgrst, 'reload schema';`;
  const r = await sql(ctx, p.ref, q, 600_000);
  const ddlS = Math.round((Date.now() - t0) / 1000);
  if (r.error) return { ddlS, servedS: -1, error: r.error };
  // Served: the last function answers (growing), or the first dropped one 404s (shrinking).
  const t1 = Date.now();
  if (n === have) return { ddlS, servedS: 0, error: "" };
  const h = { apikey: p.keys.service, Authorization: `Bearer ${p.keys.service}`, "Content-Type": "application/json" };
  const grow = n > have;
  const probeName = String(grow ? n : n + 1).padStart(5, "0");
  while (Date.now() - t1 < 300_000) {
    const res = await fetch(`https://${p.host}/rest/v1/rpc/dc22_f_${probeName}`, { method: "POST", headers: h, body: JSON.stringify({ a: 1 }) }).catch(() => null);
    const st = res?.status ?? 0;
    await res?.text().catch(() => "");
    if (grow ? st === 200 : st === 404) return { ddlS, servedS: Math.round((Date.now() - t1) / 1000), error: "" };
    await sleep(2_000);
  }
  return { ddlS, servedS: -1, error: "not served within 300 s" };
}

/** Per-request cost of each shape against the number of functions in public, single sequential requests. */
async function curve(ctx: Ctx, p: DcProject): Promise<{ results: TestResult[]; have: number }> {
  const results: TestResult[] = [];
  let have = 0;
  for (const n of FN_STEPS) {
    const f = await setFunctions(ctx, p, n, have);
    have = n;
    await sleep(5_000);
    const c = await counts(ctx, p.ref);
    const r = await atRest(p, 20);
    results.push({
      id: "DC22f",
      title: `${n} added functions in public: per-request upstream time, 20 sequential requests per shape`,
      status: f.error ? "fail" : "info",
      detail: `${c}; DDL ${f.ddlS} s, served after ${f.servedS} s${f.error ? ` (${f.error})` : ""}; ${r.text}`,
      measurements: { added_functions: n, schema: c, ...r.m },
    });
    ctx.log(`DC22f n=${n}: ${r.text}`);
  }
  return { results, have };
}

interface Bucket15 {
  t: number;
  probe: Record<Probe, { st: Record<string, number>; d: number[] }>;
  flood: Record<string, number>;
}

/** One sustained flood across the periods of S_PERIODS, with events at the period boundaries. */
async function sustained(ctx: Ctx, p: DcProject, k: NewKeys): Promise<TestResult[]> {
  const [preS, onS, restartS, offKeysS, offS] = S_PERIODS as [number, number, number, number, number];
  const total = preS + onS + restartS + offKeysS + offS;
  const floodS = onS + restartS + offKeysS;
  const probes: Probe[] = ["anon", "secret", "publishable"];
  const probeRuns = probes.map((pr) =>
    runOhaRecorded(`https://${p.host}${PROBE_PATH}`, ["-q", String(PROBE_Q), "-c", "16", "-z", `${total}s`, "-t", "60s", "-w"], probeHeaders(p, k, pr)),
  );
  const t0 = Date.now();
  let stop = false;
  const scrapes: Scrape[] = [];
  const ups: { probe: Up; shape: Up }[] = [];
  const sampler = (async () => {
    while (!stop) {
      const m = await scrape(p.host, k.secret);
      if (m.s) scrapes.push(m.s);
      await sleep(5_000);
    }
  })();
  const upLoop = (async () => {
    const ah = { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` };
    while (!stop) {
      const [a, b] = await Promise.all([timed(p.host, "GET", PROBE_PATH, { apikey: k.secret }), shapeReq(p, S_KIND, ah)]);
      ups.push({ probe: a, shape: b });
      await sleep(3_000);
    }
  })();

  await sleep(preS * 1000);
  const floodStart = Date.now();
  const spec = floodSpec(p, S_KIND);
  const fP = runOhaRecorded(spec.url, ["--rand-regex-url", ...spec.extra, "-q", String(S_RATE), "-c", String(C), "-z", `${floodS}s`, "-t", "60s", "-w"], {
    apikey: p.keys.anon,
    Authorization: `Bearer ${p.keys.anon}`,
  });
  await sleep(onS * 1000);
  const tRestart = Date.now();
  const before = await scrape(p.host, k.secret);
  const poolNow = before.s?.max && before.s.max > 0 ? before.s.max : 30;
  const patch = await patchPostgrest(ctx, p.ref, { db_pool: poolNow });
  await sleep(Math.max(0, tRestart + restartS * 1000 - Date.now()));
  const tKeysOff = Date.now();
  const off = await mgmt(ctx, "PUT", `/projects/${p.ref}/api-keys/legacy?enabled=false`);
  const flood = await fP;
  const tFloodEnd = Date.now();
  const pr = await Promise.all(probeRuns);
  stop = true;
  await sampler;
  await upLoop;
  const starts = await postgrestStarts(ctx, p.ref, t0 - 60_000);

  // 15 s buckets by send time from the flood start.
  const B = 15_000;
  const key = (t: number) => Math.floor((t - floodStart) / B);
  const buckets = new Map<number, Bucket15>();
  const get = (i: number): Bucket15 => {
    let b = buckets.get(i);
    if (!b) {
      b = { t: i * 15, probe: { anon: { st: {}, d: [] }, secret: { st: {}, d: [] }, publishable: { st: {}, d: [] } }, flood: {} };
      buckets.set(i, b);
    }
    return b;
  };
  probes.forEach((name, i) => {
    const run = pr[i]!;
    for (const r of run.rows) {
      const b = get(key(run.t0 + r.start * 1000)).probe[name];
      b.st[String(r.status)] = (b.st[String(r.status)] ?? 0) + 1;
      b.d.push(r.duration * 1000);
    }
  });
  for (const r of flood.rows) {
    const b = get(key(flood.t0 + r.start * 1000)).flood;
    b[String(r.status)] = (b[String(r.status)] ?? 0) + 1;
  }
  // CPU per metrics refresh interval.
  const distinct = scrapes.filter((x, i) => i === 0 || x.busy !== scrapes[i - 1]!.busy || x.idle !== scrapes[i - 1]!.idle);
  const cpuTl = distinct
    .slice(1)
    .map((x, i) => {
      const a = distinct[i]!;
      const pctBusy = Math.round((1000 * (x.busy - a.busy)) / (x.busy - a.busy + x.idle - a.idle)) / 10;
      return `+${Math.round((x.t - floodStart) / 1000)}s ${pctBusy}% (waiting ${x.waiting}, available ${x.available}/${x.max})`;
    })
    .join(", ");
  const rows = [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map(
      (b) =>
        `+${b.t}s anon ${fmtCounts(b.probe.anon.st) || "-"} p50 ${Math.round(pct(b.probe.anon.d, 0.5))}; secret ${fmtCounts(b.probe.secret.st) || "-"} p50 ${Math.round(pct(b.probe.secret.d, 0.5))}; publishable ${fmtCounts(b.probe.publishable.st) || "-"} p50 ${Math.round(pct(b.probe.publishable.d, 0.5))}; flood ${fmtCounts(b.flood) || "-"}`,
    );
  const rel = (t: number) => Math.round((t - floodStart) / 1000);
  const periods: [string, number, number][] = [
    ["pre", t0, floodStart],
    ["flood", floodStart, tRestart],
    ["after restart PATCH", tRestart, tKeysOff],
    ["after legacy keys off", tKeysOff, tFloodEnd],
    ["flood stopped", tFloodEnd, tFloodEnd + offS * 1000 + 60_000],
  ];
  const m: Record<string, number | string> = {
    s_functions: S_FUNCS,
    s_rate: S_RATE,
    s_kind: S_KIND,
    restart_patch_status: patch.status,
    restart_patch_db_pool: poolNow,
    restart_patch_at_s: rel(tRestart),
    legacy_off_status: off.status,
    legacy_off_at_s: rel(tKeysOff),
    flood_end_at_s: rel(tFloodEnd),
    flood_rps: flood.rps,
    flood_answered: flood.rows.length,
    flood_statuses: flood.statuses,
    flood_client_errors: errorsText(flood.errors),
    postgrest_starts: starts.count,
  };
  const ptxt: string[] = [];
  for (const [name, a, b] of periods) {
    for (const [i, pn] of probes.entries()) {
      const w = win(pr[i]!, a, b);
      const slug = name.replace(/[^a-z]+/g, "_");
      m[`${pn}_${slug}_p50_ms`] = w.p50;
      m[`${pn}_${slug}_p95_ms`] = w.p95;
      m[`${pn}_${slug}_max_ms`] = w.max;
      m[`${pn}_${slug}_statuses`] = w.statuses;
      ptxt.push(`${name} ${pn}: ${wtxt(w)}`);
    }
  }
  const odd = ups.flatMap((u) => [u.probe.note, u.shape.note]).filter(Boolean) as string[];
  const oddKinds = new Map<string, string>();
  for (const o of odd) {
    const st = o.match(/-> (\d+)/)?.[1] ?? "client";
    if (!oddKinds.has(st)) oddKinds.set(st, o);
  }
  const upTl = ups
    .filter((_, i) => i % 5 === 0)
    .map((u) => `+${rel(u.probe.t)}s secret ${u.probe.status}/${u.probe.ms}ms/up ${u.probe.up}; shape ${u.shape.status}/${u.shape.ms}ms/up ${u.shape.up}`)
    .join(", ");
  return [
    {
      id: "DC22s",
      title: `Sustained ${S_KIND} flood at ${S_RATE} req/s with ${S_FUNCS} added functions: restart PATCH, legacy keys off, flood stopped`,
      status: "info",
      detail: redact(
        `restart PATCH ${patch.status} at +${rel(tRestart)} s (starting lines in the window: ${starts.count}, ${starts.times}); legacy off ${off.status} at +${rel(tKeysOff)} s; flood ended +${rel(tFloodEnd)} s: ${flood.rows.length} answered, ${flood.rps} req/s, ${flood.statuses}, client errors ${errorsText(flood.errors)} || ${ptxt.join(" | ")}`,
      ).replace(ipv4, "<ip>"),
      measurements: m,
      evidence: redact(
        `15 s buckets by send time from the flood start: ${rows.join(" | ")} || node CPU per metrics refresh: ${cpuTl} || every 15 s, secret probe and one flood-shape request (status/client ms/upstream ms): ${upTl} || odd answers, first of each status: ${[...oddKinds.values()].join(" || ")} (${odd.length} odd answers in total)`,
      ).replace(ipv4, "<ip>"),
    },
  ];
}

const mod: TestModule = {
  id: "DC22",
  title: "A 404 flood (missing tables and functions, legacy anon key) against other Data API requests",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC22");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      await ensureItems(ctx, p);
      const k = await newKeys(ctx, p.ref);
      if (!k.secret || !k.publishable) throw new Error("sb_secret_ / sb_publishable_ keys absent");
      const anonH = { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` };
      const pg = await sql(ctx, p.ref, "select version() as v, (select application_name from pg_stat_activity where usename = 'authenticator' and application_name <> '' limit 1) as app");
      const before = await counts(ctx, p.ref);
      const s404t = await sample(p.host, "GET", "/rest/v1/zz_nothere_table?select=id", anonH);
      const s404near = await sample(p.host, "GET", "/rest/v1/dc_item?select=id", anonH);
      const s404r = await sample(p.host, "POST", "/rest/v1/rpc/zz_nothere_fn", anonH, {});
      const s404rnear = await sample(p.host, "POST", "/rest/v1/rpc/dc_slep", anonH, {});
      const s200 = await sample(p.host, "GET", PROBE_PATH, anonH);
      const rest0 = await atRest(p, 20);
      out.push({
        id: "DC22a",
        title: "Versions, schema size and sample answers before any flood",
        status: "info",
        detail: `${String(pg.rows?.[0]?.v ?? "").split(" on ")[0]}; PostgREST application_name ${String(pg.rows?.[0]?.app ?? "?")}; ${before}; 20 sequential requests per shape at rest: ${rest0.text}`,
        measurements: { pg_version: String(pg.rows?.[0]?.v ?? "").split(" on ")[0] ?? "", postgrest_app: String(pg.rows?.[0]?.app ?? ""), schema_before: before, ...rest0.m },
        evidence: [s404t, s404near, s404r, s404rnear, s200].join(" || "),
      });

      const worst: { kind: Kind; rate: number; p95: number }[] = [];
      const topRate = Math.max(...RATES);
      if (PHASES.includes("base")) {
        out.push((await arm(ctx, p, k, "control", null, 0, p.keys.service)).res);
        await sleep(GAP_S * 1000);
        const slow = new Set<Kind>();
        for (const rate of RATES) {
          for (const kind of KINDS) {
            if (slow.has(kind)) {
              out.push({ id: "DC22", title: `${kind} at ${rate} req/s`, status: "skip", detail: `skipped: ${kind} already pushed the anon probe p50 past ${SLOW_MS} ms at a lower rate` });
              continue;
            }
            const a = await arm(ctx, p, k, `${kind}-${rate}`, kind, rate, p.keys.service);
            out.push(a.res);
            ctx.log(`DC22 ${kind}@${rate}: ${(a.res.detail ?? "").slice(0, 400)}`);
            if (kind !== "valid") worst.push({ kind, rate, p95: a.anonFloodP95 });
            if (a.anonFloodP50 > SLOW_MS) slow.add(kind);
            await sleep(GAP_S * 1000);
          }
        }
        // Did PostgREST log the 404s? (DC12: 200s leave no access line, 5xx do.)
        const lr = await logsQuery({ ...ctx, ref: p.ref }, "select count(*) as n from logs where source = 'postgrest_logs' and event_message like '%zz_%'", 2).catch(() => null);
        const ls = await logsQuery({ ...ctx, ref: p.ref }, "select event_message from logs where source = 'postgrest_logs' order by timestamp desc limit 3", 2).catch(() => null);
        out.push({
          id: "DC22b",
          title: "PostgREST log lines naming the flood's missing objects",
          status: "info",
          detail: `postgrest_logs lines containing zz_ in the last 2 h: ${String(lr?.rows?.[0]?.n ?? `error ${lr?.error ?? "query failed"}`)}`,
          measurements: { postgrest_lines_zz: Number(lr?.rows?.[0]?.n ?? -1) },
          evidence: redact((ls?.rows ?? []).map((r) => String(r.event_message ?? "").slice(0, 200)).join(" || ")).replace(ipv4, "<ip>"),
        });
      }

      if (PHASES.includes("D")) {
        const t0 = Date.now();
        const setup = await sql(ctx, p.ref, D_SQL, 600_000);
        const ddlS = Math.round((Date.now() - t0) / 1000);
        const last = String(D_TABLES).padStart(5, "0");
        const lastF = String(D_FUNCS).padStart(5, "0");
        const tw = await untilServed(p, `/rest/v1/dc22_t_${last}?select=id`, "GET");
        const fw = await untilServed(p, `/rest/v1/rpc/dc22_f_${lastF}`, "POST");
        const after = await counts(ctx, p.ref);
        const near = await sample(p.host, "GET", "/rest/v1/dc22_t_0001x?select=id", anonH);
        const nearF = await sample(p.host, "POST", "/rest/v1/rpc/dc22_f_0001x", anonH, {});
        const rndS = await sample(p.host, "POST", "/rest/v1/rpc/zz_nothere_fn", anonH, {});
        const rest1 = await atRest(p, 20);
        out.push({
          id: "DC22d",
          title: `${D_TABLES} tables and ${D_FUNCS} functions added to public`,
          status: setup.error || tw.s < 0 || fw.s < 0 ? "fail" : "info",
          detail: `DDL ${setup.error ? `error ${setup.error}` : `ok in ${ddlS} s`}; last table served after ${tw.s} s (${tw.status}), last function after ${fw.s} s (${fw.status}); ${after}; 20 sequential requests per shape at rest: ${rest1.text}`,
          measurements: { ddl_s: ddlS, table_served_s: tw.s, function_served_s: fw.s, schema_after: after, ...rest1.m },
          evidence: [near, nearF, rndS].join(" || "),
        });
        await sleep(GAP_S * 1000);
        out.push((await arm(ctx, p, k, "D-control", null, 0, p.keys.service)).res);
        await sleep(GAP_S * 1000);
        for (const kind of ["table", "rpc"] as Kind[]) {
          const a = await arm(ctx, p, k, `D-${kind}-${topRate}`, kind, topRate, p.keys.service);
          out.push(a.res);
          ctx.log(`DC22 D ${kind}@${topRate}: ${(a.res.detail ?? "").slice(0, 400)}`);
          worst.push({ kind, rate: topRate, p95: a.anonFloodP95 });
          await sleep(GAP_S * 1000);
        }
      }

      if (PHASES.includes("curve") || PHASES.includes("S")) {
        let have = 0;
        if (PHASES.includes("curve")) {
          const c = await curve(ctx, p);
          out.push(...c.results);
          have = c.have;
        }
        if (PHASES.includes("S")) {
          const f = await setFunctions(ctx, p, S_FUNCS, have);
          await sleep(5_000);
          const r = await atRest(p, 20);
          out.push({
            id: "DC22f",
            title: `${S_FUNCS} added functions in public before the sustained flood`,
            status: f.error ? "fail" : "info",
            detail: `${await counts(ctx, p.ref)}; DDL ${f.ddlS} s, served after ${f.servedS} s${f.error ? ` (${f.error})` : ""}; ${r.text}`,
            measurements: { added_functions: S_FUNCS, ...r.m },
          });
          out.push(...(await sustained(ctx, p, k)));
        }
      }

      if (PHASES.includes("E")) {
        const pick = worst.sort((a, b) => b.p95 - a.p95)[0] ?? { kind: "table" as Kind, rate: topRate, p95: -1 };
        const t0 = Date.now();
        const off = await mgmt(ctx, "PUT", `/projects/${p.ref}/api-keys/legacy?enabled=false`);
        let firstRefused = -1;
        let refusedSample = "";
        while (Date.now() - t0 < 300_000) {
          const r = await fetch(`https://${p.host}${PROBE_PATH}`, { headers: anonH }).catch(() => null);
          const st = r?.status ?? 0;
          await r?.text().catch(() => "");
          if (st === 401) {
            firstRefused = Math.round((Date.now() - t0) / 1000);
            break;
          }
          await sleep(5_000);
        }
        refusedSample = [
          await sample(p.host, "GET", PROBE_PATH, anonH),
          await sample(p.host, "GET", "/rest/v1/zz_nothere_table?select=id", anonH),
          await sample(p.host, "POST", "/rest/v1/rpc/zz_nothere_fn", anonH, {}),
          await sample(p.host, "GET", PROBE_PATH, { apikey: k.secret }),
          await sample(p.host, "GET", PROBE_PATH, { apikey: k.publishable }),
        ].join(" || ");
        const legacyMetrics = await scrape(p.host, p.keys.service);
        const secretMetrics = await scrape(p.host, k.secret);
        out.push({
          id: "DC22e",
          title: "Legacy API keys disabled: time to the first 401 for the anon key, and what answers",
          status: off.status < 300 && firstRefused >= 0 ? "info" : "fail",
          detail: `PUT ${off.status}; first anon 401 after ${firstRefused} s (5 s polls); metrics endpoint with legacy service_role ${legacyMetrics.status}, with sb_secret_ ${secretMetrics.status}; flood next: ${pick.kind} at ${pick.rate} (anon probe p95 ${pick.p95} ms under it)`,
          measurements: { put_status: off.status, first_401_s: firstRefused, metrics_legacy_status: legacyMetrics.status, metrics_secret_status: secretMetrics.status, e_flood_kind: pick.kind, e_flood_rate: pick.rate },
          evidence: refusedSample,
        });
        const pass = secretMetrics.status === 200 ? k.secret : p.keys.service;
        out.push((await arm(ctx, p, k, `E-${pick.kind}-${pick.rate}`, pick.kind, pick.rate, pass)).res);
      }
    } catch (e) {
      out.push({ id: "DC22", title: "DC22", status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
