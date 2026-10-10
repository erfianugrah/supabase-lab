/**
 * PG03 - btree_gist indexes on float4 / float8 columns holding NaN, before and
 * after the minor, and before and after REINDEX (public changelog:
 * https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes).
 *
 * Per pair, per float type: a table of 2000 ordinary values, 50 NaN and 5
 * Infinity, with a btree_gist GiST index built on the OLD image. Ten range /
 * equality predicates are counted twice, once with only a sequential scan
 * allowed (the heap is the reference) and once with only an index scan allowed
 * (bitmap or plain), at four stages:
 *
 *   old_idx         the old image, index just built
 *   new_stale       the new image, same data directory, index untouched
 *   new_reindexed   after REINDEX INDEX CONCURRENTLY (the changelog's remedy)
 *   new_fresh       a second table and index built from scratch on the new image
 *
 * A predicate is "wrong" at a stage when the index count differs from the
 * sequential count. The sequential count is the operator's own answer on that
 * server; it is not independently known, but it is the same number at every
 * stage for these predicates (recorded as `seq_*`).
 *
 * amcheck: this module records whether either image ships a GiST check
 * (gist_index_check). The images carry amcheck 1.4, which checks B-tree only,
 * so GiST validity here is read from query results, not from amcheck.
 *
 * Not measured here: numeric, text or other btree_gist opclasses; indexes built
 * with different fillfactor or on multicolumn keys; any hosted project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { one, pairs, skipReason, tryq, withRig, type Pair } from "../lib/rig";
import type { Client } from "pg";

const ID = "PG03";

const QUERIES: [string, string][] = [
  ["eq_NaN", "x = 'NaN'"],
  ["ge_NaN", "x >= 'NaN'"],
  ["gt_NaN", "x > 'NaN'"],
  ["lt_NaN", "x < 'NaN'"],
  ["le_NaN", "x <= 'NaN'"],
  ["gt_1000", "x > 1000"],
  ["ge_1999", "x >= 1999"],
  ["ge_Infinity", "x >= 'Infinity'"],
  ["eq_5", "x = 5"],
  ["le_10", "x <= 10"],
];

const DETECT = `
  select i.indexrelid::regclass::text as idx
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_am am on am.oid = c.relam and am.amname = 'gist'
  where exists (select 1 from unnest(string_to_array(i.indclass::text, ' ')::oid[]) o
                join pg_opclass oc on oc.oid = o where oc.opcname in ('gist_float4_ops', 'gist_float8_ops'))
  order by 1`;

type Counts = Record<string, { seq: number; idx: number }>;

async function count(c: Client, table: string, where: string, useIndex: boolean): Promise<number> {
  await c.query(`set enable_seqscan = ${!useIndex}`);
  await c.query(`set enable_indexscan = ${useIndex}`);
  await c.query(`set enable_bitmapscan = ${useIndex}`);
  const n = Number(await one(c, `select count(*) from ${table} where ${where}`));
  await c.query("reset enable_seqscan");
  await c.query("reset enable_indexscan");
  await c.query("reset enable_bitmapscan");
  return n;
}

async function stage(c: Client, table: string): Promise<Counts> {
  const out: Counts = {};
  for (const [k, w] of QUERIES) out[k] = { seq: await count(c, table, w, false), idx: await count(c, table, w, true) };
  return out;
}

async function usesGist(c: Client, table: string, indexName: string): Promise<boolean> {
  await c.query("set enable_seqscan = off");
  const r = await c.query(`explain select count(*) from ${table} where x = 'NaN'`);
  await c.query("reset enable_seqscan");
  return r.rows.some((x) => String(Object.values(x)[0]).includes(indexName));
}

const wrong = (s: Counts) => Object.entries(s).filter(([, v]) => v.seq !== v.idx).map(([k]) => k);

async function runPair(p: Pair): Promise<TestResult> {
  const m: Record<string, string | number> = {};
  const dev: string[] = [];
  const expect = (label: string, cond: boolean) => {
    if (!cond) dev.push(label);
  };
  const types = ["float4", "float8"] as const;
  const old: Record<string, Counts> = {};
  const stale: Record<string, Counts> = {};
  const reidx: Record<string, Counts> = {};
  const fresh: Record<string, Counts> = {};

  await withRig(p, async (r) => {
    await r.start("old");
    await r.withClient("supabase_admin", "postgres", async (c) => {
      m.old_server_version = await one(c, "select current_setting('server_version')");
      await c.query("create schema if not exists extensions");
      await c.query("create extension btree_gist with schema extensions");
      await c.query("create extension amcheck with schema extensions");
      m.old_btree_gist_version = await one(c, "select extversion from pg_extension where extname = 'btree_gist'");
      m.old_has_gist_index_check = (await one<boolean>(c, "select to_regproc('gist_index_check') is not null")) ? "yes" : "no";
      for (const t of types) {
        await c.query(`create table g_${t}(x ${t})`);
        await c.query(`insert into g_${t} select i from generate_series(1, 2000) i`);
        await c.query(`insert into g_${t} select 'NaN' from generate_series(1, 50)`);
        await c.query(`insert into g_${t} select 'Infinity' from generate_series(1, 5)`);
        await c.query(`create index g_${t}_gist on g_${t} using gist (x)`);
        await c.query(`analyze g_${t}`);
        m[`${t}_rows`] = Number(await one(c, `select count(*) from g_${t}`));
        m[`old_${t}_plan_uses_gist_index`] = (await usesGist(c, `g_${t}`, `g_${t}_gist`)) ? "yes" : "no";
        old[t] = await stage(c, `g_${t}`);
      }
      m.old_detect_flagged = (await c.query(DETECT)).rows.map((x) => x.idx).join(", ") || "(none)";
    });
    await r.stop();

    await r.start("new");
    await r.withClient("supabase_admin", "postgres", async (c) => {
      m.new_server_version = await one(c, "select current_setting('server_version')");
      m.new_has_gist_index_check = (await one<boolean>(c, "select to_regproc('gist_index_check') is not null")) ? "yes" : "no";
      m.new_detect_flagged = (await c.query(DETECT)).rows.map((x) => x.idx).join(", ") || "(none)";
      for (const t of types) stale[t] = await stage(c, `g_${t}`);
      for (const t of types) {
        const re = await tryq(c, `reindex index concurrently g_${t}_gist`);
        m[`new_${t}_reindex_concurrently`] = re.ok ? "ok" : `ERR ${re.code}: ${re.err}`;
        reidx[t] = await stage(c, `g_${t}`);
        await c.query(`create table f_${t} as select x from g_${t}`);
        await c.query(`create index f_${t}_gist on f_${t} using gist (x)`);
        await c.query(`analyze f_${t}`);
        fresh[t] = await stage(c, `f_${t}`);
      }
    });
    await r.stop();
  });

  for (const t of types) {
    for (const [k] of QUERIES) {
      const a = old[t]![k]!;
      const b = stale[t]![k]!;
      const d = reidx[t]![k]!;
      const f = fresh[t]![k]!;
      m[`${t}_${k}`] = `seq ${a.seq}/${b.seq}/${d.seq}/${f.seq}; idx ${a.idx}/${b.idx}/${d.idx}/${f.idx}`;
    }
    m[`${t}_wrong_old_idx`] = `${wrong(old[t]!).length} of ${QUERIES.length}`;
    m[`${t}_wrong_new_stale`] = `${wrong(stale[t]!).length} of ${QUERIES.length}`;
    m[`${t}_wrong_new_reindexed`] = `${wrong(reidx[t]!).length} of ${QUERIES.length}`;
    m[`${t}_wrong_new_fresh`] = `${wrong(fresh[t]!).length} of ${QUERIES.length}`;
    m[`${t}_wrong_old_idx_list`] = wrong(old[t]!).join(",") || "(none)";
    m[`${t}_wrong_new_stale_list`] = wrong(stale[t]!).join(",") || "(none)";
    expect(`${t}: the old image's index disagrees with the heap on at least one predicate`, wrong(old[t]!).length > 0);
    expect(`${t}: the stale index on the new image still disagrees`, wrong(stale[t]!).length > 0);
    expect(`${t}: REINDEX CONCURRENTLY removes every disagreement`, wrong(reidx[t]!).length === 0);
    expect(`${t}: an index built fresh on the new image agrees`, wrong(fresh[t]!).length === 0);
  }
  m.cell_format = "seq <old>/<new_stale>/<new_reindexed>/<new_fresh>; idx <old>/<new_stale>/<new_reindexed>/<new_fresh>";

  return {
    id: `${ID}-pg${p.major}`,
    title: `btree_gist NaN on float4/float8 (PG ${p.major}: ${p.oldTag} -> ${p.newTag})`,
    status: dev.length ? "fail" : "pass",
    detail: dev.length
      ? `deviations from the changelog's description: ${dev.join("; ")}`
      : "stale index wrong on both images, correct after REINDEX CONCURRENTLY and when built fresh on the new image",
    measurements: m,
  };
}

const mod: TestModule = {
  id: ID,
  title: "btree_gist NaN on float columns, before/after REINDEX",
  where: "local",
  requires: [],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult[]> {
    const why = await skipReason();
    if (why) return [{ id: ID, title: this.title, status: "skip", detail: why }];
    const out: TestResult[] = [];
    for (const p of pairs()) {
      try {
        out.push(await runPair(p));
      } catch (e) {
        out.push({ id: `${ID}-pg${p.major}`, title: this.title, status: "fail", detail: `threw: ${(e as Error).message}` });
      }
    }
    return out;
  },
};

export default mod;
