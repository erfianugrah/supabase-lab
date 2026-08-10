/**
 * psql over the transaction pooler, returning tab-separated rows.
 *
 * Same shape as stripe-sync-schema/lib/pg.ts and for the same reasons: a file
 * under lib/ rather than tests/ because the registry scans tests/, and a file
 * read rather than a `printf | psql` pipeline because an early-exiting reader
 * turns a successful query into exit 141 under pipefail.
 *
 * The addition here is `timed`: half this experiment is latency, and timing a
 * query by wrapping the psql process measures process startup and TLS
 * handshake alongside it. `\timing` reports the server-side execution instead,
 * and the two differ by tens of milliseconds over a pooler in another region -
 * which is most of a fast traversal query.
 */
import { $ } from "bun";
import type { Ctx } from "../../../harness/src/types";

export function poolerUrl(ctx: Ctx): string {
  const host = ctx.endpoints.pooler;
  if (!host) throw new Error("no pooler host - set PVLAB_ENDPOINT_POOLER");
  const user = `postgres.${ctx.ref}`;
  return `postgresql://${user}:${encodeURIComponent(ctx.dbPassword)}@${host}:6543/postgres?connect_timeout=15`;
}

export interface QueryResult {
  ok: boolean;
  rows: string[][];
  raw: string;
}

/**
 * THE TIMEOUT IS A SEPARATE -c, AND -q IS LOAD-BEARING.
 *
 * This function used to send `set statement_timeout='600s'; <sql>` in ONE -c.
 * psql prints the command status tag for a SET even under -At, so every result
 * came back with a phantom leading row `["SET"]` and `scalar()` returned the
 * string "SET" for every query in the suite. The damage was silent and plural:
 * a fixture count read 8 instead of 7, a genre named "unknown" appeared with one
 * member, every pg_total_relation_size came back null, a halfvec/vector ratio
 * rendered as "unknown", and `Number("SET")` reached pgr_dijkstra as NaN, where
 * Postgres answered `column "nan" does not exist`. One defect, five symptoms,
 * none of which named its cause.
 *
 * It survived a fully green loop run. The defect sat in this shared helper,
 * which was in the base rather than the diff, so the reviewing judge never saw
 * it, and the per-test sensors asserted that a measurement EXISTED rather than
 * that it was coherent - `"SET"` and `null` are both perfectly present values.
 *
 * Two rejected fixes, both measured here rather than assumed:
 *
 *   PGOPTIONS='-c statement_timeout=...' is libpq's own channel for
 *   connection-time GUCs and it does NOT survive the transaction pooler.
 *   Through port 6543 `show statement_timeout` reports the role default (2min)
 *   whether PGOPTIONS is set or not - Supavisor does not forward startup
 *   options. It fails silently, which is worse than the bug it replaced.
 *
 *   A single -c with `begin; set local ...; commit` just trades one phantom tag
 *   for three.
 *
 * So: the SET goes in its own -c (which does take effect - verified by a 250ms
 * timeout cancelling pg_sleep(2)), and -q suppresses the tag it would otherwise
 * print. Removing -q silently reintroduces the original bug.
 */

/** One statement. Rows come back as arrays of column strings. */
export async function q(ctx: Ctx, sql: string, timeoutS = 600): Promise<QueryResult> {
  const p = await $`psql ${poolerUrl(ctx)} -qAt -F${"\t"} -v ON_ERROR_STOP=1 -c ${`set statement_timeout='${timeoutS}s'`} -c ${sql}`
    .quiet()
    .nothrow();
  const raw = (p.stdout.toString() + p.stderr.toString()).trim();
  if (p.exitCode !== 0) return { ok: false, rows: [], raw };
  const rows = raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\t"));
  return { ok: true, rows, raw };
}

/** First column of the first row, or undefined. */
export async function scalar(ctx: Ctx, sql: string, timeoutS = 600): Promise<string | undefined> {
  const r = await q(ctx, sql, timeoutS);
  return r.ok ? r.rows[0]?.[0] : undefined;
}

/** Run a file of statements. Returns raw output; ON_ERROR_STOP is on. */
export async function file(ctx: Ctx, path: string, timeoutS = 1800): Promise<QueryResult> {
  const p = await $`psql ${poolerUrl(ctx)} -qAt -F${"\t"} -v ON_ERROR_STOP=1 -c ${`set statement_timeout='${timeoutS}s'`} -f ${path}`
    .quiet()
    .nothrow();
  const raw = (p.stdout.toString() + p.stderr.toString()).trim();
  return { ok: p.exitCode === 0, rows: [], raw };
}

/**
 * Server-side execution time in ms, median of `runs`.
 *
 * Uses EXPLAIN ANALYZE's own Execution Time rather than wall-clock around the
 * client, so the number is the database's work and not the round trip. The
 * first run is discarded: a cold buffer cache measures the disk, and every
 * comparison in this experiment is between query SHAPES, which is only
 * meaningful once both are warm.
 */
export async function medianExecMs(
  ctx: Ctx,
  sql: string,
  runs = 5,
): Promise<{ ms: number | null; samples: number[]; raw: string }> {
  const samples: number[] = [];
  let raw = "";
  for (let i = 0; i <= runs; i++) {
    const r = await q(ctx, `explain (analyze, buffers, format json) ${sql}`);
    raw = r.raw;
    if (!r.ok) return { ms: null, samples, raw };
    const m = r.raw.match(/"Execution Time":\s*([0-9.]+)/);
    if (!m?.[1]) return { ms: null, samples, raw };
    if (i > 0) samples.push(Number(m[1])); // discard the cold first run
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const ms =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);
  return { ms: Math.round(ms * 100) / 100, samples, raw };
}

/** Is the corpus schema loaded? Every data test is meaningless without it. */
export async function corpusReady(ctx: Ctx): Promise<boolean> {
  const n = await scalar(
    ctx,
    "select count(*) from information_schema.tables where table_schema='corpus'",
  );
  return Number(n ?? 0) > 0;
}

/** The compute the run was taken on. Travels with every latency measurement. */
export function instanceSize(): string {
  return process.env.PVLAB_INSTANCE_SIZE || "unknown";
}
