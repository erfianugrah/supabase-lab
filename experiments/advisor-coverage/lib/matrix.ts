/**
 * Pure matching and classification for the advisor-coverage matrix.
 *
 * Each seeded fixture names a unique object marker (`av_f01_rls_off`, ...),
 * the audit checks that cover its category and the advisor lints that cover
 * it. A finding belongs to a fixture when the marker appears as a whole
 * identifier in the audit row's `object` or in the lint's `detail` or
 * `metadata`. The cell is decided by the category's checks and lints only;
 * every other finding on the same object is kept as "incidental" so the
 * reader sees it without it changing the cell.
 */

export interface AuditRow {
  severity: string;
  check: string;
  object: string;
}

export interface Lint {
  name: string;
  level: string;
  detail: string;
  metadata?: Record<string, unknown>;
  cache_key?: string;
}

export type Cell = "both" | "tool only" | "advisors only" | "neither";

export interface Classified {
  cell: Cell;
  /** `severity check` for each audit row of the category's checks. */
  audit: string[];
  /** `level name` for each lint of the category's lints. */
  advisors: string[];
  /** Other audit checks that fired on the same object. */
  otherAudit: string[];
  /** Other lints that fired on the same object. */
  otherAdvisors: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `marker` occurs in `text` as a whole identifier (not as a prefix of a longer one). */
export function mentions(text: string, marker: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${escape(marker)}(?![A-Za-z0-9_])`).test(text);
}

export function auditHits(marker: string, rows: AuditRow[]): AuditRow[] {
  return rows.filter((r) => mentions(r.object, marker));
}

export function lintHits(marker: string, lints: Lint[]): Lint[] {
  return lints.filter((l) => mentions(l.detail ?? "", marker) || mentions(JSON.stringify(l.metadata ?? {}), marker));
}

const uniq = (xs: string[]) => [...new Set(xs)].sort();

export function classify(
  marker: string,
  auditChecks: string[],
  advisorLints: string[],
  rows: AuditRow[],
  lints: Lint[],
): Classified {
  const a = auditHits(marker, rows);
  const l = lintHits(marker, lints);
  const aIn = a.filter((r) => auditChecks.includes(r.check));
  const lIn = l.filter((x) => advisorLints.includes(x.name));
  const tool = aIn.length > 0;
  const adv = lIn.length > 0;
  const cell: Cell = tool && adv ? "both" : tool ? "tool only" : adv ? "advisors only" : "neither";
  return {
    cell,
    audit: uniq(aIn.map((r) => `${r.severity} ${r.check}`)),
    advisors: uniq(lIn.map((x) => `${x.level} ${x.name}`)),
    otherAudit: uniq(a.filter((r) => !auditChecks.includes(r.check)).map((r) => `${r.severity} ${r.check}`)),
    otherAdvisors: uniq(l.filter((x) => !advisorLints.includes(x.name)).map((x) => `${x.level} ${x.name}`)),
  };
}

/** Lint rows from a `GET /advisors/{security,performance}` body (`{ lints: [...] }`). */
export function lintsFrom(json: unknown): Lint[] {
  const arr = (json as { lints?: unknown } | undefined)?.lints;
  return Array.isArray(arr) ? (arr as Lint[]) : [];
}

/** Stable identity of a lint row, for "did the answer change between polls". */
export const lintKey = (l: Lint): string => l.cache_key ?? `${l.name}|${l.detail}`;
