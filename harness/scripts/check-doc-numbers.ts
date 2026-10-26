#!/usr/bin/env bun
/**
 * Does every number a doc quotes as measured exist in the artifacts it cites?
 *
 *   bun scripts/check-doc-numbers.ts <doc.mdx|RUNLOG.md> <run.json> [<run.json> ...]
 *
 * Reads the prose, takes every line that contains the word "measured" or a
 * module id (EF01, DC16, TPA08, OB03d ...; prefixes and digit widths come from
 * the experiments/<name>/tests file names, see src/doc-numbers.ts), extracts its numbers, and
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
import { resolve } from "node:path";
import { figuresOnLine, isMeasuredLine, liveModuleBases, moduleIdPattern } from "../src/doc-numbers";
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
const ids = moduleIdPattern(liveModuleBases(resolve(import.meta.dir, "../../experiments")));
const text = await Bun.file(doc).text();
const lines = text.split("\n");
let flagged = 0;
lines.forEach((line, i) => {
  if (!isMeasuredLine(line, ids)) return;
  const missing = figuresOnLine(line).filter((n) => !known.has(n));
  if (missing.length) {
    flagged++;
    console.log(`${doc}:${i + 1}: not in any artifact: ${missing.join(", ")}`);
    console.log(`    ${line.trim().slice(0, 160)}`);
  }
});
console.log(flagged ? `${flagged} line(s) carry numbers absent from the ${runs.length} artifact(s) - judge each: documented figure, or a retyped measurement?` : "every number on a measured line appears in an artifact");
