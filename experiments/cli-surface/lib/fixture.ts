/**
 * Shared setup for the local-database modules (CL01-CL03): a throwaway
 * `supabase init` project with a running local Postgres (legacy backend,
 * Docker) and the app-schema fixture applied. The CLI's `db start` boots only
 * the database container, which is all `db diff` and the declarative commands
 * need (they build their own shadow database).
 */
import { readFileSync, rmSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Client } from "pg";
import { initLocalProject, stopLocal, type LocalProject, type RunResult } from "./cli";

export const FIXTURE_SQL = readFileSync(join(import.meta.dir, "..", "fixtures", "schema.sql"), "utf8");

export interface Started {
  p: LocalProject;
  startMs: number;
  fixtureMs: number;
  startOut: RunResult;
}

export async function pgExec(url: string, sql: string): Promise<void> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

export async function pgQuery<T = Record<string, unknown>>(url: string, sql: string): Promise<T[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql)).rows as T[];
  } finally {
    await c.end();
  }
}

export async function startFixtureProject(name: string, slot: number, applyFixture = true): Promise<Started> {
  const p = await initLocalProject(name, slot);
  const startOut = await p.sb(["db", "start"], { timeoutMs: 600_000 });
  if (startOut.code !== 0) throw new Error(`db start failed: ${startOut.all.slice(-400)}`);
  const t1 = performance.now();
  if (applyFixture) await pgExec(p.dbUrl, FIXTURE_SQL);
  return { p, startMs: startOut.ms, fixtureMs: Math.round(performance.now() - t1), startOut };
}

export async function teardown(p: LocalProject | undefined): Promise<void> {
  if (!p) return;
  await stopLocal(p);
  rmSync(dirname(p.home), { recursive: true, force: true });
}

/** Statement-start lines (CREATE/ALTER/DROP/GRANT/REVOKE/COMMENT) - a size proxy, not a parser. */
export function statementStarts(sql: string): number {
  return sql.split("\n").filter((l) => /^(create|alter|drop|grant|revoke|comment|set)\b/i.test(l)).length;
}

/** What a diff covers of the fixture's feature set, as 1/0 plus counts, by regex over the emitted SQL. */
export const COVERAGE_KEYS = ["stmt_starts", "bytes", "create_extension", "drop_stmts", "enable_rls", "force_rls", "policies", "triggers", "functions", "comments", "default_privs", "security_invoker", "column_grants", "function_acl", "sequence_acl", "grants", "revokes"] as const;
export type Coverage = Record<(typeof COVERAGE_KEYS)[number], number>;

export function featureCoverage(sql: string): Coverage {
  const n = (re: RegExp) => (sql.match(re) ?? []).length;
  return {
    stmt_starts: statementStarts(sql),
    bytes: sql.length,
    create_extension: n(/^create extension\b/gim),
    drop_stmts: n(/^drop\b/gim),
    enable_rls: n(/enable row level security/gi),
    force_rls: n(/force row level security/gi),
    policies: n(/create policy/gi),
    triggers: n(/create trigger/gi),
    functions: n(/create (or replace )?function/gi),
    comments: n(/^comment on\b/gim),
    default_privs: n(/alter default privileges/gi),
    security_invoker: n(/security_invoker/gi),
    column_grants: n(/grant update \("?title"?\)/gi),
    function_acl: n(/(grant|revoke)[^;]*on function "?app"?\."?doc_count/gi),
    sequence_acl: n(/(grant|revoke)[^;]*on sequence "?app"?\."?ticket_seq/gi),
    grants: n(/^grant\b/gim),
    revokes: n(/^revoke\b/gim),
  };
}

/** Pull the SQL out of `db diff --output-format json`; fall back to raw stdout. */
export function diffSql(r: RunResult): { sql: string; engine: string; drops: string[] } {
  try {
    const j = JSON.parse(r.stdout) as { diff?: string; engine?: string; dropStatements?: string[] };
    return { sql: j.diff ?? "", engine: j.engine ?? "", drops: j.dropStatements ?? [] };
  } catch {
    return { sql: r.stdout, engine: "", drops: [] };
  }
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

export const norm = (s: string) => s.replace(/\s+/g, " ").trim();

