/**
 * The local rig: three throwaway Postgres containers (compose.yml), no managed
 * project, no PAT. Every module in this experiment measures the same way, so
 * the measuring lives here once.
 *
 * Measurement rules, each one closing a way a naive measurement could
 * have lied:
 *
 * - Cumulative statistics (pg_stat_user_tables, pg_stat_wal) are flushed
 *   asynchronously from PG 15 on. A backend flushes its pending counters when
 *   it goes idle (rate-limited) and when it exits, so reading n_tup_upd in the
 *   same session right after the statement can show the old value. Here the
 *   statement runs on its own connection, which calls
 *   pg_stat_force_next_flush() when the server has it and then disconnects;
 *   the counters are read from a NEW connection after FLUSH_WAIT_MS.
 * - Row versions are not read from stats at all. The statement runs inside an
 *   explicit transaction whose xid is captured first; before COMMIT the same
 *   transaction counts visible rows with xmin = that xid (new versions it
 *   wrote) and xmax = that xid (rows it locked; see Measured.rows_xmax_stmt
 *   for why updated rows can carry it too). Counting inside the transaction
 *   also avoids a seq scan AFTER commit, which would prune the pages the
 *   statement just filled with dead versions and so change both the WAL the
 *   later VACUUM writes and the dead-tuple count.
 * - WAL is read two ways: EXPLAIN (ANALYZE, WAL) gives the statement's own WAL
 *   records, full-page images and bytes; pg_current_wal_insert_lsn() before
 *   the statement and after COMMIT gives the server-wide figure for the
 *   window (it adds the commit record, the in-transaction count, and anything
 *   a background process wrote meanwhile). The INSERT position, not
 *   pg_current_wal_lsn(): that one is the WRITE position, which lags WAL still
 *   in wal_buffers - the first full run on 2026-10-08 used it and read 0 bytes
 *   for VACUUMs that had removed 10,000 dead tuples.
 * - VACUUM's own WAL is read from VACUUM (VERBOSE)'s "WAL usage" line.
 * - RW02/RW03 run a CHECKPOINT right before every measured statement, so every
 *   case pays the full-page image on its first touch of each page. That is
 *   the worst case for WAL volume and the same for every case. RW05 runs the
 *   same cases with the checkpoint BEFORE the fixture build instead, so the
 *   pages were already logged this cycle and the statement pays (almost) no
 *   full-page images. Real workloads land between the two.
 * - Autovacuum is disabled on the two tables (reloption) so the dead-tuple
 *   count is what the statement left behind, not what was left after a
 *   worker cleaned up mid-measurement. Whether autovacuum WOULD trigger is
 *   computed from the server's own threshold settings.
 */
import { $ } from "bun";
import { Client } from "pg";

export interface RigTarget {
  role: "pg15" | "pg17" | "supabase";
  container: string;
  port: number;
  /**
   * A superuser: CHECKPOINT, pg_stat_reset() and VACUUM of any table need one.
   * On the supabase/postgres image `postgres` is not superuser (see
   * experiments/checkpointer-reset/lib/rig.ts); `supabase_admin` is.
   */
  user: string;
  image: string;
}

export const ALL_TARGETS: RigTarget[] = [
  { role: "pg15", container: "pvlab-redundant-writes-pg15", port: 45441, user: "postgres", image: "postgres:15-alpine (15.19)" },
  { role: "pg17", container: "pvlab-redundant-writes-pg17", port: 45442, user: "postgres", image: "postgres:17-alpine (17.11)" },
  {
    role: "supabase",
    container: "pvlab-redundant-writes-supabase",
    port: 45443,
    user: "supabase_admin",
    image: "public.ecr.aws/supabase/postgres:17.11.0.004",
  },
];

export function targets(): RigTarget[] {
  const want = (process.env.RW_TARGETS ?? "pg15,pg17,supabase").split(",").map((s) => s.trim());
  return ALL_TARGETS.filter((t) => want.includes(t.role));
}

export function sizes(): number[] {
  return (process.env.RW_SIZES ?? "10000,100000,1000000")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function reps(): number {
  const n = Number(process.env.RW_REPS ?? "3");
  return Number.isFinite(n) && n > 0 ? n : 3;
}

export const FLUSH_WAIT_MS = 600;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function connect(t: RigTarget): Promise<Client> {
  const pw = process.env.PVLAB_LOCAL_DB_PASSWORD ?? "";
  const c = new Client({
    connectionString: `postgres://${t.user}:${pw}@127.0.0.1:${t.port}/postgres`,
    connectionTimeoutMillis: 10_000,
  });
  await c.connect();
  return c;
}

export async function withConn<T>(t: RigTarget, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await connect(t);
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function rigUp(t: RigTarget): Promise<boolean> {
  try {
    await withConn(t, (c) => c.query("select 1"));
    return true;
  } catch {
    return false;
  }
}

export async function waitUp(t: RigTarget, maxWaitMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await rigUp(t)) return true;
    await sleep(500);
  }
  return false;
}

/** Does the server have this function? Checked, not assumed per version. */
export async function hasFunction(c: Client, name: string): Promise<boolean> {
  const r = await c.query("select to_regproc($1) is not null as ok", [name]);
  return Boolean(r.rows[0]?.ok);
}

/** Flush this backend's pending stats if the server can; then the caller disconnects. */
export async function forceFlush(c: Client): Promise<void> {
  if (await hasFunction(c, "pg_stat_force_next_flush")) await c.query("select pg_stat_force_next_flush()");
}

// ---------------------------------------------------------------------------
// Fixture

export type Variant = "identical" | "one_pct_differ";

/**
 * Target table `t` holding N rows and a batch table `src` holding the same N
 * ids. `identical`: every src row equals its t row. `one_pct_differ`: rows
 * with id % 100 = 0 carry a changed `b`. Both tables autovacuum-disabled and
 * vacuumed + analysed, so no dead tuples, hint bits set, visibility map set,
 * reltuples accurate before the statement runs.
 */
export async function buildFixture(t: RigTarget, n: number, variant: Variant): Promise<void> {
  await withConn(t, async (c) => {
    await c.query("drop table if exists public.t, public.src");
    await c.query(
      "create table public.t (id bigint primary key, a int not null, b text not null) with (autovacuum_enabled = false)",
    );
    await c.query(
      "insert into public.t select g, (g % 1000)::int, md5(g::text) from generate_series(1, $1::bigint) g",
      [n],
    );
    await c.query("create table public.src (id bigint not null, a int not null, b text not null) with (autovacuum_enabled = false)");
    await c.query(
      variant === "identical"
        ? "insert into public.src select id, a, b from public.t"
        : "insert into public.src select id, a, case when id % 100 = 0 then b || 'x' else b end from public.t",
    );
    await c.query("vacuum (analyze) public.t");
    await c.query("vacuum (analyze) public.src");
  });
}

// ---------------------------------------------------------------------------
// One measured statement

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
  /** New row versions the statement wrote (xmin = its xid), counted before COMMIT. */
  row_versions: number;
  /**
   * Visible rows whose xmax is the statement's xid. Where the guard skipped the
   * update, these are rows it locked and left in place. Where it did update, the
   * ON CONFLICT path (which locks the row first) carries that lock onto the
   * new version, so the count includes new versions too - read it together
   * with row_versions.
   */
  rows_xmax_stmt: number;
  /** Rows in t after the statement. */
  rows_after: number;
  /** EXPLAIN (ANALYZE, WAL) on the statement itself. */
  wal_records: number;
  wal_fpi: number;
  wal_bytes: number;
  /** pg_current_wal_insert_lsn() diff from before the statement to after COMMIT. */
  wal_bytes_lsn: number;
  shared_hit: number;
  shared_read: number;
  shared_dirtied: number;
  shared_written: number;
  /** EXPLAIN's Execution Time (TIMING OFF), ms. */
  exec_ms: number;
  /** Deltas from a new connection after a forced flush. */
  stats_n_tup_upd: number;
  stats_n_tup_hot_upd: number;
  stats_n_dead_tup: number;
  /** Would autovacuum's vacuum threshold be crossed by the dead tuples left behind? */
  autovac_threshold: number;
  autovac_would_trigger: number;
  heap_bytes_before: number;
  heap_bytes_after: number;
  index_bytes_after: number;
  /**
   * A manual VACUUM (VERBOSE) of t afterwards: what cleaning up the
   * statement's dead versions costs. WAL figures and tuples removed are parsed
   * from VACUUM's own INFO output; -1 where the line was not found.
   */
  vacuum_wal_records: number;
  vacuum_wal_fpi: number;
  vacuum_wal_bytes: number;
  vacuum_tuples_removed: number;
  vacuum_ms: number;
}

/**
 * Run one statement against a freshly built fixture and measure it. `pre` runs
 * on the measuring connection before the checkpoint (e.g. CREATE TRIGGER).
 * `checkpointBefore = false` is RW05's regime: the caller checkpoints BEFORE
 * building the fixture instead, so every page the statement touches was
 * already WAL-logged in the current checkpoint cycle and the statement writes
 * (almost) no full-page images - the per-row WAL on its own.
 */
export async function measure(t: RigTarget, stmt: string, pre: string[] = [], checkpointBefore = true): Promise<Measured> {
  // Baseline stats from a fresh connection, after the fixture's own counters
  // have had time to flush (the fixture connection already disconnected).
  await sleep(FLUSH_WAIT_MS);
  const base = await withConn(t, async (c) => ({
    stats: await readTableStats(c),
    heap: Number((await c.query("select pg_relation_size('public.t') as b")).rows[0].b),
  }));

  const m = await withConn(t, async (c) => {
    for (const p of pre) await c.query(p);
    if (checkpointBefore) await c.query("checkpoint");
    const lsn0 = (await c.query("select pg_current_wal_insert_lsn()::text as l")).rows[0].l as string;
    await c.query("begin");
    const xid = (await c.query("select (pg_current_xact_id()::text::bigint % 4294967296)::text as x")).rows[0].x as string;
    const ex = await c.query(`explain (analyze, wal, buffers, timing off, format json) ${stmt}`);
    const plan = (ex.rows[0]["QUERY PLAN"] as Array<Record<string, unknown>>)[0]!;
    const top = plan.Plan as Record<string, unknown>;
    const counts = (
      await c.query(
        `select count(*) filter (where xmin::text = $1) as v,
                count(*) filter (where xmax::text = $1) as l,
                count(*) as n
           from public.t`,
        [xid],
      )
    ).rows[0];
    await c.query("commit");
    const lsnDiff = Number(
      (await c.query("select pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint as d", [lsn0])).rows[0].d,
    );
    await forceFlush(c);
    return {
      row_versions: Number(counts.v),
      rows_xmax_stmt: Number(counts.l),
      rows_after: Number(counts.n),
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
  const after = await withConn(t, async (c) => {
    const stats = await readTableStats(c);
    const sizes = (
      await c.query("select pg_relation_size('public.t') as h, pg_indexes_size('public.t') as i")
    ).rows[0];
    const thr = (
      await c.query(
        `select current_setting('autovacuum_vacuum_threshold')::float8
              + current_setting('autovacuum_vacuum_scale_factor')::float8 * greatest(c.reltuples, 0) as thr
           from pg_class c where c.oid = 'public.t'::regclass`,
      )
    ).rows[0];
    // VACUUM last: it is the first thing after COMMIT to touch t's pages.
    const info: string[] = [];
    c.on("notice", (n) => info.push(String(n.message)));
    const t0 = performance.now();
    await c.query("vacuum (verbose) public.t");
    const vacMs = performance.now() - t0;
    return {
      stats,
      heapAfter: Number(sizes.h),
      idxAfter: Number(sizes.i),
      threshold: Number(thr.thr),
      vacMs,
      vac: parseVacuumVerbose(info.join("\n")),
    };
  });

  const deadDelta = after.stats.n_dead_tup - base.stats.n_dead_tup;
  return {
    ...m,
    stats_n_tup_upd: after.stats.n_tup_upd - base.stats.n_tup_upd,
    stats_n_tup_hot_upd: after.stats.n_tup_hot_upd - base.stats.n_tup_hot_upd,
    stats_n_dead_tup: deadDelta,
    autovac_threshold: Math.round(after.threshold),
    autovac_would_trigger: after.stats.n_dead_tup > after.threshold ? 1 : 0,
    heap_bytes_before: base.heap,
    heap_bytes_after: after.heapAfter,
    index_bytes_after: after.idxAfter,
    vacuum_wal_records: after.vac.records,
    vacuum_wal_fpi: after.vac.fpi,
    vacuum_wal_bytes: after.vac.bytes,
    vacuum_tuples_removed: after.vac.removed,
    vacuum_ms: Math.round(after.vacMs * 10) / 10,
  };
}

/** Pull the WAL usage and removed-tuple count out of VACUUM (VERBOSE) INFO text. */
export function parseVacuumVerbose(text: string): { records: number; fpi: number; bytes: number; removed: number } {
  const w = text.match(/WAL usage: (\d+) records, (\d+) full page images, (\d+) bytes/);
  const r = text.match(/tuples: (\d+) removed/);
  return {
    records: w ? Number(w[1]) : -1,
    fpi: w ? Number(w[2]) : -1,
    bytes: w ? Number(w[3]) : -1,
    removed: r ? Number(r[1]) : -1,
  };
}

// ---------------------------------------------------------------------------
// Summaries

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return Number.NaN;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

const round = (x: number) => (Number.isInteger(x) ? x : Math.round(x * 100) / 100);

/** `{key}_median`, `{key}_min`, `{key}_max` for every numeric key across reps. */
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

// ---------------------------------------------------------------------------
// Docker (RW04 only)

export async function cleanRestart(t: RigTarget): Promise<void> {
  await $`docker restart -t 30 ${t.container}`.quiet();
}

export async function killAndStart(t: RigTarget): Promise<void> {
  await $`docker kill -s SIGKILL ${t.container}`.quiet();
  await $`docker start ${t.container}`.quiet();
}

/**
 * Drop the Docker VM's page cache. vm.drop_caches is not namespaced, so a
 * privileged container writing it empties the linuxkit VM's cache for every
 * container on it (clean pages only - nothing is lost, other containers just
 * re-read from disk). Uses an image the rig already has, so no extra pull.
 */
export async function dropVmCaches(): Promise<boolean> {
  const r = await $`docker run --rm --privileged --entrypoint sh postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 -c ${"sync; echo 3 > /proc/sys/vm/drop_caches"}`
    .quiet()
    .nothrow();
  return r.exitCode === 0;
}
