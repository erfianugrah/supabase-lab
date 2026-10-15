import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  chunk,
  exactTopK,
  fingerprint,
  ftsTruthCount,
  genDocs,
  genEvents,
  genQueryVectors,
  genVectors,
  genVocab,
  multiInsert,
  overlap,
  recallAtK,
  rowsPerStatement,
  TD05_ANCHOR_END,
  TD05_COLS,
  TD05_QUERIES,
  TD05_SPAN_S,
  td05Aggregates,
  td05Ddl,
  td05Sizes,
  td05Truth,
  td06DocInsert,
  td06FtsDdl,
  td06FtsQueries,
  td06FtsSql,
  td06Sizes,
  TD06_TURSO_IDX_DEFAULT_ARGS,
  td06VecDdl,
  td06VecInsert,
  td08Sizes,
} from "./td05-06-08-data";

describe("sizes", () => {
  test("full by default, smoke on TD_SMOKE=1, overrides win", () => {
    expect(td05Sizes({})).toEqual({ events: 100_000, batchRows: 1000, n: 20, warmup: 2 });
    expect(td05Sizes({ TD_SMOKE: "1" })).toEqual({ events: 1000, batchRows: 200, n: 5, warmup: 1 });
    expect(td05Sizes({ TD_SMOKE: "1", TD05_EVENTS: "300", TD05_BATCH_ROWS: "99999" }).batchRows).toBe(1400);
    expect(td05Sizes({ TD05_N: "bogus" }).n).toBe(20);
    expect(td06Sizes({})).toMatchObject({ docs: 10_000, vectors: 10_000, dim: 384, n: 20 });
    expect(td06Sizes({ TD_SMOKE: "1" })).toMatchObject({ docs: 500, vectors: 500, n: 5 });
    expect(td08Sizes({}).n).toBe(30);
    expect(td08Sizes({ TD_SMOKE: "true" }).n).toBe(5);
  });
});

describe("SQL builders", () => {
  test("chunk and rows per statement under D1's 100 bound parameters", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow();
    expect(rowsPerStatement(TD05_COLS.length)).toBe(14);
    expect(rowsPerStatement(3)).toBe(33);
    expect(rowsPerStatement(TD05_COLS.length) * TD05_COLS.length).toBeLessThanOrEqual(100);
  });

  test("multiInsert numbers pg placeholders and wraps columns", () => {
    const pg = multiInsert("pg", "t", ["a", "b"], [
      [1, "x"],
      [2, "y"],
    ], [undefined, "$::v"]);
    expect(pg.sql).toBe("INSERT INTO t (a,b) VALUES ($1,$2::v),($3,$4::v)");
    expect(pg.params).toEqual([1, "x", 2, "y"]);
    const lite = multiInsert("sqlite", "t", ["a", "b"], [[1, "x"]], [undefined, "f(?)"]);
    expect(lite.sql).toBe("INSERT INTO t (a,b) VALUES (?,f(?))");
    expect(() => multiInsert("pg", "t", ["a"], [[1, 2]])).toThrow();
    // a "$2" replacement must not be read as a back-reference
    expect(td06VecInsert("pg", [[1, "[0]"]]).sql).toBe("INSERT INTO td06_vec (id,emb) VALUES ($1,$2::extensions.vector)");
  });
});

describe("TD05 events and aggregates", () => {
  const ev = genEvents(3000);

  test("deterministic, sorted, in the window", () => {
    expect(genEvents(50)).toEqual(genEvents(50));
    expect(ev.every((e, i) => i === 0 || ev[i - 1]![0] <= e[0])).toBe(true);
    expect(ev.every((e) => e[0] >= TD05_ANCHOR_END - TD05_SPAN_S && e[0] < TD05_ANCHOR_END)).toBe(true);
    expect(new Set(ev.map((e) => e[2])).has(200)).toBe(true);
  });

  test("the SQLite aggregates return exactly the JavaScript truth", () => {
    const db = new Database(":memory:");
    for (const s of td05Ddl("sqlite")) db.run(s);
    for (const rows of chunk(ev, rowsPerStatement(TD05_COLS.length))) {
      const { sql, params } = multiInsert("sqlite", "td05_events", TD05_COLS, rows);
      db.prepare(sql).run(...params);
    }
    const truth = td05Truth(ev);
    const aggs = td05Aggregates("sqlite");
    for (const q of TD05_QUERIES) {
      const got = db.prepare(aggs[q].sql).all(...aggs[q].params) as unknown[];
      expect(fingerprint(got)).toBe(fingerprint(truth[q]));
    }
    expect(truth.last_24h[0]!.n).toBeGreaterThan(0);
    expect(truth.by_hour.length).toBeGreaterThan(100);
  });

  test("pg aggregates differ only by placeholder and byte-order collation", () => {
    const pg = td05Aggregates("pg");
    expect(pg.last_24h.sql).toContain("$1");
    expect(pg.top_paths.sql).toContain('COLLATE "C"');
    expect(td05Ddl("pg")[1]).toContain("GENERATED ALWAYS AS IDENTITY");
  });

  test("fingerprint normalises bigint strings and float noise", () => {
    expect(fingerprint([{ n: "12", x: 1.04 }])).toBe(fingerprint([{ x: 1, n: 12 }]));
    expect(fingerprint([{ n: 1 }])).not.toBe(fingerprint([{ n: 2 }]));
  });
});

describe("TD06 search data", () => {
  const vocab = genVocab(3000);
  const docs = genDocs(400, vocab);

  test("vocab distinct and deterministic, docs well formed", () => {
    expect(new Set(vocab).size).toBe(3000);
    expect(genVocab(10)).toEqual(genVocab(10));
    expect(docs[0]![0]).toBe(1);
    expect(docs.every(([, t, b]) => /^[a-z ]+$/.test(t + b))).toBe(true);
  });

  test("FTS5 match counts equal the JavaScript truth", () => {
    const db = new Database(":memory:");
    for (const s of td06FtsDdl("sqlite")) db.run(s);
    for (const rows of chunk(docs, rowsPerStatement(3))) {
      const { sql, params } = td06DocInsert("sqlite", rows);
      db.prepare(sql).run(...params);
    }
    for (const q of td06FtsQueries(vocab)) {
      const { count, top } = td06FtsSql("sqlite", q.terms);
      const n = (db.prepare(count.sql).get(...count.params) as { n: number }).n;
      expect(n).toBe(ftsTruthCount(docs, q.terms));
      const ids = (db.prepare(top.sql).all(...top.params) as { id: number }[]).map((r) => r.id);
      expect(ids.length).toBe(Math.min(10, n));
    }
    expect(ftsTruthCount(docs, [vocab[2]!])).toBeGreaterThan(50);
  });

  test("vectors: clustered, unit-ish, exact top-k finds the base vector, recall math", () => {
    const vs = genVectors(300, 32);
    expect(vs.length).toBe(300);
    expect(vs[0]!.length).toBe(32);
    const norm = Math.sqrt(vs[5]!.reduce((a, x) => a + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(0.01);
    const q = genQueryVectors(vs, 3);
    expect(q).toEqual(genQueryVectors(vs, 3));
    const top = exactTopK(vs, vs[17]!, 10);
    expect(top[0]).toBe(18);
    expect(top.length).toBe(10);
    expect(recallAtK([1, 2, 3, 4], [4, "3", 9])).toBe(0.5);
    expect(overlap([1, 2], [2, 3])).toBe(0.5);
    expect(overlap([], [])).toBe(1);
  });
});

describe("op metadata", () => {
  test("metaDistinct and metaNums read D1-style meta", () => {
    const { metaDistinct, metaNums, sum } = require("./td05-06-08-data") as typeof import("./td05-06-08-data");
    const ops = [
      { ok: true, ms: 1, stmt: 0, out: [{ meta: { served_by_region: "OC", rows_read: 5, timings: { sql_duration_ms: 0.5 } } }] },
      { ok: true, ms: 1, stmt: 0, out: [{ meta: { served_by_region: "OC", rows_read: 7 } }, { meta: {} }] },
      { ok: false, ms: 1, stmt: 0 },
    ];
    expect(metaDistinct(ops, "served_by_region")).toBe("OC");
    expect(metaNums(ops, "rows_read")).toEqual([5, 7]);
    expect(metaNums(ops, "timings.sql_duration_ms")).toEqual([0.5]);
    expect(sum([1, 2, 3])).toBe(6);
  });
});

describe("TD06 vector DDL", () => {
  test("Turso index before the load, named <table>_idx; null skips it; pg qualifies the type", () => {
    const lite = td06VecDdl("sqlite", 384);
    expect(lite.at(-1)).toBe("CREATE INDEX td06_vec_idx ON td06_vec (libsql_vector_idx(emb, 'metric=cosine', 'compress_neighbors=float8', 'max_neighbors=16'))");
    expect(td06VecDdl("sqlite", 8, "td06_vecb", null).some((s) => s.includes("libsql_vector_idx"))).toBe(false);
    expect(td06VecDdl("sqlite", 8, "td06_vecd", TD06_TURSO_IDX_DEFAULT_ARGS).at(-1)).toBe("CREATE INDEX td06_vecd_idx ON td06_vecd (libsql_vector_idx(emb, 'metric=cosine'))");
    expect(td06VecDdl("pg", 384)[2]).toContain("extensions.vector(384)");
    expect(td06VecInsert("sqlite", [[1, "[0]"]], "td06_vecd").sql).toBe("INSERT INTO td06_vecd (id,emb) VALUES (?,vector32(?))");
  });
});
