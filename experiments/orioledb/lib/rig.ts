/**
 * Measurement for the redundant-writes re-run (OR02, OR03). Same statements
 * and the same counters as experiments/redundant-writes/lib/rig.ts, with the
 * four differences a hosted OrioleDB project forces:
 *
 * - No CHECKPOINT. The hosted `postgres` role has no `pg_checkpoint`, so the
 *   statement runs wherever the checkpoint cycle happens to be. The fixture is
 *   built immediately before the statement (its pages were WAL-logged in the
 *   current cycle), which is the "no FPI" regime of RW05 unless a checkpoint
 *   lands in between; every rep records `wal_fpi` so a rep that paid full-page
 *   images is visible rather than averaged in.
 * - No xmin/xmax on OrioleDB tables (`orioledb tuples does not have system
 *   attribute: xmin`, OR01), so `row_versions` and `rows_xmax_stmt` are -1
 *   there. The heap-table rows keep the xmin count.
 * - The server is remote: the statement still runs server-side in one
 *   transaction (EXPLAIN ANALYZE, WAL), so its WAL, buffers and execution time
 *   do not include network time; the pooler adds latency only between
 *   statements.
 * - The fixture's batch table `src` is always heap, so the read side is the
 *   same for every combination.
 */
import type { Client } from "pg";
import { sleep, withConn, type Proj } from "./pair";

export type Am = "heap" | "orioledb";
export type Variant = "identical" | "one_pct_differ";

export interface Target {
  /** Result-id suffix: which project and which table access method. */
  key: string;
  proj: Proj;
  am: Am;
  label: string;
}

export const FLUSH_WAIT_MS = 700;

export async function hasFunction(c: Client, name: string): Promise<boolean> {
  const r = await c.query("select to_regproc($1) is not null as ok", [name]);
  return Boolean(r.rows[0]?.ok);
}

export async function forceFlush(c: Client): Promise<void> {
  if (await hasFunction(c, "pg_stat_force_next_flush")) await c.query("select pg_stat_force_next_flush()");
}

/**
 * Target table `t` (access method `am`) with N rows and a heap batch table
 * `src` with the same ids; identical, or with 1% of rows (id % 100 = 0)
 * carrying a changed `b`. Autovacuum is disabled on `t` by reloption where the
 * engine accepts it; the return value says whether it did.
 */
export async function buildFixture(t: Target, n: number, variant: Variant): Promise<{ autovacuumOff: boolean; error: string }> {
  return withConn(t.proj, async (c) => {
    await c.query("drop table if exists public.t, public.src");
    let autovacuumOff = true;
    let error = "";
    try {
      await c.query(
        `create table public.t (id bigint primary key, a int not null, b text not null) using ${t.am} with (autovacuum_enabled = false)`,
      );
    } catch (e) {
      autovacuumOff = false;
      error = (e as Error).message.slice(0, 200);
      await c.query(`create table public.t (id bigint primary key, a int not null, b text not null) using ${t.am}`);
    }
    await c.query("insert into public.t select g, (g % 1000)::int, md5(g::text) from generate_series(1, $1::bigint) g", [n]);
    await c.query("create table public.src (id bigint not null, a int not null, b text not null) using heap with (autovacuum_enabled = false)");
    await c.query(
      variant === "identical"
        ? "insert into public.src select id, a, b from public.t"
        : "insert into public.src select id, a, case when id % 100 = 0 then b || 'x' else b end from public.t",
    );
    await c.query("vacuum (analyze) public.t");
    await c.query("vacuum (analyze) public.src");
    return { autovacuumOff, error };
  });
}

export interface StatsRow {
  n_tup_ins: number;
  n_tup_upd: number;
  n_tup_hot_upd: number;
  n_dead_tup: number;
  n_live_tup: number;
}

export async function readTableStats(c: Client, rel = "t"): Promise<StatsRow> {
  const r = await c.query(
    `select n_tup_ins, n_tup_upd, n_tup_hot_upd, n_dead_tup, n_live_tup
       from pg_stat_user_tables where schemaname = 'public' and relname = $1`,
    [rel],
  );
  const row = r.rows[0] ?? {};
  return {
    n_tup_ins: Number(row.n_tup_ins ?? 0),
    n_tup_upd: Number(row.n_tup_upd ?? 0),
    n_tup_hot_upd: Number(row.n_tup_hot_upd ?? 0),
    n_dead_tup: Number(row.n_dead_tup ?? 0),
    n_live_tup: Number(row.n_live_tup ?? 0),
  };
}

export interface Measured {
  /** New row versions (xmin = statement xid) counted before COMMIT; -1 on OrioleDB tables (no xmin). */
  row_versions: number;
  rows_xmax_stmt: number;
  rows_after: number;
  wal_records: number;
  wal_fpi: number;
  wal_bytes: number;
  /** pg_current_wal_insert_lsn() diff from before the statement to after COMMIT. */
  wal_bytes_lsn: number;
  shared_hit: number;
  shared_read: number;
  shared_dirtied: number;
  shared_written: number;
  exec_ms: number;
  stats_n_tup_upd: number;
  stats_n_dead_tup: number;
  heap_bytes_before: number;
  heap_bytes_after: number;
  index_bytes_after: number;
  /** 1 when manual VACUUM (VERBOSE) printed a section for public.t, 0 when it skipped the table. */
  vacuum_visits_table: number;
  vacuum_wal_records: number;
  vacuum_wal_fpi: number;
  vacuum_wal_bytes: number;
  vacuum_tuples_removed: number;
  vacuum_ms: number;
  /** Disk diagnostics read after the VACUUM (-1 when the hosted role may not read them). */
  waldir_bytes_after: number;
  database_bytes_after: number;
  archiver_archived_count: number;
  archiver_failed_count: number;
}

/** The VACUUM (VERBOSE) block for public.t: its WAL usage and removed tuples. */
export function parseVacuumMain(text: string): { visited: number; records: number; fpi: number; bytes: number; removed: number } {
  const i = text.indexOf('finished vacuuming "postgres.public.t"');
  if (i < 0) return { visited: 0, records: -1, fpi: -1, bytes: -1, removed: -1 };
  const rest = text.slice(i);
  const j = rest.indexOf('vacuuming "', 20);
  const block = j < 0 ? rest : rest.slice(0, j);
  const w = block.match(/WAL usage: (\d+) records, (\d+) full page images, (\d+) bytes/);
  const r = block.match(/tuples: (\d+) removed/);
  return {
    visited: 1,
    records: w ? Number(w[1]) : -1,
    fpi: w ? Number(w[2]) : -1,
    bytes: w ? Number(w[3]) : -1,
    removed: r ? Number(r[1]) : -1,
  };
}

export async function measure(t: Target, stmt: string, pre: string[] = []): Promise<Measured> {
  await sleep(FLUSH_WAIT_MS);
  const base = await withConn(t.proj, async (c) => ({
    stats: await readTableStats(c),
    heap: Number((await c.query("select pg_relation_size('public.t') as b")).rows[0].b),
  }));

  const m = await withConn(t.proj, async (c) => {
    for (const p of pre) await c.query(p);
    const lsn0 = (await c.query("select pg_current_wal_insert_lsn()::text as l")).rows[0].l as string;
    await c.query("begin");
    const xid = (await c.query("select (pg_current_xact_id()::text::bigint % 4294967296)::text as x")).rows[0].x as string;
    const ex = await c.query(`explain (analyze, wal, buffers, timing off, format json) ${stmt}`);
    const plan = (ex.rows[0]["QUERY PLAN"] as Array<Record<string, unknown>>)[0]!;
    const top = plan.Plan as Record<string, unknown>;
    let v = -1;
    let l = -1;
    let n: number;
    if (t.am === "heap") {
      const counts = (
        await c.query(
          `select count(*) filter (where xmin::text = $1) as v, count(*) filter (where xmax::text = $1) as l, count(*) as n from public.t`,
          [xid],
        )
      ).rows[0];
      v = Number(counts.v);
      l = Number(counts.l);
      n = Number(counts.n);
    } else {
      n = Number((await c.query("select count(*) as n from public.t")).rows[0].n);
    }
    await c.query("commit");
    const lsnDiff = Number(
      (await c.query("select pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint as d", [lsn0])).rows[0].d,
    );
    await forceFlush(c);
    return {
      row_versions: v,
      rows_xmax_stmt: l,
      rows_after: n,
      wal_records: Number(top["WAL Records"] ?? 0),
      wal_fpi: Number(top["WAL FPI"] ?? 0),
      wal_bytes: Number(top["WAL Bytes"] ?? 0),
      wal_bytes_lsn: lsnDiff,
      shared_hit: Number(top["Shared Hit Blocks"] ?? 0),
      shared_read: Number(top["Shared Read Blocks"] ?? 0),
      shared_dirtied: Number(top["Shared Dirtied Blocks"] ?? 0),
      shared_written: Number(top["Shared Written Blocks"] ?? 0),
      exec_ms: Number(plan["Execution Time"] ?? 0),
    };
  });

  await sleep(FLUSH_WAIT_MS);
  const after = await withConn(t.proj, async (c) => {
    const stats = await readTableStats(c);
    const sizes = (await c.query("select pg_relation_size('public.t') as h, pg_indexes_size('public.t') as i")).rows[0];
    const info: string[] = [];
    c.on("notice", (nn) => info.push(String(nn.message)));
    const t0 = performance.now();
    await c.query("vacuum (verbose) public.t");
    const vacMs = performance.now() - t0;
    const wal = await c.query("select coalesce(sum(size), 0)::bigint as b from pg_ls_waldir()").then((r) => Number(r.rows[0].b), () => -1);
    const dbs = await c.query("select pg_database_size(current_database())::bigint as b").then((r) => Number(r.rows[0].b), () => -1);
    const arc = await c.query("select archived_count, failed_count from pg_stat_archiver").then((r) => ({ a: Number(r.rows[0]?.archived_count ?? -1), f: Number(r.rows[0]?.failed_count ?? -1) }), () => ({ a: -1, f: -1 }));
    return { stats, heapAfter: Number(sizes.h), idxAfter: Number(sizes.i), vacMs, vac: parseVacuumMain(info.join("\n")), wal, dbs, arc };
  });

  return {
    ...m,
    stats_n_tup_upd: after.stats.n_tup_upd - base.stats.n_tup_upd,
    stats_n_dead_tup: after.stats.n_dead_tup - base.stats.n_dead_tup,
    heap_bytes_before: base.heap,
    heap_bytes_after: after.heapAfter,
    index_bytes_after: after.idxAfter,
    vacuum_visits_table: after.vac.visited,
    vacuum_wal_records: after.vac.records,
    vacuum_wal_fpi: after.vac.fpi,
    vacuum_wal_bytes: after.vac.bytes,
    vacuum_tuples_removed: after.vac.removed,
    vacuum_ms: Math.round(after.vacMs * 10) / 10,
    waldir_bytes_after: after.wal,
    database_bytes_after: after.dbs,
    archiver_archived_count: after.arc.a,
    archiver_failed_count: after.arc.f,
  };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return Number.NaN;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

const round = (x: number) => (Number.isInteger(x) ? x : Math.round(x * 100) / 100);

export function summarise(runs: Measured[]): Record<string, number> {
  const out: Record<string, number> = { reps: runs.length };
  if (!runs.length) return out;
  for (const k of Object.keys(runs[0]!) as (keyof Measured)[]) {
    const xs = runs.map((r) => r[k]);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    out[`${k}_median`] = round(median(xs));
    if (lo !== hi) {
      out[`${k}_min`] = round(lo);
      out[`${k}_max`] = round(hi);
    }
  }
  return out;
}
