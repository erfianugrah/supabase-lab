/**
 * PG05 - ltree GiST index vs operator for case-insensitive lquery matching
 * ("label@") on non-ASCII labels, across the minor, in the image's default
 * `postgres` database (ICU provider on the PG 17 images, libc on the PG 15
 * images: the `*_db_locale` cells record it) and in a second libc UTF-8
 * database created for the module (public changelog:
 * https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes says
 * ltree indexes built under the previous version may silently return
 * incomplete results on multibyte or ICU/builtin-provider databases, and
 * recommends REINDEX).
 *
 * Per pair, per database: 300 words of 4-6 letters drawn from an alphabet of
 * ASCII and accented letters in both cases (fixed seed), plus 20000 filler
 * rows, in an ltree column with a GiST index (siglen = 2000, so inner-page
 * signatures stay selective) built on the OLD image. For every word w two
 * queries are counted, `p ~ 'UPPER(w)@'` and `p ~ 'lower(w)@'`, once with only
 * a sequential scan allowed (the operator's own answer) and once with only an
 * index scan allowed. Each stored word matches both queries by the operator,
 * so "idx < seq" is a row the index failed to return. Stages as in PG03/PG04:
 * old_idx, new_stale, new_reindexed (REINDEX INDEX CONCURRENTLY), new_fresh.
 * Also recorded: how many sequential counts differ between the old and the
 * new image (the operator side changing), and a few named probes.
 *
 * Source reading that goes with this module (not measured here, cited in the
 * RUNLOG): contrib/ltree/crc32.c, which hashes labels for the GiST signature,
 * is byte-identical in the REL_17_6 and REL_17_11 tags (and in REL_15_14 and
 * REL_15_19) of github.com/postgres/postgres; contrib/ltree/lquery_op.c, the
 * operator side, differs between them.
 *
 * Not measured here: a single-byte (LATIN1) database (the image has no such
 * locale installed), the builtin locale provider on PG 17, PG 18, ltree B-tree
 * or hash indexes on non-ASCII labels, other alphabets.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { one, pairs, skipReason, tryq, withRig, type Pair, type Rig } from "../lib/rig";
import type { Client } from "pg";

const ID = "PG05";
const ALPHABET = Array.from("abcdeilnoprstuvzéèñúüöäçÉÑÚÜÖÄ");
const N_WORDS = 300;
const N_FILLER = 20000;

const DBS: { key: string; db: string; create: string | null }[] = [
  { key: "postgres_db", db: "postgres", create: null },
  {
    key: "libc",
    db: "d_libc",
    create: "create database d_libc template template0 locale_provider = libc locale = 'en_US.UTF-8' encoding = 'UTF8'",
  },
];

const PROBES: [string, string][] = [
  ["istanbul_dotted_I_upper", "İSTANBUL@"],
  ["istanbul_ascii_lower", "istanbul@"],
  ["eclair_nandu_upper_2_labels", "ÉCLAIR@.ÑANDÚ@"],
  ["eclair_nandu_lower_2_labels", "éclair@.ñandú@"],
];
const PROBE_ROWS = ["İSTANBUL", "İSTANBUL.a", "istanbul", "ISTANBUL", "Éclair.Ñandú", "éclair.ñandú"];

/** Small deterministic PRNG so every run builds the same words. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function words(): string[] {
  const rnd = prng(42);
  return Array.from({ length: N_WORDS }, (_, i) =>
    Array.from({ length: 4 + (i % 3) }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]).join(""),
  );
}

interface Run {
  seq: number[];
  idx: number[];
  probes: Record<string, [number, number]>;
}

async function countLq(c: Client, lq: string, useIndex: boolean): Promise<number> {
  await c.query(`set enable_seqscan = ${!useIndex}`);
  await c.query(`set enable_indexscan = ${useIndex}`);
  await c.query(`set enable_bitmapscan = ${useIndex}`);
  const n = Number((await c.query("select count(*) as n from lt where p ~ $1::lquery", [lq])).rows[0].n);
  await c.query("reset enable_seqscan");
  await c.query("reset enable_indexscan");
  await c.query("reset enable_bitmapscan");
  return n;
}

async function runStage(c: Client, ws: string[]): Promise<Run> {
  const seq: number[] = [];
  const idx: number[] = [];
  for (const w of ws) {
    for (const lq of [`${w.toUpperCase()}@`, `${w.toLowerCase()}@`]) {
      seq.push(await countLq(c, lq, false));
      idx.push(await countLq(c, lq, true));
    }
  }
  const probes: Record<string, [number, number]> = {};
  for (const [k, lq] of PROBES) probes[k] = [await countLq(c, lq, false), await countLq(c, lq, true)];
  return { seq, idx, probes };
}

const missing = (r: Run) => r.idx.filter((x, i) => x < r.seq[i]!).length;
const extra = (r: Run) => r.idx.filter((x, i) => x > r.seq[i]!).length;

async function build(c: Client, ws: string[]): Promise<void> {
  await c.query("create extension if not exists ltree");
  await c.query("create table lt(p ltree)");
  for (const w of ws) await c.query("insert into lt values ($1)", [w]);
  for (const pr of PROBE_ROWS) await c.query("insert into lt values ($1)", [pr]);
  await c.query(`insert into lt select ('w' || i || '.x' || (i % 50))::ltree from generate_series(1, ${N_FILLER}) i`);
  await c.query("create index lt_gist on lt using gist (p gist_ltree_ops(siglen = 2000))");
  await c.query("analyze lt");
}

async function runPair(p: Pair): Promise<TestResult> {
  const m: Record<string, string | number> = {};
  const dev: string[] = [];
  const expect = (label: string, cond: boolean) => {
    if (!cond) dev.push(label);
  };
  const ws = words();
  const stages: Record<string, Record<"old" | "stale" | "reidx" | "fresh", Run>> = {};

  await withRig(p, async (r: Rig) => {
    await r.start("old");
    m.old_server_version = await r.withClient("supabase_admin", "postgres", (c) => one(c, "select current_setting('server_version')"));
    for (const d of DBS) {
      if (d.create) await r.withClient("supabase_admin", "postgres", (c) => c.query(d.create!));
      await r.withClient("supabase_admin", d.db, async (c) => {
        const loc = (
          await c.query(
            "select datlocprovider::text p, datcollate cl, pg_encoding_to_char(encoding) e from pg_database where datname = current_database()",
          )
        ).rows[0];
        m[`${d.key}_db_locale`] = `${loc.p === "i" ? "icu" : loc.p === "c" ? "libc" : loc.p} ${loc.cl} ${loc.e}`;
        await build(c, ws);
        stages[d.key] = { old: await runStage(c, ws) } as never;
      });
    }
    await r.stop();

    await r.start("new");
    m.new_server_version = await r.withClient("supabase_admin", "postgres", (c) => one(c, "select current_setting('server_version')"));
    for (const d of DBS) {
      await r.withClient("supabase_admin", d.db, async (c) => {
        const st = stages[d.key]!;
        st.stale = await runStage(c, ws);
        const re = await tryq(c, "reindex index concurrently lt_gist");
        m[`${d.key}_new_reindex_concurrently`] = re.ok ? "ok" : `ERR ${re.code}: ${re.err}`;
        st.reidx = await runStage(c, ws);
        await c.query("create table lt_copy as select p from lt");
        await c.query("create index lt_copy_gist on lt_copy using gist (p gist_ltree_ops(siglen = 2000))");
        await c.query("analyze lt_copy");
        // the fresh table is queried under the name lt: swap names
        await c.query("alter table lt rename to lt_old");
        await c.query("alter table lt_copy rename to lt");
        st.fresh = await runStage(c, ws);
      });
    }
    await r.stop();
  });

  const nq = ws.length * 2;
  m.queries_per_stage = nq;
  m.rows_per_table = ws.length + PROBE_ROWS.length + N_FILLER;
  for (const d of DBS) {
    const st = stages[d.key]!;
    for (const [name, key] of [["old_idx", "old"], ["new_stale", "stale"], ["new_reindexed", "reidx"], ["new_fresh", "fresh"]] as const) {
      const rr = st[key];
      m[`${d.key}_${name}_idx_missing_rows`] = `${missing(rr)} of ${nq} queries`;
      m[`${d.key}_${name}_idx_extra_rows`] = `${extra(rr)} of ${nq} queries`;
    }
    m[`${d.key}_seq_counts_changed_old_to_new`] = `${st.stale.seq.filter((x, i) => x !== st.old.seq[i]).length} of ${nq} queries`;
    for (const [k] of PROBES) {
      const cell = (rr: Run) => `${rr.probes[k]![0]}/${rr.probes[k]![1]}`;
      m[`${d.key}_probe_${k}`] = `seq/idx old ${cell(st.old)}; new_stale ${cell(st.stale)}; new_reindexed ${cell(st.reidx)}; new_fresh ${cell(st.fresh)}`;
    }
    expect(`${d.key}: the old image's index misses rows the operator matches`, missing(st.old) > 0);
    expect(`${d.key}: REINDEX leaves no missing rows (changelog's remedy)`, missing(st.reidx) === 0);
    expect(`${d.key}: a fresh index on the new image leaves no missing rows`, missing(st.fresh) === 0);
  }

  return {
    id: `${ID}-pg${p.major}`,
    title: `ltree GiST case-insensitive match, index vs operator (PG ${p.major}: ${p.oldTag} -> ${p.newTag})`,
    status: dev.length ? "fail" : "pass",
    detail: dev.length
      ? `the changelog's description does not reproduce here: ${dev.join("; ")}`
      : "index misses on the old image; none after REINDEX or on a fresh index on the new image",
    measurements: m,
  };
}

const mod: TestModule = {
  id: ID,
  title: "ltree GiST index vs operator, case-insensitive lquery on non-ASCII labels",
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
