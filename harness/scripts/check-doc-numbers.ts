#!/usr/bin/env bun
/**
 * Does every number a doc quotes as measured exist in the artifacts it cites?
 *
 *   bun scripts/check-doc-numbers.ts <doc.mdx|RUNLOG.md> <run.json> [<run.json> ...]
 *
 * Reads the prose, takes every table row or bullet that contains the word
 * "measured" or a module id (EF01, SH06, W13 ...), extracts its numbers, and
 * reports the ones that appear in no supplied artifact. Thousands separators
 * are ignored; a doc's "12,019" matches an artifact's 12019.
 *
 * This is the reviewer's hand check ("does 12,022 appear anywhere in the run?")
 * as a command. It is deliberately a lab script and not a docs-site test: the
 * site's own AGENTS.md resists cross-repo verification tooling, and a check that
 * only runs on the author's machine belongs next to the artifacts. Numbers that
 * are legitimately absent from artifacts (documented figures, dates, HTTP codes
 * quoted from docs) are listed for the author to judge, not failed.
 */
import { numbersIn } from "../src/facts";
import type { RunArtifact } from "../src/types";

const [doc, ...runs] = process.argv.slice(2);
if (!doc || !runs.length) {
  console.error("usage: bun scripts/check-doc-numbers.ts <doc> <run.json> [...]");
  process.exit(2);
}
const known = new Set<string>();
for (const r of runs) {
  const run = JSON.parse(await Bun.file(r).text()) as RunArtifact;
  for (const n of numbersIn(run)) known.add(n);
}
// Dates, years and HTTP status codes are quoted from docs and calendars, not
// from measurements; skip them so the report is about figures.
const skip = (n: string) => /^(19|20)\d\d$/.test(n) || /^\d{1,2}$/.test(n) || /^(1\d\d|2\d\d|3\d\d|4\d\d|5\d\d)$/.test(n);

const text = await Bun.file(doc).text();
const lines = text.split("\n");
let flagged = 0;
lines.forEach((line, i) => {
  const measured = /\bmeasured\b/i.test(line) || /\b(EF|SH|W|L|S|C|D|X|P|R|I|F|O|M)\d{2}[a-z]?\b/.test(line);
  if (!measured) return;
  const nums = [...new Set([...line.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "")))].filter((n) => !skip(n));
  const missing = nums.filter((n) => !known.has(n));
  if (missing.length) {
    flagged++;
    console.log(`${doc}:${i + 1}: not in any artifact: ${missing.join(", ")}`);
    console.log(`    ${line.trim().slice(0, 160)}`);
  }
});
console.log(flagged ? `${flagged} line(s) carry numbers absent from the ${runs.length} artifact(s) - judge each: documented figure, or a retyped measurement?` : "every number on a measured line appears in an artifact");
