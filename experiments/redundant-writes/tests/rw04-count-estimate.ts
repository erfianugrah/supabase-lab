/**
 * RW04 - exact count(*) against the pg_class.reltuples estimate on a
 * 1,000,000-row table (the largest RW_SIZES entry), warm and cold, and how
 * each count source behaves across a stats reset, a 10% insert with no
 * ANALYZE, a clean restart and a crash.
 *
 * Per target:
 *   1. Fixture t at N rows (inserted, then vacuumed + analysed on the same
 *      connection). Read reltuples, n_live_tup and count(*). Control: the same
 *      load into t_ctl with the insert and the VACUUM (ANALYZE) on two
 *      connections, the first closed before the second runs.
 *   2. Warm: one untimed count(*), then RW_REPS timed runs of
 *      EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) select count(*) (execution ms,
 *      plan node, shared hit/read) and of the reltuples lookup (client ms).
 *   3. Cold-ish: RW_REPS times - `docker restart` (empties shared_buffers),
 *      drop the Docker VM's page cache (lib/rig.ts dropVmCaches), wait for the
 *      server, then time the reltuples lookup and the count(*) on the first
 *      connection. After the first clean restart, read n_live_tup (are the
 *      stats still there?).
 *   4. pg_stat_reset(), forced flush, new connection: n_live_tup, reltuples,
 *      count(*).
 *   5. Insert 10% more rows with no ANALYZE (autovacuum is off on t): raw
 *      reltuples, the planner's row estimate for a full scan, n_live_tup,
 *      count(*). Then ANALYZE and read them again.
 *   6. SIGKILL + start (crash recovery): n_live_tup, reltuples, count(*).
 *
 * DESTRUCTIVE on the rig: restarts and kills the containers, drops the
 * Docker VM page cache (every container on the VM loses its cached pages).
 *
 * Not settled by this module: cold reads from a hosted network disk (EBS),
 * where a cold count(*) pays per-read latency and IOPS this VM does not
 * model; parallel-query settings other than each image's defaults.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import type { Client } from "pg";
import {
  buildFixture,
  cleanRestart,
  dropVmCaches,
  forceFlush,
  FLUSH_WAIT_MS,
  killAndStart,
  median,
  readTableStats,
  reps,
  rigUp,
  sizes,
  sleep,
  targets,
  waitUp,
  withConn,
} from "../lib/rig";

const ID = "RW04";

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, Math.round((performance.now() - t0) * 100) / 100];
}

async function reltuples(c: Client): Promise<number> {
  return Number((await c.query("select reltuples::bigint as r from pg_class where oid = 'public.t'::regclass")).rows[0].r);
}

async function exactCount(c: Client): Promise<number> {
  return Number((await c.query("select count(*) as n from public.t")).rows[0].n);
}

async function explainCount(c: Client): Promise<{ ms: number; node: string; hit: number; read: number }> {
  const r = await c.query("explain (analyze, buffers, timing off, format json) select count(*) from public.t");
  const p = (r.rows[0]["QUERY PLAN"] as Array<Record<string, unknown>>)[0]!;
  const top = p.Plan as Record<string, unknown>;
  // Walk to the scan node for its type.
  let node = top;
  while (Array.isArray(node.Plans) && node.Plans.length) node = (node.Plans as Array<Record<string, unknown>>)[0]!;
  return {
    ms: Math.round(Number(p["Execution Time"]) * 100) / 100,
    node: String(node["Node Type"]),
    hit: Number(top["Shared Hit Blocks"] ?? 0),
    read: Number(top["Shared Read Blocks"] ?? 0),
  };
}

async function planRows(c: Client): Promise<number> {
  const r = await c.query("explain (format json) select * from public.t");
  return Number(((r.rows[0]["QUERY PLAN"] as Array<Record<string, unknown>>)[0]!.Plan as Record<string, unknown>)["Plan Rows"]);
}

const mod: TestModule = {
  id: ID,
  title: "count(*) vs reltuples: timing warm and cold, and each count source across reset, stale stats, restart, crash",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const n = Math.max(...sizes());
    const extra = Math.round(n / 10);
    for (const t of targets()) {
      const rid = `${ID}-${t.role}`;
      if (!(await rigUp(t))) {
        out.push({ id: rid, title: this.title, status: "skip", detail: `not answering on 127.0.0.1:${t.port}` });
        continue;
      }
      const m: Record<string, number | string> = { target: t.role, rows: n };
      const log: string[] = [];
      try {
        await buildFixture(t, n, "identical");
        await sleep(FLUSH_WAIT_MS);
        await withConn(t, async (c) => {
          m.fresh_reltuples = await reltuples(c);
          // buildFixture inserts and then runs VACUUM (ANALYZE) on ONE connection.
          m.fresh_n_live_tup = (await readTableStats(c)).n_live_tup;
          m.fresh_count = await exactCount(c);
          m.heap_bytes = Number((await c.query("select pg_relation_size('public.t') as b")).rows[0].b);
        });
        // Control for fresh_n_live_tup: the same load with the insert and the
        // VACUUM (ANALYZE) on two connections, the first closed before the second.
        await withConn(t, async (c) => {
          await c.query("drop table if exists public.t_ctl");
          await c.query("create table public.t_ctl (id bigint primary key) with (autovacuum_enabled = false)");
          await c.query("insert into public.t_ctl select generate_series(1, $1::bigint)", [n]);
        });
        await sleep(FLUSH_WAIT_MS);
        await withConn(t, (c) => c.query("vacuum (analyze) public.t_ctl"));
        await sleep(FLUSH_WAIT_MS);
        await withConn(t, async (c) => {
          m.control_two_sessions_n_live_tup = (await readTableStats(c, "t_ctl")).n_live_tup;
          await c.query("drop table public.t_ctl");
        });

        // Warm.
        const warmCount: number[] = [];
        const warmRead: number[] = [];
        const warmRel: number[] = [];
        await withConn(t, async (c) => {
          await exactCount(c);
          for (let i = 0; i < reps(); i++) {
            const e = await explainCount(c);
            warmCount.push(e.ms);
            warmRead.push(e.read);
            m.count_plan_node = e.node;
            const [, ms] = await timed(() => reltuples(c));
            warmRel.push(ms);
          }
        });
        m.warm_count_ms_median = median(warmCount);
        m.warm_count_ms_range = `${Math.min(...warmCount)}-${Math.max(...warmCount)}`;
        m.warm_count_shared_read_median = median(warmRead);
        m.warm_reltuples_ms_median = median(warmRel);
        m.warm_reltuples_ms_range = `${Math.min(...warmRel)}-${Math.max(...warmRel)}`;

        // Cold-ish.
        const coldCount: number[] = [];
        const coldCountClient: number[] = [];
        const coldRead: number[] = [];
        const coldRel: number[] = [];
        let dropped = 0;
        for (let i = 0; i < reps(); i++) {
          await cleanRestart(t);
          if (await dropVmCaches()) dropped++;
          if (!(await waitUp(t))) throw new Error("server did not come back after restart");
          await withConn(t, async (c) => {
            if (i === 0) m.after_clean_restart_n_live_tup = (await readTableStats(c)).n_live_tup;
            const [, relMs] = await timed(() => reltuples(c));
            coldRel.push(relMs);
            const [e, cliMs] = await timed(() => explainCount(c));
            coldCount.push(e.ms);
            coldCountClient.push(cliMs);
            coldRead.push(e.read);
          });
        }
        m.cold_reps = reps();
        m.cold_vm_cache_dropped = dropped;
        m.cold_count_ms_median = median(coldCount);
        m.cold_count_ms_range = `${Math.min(...coldCount)}-${Math.max(...coldCount)}`;
        m.cold_count_client_ms_median = median(coldCountClient);
        m.cold_count_shared_read_median = median(coldRead);
        m.cold_reltuples_ms_median = median(coldRel);
        m.cold_reltuples_ms_range = `${Math.min(...coldRel)}-${Math.max(...coldRel)}`;

        // Stats reset.
        await withConn(t, async (c) => {
          await c.query("select pg_stat_reset()");
          await forceFlush(c);
        });
        await sleep(FLUSH_WAIT_MS);
        await withConn(t, async (c) => {
          m.after_reset_n_live_tup = (await readTableStats(c)).n_live_tup;
          m.after_reset_reltuples = await reltuples(c);
          m.after_reset_count = await exactCount(c);
        });

        // 10% insert, no ANALYZE.
        await withConn(t, async (c) => {
          await c.query(
            "insert into public.t select g, (g % 1000)::int, md5(g::text) from generate_series($1::bigint + 1, $1::bigint + $2::bigint) g",
            [n, extra],
          );
          await forceFlush(c);
        });
        await sleep(FLUSH_WAIT_MS);
        await withConn(t, async (c) => {
          m.inserted_rows = extra;
          m.stale_reltuples = await reltuples(c);
          m.stale_plan_rows = await planRows(c);
          m.stale_n_live_tup = (await readTableStats(c)).n_live_tup;
          m.stale_count = await exactCount(c);
          await c.query("analyze public.t");
          await forceFlush(c);
        });
        await sleep(FLUSH_WAIT_MS);
        await withConn(t, async (c) => {
          m.analyzed_reltuples = await reltuples(c);
          m.analyzed_n_live_tup = (await readTableStats(c)).n_live_tup;
        });

        // Crash.
        await killAndStart(t);
        if (!(await waitUp(t))) throw new Error("server did not come back after SIGKILL");
        await withConn(t, async (c) => {
          m.after_crash_n_live_tup = (await readTableStats(c)).n_live_tup;
          m.after_crash_reltuples = await reltuples(c);
          m.after_crash_count = await exactCount(c);
        });
        log.push(JSON.stringify({ warmCount, warmRel, coldCount, coldCountClient, coldRel, coldRead }));
        ctx.log(`${rid}: ${JSON.stringify(m)}`);
        out.push({
          id: rid,
          title: this.title,
          status: "pass",
          detail: `${t.image}, ${n} rows; cold reps with VM cache dropped: ${dropped}/${reps()}`,
          measurements: m,
          evidence: log.join("\n"),
        });
      } catch (e) {
        out.push({ id: rid, title: this.title, status: "fail", detail: `error: ${(e as Error).message}`, measurements: m });
      }
    }
    return out;
  },
};

export default mod;
