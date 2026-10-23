/**
 * The community audit file, fetched at run time pinned by commit and checked
 * by SHA-256. It is MIT-licensed, so vendoring would be allowed; it is fetched
 * instead so this repo carries none of its text and a moved pin fails loudly
 * rather than silently auditing different SQL.
 *
 * Source: https://github.com/EstasDespedido/supabase-audit (was
 * Concepto505/supabase-audit; GitHub redirects the old name). Commit f8d15fa
 * is the last one that touched audit.sql (2026-09-20): checks 1-11 are
 * byte-identical to the first commit 983ac92 ("eleven production failure
 * modes"), and check 12 (INSERT policy with no SELECT policy) was added here.
 */
import { createHash } from "node:crypto";
import type { PgSession } from "../../data-api-defaults/lib/project.js";
import type { AuditRow } from "./matrix.js";

export const AUDIT_REPO = "EstasDespedido/supabase-audit";
export const AUDIT_COMMIT = "f8d15fa4f51a131c1250fb8de32300a7f9f6b22a";
export const AUDIT_SHA256 = "b3231d413df8f5fb5df595a8820599193238f7aeb920d409054eaef9a6918cfa";
export const AUDIT_URL = `https://raw.githubusercontent.com/${AUDIT_REPO}/${AUDIT_COMMIT}/audit.sql`;

let cached: string | null = null;

export async function fetchAudit(): Promise<string> {
  if (cached) return cached;
  const res = await fetch(AUDIT_URL, { signal: AbortSignal.timeout(20_000) });
  if (res.status !== 200) throw new Error(`fetch audit.sql: HTTP ${res.status}`);
  const text = await res.text();
  const sha = createHash("sha256").update(text).digest("hex");
  if (sha !== AUDIT_SHA256) throw new Error(`audit.sql sha256 ${sha} != pinned ${AUDIT_SHA256}`);
  cached = text;
  return text;
}

export interface AuditRun {
  rows: AuditRow[];
  /** Ran inside BEGIN TRANSACTION READ ONLY: any write would have raised 25006. */
  readOnly: boolean;
  error?: string;
  ms: number;
}

/**
 * Run the file as `postgres` (the SQL Editor's role) inside a READ ONLY
 * transaction, then roll back. The file is one WITH ... SELECT statement
 * followed by comments.
 */
export async function runAudit(s: PgSession, sqlText: string): Promise<AuditRun> {
  const t0 = Date.now();
  const b = await s.query("begin transaction read only");
  if (b.error) return { rows: [], readOnly: false, error: `begin: ${b.error}`, ms: Date.now() - t0 };
  const r = await s.query(sqlText);
  await s.query("rollback");
  const ms = Date.now() - t0;
  if (r.error) return { rows: [], readOnly: true, error: `${r.code ?? ""} ${r.error}`.trim(), ms };
  const rows = r.rows.map((x) => ({ severity: String(x.severity), check: String(x.check), object: String(x.object) }));
  return { rows, readOnly: true, ms };
}
