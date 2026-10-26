/**
 * Which lines of a write-up quote a measurement? Used by
 * scripts/check-doc-numbers.ts.
 *
 * A line counts when it says "measured" or names a module id. The id pattern
 * is derived from the test files under experiments/<name>/tests: each file is
 * named <prefix><digits>-<slug>.ts (dc01-..., tpa08-..., itl1-...), so the
 * prefixes and their digit widths in use are whatever is on disk. A hard-coded
 * list of one-letter prefixes (EF|SH|...|M) missed every two- and three-letter
 * prefix (DC, RR, OB, TPA ...), and the check passed vacuously on most
 * write-ups. Matching prefix + width rather than the exact ids lets a doc cite
 * a sub-result (OB03d, CR01a4) or a module from the same family that is newer
 * than the files.
 *
 * simplify: a prefix that is also ordinary notation (P99, PG17) marks its line
 * as measured; that only adds lines to the report, it never hides one.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Upper-cased module ids (DC01, TPA08, ITL1) read off experiments/<name>/tests/*.ts. */
export function liveModuleBases(experimentsRoot: string): string[] {
  const out = new Set<string>();
  for (const e of readdirSync(experimentsRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    let files: string[];
    try {
      files = readdirSync(join(experimentsRoot, e.name, "tests"));
    } catch {
      continue; // infra-only experiment, no tests dir
    }
    for (const f of files) {
      const id = /^([a-z]+\d+)-.*\.ts$/.exec(f)?.[1];
      if (id && !f.endsWith(".test.ts")) out.add(id.toUpperCase());
    }
  }
  return [...out].sort();
}

/**
 * One regex for every prefix at the digit width it is used with, plus an
 * optional one-letter, one-digit suffix (OB03d, CR01a4, L10E).
 */
export function moduleIdPattern(bases: Iterable<string>): RegExp {
  const byWidth = new Map<number, Set<string>>();
  for (const b of bases) {
    const [, prefix, digits] = /^([A-Z]+)(\d+)$/.exec(b) ?? [];
    if (!prefix || !digits) continue;
    const set = byWidth.get(digits.length) ?? new Set<string>();
    set.add(prefix);
    byWidth.set(digits.length, set);
  }
  if (!byWidth.size) return /(?!)/;
  // Longest prefix first so TPA is tried before T.
  const alts = [...byWidth].map(([w, ps]) => `(?:${[...ps].sort((a, b) => b.length - a.length || a.localeCompare(b)).join("|")})\\d{${w}}`);
  return new RegExp(`\\b(?:${alts.join("|")})[A-Za-z]?\\d?\\b`);
}

export function isMeasuredLine(line: string, ids: RegExp): boolean {
  return /\bmeasured\b/i.test(line) || ids.test(line);
}

// Dates, years, one- and two-digit counts and HTTP status codes are quoted from
// docs and calendars, not from measurements; skip them so the report is about
// figures.
const notAFigure = (n: string) => /^(19|20)\d\d$/.test(n) || /^\d{1,2}$/.test(n) || /^[1-5]\d\d$/.test(n);

// Tokens whose digits are not figures: run artifact names
// (run-2026-10-26T00-24-19-000Z), commit ids with at least one hex letter
// (848b9f3; an all-digit id such as 4141477 still reads as a number) and
// dotted versions (1.16.0, 2.118.0).
const NOT_FIGURES = [/run-\d{4}-\d\d-\d\dT[\d-]+Z/g, /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g, /\b\d+\.\d+\.\d+\b/g];

/** The distinct figures a line quotes, thousands separators removed. */
export function figuresOnLine(line: string): string[] {
  const text = NOT_FIGURES.reduce((t, re) => t.replace(re, " "), line);
  return [...new Set([...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "")))].filter((n) => !notAFigure(n));
}
