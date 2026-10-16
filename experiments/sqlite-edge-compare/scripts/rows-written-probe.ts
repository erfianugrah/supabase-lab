/**
 * Standalone probe (card: Turso rows_written gap): Turso usage rows_written per
 * insert shape, libSQL vs the Turso engine. One throwaway database per (engine,
 * shape) in the fixture group sec-syd, all writes first, then one usage read per
 * database after WAIT_MS: the usage counter lags by more than a 20 s settle rule
 * (2026-10-16), so per-step reads on one database misattribute. Needs
 * TURSO_API_TOKEN and PVLAB_TURSO_ORG; creates and deletes sec-rw-* databases.
 * Output is a printed table, not an artifact.
 */
import { createClient } from "@libsql/client/web";
import { chunk, genEvents, multiInsert, rowsPerStatement, TD05_COLS, TD05_QUERIES, td05Aggregates, td05Ddl } from "../lib/td05-06-08-data";
import { createTursoDb, deleteTursoDb, sleep, turso, tursoCreds, tursoDbToken } from "../lib/vendors";

const WAIT_MS = Number(process.env.WAIT_MS ?? 300_000);
const t = tursoCreds()!;
const usage = async (db: string): Promise<number> => {
  for (let i = 0; i < 5; i++) {
    try {
      return (await turso<{ database?: { usage?: Record<string, number> } }>(t, "GET", `databases/${db}/usage`)).json.database?.usage?.rows_written ?? Number.NaN;
    } catch {
      await sleep(10_000); // a local network drop lost a readout on 2026-10-16
    }
  }
  return Number.NaN;
};

type Client = ReturnType<typeof createClient>;
const rows = (n: number, from: number, extra = "") => Array.from({ length: n }, (_, i) => `(${from + i}, 'v'${extra ? `, ${(from + i) % 7}` : ""})`).join(",");
// TD05's ingest, as the module sends it: 1000-row ops, each a batch("write") of multi-row INSERTs with bound parameters.
const T5_EVENTS = 2000;
// Td05Event is a tuple in TD05_COLS order, as the module passes it to multiInsert.
const t5Rows = () => genEvents(T5_EVENTS);
const t5Batches = (literal: boolean) =>
  chunk(t5Rows(), 1000).map((b) =>
    chunk(b, rowsPerStatement(TD05_COLS.length)).map((r) => {
      const q = multiInsert("sqlite", "td05_events", TD05_COLS, r);
      if (!literal) return { sql: q.sql, args: q.params };
      let k = 0;
      return { sql: q.sql.replace(/\?/g, () => { const v = q.params[k++]; return typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v); }), args: [] };
    }),
  );
const t5Ddl = (index: boolean) => td05Ddl("sqlite").filter((d) => index || !/CREATE INDEX/.test(d)).filter((d) => !/^DROP/.test(d));
const t5Write = (literal: boolean) => async (c: Client) => { for (const b of t5Batches(literal)) await c.batch(b, "write"); };

// TD05's five aggregates, each run 7 times after the ingest (the small TD05 run made 7 passes: 5 kept, 1 warm-up, 1 correctness).
const aggs = td05Aggregates("sqlite");
const aggShape = (q: (typeof TD05_QUERIES)[number]) => ({
  key: `a${TD05_QUERIES.indexOf(q)}`,
  label: `TD05 ingest + 7 x ${q}`,
  ddl: t5Ddl(true),
  rows: T5_EVENTS,
  table: "td05_events",
  write: async (c: Client) => {
    await t5Write(false)(c);
    for (let i = 0; i < 7; i++) await c.execute({ sql: aggs[q].sql, args: aggs[q].params });
  },
});
const aggAll = { key: "aa", label: "TD05 ingest + 7 x all five aggregates", ddl: t5Ddl(true), rows: T5_EVENTS, table: "td05_events", write: async (c: Client) => { await t5Write(false)(c); for (let i = 0; i < 7; i++) for (const q of TD05_QUERIES) await c.execute({ sql: aggs[q].sql, args: aggs[q].params }); } };

const ALL_SHAPES: { key: string; label: string; ddl: string[]; write: (c: Client) => Promise<unknown>; rows: number; table?: string }[] = [
  { key: "s1", label: "100 single-row INSERTs (autocommit)", ddl: ["CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)"], rows: 100, write: async (c) => { for (let i = 1; i <= 100; i++) await c.execute({ sql: "INSERT INTO a VALUES (?, 'v')", args: [i] }); } },
  { key: "m1", label: "one 100-row INSERT", ddl: ["CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)"], rows: 100, write: (c) => c.execute(`INSERT INTO a VALUES ${rows(100, 1)}`) },
  { key: "b1", label: "batch of 10 x 10-row INSERTs", ddl: ["CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)"], rows: 100, write: (c) => c.batch(Array.from({ length: 10 }, (_, j) => `INSERT INTO a VALUES ${rows(10, j * 10 + 1)}`), "write") },
  { key: "t5", label: "TD05 ingest as sent (params, ts index), 2000 events", ddl: t5Ddl(true), rows: T5_EVENTS, table: "td05_events", write: t5Write(false) },
  { key: "tn", label: "TD05 ingest, no ts index", ddl: t5Ddl(false), rows: T5_EVENTS, table: "td05_events", write: t5Write(false) },
  { key: "tl", label: "TD05 ingest, literal values (ts index)", ddl: t5Ddl(true), rows: T5_EVENTS, table: "td05_events", write: t5Write(true) },
  ...TD05_QUERIES.map(aggShape),
  aggAll,
  { key: "rg", label: "1000 rows, then 10 x GROUP BY over them (reads)", ddl: ["CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT, k INTEGER)"], rows: 1000, write: async (c) => { await c.batch(Array.from({ length: 10 }, (_, j) => `INSERT INTO a VALUES ${rows(100, j * 100 + 1, "k")}`), "write"); for (let i = 0; i < 10; i++) await c.execute("SELECT k, count(*) AS n FROM a GROUP BY k"); } },
  { key: "ro", label: "1000 rows, then 10 x ORDER BY v LIMIT 10 (reads)", ddl: ["CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT, k INTEGER)"], rows: 1000, write: async (c) => { await c.batch(Array.from({ length: 10 }, (_, j) => `INSERT INTO a VALUES ${rows(100, j * 100 + 1, "k")}`), "write"); for (let i = 0; i < 10; i++) await c.execute("SELECT * FROM a ORDER BY v DESC, k LIMIT 10"); } },
  { key: "ra", label: "1000 rows, then ANALYZE", ddl: ["CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT, k INTEGER)", "CREATE INDEX a_k ON a (k)"], rows: 1000, write: async (c) => { await c.batch(Array.from({ length: 10 }, (_, j) => `INSERT INTO a VALUES ${rows(100, j * 100 + 1, "k")}`), "write"); await c.execute("ANALYZE a"); } },
  { key: "r0", label: "1000 rows, no reads (control)", ddl: ["CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT, k INTEGER)"], rows: 1000, write: (c) => c.batch(Array.from({ length: 10 }, (_, j) => `INSERT INTO a VALUES ${rows(100, j * 100 + 1, "k")}`), "write") },
  { key: "bx", label: "batch of 10 x 10-row INSERTs, 1 secondary index", ddl: ["CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT, k INTEGER)", "CREATE INDEX a_k ON a (k)"], rows: 100, write: (c) => c.batch(Array.from({ length: 10 }, (_, j) => `INSERT INTO a VALUES ${rows(10, j * 10 + 1, "k")}`), "write") },
];

// SHAPES=rg,ro,ra,r0 picks a subset (default: all).
const pick = (process.env.SHAPES ?? "").split(",").filter(Boolean);
const shapes = pick.length ? ALL_SHAPES.filter((x) => pick.includes(x.key)) : ALL_SHAPES;
const made: { name: string; engine: string; shape: (typeof shapes)[number]; ddlRows: number }[] = [];
const stamp = Date.now().toString(36);
try {
  const engines = (process.env.ENGINES ?? "libsql,tursodb").split(",") as ("libsql" | "tursodb")[];
  for (const engine of engines) {
    for (const shape of shapes) {
      const name = `sec-rw-${engine === "tursodb" ? "m" : "l"}${shape.key}-${stamp}`;
      const db = await createTursoDb(t, name, "sec-syd", engine === "tursodb");
      made.push({ name, engine, shape, ddlRows: 0 });
      const c = createClient({ url: `https://${db.hostname}`, authToken: await tursoDbToken(t, name, "1d") });
      for (let i = 0; i < 15; i++) {
        try {
          await c.execute("select 1");
          break;
        } catch {
          await sleep(2000);
        }
      }
      for (const d of shape.ddl) await c.execute(d);
      await shape.write(c);
      const n = Number((await c.execute(`SELECT count(*) AS n FROM ${shape.table ?? "a"}`)).rows[0]?.n);
      if (n !== shape.rows) throw new Error(`${name}: ${n} rows, expected ${shape.rows}`);
      c.close();
    }
  }
  console.log(`writes done; waiting ${WAIT_MS / 1000} s for the usage counter`);
  await sleep(WAIT_MS);
  for (const m of made) {
    const a = await usage(m.name);
    await sleep(30_000);
    const b = await usage(m.name);
    console.log(`${m.engine.padEnd(8)} ${m.shape.label.padEnd(48)} rows ${m.shape.rows} ddl ${m.shape.ddl.length}  rows_written ${a} (30 s later ${b})`);
  }
} finally {
  for (const m of made) console.log(`delete ${m.engine} ${m.shape.key}: ${await deleteTursoDb(t, m.name)}`);
}
