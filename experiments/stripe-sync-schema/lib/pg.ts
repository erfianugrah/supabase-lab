/**
 * psql over the transaction pooler, returning tab-separated rows.
 *
 * A helper rather than three copies of the same $`psql` line, and a file under
 * lib/ rather than tests/ because the registry scans tests/ and would try to
 * register this as a module.
 *
 * Reads a file, never `printf "$body" | psql`: with `set -o pipefail` in the
 * calling shell a reader that exits early leaves the writer with SIGPIPE and
 * the pipeline reports 141, so a successful query intermittently looks like a
 * failure. Bun's $ does not use pipefail, but the same shape is a trap worth
 * not laying down for the next person.
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

/** One statement. Rows come back as arrays of column strings. */
export async function q(ctx: Ctx, sql: string): Promise<QueryResult> {
  const p = await $`psql ${poolerUrl(ctx)} -At -F${"\t"} -v ON_ERROR_STOP=1 -c ${sql}`
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
export async function scalar(ctx: Ctx, sql: string): Promise<string | undefined> {
  const r = await q(ctx, sql);
  return r.ok ? r.rows[0]?.[0] : undefined;
}

/**
 * Is the integration installed? Every test here is meaningless without it, and
 * the lab idiom is an explicit skip with a reason rather than a confusing
 * failure deep inside a query.
 */
export async function stripeSchemaPresent(ctx: Ctx): Promise<boolean> {
  const n = await scalar(
    ctx,
    "select count(*) from information_schema.schemata where schema_name='stripe'",
  );
  return n === "1";
}
