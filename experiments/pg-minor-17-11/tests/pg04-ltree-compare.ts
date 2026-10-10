/**
 * PG04 - ltree comparison of very deep values, B-tree validity and amcheck,
 * across the minor (public changelog:
 * https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes says
 * values with more than about 14,653 labels can compare incorrectly and
 * corrupt B-tree indexes). Upstream source for the changed function:
 * contrib/ltree/ltree_op.c, ltree_compare(), between the REL_17_6 and
 * REL_17_11 tags of github.com/postgres/postgres.
 *
 * Per pair:
 *
 *   sweep   for n = 14640..14670, plus 20000, 40000, 65535: is the ltree of n
 *           labels 'a.a. ... .a' greater than the one-label ltree 'a'? The
 *           true answer is yes for every n (same prefix, more labels). Run on
 *           both images; the first n that answers "no" is recorded.
 *   index   a table of all-'a' ltrees of 1..400 labels, 1000..14000 labels in
 *           steps of 500, and 14660..14760 labels in steps of 4 (453 rows),
 *           with a B-tree index built on the OLD image. Because every value
 *           is a chain of 'a', the true order is the order of nlevel(), so
 *           the truth for each predicate is a count over nlevel() and does
 *           not use the comparison under test. Predicates are counted by
 *           sequential scan (the operator's own answer) and by index scan, at
 *           old_idx, new_stale, new_reindexed (REINDEX INDEX CONCURRENTLY),
 *           and new_fresh (second table and index built on the new image).
 *           bt_index_check(index, true) and bt_index_parent_check(index, true,
 *           true) are run at each stage and their outcome recorded.
 *
 * Whether amcheck flags the stale index is NOT part of the pass band: it is a
 * recorded observation for this one fixture of 453 rows.
 *
 * Not measured here: ltree values with fewer than 14,653 labels whose
 * comparison could overflow through long labels (the source suggests the
 * product is label-length times remaining labels); GiST ltree indexes (PG05
 * covers the case-folding side); any hosted project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { one, outcome, pairs, skipReason, tryq, withRig, type Pair } from "../lib/rig";
import type { Client } from "pg";

const ID = "PG04";

const deep = (n: number | string) => `text2ltree(repeat('a.', (${n}) - 1) || 'a')`;

const SWEEP = [...Array.from({ length: 31 }, (_, i) => 14640 + i), 20000, 40000, 65535];

/** [key, predicate on column p, truth predicate on nlevel(p)] */
const PREDS: [string, string, string][] = [
  ["gt_3_labels", `p > ${deep(3)}`, "nlevel(p) > 3"],
  ["gt_14660_labels", `p > ${deep(14660)}`, "nlevel(p) > 14660"],
  ["lt_1000_labels", `p < ${deep(1000)}`, "nlevel(p) < 1000"],
  ["eq_14700_labels", `p = ${deep(14700)}`, "nlevel(p) = 14700"],
];

async function firstWrong(c: Client): Promise<{ first: string; wrongCount: number }> {
  let first = "(none)";
  let wrongCount = 0;
  for (const n of SWEEP) {
    const gt = await one<boolean>(c, `select ${deep(n)} > 'a'::ltree`);
    if (!gt) {
      wrongCount++;
      if (first === "(none)") first = String(n);
    }
  }
  return { first, wrongCount };
}

type Stage = Record<string, { seq: number; idx: number; truth: number }>;

async function counts(c: Client, table: string): Promise<{ s: Stage; order: string }> {
  const s: Stage = {};
  for (const [k, pred, truth] of PREDS) {
    const t = Number(await one(c, `select count(*) from ${table} where ${truth}`));
    await c.query("set enable_seqscan = on; set enable_indexscan = off; set enable_bitmapscan = off");
    const seq = Number(await one(c, `select count(*) from ${table} where ${pred}`));
    await c.query("set enable_seqscan = off; set enable_indexscan = on; set enable_bitmapscan = on");
    const idx = Number(await one(c, `select count(*) from ${table} where ${pred}`));
    await c.query("reset enable_seqscan; reset enable_indexscan; reset enable_bitmapscan");
    s[k] = { seq, idx, truth: t };
  }
  await c.query("set enable_seqscan = off; set enable_bitmapscan = off");
  const order = await one<string>(c, `select string_agg(nlevel(p)::text, ',') from (select p from ${table} order by p limit 5) s`);
  await c.query("reset enable_seqscan; reset enable_bitmapscan");
  return { s, order };
}

const bad = (s: Stage, which: "seq" | "idx") => Object.entries(s).filter(([, v]) => v[which] !== v.truth).map(([k]) => k);

async function amcheck(c: Client, index: string): Promise<{ check: string; parent: string }> {
  const a = await tryq(c, `select bt_index_check('${index}'::regclass, true)`);
  const b = await tryq(c, `select bt_index_parent_check('${index}'::regclass, true, true)`);
  return { check: outcome(a), parent: outcome(b) };
}

async function runPair(p: Pair): Promise<TestResult> {
  const m: Record<string, string | number> = {};
  const dev: string[] = [];
  const expect = (label: string, cond: boolean) => {
    if (!cond) dev.push(label);
  };
  let old!: { s: Stage; order: string };
  let stale!: { s: Stage; order: string };
  let reidx!: { s: Stage; order: string };
  let fresh!: { s: Stage; order: string };

  await withRig(p, async (r) => {
    await r.start("old");
    await r.withClient("supabase_admin", "postgres", async (c) => {
      m.old_server_version = await one(c, "select current_setting('server_version')");
      await c.query("create schema if not exists extensions");
      await c.query("create extension ltree with schema extensions");
      await c.query("create extension amcheck with schema extensions");
      const sw = await firstWrong(c);
      m.old_sweep_first_n_where_deep_is_not_greater_than_a = sw.first;
      m.old_sweep_wrong_of = `${sw.wrongCount} of ${SWEEP.length}`;
      expect("old: some deep value compares as not greater than its own prefix", sw.wrongCount > 0);
      await c.query("create table dd(p ltree)");
      await c.query(`insert into dd select ${deep("n")} from generate_series(14660, 14760, 4) n`);
      await c.query(`insert into dd select ${deep("n")} from generate_series(1, 400) n`);
      await c.query(`insert into dd select ${deep("n")} from generate_series(1000, 14000, 500) n`);
      await c.query("create index dd_bt on dd using btree (p)");
      await c.query("analyze dd");
      m.rows = Number(await one(c, "select count(*) from dd"));
      m.old_detect_rows_over_14653_labels = Number(await one(c, "select count(*) from dd where nlevel(p) > 14653"));
      old = await counts(c, "dd");
      const am = await amcheck(c, "dd_bt");
      m.old_bt_index_check = am.check;
      m.old_bt_index_parent_check = am.parent;
    });
    await r.stop();

    await r.start("new");
    await r.withClient("supabase_admin", "postgres", async (c) => {
      m.new_server_version = await one(c, "select current_setting('server_version')");
      const sw = await firstWrong(c);
      m.new_sweep_first_n_where_deep_is_not_greater_than_a = sw.first;
      m.new_sweep_wrong_of = `${sw.wrongCount} of ${SWEEP.length}`;
      expect("new: every deep value compares greater than its prefix", sw.wrongCount === 0);
      stale = await counts(c, "dd");
      const am = await amcheck(c, "dd_bt");
      m.new_stale_bt_index_check = am.check;
      m.new_stale_bt_index_parent_check = am.parent;
      const re = await tryq(c, "reindex index concurrently dd_bt");
      m.new_reindex_concurrently = re.ok ? "ok" : `ERR ${re.code}: ${re.err}`;
      reidx = await counts(c, "dd");
      const am2 = await amcheck(c, "dd_bt");
      m.new_reindexed_bt_index_check = am2.check;
      m.new_reindexed_bt_index_parent_check = am2.parent;
      await c.query("create table dd_fresh as select p from dd");
      await c.query("create index dd_fresh_bt on dd_fresh using btree (p)");
      await c.query("analyze dd_fresh");
      fresh = await counts(c, "dd_fresh");
      const am3 = await amcheck(c, "dd_fresh_bt");
      m.new_fresh_bt_index_check = am3.check;
      m.new_fresh_bt_index_parent_check = am3.parent;
    });
    await r.stop();
  });

  for (const [k] of PREDS) {
    m[`${k}`] =
      `truth ${old.s[k]!.truth}; seq ${old.s[k]!.seq}/${stale.s[k]!.seq}/${reidx.s[k]!.seq}/${fresh.s[k]!.seq}; idx ${old.s[k]!.idx}/${stale.s[k]!.idx}/${reidx.s[k]!.idx}/${fresh.s[k]!.idx}`;
  }
  m.first_five_by_index_order_nlevel = `truth 1,2,3,4,5; ${old.order} / ${stale.order} / ${reidx.order} / ${fresh.order}`;
  m.cell_format = "seq and idx: <old>/<new_stale>/<new_reindexed>/<new_fresh>";
  m.wrong_seq_old = bad(old.s, "seq").join(",") || "(none)";
  m.wrong_idx_old = bad(old.s, "idx").join(",") || "(none)";
  m.wrong_idx_new_stale = bad(stale.s, "idx").join(",") || "(none)";
  m.wrong_idx_new_reindexed = bad(reidx.s, "idx").join(",") || "(none)";
  m.wrong_idx_new_fresh = bad(fresh.s, "idx").join(",") || "(none)";
  m.wrong_seq_new = bad(stale.s, "seq").join(",") || "(none)";

  expect("old: the sequential or index count disagrees with the nlevel() truth on some predicate", bad(old.s, "seq").length + bad(old.s, "idx").length > 0);
  expect("new: sequential counts equal the truth", bad(stale.s, "seq").length === 0);
  expect("new: REINDEX CONCURRENTLY leaves the index answering the truth", bad(reidx.s, "idx").length === 0);
  expect("new: a fresh index answers the truth", bad(fresh.s, "idx").length === 0);

  return {
    id: `${ID}-pg${p.major}`,
    title: `ltree deep-value comparison and B-tree validity (PG ${p.major}: ${p.oldTag} -> ${p.newTag})`,
    status: dev.length ? "fail" : "pass",
    detail: dev.length ? `deviations from the changelog's description: ${dev.join("; ")}` : "old compares deep values wrongly; new compares correctly; reindexed and fresh indexes answer the truth",
    measurements: m,
  };
}

const mod: TestModule = {
  id: ID,
  title: "ltree >14,653 labels: comparison, B-tree index, amcheck",
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
