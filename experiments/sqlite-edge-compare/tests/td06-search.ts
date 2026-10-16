/**
 * TD06 - Search: FTS5 (D1, Turso) vs tsvector+GIN, and Turso native vector vs pgvector HNSW top-10 with recall@10
 *
 * Two search shapes on seeded data (TD06_SEED), all rows from the probe
 * Worker (colo recorded):
 *
 *   Full text, `docs` documents (title 3-8 words, body 40-120 words, Zipf
 *   over a 3000-word pseudo-word vocabulary):
 *     d1     FTS5 virtual table through the D1 binding (served_by_region recorded)
 *     turso  FTS5 virtual table on libSQL (@libsql/client/web, aws-ap-southeast-2)
 *     pg     generated tsvector ('simple' config, no stemming, like FTS5's
 *            unicode61) + GIN, through Hyperdrive with caching off
 *   Vector, `vectors` x 384-dim clustered unit vectors, cosine distance:
 *     turso  F32_BLOB column, libsql_vector_idx with metric=cosine,
 *            compress_neighbors=float8, max_neighbors=16, created before the
 *            load, vector_top_k (why not defaults: TD06g and the
 *            TD06_TURSO_IDX_ARGS comment in lib/td05-06-08-data.ts)
 *     pg     pgvector vector(384), HNSW built after the load (pgvector's
 *            recommended order), defaults; hnsw.ef_search read and recorded
 *     d1     no in-DB vector found in the D1 docs; one probe call of vector32()
 *            records the error text D1 answers with
 *
 *   TD06a-<backend>         document ingest (330 docs per op; FTS5 and GIN
 *                           maintained during the load), summed op time, rows/s
 *   TD06b-<backend>-<query> top-10 ranked query (bm25 on FTS5, ts_rank on
 *                           Postgres) for four query shapes (common, mid, rare
 *                           term, two-term AND); n per query after warm-up;
 *                           `correct` = the match count equals the JavaScript
 *                           truth; top-10 overlap with D1 recorded (ranking
 *                           functions differ by design, so overlap < 1 on pg is
 *                           not a failure)
 *   TD06c-<backend>         vector load (+ index build on pg), ms
 *   TD06d-<backend>-ann     top-10 through the index: latency, recall@10 vs
 *                           exact brute force computed in JavaScript (mean, min)
 *   TD06e-<backend>-exact   top-10 by full scan in the database, same queries:
 *                           latency and recall (should be ~1; f32 rounding)
 *   TD06f-d1-vector         D1 vector32() probe
 *   TD06g-turso-defaults    the same load into a table whose index uses
 *                           libSQL's defaults (metric=cosine only), first
 *                           min(500, vectors) rows: per-op ms, first vs last
 *   TD06g-turso-after-load  min(3000, vectors) rows loaded with no index,
 *                           then CREATE INDEX with the measured arguments:
 *                           ms, or the error text verbatim
 *   TD06z                   cleanup
 *
 * Each timed vector query uses a different seeded query vector (n + warm-up
 * of them); backends round-robin per iteration with the order rotating.
 *
 * Sizes (env): full 10k docs, 10k vectors, n=20, warm-up 2; TD_SMOKE=1: 500
 * docs, 500 vectors, n=5, warm-up 1 (TD06_DOCS, TD06_VECTORS, TD06_N,
 * TD06_WARMUP, TD06_DIM override).
 *
 * Not settled by this module: the Turso engine's Tantivy `USING fts` index
 * (a different engine, out of scope), stemming or language configs, phrase
 * and prefix queries, relevance quality (no judged set: overlap only),
 * filtered vector search, HNSW/DiskANN parameter tuning, Vectorize (a
 * separate Cloudflare product), the local vantage.
 *
 * DESTRUCTIVE: creates td06_fts (D1, Turso), td06_docs (Postgres), td06_vec
 * (Turso, Postgres) and `CREATE EXTENSION IF NOT EXISTS vector` on the
 * fixture project (the extension is left in place; the project is the
 * fixture's and goes at `make down`); tables dropped at start and in
 * finally. Self-skips without the fixture.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fixtureOrSkip, type RunResult, runLocal, runOnWorker } from "../lib/client";
import type { RunRequest, Stmt, WorkerBackend } from "../lib/contract";
import type { Fixture } from "../lib/fixture";
import { roundRobin, summarize, summaryColumns } from "../lib/stats";
import { withTursodb } from "../lib/td04-07-plan";
import {
  chunk,
  type Dialect,
  exactTopK,
  ftsTruthCount,
  genDocs,
  genQueryVectors,
  genVectors,
  genVocab,
  idsOf,
  mean,
  metaDistinct,
  overlap,
  r3,
  recallAtK,
  rowsPerStatement,
  sum,
  TD06_PG_HNSW,
  TD06_SEED,
  TD06_TURSO_IDX_ARGS,
  TD06_TURSO_IDX_DEFAULT_ARGS,
  TD06_VOCAB,
  td06DocInsert,
  td06FtsDdl,
  td06FtsQueries,
  td06FtsSql,
  td06Sizes,
  td06VecDdl,
  td06VecInsert,
  td06VecSql,
  tursoVecIndex,
  vecText,
} from "../lib/td05-06-08-data";

const ID = "TD06";
const BASE_FTS: { b: WorkerBackend; d: Dialect }[] = [
  { b: "d1", d: "sqlite" },
  { b: "turso", d: "sqlite" },
  { b: "do", d: "sqlite" },
  { b: "pg", d: "pg" },
];
const BASE_VEC: { b: WorkerBackend; d: Dialect }[] = [
  { b: "turso", d: "sqlite" },
  { b: "pg", d: "pg" },
];
const DOCS_PER_OP = 330;
/** 100 per op: Turso maintains its vector index on insert, so ops stay short. */
const VECS_PER_OP = 100;
const VECS_PER_STMT = 50;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const firstErr = (r: RunResult) => r.error ?? r.errors?.[0]?.text ?? "";
const failed = (e: unknown) => ({ ok: false, error: errMsg(e), ops: [], colos: [], httpMs: [], errors: [] }) as unknown as RunResult;
const allOk = (r: RunResult) => r.ok && r.ops.length > 0 && r.ops.every((o) => o.ok);
const opErr = (r: RunResult) => r.ops.find((o) => !o.ok)?.error ?? firstErr(r) ?? "no ops";

async function run(fx: Fixture, req: RunRequest<WorkerBackend>, timeoutMs = 180_000): Promise<RunResult> {
  return runOnWorker(fx, req, { timeoutMs }).catch(failed);
}

type Sample = { ms: number; ok: boolean; warm: boolean; error?: string; ids: number[]; iter: number };
const push = (m: Map<string, Sample[]>, k: string, s: Sample) => (m.get(k) ?? m.set(k, []).get(k)!).push(s);
const kept = (xs: Sample[]) => xs.filter((x) => !x.warm && x.ok);

const mod: TestModule = {
  id: ID,
  title: "Search: FTS5 (D1, Turso) vs tsvector+GIN, and Turso native vector vs pgvector HNSW top-10 with recall@10",
  where: "local",
  // The battery always runs with the PAT; requiring it keeps an offline run from probing a live fixture.
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const fx = await fixtureOrSkip(ctx);
    if ("skip" in fx) return [{ id: ID, title: this.title, status: "skip", detail: fx.skip }];
    // tursodb: FTS5 refused in MVCC mode, no vector index on Cloud (2026-10-16 probe); both recorded as measured.
    const FTS = withTursodb(fx, BASE_FTS);
    const VEC = withTursodb(fx, BASE_VEC);
    const sz = td06Sizes();
    const out: TestResult[] = [];
    const vantage = {
      vantage: "worker",
      seed: TD06_SEED,
      turso_location: fx.turso?.location ?? "",
      supabase_region: fx.supabase?.region ?? "",
      d1_location_hint: fx.d1?.locationHint ?? "",
      pg_driver: fx.meta?.drivers?.pg ?? "",
      libsql_driver: fx.meta?.drivers?.["@libsql/client"] ?? "",
    };
    const dropAll = async (): Promise<{ bad: string; left: string }> => {
      const bad: string[] = [];
      const plan: [WorkerBackend, string[]][] = [
        ["d1", ["DROP TABLE IF EXISTS td06_fts"]],
        [
          "turso",
          ["DROP TABLE IF EXISTS td06_fts", ...["td06_vec", "td06_vecd", "td06_vecb"].flatMap((t) => [`DROP INDEX IF EXISTS ${t}_idx`, `DROP TABLE IF EXISTS ${t}`])],
        ],
        ["pg", ["DROP TABLE IF EXISTS td06_docs", "DROP TABLE IF EXISTS td06_vec"]],
        ["do", ["DROP TABLE IF EXISTS td06_fts"]],
        ...(VEC.some((x) => x.b === "tursodb") ? ([["tursodb", ["DROP TABLE IF EXISTS td06_vec"]]] as [WorkerBackend, string[]][]) : []),
      ];
      for (const [b, stmts] of plan) {
        const r = await run(fx, { backend: b, statements: stmts.map((sql) => ({ sql })) });
        if (!allOk(r)) bad.push(`${b}: ${opErr(r)}`);
      }
      const left = await tursoVecLeftovers(true);
      return { bad: bad.join("; "), left };
    };
    /**
     * libSQL keeps a vector index in `<index>_shadow` plus a row in
     * libsql_vector_meta_shadow. A DROP INDEX on a defaults-args index
     * returned ok and left both behind (2026-10-15), and later CREATE INDEX
     * calls then failed. Lists orphans under this module's td06 names and,
     * with `clean`, removes them. Returns what it found ("" when none).
     */
    const tursoVecLeftovers = async (clean: boolean): Promise<string> => {
      const r = await run(fx, {
        backend: "turso",
        // only orphans: a shadow table or meta row whose index is gone from sqlite_master (a live index keeps both)
        statements: [
          { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'td06%shadow' AND substr(name, 1, length(name) - 7) NOT IN (SELECT name FROM sqlite_master WHERE type = 'index')" },
          { sql: "SELECT name FROM libsql_vector_meta_shadow WHERE name LIKE 'td06%' AND name NOT IN (SELECT name FROM sqlite_master WHERE type = 'index')" },
        ],
        returnRows: true,
        returnMeta: false,
      });
      const names = (k: number) => (r.ops.find((o) => o.stmt === k && o.ok)?.out?.[0]?.rows ?? []).map((x) => String((x as { name?: unknown }).name ?? "")).filter((n) => /^td06_[a-z_]+$/.test(n));
      const shadows = names(0);
      const meta = names(1);
      if (clean && (shadows.length || meta.length)) {
        await run(fx, {
          backend: "turso",
          statements: [...shadows.map((t) => ({ sql: `DROP TABLE IF EXISTS ${t}` })), ...meta.map((n) => ({ sql: "DELETE FROM libsql_vector_meta_shadow WHERE name = ?", params: [n] }))],
        });
      }
      return [...shadows.map((t) => `table ${t}`), ...meta.map((n) => `meta ${n}`)].join(", ");
    };
    /** DDL with up to 3 attempts; Turso vector DDL failed intermittently in probes. Attempts and errors are recorded, not hidden. */
    const ddl = async (b: WorkerBackend, stmts: string[]): Promise<{ ok: boolean; attempts: number; errors: string[] }> => {
      const errors: string[] = [];
      for (let a = 1; a <= 3; a++) {
        const r = await run(fx, { backend: b, statements: stmts.map((sql) => ({ sql })) });
        if (allOk(r)) return { ok: true, attempts: a, errors };
        errors.push(opErr(r).slice(0, 200));
        if (b === "turso") await tursoVecLeftovers(true);
      }
      return { ok: false, attempts: 3, errors };
    };

    try {
      ctx.log(`${ID}: sizes ${JSON.stringify(sz)}`);
      await dropAll();

      /* ------------------------------ full text ------------------------------ */
      const vocab = genVocab(TD06_VOCAB);
      const docs = genDocs(sz.docs, vocab);
      const queries = td06FtsQueries(vocab);
      const broken = new Map<WorkerBackend, string>();
      for (const { b, d } of FTS) {
        const r = await run(fx, { backend: b, statements: td06FtsDdl(d).map((sql) => ({ sql })) });
        if (!allOk(r)) broken.set(b, `schema: ${opErr(r)}`);
      }
      const ing = new Map<WorkerBackend, { ms: number[]; rows: number; errs: string[]; colos: Set<string>; ops: RunResult["ops"] }>(
        FTS.map(({ b }) => [b, { ms: [], rows: 0, errs: [], colos: new Set(), ops: [] }]),
      );
      const docBatches = chunk(docs, DOCS_PER_OP);
      for (const slot of roundRobin(FTS, docBatches.length)) {
        const { b, d } = slot.item;
        if (broken.has(b)) continue;
        const rows = docBatches[slot.iter]!;
        const statements: Stmt[] = d === "sqlite" ? chunk(rows, rowsPerStatement(3)).map((r) => td06DocInsert("sqlite", r)) : [td06DocInsert("pg", rows)];
        const r = await run(fx, { backend: b, statements, mode: d === "sqlite" ? "batch" : "each", returnMeta: b === "d1" });
        const a = ing.get(b)!;
        for (const c of r.colos ?? []) a.colos.add(c);
        const op = r.ops[0];
        if (r.ok && op?.ok) {
          a.ms.push(op.ms);
          a.rows += rows.length;
          a.ops.push(op);
        } else a.errs.push(op?.error ?? firstErr(r));
      }
      for (const { b } of FTS) {
        const a = ing.get(b)!;
        const m: Record<string, number | string> = { backend: b, ...vantage, docs: sz.docs, docs_per_op: DOCS_PER_OP };
        if (broken.has(b)) {
          out.push({ id: `${ID}a-${b}`, title: `FTS ingest ${sz.docs} docs (${b})`, status: "fail", detail: broken.get(b)!, measurements: m });
          continue;
        }
        const s = summarize(a.ms);
        Object.assign(m, {
          colo: [...a.colos].join("/"),
          n: a.ms.length,
          rows_ok: a.rows,
          ingest_op_ms_sum: r3(sum(a.ms)),
          rows_per_s: r3(a.rows / (sum(a.ms) / 1000)),
          op_ms_p50: s.p50,
          op_ms_p95: s.p95,
          failed_ops: a.errs.length,
        });
        if (b === "d1") m.served_by_region = metaDistinct(a.ops, "served_by_region");
        const ok = a.rows === sz.docs;
        if (!ok) broken.set(b, `ingest incomplete ${a.rows}/${sz.docs}`);
        out.push({
          id: `${ID}a-${b}`,
          title: `FTS ingest ${sz.docs} docs, index maintained on insert (${b}, Worker)`,
          status: ok ? "pass" : "fail",
          detail: `${a.rows} docs in ${a.ms.length} ops, ${m.ingest_op_ms_sum} ms summed op time (${m.rows_per_s} docs/s)${a.errs.length ? `; ${a.errs.length} errors, first: ${a.errs[0]!.slice(0, 300)}` : ""}`,
          measurements: m,
        });
      }
      const ftsLive = FTS.filter((x) => !broken.has(x.b));

      // match counts vs truth
      const matchCount = new Map<string, number>();
      for (const { b, d } of ftsLive) {
        const r = await run(fx, { backend: b, statements: queries.map((q) => td06FtsSql(d, q.terms).count), returnRows: true, returnMeta: false });
        for (const [k, q] of queries.entries()) {
          const op = r.ops.find((o) => o.stmt === k);
          matchCount.set(`${b}/${q.name}`, op?.ok ? Number((op.out?.[0]?.rows?.[0] as { n?: unknown } | undefined)?.n ?? Number.NaN) : Number.NaN);
        }
      }

      // timed top-10
      const fts = new Map<string, Sample[]>();
      const ftsColos = new Map<WorkerBackend, Set<string>>();
      const ftsServed = new Map<WorkerBackend, RunResult["ops"]>();
      for (const slot of roundRobin(ftsLive, sz.n + sz.warmup, sz.warmup)) {
        const { b, d } = slot.item;
        const r = await run(fx, { backend: b, statements: queries.map((q) => td06FtsSql(d, q.terms).top), returnRows: true, rowsLimit: 10, returnMeta: b === "d1" });
        for (const c of r.colos ?? []) (ftsColos.get(b) ?? ftsColos.set(b, new Set()).get(b)!).add(c);
        if (b === "d1") (ftsServed.get(b) ?? ftsServed.set(b, []).get(b)!).push(...r.ops);
        for (const [k, q] of queries.entries()) {
          const op = r.ops.find((o) => o.stmt === k);
          push(fts, `${b}/${q.name}`, op ? { ms: op.ms, ok: op.ok, warm: slot.warmup, error: op.error, ids: idsOf(op.out?.[0]?.rows), iter: slot.iter } : { ms: Number.NaN, ok: false, warm: slot.warmup, error: firstErr(r), ids: [], iter: slot.iter });
        }
      }
      for (const { b } of ftsLive) {
        for (const q of queries) {
          const key = `${b}/${q.name}`;
          const list = fts.get(key) ?? [];
          const s = { ...summarize(kept(list).map((x) => x.ms)), dropped: list.filter((x) => x.warm).length };
          const truthN = ftsTruthCount(docs, q.terms);
          const got = matchCount.get(key) ?? Number.NaN;
          const fails = list.filter((x) => !x.warm && !x.ok);
          const lastIds = kept(list).at(-1)?.ids ?? [];
          const d1Ids = kept(fts.get(`d1/${q.name}`) ?? []).at(-1)?.ids;
          const m: Record<string, number | string> = {
            backend: b,
            query: q.name,
            terms: q.terms.length,
            ...vantage,
            docs: sz.docs,
            colo: [...(ftsColos.get(b) ?? [])].join("/"),
            ...summaryColumns("ms", s),
            failed: fails.length,
            match_count: got,
            truth_count: truthN,
            correct: got === truthN ? 1 : 0,
            top_returned: lastIds.length,
          };
          if (d1Ids && b !== "d1") m.top10_overlap_vs_d1 = r3(overlap(lastIds, d1Ids));
          if (b === "d1") m.served_by_region = metaDistinct(ftsServed.get("d1") ?? [], "served_by_region");
          const ok = fails.length === 0 && s.n > 0 && m.correct === 1;
          out.push({
            id: `${ID}b-${b}-${q.name}`,
            title: `FTS top-10, ${q.name} (${q.terms.length} term${q.terms.length > 1 ? "s" : ""}, ${truthN} matches of ${sz.docs}) (${b}, Worker)`,
            status: ok ? "pass" : "fail",
            detail: ok
              ? `p50 ${s.p50} ms, p95 ${s.p95} ms (n=${s.n}, ${s.dropped} warm-up dropped), ${got} matches${m.top10_overlap_vs_d1 !== undefined ? `, top-10 overlap with D1 ${m.top10_overlap_vs_d1}` : ""}`
              : `${fails.length} failed${fails[0]?.error ? `: ${fails[0].error.slice(0, 300)}` : ""}; match count ${got} vs truth ${truthN}`,
            measurements: m,
          });
        }
      }

      /* -------------------------------- vector -------------------------------- */
      const vecs = genVectors(sz.vectors, sz.dim);
      const qv = genQueryVectors(vecs, sz.n + sz.warmup);
      const truth = qv.map((q) => exactTopK(vecs, q, 10));
      const vBroken = new Map<WorkerBackend, string>();
      const load = new Map<WorkerBackend, Record<string, number | string>>();
      for (const { b, d } of VEC) {
        const r = await ddl(b, td06VecDdl(d, sz.dim, "td06_vec", b === "tursodb" ? null : undefined));
        if (!r.ok) vBroken.set(b, `schema, 3 attempts: ${r.errors.join(" | ")}`);
        load.set(b, { ms_sum: 0, rows: 0, ops: 0, errors: 0, schema_attempts: r.attempts, ...(r.errors.length ? { schema_errors: r.errors.join(" | ").slice(0, 400) } : {}) });
      }
      const rows = vecs.map((v, i) => [i + 1, vecText(v)] as const);
      const vBatches = chunk(rows, VECS_PER_OP);
      const firstLoadErr = new Map<WorkerBackend, string>();
      const loadMs = new Map<WorkerBackend, number[]>(VEC.map(({ b }) => [b, []]));
      for (const slot of roundRobin(VEC, vBatches.length)) {
        const { b, d } = slot.item;
        if (vBroken.has(b)) continue;
        const batch = vBatches[slot.iter]!;
        const statements: Stmt[] = d === "sqlite" ? chunk(batch, VECS_PER_STMT).map((r) => td06VecInsert("sqlite", r)) : [td06VecInsert("pg", batch)];
        let r = await run(fx, { backend: b, statements, mode: d === "sqlite" ? "batch" : "each", returnMeta: false });
        const L = load.get(b)!;
        let op = r.ops[0];
        if (!(r.ok && op?.ok)) {
          // Explicit ids: one re-send; a UNIQUE/duplicate-key answer means the first attempt landed (a lost batch on 2026-10-16 left 9900/10000).
          const first = op?.error ?? firstErr(r);
          L.retries = ((L.retries as number | undefined) ?? 0) + 1;
          if (!firstLoadErr.has(b)) firstLoadErr.set(b, `retried after: ${first}`);
          r = await run(fx, { backend: b, statements, mode: d === "sqlite" ? "batch" : "each", returnMeta: false });
          op = r.ops[0];
          if (!(r.ok && op?.ok) && /UNIQUE|duplicate key/i.test(op?.error ?? firstErr(r))) {
            L.rows = (L.rows as number) + batch.length;
            L.landed_on_first_attempt = ((L.landed_on_first_attempt as number | undefined) ?? 0) + 1;
            continue;
          }
        }
        if (r.ok && op?.ok) {
          L.ms_sum = (L.ms_sum as number) + op.ms;
          loadMs.get(b)!.push(op.ms);
          L.rows = (L.rows as number) + batch.length;
          L.ops = (L.ops as number) + 1;
        } else {
          L.errors = (L.errors as number) + 1;
          if (!firstLoadErr.has(b)) firstLoadErr.set(b, op?.error ?? firstErr(r));
        }
      }
      // pgvector: HNSW after the load. Worker first (Hyperdrive documents a 60 s query ceiling); local session pooler if that fails.
      let hnswUsed = "";
      let efSearch = "";
      if (!vBroken.has("pg") && load.get("pg")!.rows === sz.vectors) {
        const L = load.get("pg")!;
        const r = await run(fx, { backend: "pg", statements: [{ sql: TD06_PG_HNSW }], returnMeta: false }, 300_000);
        if (allOk(r)) {
          L.index_build_ms = r3(r.ops[0]!.ms);
          L.index_build_vantage = "worker";
        } else {
          L.index_build_worker_error = opErr(r).slice(0, 200);
          const loc = await runLocal(fx, { backend: "pg_session", statements: [{ sql: "DROP INDEX IF EXISTS td06_vec_hnsw" }, { sql: TD06_PG_HNSW }] }).catch(failed);
          if (allOk(loc)) {
            L.index_build_ms = r3(loc.ops[1]!.ms);
            L.index_build_vantage = "local pooler 5432";
          } else vBroken.set("pg", `HNSW build: ${opErr(loc)}`);
        }
        const ex = await run(fx, {
          backend: "pg",
          statements: [{ sql: `EXPLAIN ${td06VecSql("pg", vecText(qv[0]!)).ann.sql}`, params: [vecText(qv[0]!)] }, { sql: "SHOW hnsw.ef_search" }],
          returnRows: true,
          returnMeta: false,
        });
        const plan = JSON.stringify(ex.ops[0]?.out?.[0]?.rows ?? []);
        hnswUsed = ex.ops[0]?.ok ? (plan.includes("td06_vec_hnsw") ? "yes" : "no") : `explain failed: ${ex.ops[0]?.error ?? firstErr(ex)}`.slice(0, 200);
        efSearch = ex.ops[1]?.ok ? String(Object.values((ex.ops[1]?.out?.[0]?.rows?.[0] ?? {}) as Record<string, unknown>)[0] ?? "") : `unreadable: ${ex.ops[1]?.error ?? ""}`.slice(0, 200);
      }
      for (const { b } of VEC) {
        const L = load.get(b)!;
        const ok = !vBroken.has(b) && L.rows === sz.vectors && L.errors === 0;
        if (!ok && !vBroken.has(b)) vBroken.set(b, `load incomplete ${L.rows}/${sz.vectors}${firstLoadErr.has(b) ? `; first error: ${firstLoadErr.get(b)}` : ""}`);
        const m: Record<string, number | string> = {
          backend: b,
          ...vantage,
          vectors: sz.vectors,
          dim: sz.dim,
          rows_ok: L.rows as number,
          n: L.ops as number,
          load_op_ms_sum: r3(L.ms_sum as number),
          rows_per_s: r3((L.rows as number) / ((L.ms_sum as number) / 1000)),
          failed_ops: L.errors as number,
          rows_per_op: VECS_PER_OP,
          op_ms_p50: summarize(loadMs.get(b)!).p50,
          op_ms_first: r3(loadMs.get(b)![0] ?? Number.NaN),
          op_ms_last: r3(loadMs.get(b)!.at(-1) ?? Number.NaN),
          index_order: b === "pg" ? "HNSW after load" : b === "tursodb" ? "none (no vector index on the Turso engine)" : "libsql_vector_idx before load (maintained on insert)",
          index_args: b === "pg" ? "hnsw vector_cosine_ops, build defaults" : b === "tursodb" ? "none" : TD06_TURSO_IDX_ARGS.replace(/'/g, ""),
        };
        for (const k of ["index_build_ms", "index_build_vantage", "index_build_worker_error", "schema_attempts", "schema_errors", "retries", "landed_on_first_attempt"]) if (L[k] !== undefined) m[k] = L[k]!;
        if (b === "pg") {
          m.hnsw_used_by_ann_query = hnswUsed;
          m.hnsw_ef_search = efSearch;
        }
        out.push({
          id: `${ID}c-${b}`,
          title: `vector load ${sz.vectors} x ${sz.dim} (${b}, Worker)`,
          status: ok ? "pass" : "fail",
          detail: ok
            ? `${L.rows} vectors, ${m.load_op_ms_sum} ms summed op time${m.index_build_ms !== undefined ? `, HNSW build ${m.index_build_ms} ms (${m.index_build_vantage})` : ""}`
            : (vBroken.get(b) ?? firstLoadErr.get(b) ?? "load failed"),
          measurements: m,
        });
      }

      const vecLive = VEC.filter((x) => !vBroken.has(x.b));
      const vs = new Map<string, Sample[]>();
      const vColos = new Map<WorkerBackend, Set<string>>();
      for (const slot of roundRobin(vecLive, qv.length, sz.warmup)) {
        const { b, d } = slot.item;
        const sqls = td06VecSql(d, vecText(qv[slot.iter]!));
        const r = await run(fx, { backend: b, statements: [sqls.ann, sqls.exact], returnRows: true, rowsLimit: 10, returnMeta: false });
        for (const c of r.colos ?? []) (vColos.get(b) ?? vColos.set(b, new Set()).get(b)!).add(c);
        for (const [k, kind] of (["ann", "exact"] as const).entries()) {
          const op = r.ops.find((o) => o.stmt === k);
          push(vs, `${b}/${kind}`, op ? { ms: op.ms, ok: op.ok, warm: slot.warmup, error: op.error, ids: idsOf(op.out?.[0]?.rows), iter: slot.iter } : { ms: Number.NaN, ok: false, warm: slot.warmup, error: firstErr(r), ids: [], iter: slot.iter });
        }
      }
      for (const { b } of vecLive) {
        for (const [letter, kind] of [
          ["d", "ann"],
          ["e", "exact"],
        ] as const) {
          const list = vs.get(`${b}/${kind}`) ?? [];
          const k = kept(list);
          const s = { ...summarize(k.map((x) => x.ms)), dropped: list.filter((x) => x.warm).length };
          const recalls = k.map((x) => recallAtK(truth[x.iter]!, x.ids));
          const fails = list.filter((x) => !x.warm && !x.ok);
          const m: Record<string, number | string> = {
            backend: b,
            kind,
            ...vantage,
            vectors: sz.vectors,
            dim: sz.dim,
            colo: [...(vColos.get(b) ?? [])].join("/"),
            ...summaryColumns("ms", s),
            failed: fails.length,
            recall_at10_mean: r3(mean(recalls)),
            recall_at10_min: recalls.length ? r3(Math.min(...recalls)) : Number.NaN,
          };
          if (b === "pg" && kind === "ann") {
            m.hnsw_used = hnswUsed;
            m.hnsw_ef_search = efSearch;
          }
          const ok = fails.length === 0 && s.n > 0;
          out.push({
            id: `${ID}${letter}-${b}-${kind}`,
            title: `vector top-10 ${kind === "ann" ? "through the index" : "by full scan"} over ${sz.vectors} x ${sz.dim} (${b}, Worker)`,
            status: ok ? "pass" : "fail",
            detail: ok
              ? `p50 ${s.p50} ms, p95 ${s.p95} ms (n=${s.n}, ${s.dropped} warm-up dropped), recall@10 mean ${m.recall_at10_mean}, min ${m.recall_at10_min}`
              : `${fails.length} failed${fails[0]?.error ? `: ${fails[0].error.slice(0, 300)}` : ""}`,
            measurements: m,
          });
        }
      }

      // Turso index probes: defaults on insert, and a build after the load.
      if (!vBroken.has("turso")) {
        const P = Math.min(500, sz.vectors);
        const dd = await ddl("turso", td06VecDdl("sqlite", sz.dim, "td06_vecd", TD06_TURSO_IDX_DEFAULT_ARGS));
        const msD: number[] = [];
        let errD = dd.ok ? "" : `schema, 3 attempts: ${dd.errors.join(" | ")}`;
        for (const b of errD ? [] : chunk(rows.slice(0, P), VECS_PER_OP)) {
          const r = await run(fx, { backend: "turso", statements: chunk(b, VECS_PER_STMT).map((x) => td06VecInsert("sqlite", x, "td06_vecd")), mode: "batch", returnMeta: false }, 300_000);
          if (!allOk(r)) {
            errD = opErr(r);
            break;
          }
          msD.push(r.ops[0]!.ms);
        }
        const tuned = loadMs.get("turso")!;
        const dropD = await run(fx, { backend: "turso", statements: [{ sql: "DROP INDEX IF EXISTS td06_vecd_idx" }, { sql: "DROP TABLE IF EXISTS td06_vecd" }] });
        const leftD = await tursoVecLeftovers(true);
        out.push({
          id: `${ID}g-turso-defaults`,
          title: `Turso vector index with libSQL defaults: insert ${P} x ${sz.dim} in ${VECS_PER_OP}-row ops (Worker)`,
          status: "info",
          detail: errD
            ? `error after ${msD.length} ops: ${errD.slice(0, 300)}`
            : `${P} rows, ${r3(sum(msD))} ms summed (first op ${r3(msD[0] ?? Number.NaN)} ms, last ${r3(msD.at(-1) ?? Number.NaN)} ms); the measured-args index took ${r3(sum(tuned.slice(0, msD.length)))} ms for its first ${msD.length} ops; DROP INDEX ${dropD.ops[0]?.ok ? "ok" : "failed"}, left behind: ${leftD || "none"}`,
          measurements: {
            backend: "turso",
            ...vantage,
            n: msD.length,
            rows: P,
            index_args: TD06_TURSO_IDX_DEFAULT_ARGS.replace(/'/g, ""),
            ops_ms_sum: r3(sum(msD)),
            op_ms_first: r3(msD[0] ?? Number.NaN),
            op_ms_last: r3(msD.at(-1) ?? Number.NaN),
            tuned_same_ops_ms_sum: r3(sum(tuned.slice(0, msD.length))),
            schema_attempts: dd.attempts,
            drop_index_ok: dropD.ops[0]?.ok ? 1 : 0,
            drop_left_behind: leftD || "none",
            error: errD.slice(0, 300),
          },
        });

        const B = Math.min(3000, sz.vectors);
        const db0 = await ddl("turso", td06VecDdl("sqlite", sz.dim, "td06_vecb", null));
        let errB = db0.ok ? "" : `schema, 3 attempts: ${db0.errors.join(" | ")}`;
        let loadB = 0;
        for (const b of errB ? [] : chunk(rows.slice(0, B), VECS_PER_OP)) {
          const r = await run(fx, { backend: "turso", statements: chunk(b, VECS_PER_STMT).map((x) => td06VecInsert("sqlite", x, "td06_vecb")), mode: "batch", returnMeta: false });
          if (!allOk(r)) {
            errB = `load: ${opErr(r)}`;
            break;
          }
          loadB += r.ops[0]!.ms;
        }
        let buildMs = Number.NaN;
        let buildErr = "";
        const buildErrors: string[] = [];
        let attempts = 0;
        while (!errB && attempts < 3) {
          attempts++;
          const r = await run(fx, { backend: "turso", statements: [{ sql: tursoVecIndex("td06_vecb") }], returnMeta: false }, 300_000);
          buildMs = r.ops[0]?.ms ?? Number.NaN;
          if (allOk(r)) {
            buildErr = "";
            break;
          }
          buildErr = opErr(r);
          buildErrors.push(buildErr.slice(0, 200));
          await run(fx, { backend: "turso", statements: [{ sql: "DROP INDEX IF EXISTS td06_vecb_idx" }] });
          await tursoVecLeftovers(true);
        }
        out.push({
          id: `${ID}g-turso-after-load`,
          title: `Turso: CREATE INDEX (measured args) after loading ${B} x ${sz.dim} rows with no index (Worker)`,
          status: "info",
          detail: errB
            ? errB.slice(0, 300)
            : buildErr
              ? `CREATE INDEX failed ${attempts} times, last after ${r3(buildMs)} ms: ${buildErr.slice(0, 300)}`
              : `built in ${r3(buildMs)} ms on attempt ${attempts} (load without index ${r3(loadB)} ms)${buildErrors.length ? `; earlier attempts: ${buildErrors.join(" | ")}` : ""}`,
          measurements: {
            backend: "turso",
            ...vantage,
            n: 1,
            rows: B,
            index_args: TD06_TURSO_IDX_ARGS.replace(/'/g, ""),
            load_ms_sum: r3(loadB),
            build_ms: r3(buildMs),
            build_ok: errB || buildErr ? 0 : 1,
            build_attempts: attempts,
            build_errors: buildErrors.join(" | ").slice(0, 400),
            error: (errB || buildErr).slice(0, 300),
          },
        });
        await run(fx, { backend: "turso", statements: [{ sql: "DROP INDEX IF EXISTS td06_vecb_idx" }, { sql: "DROP TABLE IF EXISTS td06_vecb" }] });
      }

      // D1: no in-DB vector found in its docs; record what the engine answers.
      const d1v = await run(fx, { backend: "d1", statements: [{ sql: "SELECT vector32('[1,2,3]') AS v" }], returnMeta: true });
      const d1op = d1v.ops[0];
      out.push({
        id: `${ID}f-d1-vector`,
        title: "D1: vector32() through the binding (no in-DB vector found in D1 docs)",
        status: "info",
        detail: d1op ? (d1op.ok ? "vector32() answered: D1 has a libSQL vector function after all" : `error: ${d1op.error}`) : `no op: ${firstErr(d1v)}`,
        measurements: { backend: "d1", ...vantage, colo: d1v.colos.join("/"), n: 1, vector32_ok: d1op?.ok ? 1 : 0, served_by_region: metaDistinct(d1v.ops, "served_by_region") },
      });
      // Durable Object SQLite: same question (the docs name FTS5, JSON and math functions, no vector type).
      const dov = await run(fx, { backend: "do", statements: [{ sql: "SELECT vector32('[1,2,3]') AS v" }], returnMeta: true });
      const doop = dov.ops[0];
      out.push({
        id: `${ID}f-do-vector`,
        title: "Durable Object SQLite: vector32() (no vector type in the Durable Objects SQL docs)",
        status: "info",
        detail: doop ? (doop.ok ? "vector32() answered" : `error: ${doop.error}`) : `no op: ${firstErr(dov)}`,
        measurements: { backend: "do", ...vantage, colo: dov.colos.join("/"), n: 1, vector32_ok: doop?.ok ? 1 : 0 },
      });
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${errMsg(e)}` });
    } finally {
      const { bad, left } = await dropAll();
      out.push({
        id: `${ID}z`,
        title: "cleanup",
        status: bad ? "fail" : "pass",
        detail: `${bad ? `drop failed: ${bad}` : `dropped td06_fts (D1, Turso, Durable Object), td06_docs (pg), td06_vec (Turso, pg${VEC.some((x) => x.b === "tursodb") ? ", Turso engine" : ""}); vector extension left on the fixture project`}${left ? `; Turso vector-index leftovers found and removed: ${left}` : ""}`,
      });
    }
    return out;
  },
};
export default mod;
