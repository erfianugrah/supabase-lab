/**
 * Pure helpers for TD05 (event log), TD06 (search) and TD08 (embedded
 * replica): run sizes from the environment, seeded synthetic data, SQL
 * builders per dialect, and the JavaScript ground truth each module checks
 * the databases against. No I/O here, so every piece is unit-tested
 * (td05-06-08-data.test.ts).
 *
 * Dialects: "sqlite" (D1 and Turso libSQL, `?` placeholders) and "pg"
 * (Postgres via Hyperdrive or the pooler, `$n` placeholders).
 */
import { rng } from "./stats";

export type Dialect = "sqlite" | "pg";
type Env = Record<string, string | undefined>;

/* --------------------------------- sizes --------------------------------- */

const envInt = (env: Env, key: string, def: number): number => {
  const v = env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : def;
};
export const isSmoke = (env: Env = process.env) => env.TD_SMOKE === "1" || env.TD_SMOKE === "true";

export interface Td05Sizes {
  events: number;
  /** Rows per ingest op (one D1/libSQL batch, one Postgres multi-row INSERT). */
  batchRows: number;
  n: number;
  warmup: number;
}
/** Full: 100k events, 1000-row batches, n=20 per aggregate. TD_SMOKE=1: 1k events, 200-row batches, n=5. */
export function td05Sizes(env: Env = process.env): Td05Sizes {
  const s = isSmoke(env);
  return {
    events: envInt(env, "TD05_EVENTS", s ? 1000 : 100_000),
    batchRows: Math.min(1400, envInt(env, "TD05_BATCH_ROWS", s ? 200 : 1000)),
    n: envInt(env, "TD05_N", s ? 5 : 20),
    warmup: envInt(env, "TD05_WARMUP", s ? 1 : 2),
  };
}

export interface Td06Sizes {
  docs: number;
  vectors: number;
  dim: number;
  n: number;
  warmup: number;
}
/** Full: 10k docs, 10k x 384 vectors, n=20. TD_SMOKE=1: 500 docs, 500 vectors, n=5. */
export function td06Sizes(env: Env = process.env): Td06Sizes {
  const s = isSmoke(env);
  return {
    docs: envInt(env, "TD06_DOCS", s ? 500 : 10_000),
    vectors: envInt(env, "TD06_VECTORS", s ? 500 : 10_000),
    dim: envInt(env, "TD06_DIM", 384),
    n: envInt(env, "TD06_N", s ? 5 : 20),
    warmup: envInt(env, "TD06_WARMUP", s ? 1 : 2),
  };
}

export interface Td08Sizes {
  seedRows: number;
  n: number;
  warmup: number;
}
/** Full: n=30 lag samples and reads. TD_SMOKE=1: n=5. */
export function td08Sizes(env: Env = process.env): Td08Sizes {
  const s = isSmoke(env);
  return {
    seedRows: envInt(env, "TD08_SEED_ROWS", s ? 100 : 1000),
    n: envInt(env, "TD08_N", s ? 5 : 30),
    warmup: envInt(env, "TD08_WARMUP", s ? 1 : 3),
  };
}

/* ------------------------------ SQL builders ----------------------------- */

export function chunk<T>(xs: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk: size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** D1 allows 100 bound parameters per query: rows per multi-row INSERT at `cols` columns. */
export function rowsPerStatement(cols: number, maxParams = 100): number {
  return Math.max(1, Math.floor(maxParams / cols));
}

/**
 * Multi-row INSERT with one placeholder per value. `wrap[k]` wraps column k's
 * placeholder (e.g. "vector32(?)" / "$::extensions.vector"), with `?` / `$`
 * standing for the placeholder.
 */
export function multiInsert(
  d: Dialect,
  table: string,
  cols: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
  wrap: readonly (string | undefined)[] = [],
): { sql: string; params: (string | number | null)[] } {
  let p = 0;
  const ph = (k: number) => {
    p += 1;
    const base = d === "pg" ? `$${p}` : "?";
    const w = wrap[k];
    // function replacement: a "$1" replacement string would be read as a pattern
    return w ? w.replace(d === "pg" ? "$" : "?", () => base) : base;
  };
  const tuples = rows.map((r) => {
    if (r.length !== cols.length) throw new Error(`multiInsert: row has ${r.length} values, want ${cols.length}`);
    return `(${r.map((_, k) => ph(k)).join(",")})`;
  });
  return { sql: `INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")}`, params: rows.flat() as (string | number | null)[] };
}

/* ---------------------------------- TD05 ---------------------------------- */

export const TD05_SEED = 20261015;
/** Events span the 7 days before this instant (fixed, so every backend and every run sees the same data). */
export const TD05_ANCHOR_END = Date.UTC(2026, 9, 1) / 1000;
export const TD05_SPAN_S = 7 * 86_400;
export const TD05_COLS = ["ts", "path", "status", "country", "colo", "latency_ms", "ua_class"] as const;
export type Td05Event = [ts: number, path: string, status: number, country: string, colo: string, latency_ms: number, ua_class: string];

const PATHS = [
  "/",
  "/api/v1/items",
  "/api/v1/items/detail",
  "/api/v1/search",
  "/api/v1/auth/token",
  "/api/v1/auth/refresh",
  "/api/v1/users/me",
  "/api/v1/cart",
  "/api/v1/checkout",
  "/api/v1/events",
  "/static/app.js",
  "/static/app.css",
  "/static/logo.svg",
  "/img/hero.webp",
  "/img/thumb.webp",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/healthz",
  "/login",
  "/logout",
  "/docs",
  "/docs/getting-started",
  "/docs/reference",
  "/blog",
  "/blog/post",
  "/pricing",
  "/about",
  "/contact",
  "/wp-login.php",
];
const COUNTRIES = ["AU", "SG", "JP", "IN", "ID", "US", "GB", "DE", "NZ", "MY", "PH", "KR", "TH", "VN", "HK", "TW", "FR", "BR", "CA", "NL"];
const COLOS = ["SYD", "MEL", "BNE", "PER", "AKL", "SIN", "NRT", "BOM", "CGK", "LAX", "LHR", "FRA", "ICN", "HKG", "KUL"];
const UA = ["browser", "mobile", "api", "bot"];
const STATUS: [number, number][] = [
  [200, 0.82],
  [304, 0.06],
  [404, 0.05],
  [301, 0.02],
  [429, 0.02],
  [500, 0.015],
  [503, 0.015],
];

/** Zipf-ish CDF over `k` items (weight 1/(rank+1)^s). */
export function zipfCdf(k: number, s = 1.07): number[] {
  const w = Array.from({ length: k }, (_, r) => 1 / (r + 1) ** s);
  const tot = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  return w.map((x) => (acc += x / tot));
}
export function pick(cdf: readonly number[], u: number): number {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (u <= cdf[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Standard normal from a uniform source (Box-Muller). */
export function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Seeded edge-gateway request events, sorted by ts (an append-only log arrives in time order). */
export function genEvents(n: number, seed = TD05_SEED): Td05Event[] {
  const r = rng(seed);
  const pathCdf = zipfCdf(PATHS.length);
  const ctyCdf = zipfCdf(COUNTRIES.length, 0.9);
  const coloCdf = zipfCdf(COLOS.length, 0.9);
  const statusCdf = (() => {
    let acc = 0;
    return STATUS.map(([, p]) => (acc += p));
  })();
  const out: Td05Event[] = [];
  for (let i = 0; i < n; i++) {
    const ts = TD05_ANCHOR_END - TD05_SPAN_S + Math.floor(r() * TD05_SPAN_S);
    const path = PATHS[pick(pathCdf, r())]!;
    const status = STATUS[Math.min(STATUS.length - 1, pick(statusCdf, r() * statusCdf[statusCdf.length - 1]!))]![0];
    const country = COUNTRIES[pick(ctyCdf, r())]!;
    const colo = COLOS[pick(coloCdf, r())]!;
    // log-normal latency, one decimal (ms)
    const latency = Math.round(Math.exp(3.2 + 0.8 * gauss(r)) * 10) / 10;
    const ua = UA[pick([0.55, 0.8, 0.93, 1], r())]!;
    out.push([ts, path, status, country, colo, latency, ua]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

export function td05Ddl(d: Dialect): string[] {
  const table =
    d === "pg"
      ? "CREATE TABLE td05_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, ts bigint NOT NULL, path text NOT NULL, status int NOT NULL, country text NOT NULL, colo text NOT NULL, latency_ms double precision NOT NULL, ua_class text NOT NULL)"
      : "CREATE TABLE td05_events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, country TEXT NOT NULL, colo TEXT NOT NULL, latency_ms REAL NOT NULL, ua_class TEXT NOT NULL)";
  return ["DROP TABLE IF EXISTS td05_events", table, "CREATE INDEX td05_events_ts ON td05_events (ts)"];
}

export const TD05_QUERIES = ["by_hour", "top_paths", "status_by_country", "p95_by_colo", "last_24h"] as const;
export type Td05Query = (typeof TD05_QUERIES)[number];

/**
 * The five dashboard aggregates, same SQL text on both dialects except the
 * placeholder and a byte-order collation on Postgres string ORDER BYs (SQLite
 * sorts BINARY; the project's default collation need not), so ordered rows
 * compare equal. p95 is the nearest-rank-below value via window functions on
 * both, since SQLite has no percentile aggregate.
 */
export function td05Aggregates(d: Dialect): Record<Td05Query, { sql: string; params: number[] }> {
  const c = d === "pg" ? ' COLLATE "C"' : "";
  const ph = d === "pg" ? "$1" : "?";
  return {
    by_hour: { sql: "SELECT ts / 3600 AS h, count(*) AS n FROM td05_events GROUP BY ts / 3600 ORDER BY h", params: [] },
    top_paths: { sql: `SELECT path, count(*) AS n FROM td05_events GROUP BY path ORDER BY n DESC, path${c} LIMIT 10`, params: [] },
    status_by_country: {
      sql: `SELECT country, status, count(*) AS n FROM td05_events GROUP BY country, status ORDER BY country${c}, status`,
      params: [],
    },
    p95_by_colo: {
      sql: `SELECT colo, latency_ms AS p95 FROM (SELECT colo, latency_ms, row_number() OVER (PARTITION BY colo ORDER BY latency_ms) AS rn, count(*) OVER (PARTITION BY colo) AS c FROM td05_events) t WHERE rn = ((c - 1) * 95) / 100 + 1 ORDER BY colo${c}`,
      params: [],
    },
    last_24h: { sql: `SELECT count(*) AS n FROM td05_events WHERE ts >= ${ph}`, params: [TD05_ANCHOR_END - 86_400] },
  };
}

type Row = Record<string, unknown>;
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What each aggregate must return, computed from the generated events. */
export function td05Truth(ev: readonly Td05Event[]): Record<Td05Query, Row[]> {
  const count = <K>(key: (e: Td05Event) => K) => {
    const m = new Map<K, number>();
    for (const e of ev) m.set(key(e), (m.get(key(e)) ?? 0) + 1);
    return m;
  };
  const byHour = [...count((e) => Math.floor(e[0] / 3600)).entries()].sort((a, b) => a[0] - b[0]).map(([h, n]) => ({ h, n }));
  const topPaths = [...count((e) => e[1]).entries()]
    .sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))
    .slice(0, 10)
    .map(([path, n]) => ({ path, n }));
  const sbc = [...count((e) => `${e[3]}|${e[2]}`).entries()]
    .map(([k, n]) => ({ country: k.split("|")[0]!, status: Number(k.split("|")[1]), n }))
    .sort((a, b) => cmpStr(a.country, b.country) || a.status - b.status);
  const lat = new Map<string, number[]>();
  for (const e of ev) {
    const l = lat.get(e[4]) ?? [];
    l.push(e[5]);
    lat.set(e[4], l);
  }
  const p95 = [...lat.entries()]
    .sort((a, b) => cmpStr(a[0], b[0]))
    .map(([colo, xs]) => {
      const s = [...xs].sort((a, b) => a - b);
      return { colo, p95: s[Math.floor(((s.length - 1) * 95) / 100)]! };
    });
  const last = ev.filter((e) => e[0] >= TD05_ANCHOR_END - 86_400).length;
  return { by_hour: byHour, top_paths: topPaths, status_by_country: sbc, p95_by_colo: p95, last_24h: [{ n: last }] };
}

/**
 * Canonical text of a result set: keys sorted, numeric strings (Postgres
 * bigint counts arrive as strings) turned into numbers, floats to 1 decimal.
 */
export function fingerprint(rows: readonly unknown[]): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return norm(Number(v));
    if (typeof v === "number") return Math.round(v * 10) / 10;
    return v;
  };
  return JSON.stringify(
    rows.map((r) => {
      const o = (r ?? {}) as Row;
      return Object.keys(o)
        .sort()
        .map((k) => [k, norm(o[k])]);
    }),
  );
}

/* ---------------------------------- TD06 ---------------------------------- */

export const TD06_SEED = 6061015;
const SYL_C = "bcdfghklmnprstvz";
const SYL_V = "aeiou";

/** `size` distinct lowercase pseudo-words, rank order = frequency order. */
export function genVocab(size: number, seed = TD06_SEED): string[] {
  const r = rng(seed);
  const seen = new Set<string>();
  const out: string[] = [];
  while (out.length < size) {
    const syl = 2 + Math.floor(r() * 3);
    let w = "";
    for (let k = 0; k < syl; k++) w += SYL_C[Math.floor(r() * SYL_C.length)]! + SYL_V[Math.floor(r() * SYL_V.length)]!;
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

export type Td06Doc = [id: number, title: string, body: string];
export const TD06_VOCAB = 3000;

/** Seeded docs: title 3-8 words, body 40-120 words, Zipf over the vocabulary. ids 1..n. */
export function genDocs(n: number, vocab: readonly string[], seed = TD06_SEED + 1): Td06Doc[] {
  const r = rng(seed);
  const cdf = zipfCdf(vocab.length);
  const words = (k: number) => Array.from({ length: k }, () => vocab[pick(cdf, r())]!).join(" ");
  return Array.from({ length: n }, (_, i) => [i + 1, words(3 + Math.floor(r() * 6)), words(40 + Math.floor(r() * 81))] as Td06Doc);
}

/** Four query shapes by vocabulary rank: common, mid, rare single terms, and a two-term AND. */
export function td06FtsQueries(vocab: readonly string[]): { name: string; terms: string[] }[] {
  return [
    { name: "common", terms: [vocab[2]!] },
    { name: "mid", terms: [vocab[60]!] },
    { name: "rare", terms: [vocab[1200]!] },
    { name: "and2", terms: [vocab[10]!, vocab[150]!] },
  ];
}

/** Docs containing every term (title or body): what both FTS engines' match count must equal. */
export function ftsTruthCount(docs: readonly Td06Doc[], terms: readonly string[]): number {
  let n = 0;
  for (const [, t, b] of docs) {
    const s = new Set(`${t} ${b}`.split(" "));
    if (terms.every((x) => s.has(x))) n++;
  }
  return n;
}

export function td06FtsDdl(d: Dialect): string[] {
  return d === "pg"
    ? [
        "DROP TABLE IF EXISTS td06_docs",
        "CREATE TABLE td06_docs (id int PRIMARY KEY, title text NOT NULL, body text NOT NULL, tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || body)) STORED)",
        "CREATE INDEX td06_docs_tsv ON td06_docs USING gin (tsv)",
      ]
    : ["DROP TABLE IF EXISTS td06_fts", "CREATE VIRTUAL TABLE td06_fts USING fts5(title, body)"];
}

export function td06DocInsert(d: Dialect, rows: readonly Td06Doc[]) {
  return d === "pg" ? multiInsert("pg", "td06_docs", ["id", "title", "body"], rows) : multiInsert("sqlite", "td06_fts", ["rowid", "title", "body"], rows);
}

/** Top-10 ranked (bm25 on FTS5, ts_rank on Postgres) and the match count, per dialect. */
export function td06FtsSql(d: Dialect, terms: readonly string[]) {
  const q = terms.join(" ");
  return d === "pg"
    ? {
        top: { sql: "SELECT id FROM td06_docs, plainto_tsquery('simple', $1) q WHERE tsv @@ q ORDER BY ts_rank(tsv, q) DESC, id LIMIT 10", params: [q] },
        count: { sql: "SELECT count(*) AS n FROM td06_docs WHERE tsv @@ plainto_tsquery('simple', $1)", params: [q] },
      }
    : {
        top: { sql: "SELECT rowid AS id FROM td06_fts WHERE td06_fts MATCH ? ORDER BY rank LIMIT 10", params: [q] },
        count: { sql: "SELECT count(*) AS n FROM td06_fts WHERE td06_fts MATCH ?", params: [q] },
      };
}

/**
 * Seeded clustered unit vectors (real embeddings cluster; uniform random
 * vectors would make every neighbour equidistant). Components rounded to 4
 * decimals so the text sent to the database and the ground truth agree.
 */
export function genVectors(n: number, dim: number, seed = TD06_SEED + 2, clusters = 40, noise = 0.6): number[][] {
  const r = rng(seed);
  const unit = (v: number[]) => {
    const s = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / s);
  };
  const centers = Array.from({ length: clusters }, () => unit(Array.from({ length: dim }, () => gauss(r))));
  const sd = noise / Math.sqrt(dim);
  return Array.from({ length: n }, (_, i) => {
    const c = centers[i % clusters]!;
    return unit(c.map((x) => x + sd * gauss(r))).map((x) => Math.round(x * 1e4) / 1e4);
  });
}

/** Queries: perturbed copies of seeded picks from the corpus, so true neighbours are cluster mates. */
export function genQueryVectors(corpus: readonly number[][], k: number, seed = TD06_SEED + 3, noise = 0.3): number[][] {
  const r = rng(seed);
  const dim = corpus[0]?.length ?? 0;
  const sd = noise / Math.sqrt(Math.max(1, dim));
  return Array.from({ length: k }, () => {
    const base = corpus[Math.floor(r() * corpus.length)]!;
    const v = base.map((x) => x + sd * gauss(r));
    const s = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => Math.round((x / s) * 1e4) / 1e4);
  });
}

export const vecText = (v: readonly number[]) => `[${v.join(",")}]`;

export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Exact top-k ids (1-based: row k of the corpus has id k+1) by cosine distance. */
export function exactTopK(corpus: readonly number[][], q: readonly number[], k = 10): number[] {
  return corpus
    .map((v, i) => [cosineDistance(v, q), i + 1] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .slice(0, k)
    .map(([, id]) => id);
}

/** |truth ∩ got| / |truth|. */
export function recallAtK(truth: readonly number[], got: readonly unknown[]): number {
  if (truth.length === 0) return Number.NaN;
  const g = new Set(got.map((x) => Number(x)));
  return truth.filter((t) => g.has(t)).length / truth.length;
}

/**
 * Turso index arguments for the measured rows. libSQL's defaults were not
 * usable at 10k x 384 on Turso Cloud (2026-10-15, local probes against the
 * fixture DB): with defaults a 1000-row CREATE INDEX took 81124 ms and 100
 * inserts into the indexed table 41842 ms; with these arguments 5841 ms and
 * 2108 ms, and 3000 incremental inserts stayed near 3 s per 100 rows. The
 * index is created before the load (inserts maintain it) because CREATE
 * INDEX after a load failed intermittently in the same probes ("vector
 * index: unable to initialize diskann", or "index ... already exists" right
 * after a DROP INDEX). TD06g re-measures the defaults cost and the
 * after-load build in every run.
 */
export const TD06_TURSO_IDX_ARGS = "'metric=cosine', 'compress_neighbors=float8', 'max_neighbors=16'";
export const TD06_TURSO_IDX_DEFAULT_ARGS = "'metric=cosine'";

export const tursoVecIndex = (table: string, args = TD06_TURSO_IDX_ARGS) => `CREATE INDEX ${table}_idx ON ${table} (libsql_vector_idx(emb, ${args}))`;

export function td06VecDdl(d: Dialect, dim: number, table = "td06_vec", tursoIdxArgs: string | null = TD06_TURSO_IDX_ARGS): string[] {
  return d === "pg"
    ? [
        "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions",
        `DROP TABLE IF EXISTS ${table}`,
        `CREATE TABLE ${table} (id int PRIMARY KEY, emb extensions.vector(${dim}) NOT NULL)`,
      ]
    : [
        `DROP INDEX IF EXISTS ${table}_idx`,
        `DROP TABLE IF EXISTS ${table}`,
        `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, emb F32_BLOB(${dim}) NOT NULL)`,
        // Index first, rows after (the DiskANN index is maintained on insert); null = no index.
        ...(tursoIdxArgs === null ? [] : [tursoVecIndex(table, tursoIdxArgs)]),
      ];
}

/** Postgres builds HNSW after the load (pgvector's recommended order), default build parameters. */
export const TD06_PG_HNSW = "CREATE INDEX td06_vec_hnsw ON td06_vec USING hnsw (emb extensions.vector_cosine_ops)";

export function td06VecInsert(d: Dialect, rows: readonly (readonly [number, string])[], table = "td06_vec") {
  return d === "pg"
    ? multiInsert("pg", table, ["id", "emb"], rows, [undefined, "$::extensions.vector"])
    : multiInsert("sqlite", table, ["id", "emb"], rows, [undefined, "vector32(?)"]);
}

/**
 * ann: through the index (vector_top_k / ORDER BY <=> with HNSW present).
 * exact: a full scan on both (`vector_distance_cos` ORDER BY on libSQL;
 * `(<=>) + 0` on Postgres, an expression the HNSW index cannot serve).
 */
export function td06VecSql(d: Dialect, q: string) {
  return d === "pg"
    ? {
        ann: { sql: "SELECT id FROM td06_vec ORDER BY emb OPERATOR(extensions.<=>) $1::extensions.vector LIMIT 10", params: [q] },
        exact: { sql: "SELECT id FROM td06_vec ORDER BY (emb OPERATOR(extensions.<=>) $1::extensions.vector) + 0 LIMIT 10", params: [q] },
      }
    : {
        ann: { sql: "SELECT id FROM vector_top_k('td06_vec_idx', vector32(?), 10)", params: [q] },
        exact: { sql: "SELECT id FROM td06_vec ORDER BY vector_distance_cos(emb, vector32(?)) LIMIT 10", params: [q] },
      };
}

/* ---------------------------------- shared --------------------------------- */

/** Ids out of a result's rows (`id` column), for recall and overlap. */
export const idsOf = (rows: readonly unknown[] | undefined): number[] => (rows ?? []).map((r) => Number((r as Row).id));

/** |a ∩ b| / max(|a|,|b|): how much two top-10 lists agree (FTS ranking functions differ by design). */
export function overlap(a: readonly number[], b: readonly number[]): number {
  const m = Math.max(a.length, b.length);
  if (m === 0) return 1;
  const s = new Set(b);
  return a.filter((x) => s.has(x)).length / m;
}

export const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
export const r3 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

/* ------------------------------ op metadata ------------------------------ */

type OpLike = { ok: boolean; ms: number; stmt: number; out?: { rowCount?: number; rows?: unknown[]; meta?: Record<string, unknown> }[] };

/** Distinct values of one meta key across ops (D1 served_by_region etc.), joined with "/". */
export function metaDistinct(ops: readonly OpLike[], key: string): string {
  const s = new Set<string>();
  for (const o of ops) for (const x of o.out ?? []) if (x.meta && x.meta[key] !== undefined && x.meta[key] !== null) s.add(String(x.meta[key]));
  return [...s].sort().join("/");
}

/** Numeric meta values for one key, one per statement output (nested `timings.sql_duration_ms` via a dotted key). */
export function metaNums(ops: readonly OpLike[], key: string): number[] {
  const out: number[] = [];
  for (const o of ops)
    for (const x of o.out ?? []) {
      let v: unknown = x.meta;
      for (const k of key.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
      if (typeof v === "number") out.push(v);
    }
  return out;
}

export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
