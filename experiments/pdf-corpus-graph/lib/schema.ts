/**
 * Idempotent schema setup, shared by G03/G04/G05/G07. One `.sql` file per
 * table group under `sql/`, run through `file()` (psql -f).
 *
 * PATH RESOLUTION IS `process.cwd()`-RELATIVE, NOT `import.meta.dir`-RELATIVE,
 * and that is a fix for a real bug, not a style choice. `bun build --compile`
 * - what scripts/live-suite.sh actually runs - bundles only statically
 * reachable CODE into a single binary; it does not carry `sql/*.sql` next to
 * it on disk. `import.meta.dir` inside the compiled binary resolves to a
 * virtual `/$bunfs/...` location, so `psql -f <that path>` fails with "No
 * such file or directory" the moment this harness is compiled - confirmed by
 * compiling a throwaway binary and watching that exact read fail. `run.ts`
 * already assumes the invoking shell has `cd`'d into the experiment directory
 * (its own `--tests`/`--out` flags default to `./tests`/`./out`), and
 * scripts/live-suite.sh does exactly that before invoking `dist/pvlab` - so
 * `process.cwd()` is the one path anchor that is valid both running from
 * source and running the compiled binary.
 */
import { join } from "node:path";
import type { Ctx } from "../../../harness/src/types";
import { file, scalar, type QueryResult } from "./pg";

const SQL_DIR = join(process.cwd(), "sql");

export async function ensureDocumentsTable(ctx: Ctx): Promise<QueryResult> {
  return file(ctx, join(SQL_DIR, "corpus-documents.sql"), 60);
}

export async function ensureEntityGraphTables(ctx: Ctx): Promise<QueryResult> {
  return file(ctx, join(SQL_DIR, "corpus-entities-edges.sql"), 60);
}

export async function ensureChunkTables(ctx: Ctx): Promise<QueryResult> {
  return file(ctx, join(SQL_DIR, "corpus-chunks.sql"), 60);
}

/** Row count of a schema-qualified table. Used for idempotency checks. */
export async function tableRowCount(ctx: Ctx, relation: string): Promise<number> {
  const n = await scalar(ctx, `select count(*) from ${relation}`);
  return Number(n ?? 0);
}

/** Whole-relation size including TOAST and indexes. */
export async function relationTotalBytes(ctx: Ctx, relation: string): Promise<number | null> {
  const n = await scalar(ctx, `select pg_total_relation_size('${relation}')`);
  return n == null ? null : Number(n);
}

/** Heap + TOAST only, excluding indexes - the clean figure for comparing
 * storage TYPES (vector vs halfvec) independent of which index sits on top. */
export async function relationTableBytes(ctx: Ctx, relation: string): Promise<number | null> {
  const n = await scalar(ctx, `select pg_table_size('${relation}')`);
  return n == null ? null : Number(n);
}
