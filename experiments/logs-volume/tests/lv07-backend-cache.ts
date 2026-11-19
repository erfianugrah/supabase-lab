/**
 * LV07 - does a read cache in the customer's backend cut log rows the way the
 * TTL-bucket estimate on gateway logs predicts, and what do the other
 * backend-side levers write?
 *
 * One throwaway Pro-org project (ap-southeast-1). Vantage: this machine acting
 * as the customer's backend: supabase-js with the legacy service_role key,
 * lru-cache 11.5.3 for the cache, node-postgres for pooled reads. Table
 * `lv7` holds K businesses x 3 rows; a read is `select id,status where biz=k`.
 * The trace is R reads at Poisson arrivals (mean gap GAP_MS) over K keys with
 * Zipf(1) popularity, generated once from a fixed seed and replayed verbatim
 * in LV07a-c, so the three phases see the same keys at the same offsets.
 * Each phase carries its own marker in the query string, so its edge_logs
 * rows are counted by marker, not by window.
 *
 *   LV07a  no cache: every read is one REST GET. edge_logs rows by marker,
 *          plus the TTL-bucket estimate (1 - distinct(key, floor(t / T)) / n)
 *          for T = 5 s and 30 s, from the logged rows and from the client's
 *          send times.
 *   LV07b  lru-cache, ttl 5 s, fetch() with a fetchMethod: REST calls made,
 *          cache hits, edge_logs rows by marker. Also the offline replay of
 *          the trace through a fill-time TTL cache with no network.
 *   LV07c  the same with ttl 30 s.
 *   LV07d  C concurrent fetch() for one key on an empty cache: fetchMethod
 *          calls and edge_logs rows.
 *   LV07e  delete-on-write: cached read, PATCH through REST, read again
 *          without and with cache.delete(); values returned.
 *   LV07f  auth.admin.getUserById, N calls, no cache: rows per call by source
 *          (window minus idle rate).
 *   LV07g  the same N calls through lru-cache (ttl 300 s): rows per call.
 *   LV07h  N reads over one pg.Pool (max 2) on the shared pooler in
 *          transaction mode (6543) as postgres: rows per read by source.
 *   LV07i  M reads, each on a new connection (connect, query, end) on 6543:
 *          rows per connection by source.
 *
 * Pass/fail: LV07d passes when fetchMethod ran once; the rest are `info`.
 * Not settled: several backend instances (each with its own cache), RLS-scoped
 * reads (the cache key must then include the user), log_connections on (off on
 * a new project), the dedicated pooler, metered bytes (not readable by PAT).
 *
 * DESTRUCTIVE: creates and deletes one project; runs about 15 minutes.
 */
import { createClient } from "@supabase/supabase-js";
import { LRUCache } from "lru-cache";
import pg from "pg";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { dropProject, logs, makeProject, sleep, sql } from "../../observability-surface/lib/ob";
import { PREFIX, type Window, footprint, perAction, rates, waitForRows } from "../lib/lv";

const K = Number(process.env.LV07_KEYS ?? 20);
const R = Number(process.env.LV07_READS ?? 600);
const GAP_MS = Number(process.env.LV07_GAP_MS ?? 100);
const N = Number(process.env.LV07_N ?? 50);
const M = Number(process.env.LV07_CONNS ?? 30);
const C = Number(process.env.LV07_CONCURRENT ?? 50);
const IDLE_S = Number(process.env.LV07_IDLE_S ?? 120);
const QUIET_MS = 30_000;
const PAD_BEFORE = 1000;
const PAD_AFTER = 5000;
const TTLS = [5, 30];

/** mulberry32: a small seeded PRNG so the trace is the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** R reads: offset from phase start (ms) and key, Poisson arrivals, Zipf(1) over K keys. */
function makeTrace(): Array<{ at: number; key: number }> {
  const r = rng(7);
  const w = Array.from({ length: K }, (_, i) => 1 / (i + 1));
  const sum = w.reduce((a, b) => a + b, 0);
  const out: Array<{ at: number; key: number }> = [];
  let at = 0;
  for (let i = 0; i < R; i++) {
    at += -Math.log(1 - r()) * GAP_MS;
    let u = r() * sum;
    let key = 0;
    while (key < K - 1 && u > w[key]!) u -= w[key++]!;
    out.push({ at: Math.round(at), key });
  }
  return out;
}

/** 1 - distinct(key, floor(t / ttl)) / n over (key, epoch ms) pairs. */
function bucketEstimate(xs: Array<{ key: number; t: number }>, ttlS: number): number {
  const seen = new Set(xs.map((x) => `${x.key}|${Math.floor(x.t / (ttlS * 1000))}`));
  return xs.length ? 1 - seen.size / xs.length : 0;
}

/** Offline replay through a cache whose entry lives ttl after the fill, no network latency. */
function fillTtlHitRate(xs: Array<{ key: number; t: number }>, ttlS: number): number {
  const filled = new Map<number, number>();
  let hits = 0;
  for (const x of xs) {
    const f = filled.get(x.key);
    if (f !== undefined && x.t - f < ttlS * 1000) hits++;
    else filled.set(x.key, x.t);
  }
  return xs.length ? hits / xs.length : 0;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

const mod: TestModule = {
  id: "LV07",
  title: "Backend read cache, admin user lookups and pooled reads vs log rows",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "LV07", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    let ref = "";
    const pools: pg.Pool[] = [];
    try {
      const proj = await makeProject(ctx, "lv07", PREFIX);
      ref = proj.ref;
      const pc = proj.ctx;
      const url = `https://${pc.apiHost}`;
      const svc = { apikey: pc.serviceKey!, authorization: `Bearer ${pc.serviceKey}` };
      const run = Date.now().toString(36);

      // ---- setup (outside every window)
      const seed = Array.from({ length: K }, (_, b) => [0, 1, 2].map((j) => `(${b * 3 + j}, ${b}, 'online')`).join(", ")).join(", ");
      const ddl = await sql(
        pc,
        `create table public.lv7(id int primary key, biz int not null, status text not null); create index on public.lv7(biz); grant select, insert, update, delete on table public.lv7 to service_role; alter table public.lv7 enable row level security; insert into public.lv7 values ${seed};`,
      );
      if (ddl.status >= 300) throw new Error(`ddl: ${ddl.error}`);
      const admin = createClient(url, pc.serviceKey!, { auth: { persistSession: false } });
      const cu = await admin.auth.admin.createUser({ email: `lv07-${run}@example.com`, password: "Passw0rd!lv07", email_confirm: true });
      if (cu.error || !cu.data.user) throw new Error(`createUser: ${cu.error?.message}`);
      const uid = cu.data.user.id;
      const cfg = await mgmt(pc, "GET", `/projects/${ref}/config/database/pooler`);
      const poolerHost = (Array.isArray(cfg.json) ? (cfg.json as Array<{ db_host?: string; database_type?: string }>) : []).find((e) => e.database_type === "PRIMARY")?.db_host;
      if (!poolerHost) throw new Error(`pooler config HTTP ${cfg.status}`);
      const pgCfg = { host: poolerHost, port: 6543, user: `postgres.${ref}`, password: pc.dbPassword, database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000 };
      // warm the Data API schema cache and the pooler outside the windows
      for (let i = 0; i < 5; i++) await fetch(`${url}/rest/v1/lv7?select=id&biz=eq.0`, { headers: svc }).then((r) => r.arrayBuffer());
      await sleep(QUIET_MS);

      const read = async (key: number, marker: string) => {
        const r = await fetch(`${url}/rest/v1/lv7?select=id,status&biz=eq.${key}&status=neq.${marker}`, { headers: svc });
        if (r.status !== 200) throw new Error(`read HTTP ${r.status}`);
        return (await r.json()) as Array<{ id: number; status: string }>;
      };

      const windows: Window[] = [];
      const phase = async (name: string, n: number, body: () => Promise<string | void>) => {
        const t0 = Date.now();
        const note = await body();
        const t1 = Date.now();
        windows.push({ name, t0, t1, n, note: note ?? undefined });
        await sleep(QUIET_MS);
      };

      await phase("idle", 1, async () => {
        await sleep(IDLE_S * 1000);
      });

      // ---- LV07a-c: the same trace, uncached and through two caches
      const trace = makeTrace();
      const replay = async (doRead: (key: number) => Promise<unknown>) => {
        const start = Date.now();
        const sent: Array<{ key: number; t: number }> = [];
        const pending: Promise<unknown>[] = [];
        let errors = 0;
        for (const x of trace) {
          const wait = start + x.at - Date.now();
          if (wait > 0) await sleep(wait);
          sent.push({ key: x.key, t: Date.now() });
          pending.push(doRead(x.key).catch(() => errors++));
        }
        await Promise.all(pending);
        return { sent, errors };
      };

      const mA = `lv7a${run}`;
      let sentA: Array<{ key: number; t: number }> = [];
      await phase("no_cache", R, async () => {
        const r = await replay((k) => read(k, mA));
        sentA = r.sent;
        return `errors:${r.errors}`;
      });

      const cached: Record<number, { calls: number; errors: number; marker: string }> = {};
      for (const ttl of TTLS) {
        const marker = `lv7c${ttl}${run}`;
        let calls = 0;
        const cache = new LRUCache<number, Array<{ id: number; status: string }>>({
          max: 1000,
          ttl: ttl * 1000,
          fetchMethod: async (k) => {
            calls++;
            return read(k, marker);
          },
        });
        await phase(`cache_${ttl}s`, R, async () => {
          const r = await replay((k) => cache.fetch(k));
          cached[ttl] = { calls, errors: r.errors, marker };
          return `calls:${calls} errors:${r.errors}`;
        });
      }

      // ---- LV07d: concurrent fetches for one key on an empty cache
      const mD = `lv7d${run}`;
      let dCalls = 0;
      const dCache = new LRUCache<number, Array<{ id: number; status: string }>>({
        max: 10,
        ttl: 60_000,
        fetchMethod: async (k) => {
          dCalls++;
          return read(k, mD);
        },
      });
      const dRes = await Promise.all(Array.from({ length: C }, () => dCache.fetch(3)));
      const dRows = dRes.filter((x) => Array.isArray(x) && x.length === 3).length;

      // ---- LV07e: delete-on-write
      const mE = `lv7e${run}`;
      const eCache = new LRUCache<number, Array<{ id: number; status: string }>>({ max: 10, ttl: 60_000, fetchMethod: async (k) => read(k, mE) });
      const before = (await eCache.fetch(4))?.[0]?.status ?? "-";
      const patch = await fetch(`${url}/rest/v1/lv7?id=eq.12`, { method: "PATCH", headers: { ...svc, "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ status: "away" }) });
      await patch.arrayBuffer();
      const statusOf12 = (rows?: Array<{ id: number; status: string }>) => rows?.find((x) => x.id === 12)?.status ?? "-";
      const staleRead = statusOf12(await eCache.fetch(4));
      eCache.delete(4);
      const freshRead = statusOf12(await eCache.fetch(4));
      await sleep(QUIET_MS);

      // ---- LV07f-g: admin user lookups
      await phase("admin_getuser", N, async () => {
        let ok = 0;
        for (let i = 0; i < N; i++) if (!(await admin.auth.admin.getUserById(uid)).error) ok++;
        return `ok:${ok}`;
      });
      let gCalls = 0;
      const uCache = new LRUCache<string, object>({
        max: 1000,
        ttl: 300_000,
        fetchMethod: async (id) => {
          gCalls++;
          const r = await admin.auth.admin.getUserById(id);
          if (r.error || !r.data.user) throw new Error(r.error?.message ?? "no user");
          return r.data.user;
        },
      });
      await phase("admin_getuser_cached", N, async () => {
        let ok = 0;
        for (let i = 0; i < N; i++) if (await uCache.fetch(uid)) ok++;
        return `ok:${ok} calls:${gCalls}`;
      });

      // ---- LV07h-i: reads over the pooler, transaction mode
      const pool = new pg.Pool({ ...pgCfg, max: 2 });
      pools.push(pool);
      await pool.query("select 1"); // open the connections outside the window
      await pool.query("select 1");
      await sleep(QUIET_MS);
      await phase("pool_persistent", N * 4, async () => {
        let ok = 0;
        for (let i = 0; i < N * 4; i++) {
          const r = await pool.query("select id, status from public.lv7 where biz = $1", [i % K]).catch(() => null);
          if (r?.rowCount === 3) ok++;
        }
        return `ok:${ok}`;
      });
      await pool.end();
      pools.length = 0;
      await phase("pool_connect_per_read", M, async () => {
        let ok = 0;
        for (let i = 0; i < M; i++) {
          const c = new pg.Client(pgCfg);
          try {
            await c.connect();
            const r = await c.query("select id, status from public.lv7 where biz = $1", [i % K]);
            if (r.rowCount === 3) ok++;
          } catch {
            /* counted as not ok */
          } finally {
            await c.end().catch(() => undefined);
          }
        }
        return `ok:${ok}`;
      });

      // ---- read back
      const seenA = await waitForRows(pc, windows[0]!.t0, mA, Math.floor(R * 0.95));
      await sleep(120_000);
      const idleW = windows.find((w) => w.name === "idle")!;
      const idleF = await footprint(pc, idleW.t0, idleW.t1);
      const idleRate = rates(idleF.counts, (idleW.t1 - idleW.t0) / 1000);

      const markerRows = async (marker: string) => {
        const r = await logs(pc, `select count(*) as n from logs where source = 'edge_logs' and position(event_message, '${marker}') > 0`, 6);
        return { n: Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0), error: r.error };
      };

      // LV07a with the bucket estimate from the logged rows themselves
      const wA = windows.find((w) => w.name === "no_cache")!;
      const a = await markerRows(mA);
      const aM: Record<string, number | string> = { reads: R, keys: K, mean_gap_ms: GAP_MS, edge_rows: a.n, edge_rows_per_read: r3(a.n / R), rows_seen_before_tail: seenA, client_note: wA.note ?? "" };
      for (const ttl of TTLS) {
        const q = await logs(
          pc,
          `select count(*) as n, uniqExact(concat(extract(event_message, 'biz=eq.([0-9]+)'), '|', toString(intDiv(toUnixTimestamp(timestamp), ${ttl})))) as d from logs where source = 'edge_logs' and position(event_message, '${mA}') > 0`,
          6,
        );
        const row = (q.rows[0] ?? {}) as { n?: number; d?: number };
        aM[`est_logs_ttl_${ttl}s`] = row.n ? r3(1 - Number(row.d) / Number(row.n)) : (q.error || "no rows");
        aM[`est_client_ttl_${ttl}s`] = r3(bucketEstimate(sentA, ttl));
        aM[`offline_fill_ttl_${ttl}s`] = r3(fillTtlHitRate(sentA, ttl));
      }
      out.push({ id: "LV07a", title: "LV07a: trace with no cache, edge_logs rows and the TTL-bucket estimate", status: a.error ? "fail" : "info", detail: a.error || undefined, measurements: aM });

      for (const [i, ttl] of TTLS.entries()) {
        const c = cached[ttl]!;
        const rows = await markerRows(c.marker);
        out.push({
          id: `LV07${"bc"[i]}`,
          title: `LV07${"bc"[i]}: the same trace through lru-cache, ttl ${ttl} s`,
          status: rows.error ? "fail" : "info",
          detail: rows.error || undefined,
          measurements: {
            reads: R,
            rest_calls: c.calls,
            live_hit_rate: r3(1 - c.calls / R),
            edge_rows: rows.n,
            edge_rows_per_rest_call: c.calls ? r3(rows.n / c.calls) : 0,
            edge_rows_vs_uncached: a.n ? r3(rows.n / a.n) : 0,
            est_client_ttl: aM[`est_client_ttl_${ttl}s`]!,
            offline_fill_ttl: aM[`offline_fill_ttl_${ttl}s`]!,
            errors: c.errors,
          },
        });
      }

      const dEdge = await markerRows(mD);
      out.push({
        id: "LV07d",
        title: `LV07d: ${C} concurrent fetch() for one key on an empty cache`,
        status: dCalls === 1 ? "pass" : "fail",
        measurements: { concurrent_fetches: C, fetch_method_calls: dCalls, results_with_3_rows: dRows, edge_rows: dEdge.n },
      });
      out.push({
        id: "LV07e",
        title: "LV07e: PATCH, then read without and with cache.delete()",
        status: "info",
        measurements: { status_before: before, patch_http: patch.status, read_after_patch_no_delete: staleRead, read_after_delete: freshRead },
      });

      const ids: Record<string, string> = { admin_getuser: "LV07f", admin_getuser_cached: "LV07g", pool_persistent: "LV07h", pool_connect_per_read: "LV07i" };
      for (const w of windows.filter((x) => ids[x.name])) {
        const f = await footprint(pc, w.t0 - PAD_BEFORE, w.t1 + PAD_AFTER);
        const m = perAction({ ...w, t0: w.t0 - PAD_BEFORE, t1: w.t1 + PAD_AFTER }, f.counts, idleRate);
        if (w.note) m.client_note = w.note;
        out.push({ id: ids[w.name]!, title: `${ids[w.name]}: ${w.name}`, status: f.error ? "fail" : "info", detail: f.error || undefined, measurements: m });
        await sleep(3000);
      }
    } catch (e) {
      out.push({ id: "LV07", title: "LV07", status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      for (const p of pools) await p.end().catch(() => undefined);
      await dropProject(ctx, ref);
    }
    return out;
  },
};
export default mod;
