#!/usr/bin/env bun
/**
 * Publish a run artifact: redact identifiers and copy it, plus its facts
 * rendering, to a committed `out/<date>/` directory.
 *
 *   bun scripts/publish-evidence.ts <run.json> <experiment-dir> [--only EF08,EF09]
 *
 * `evidence/` stays gitignored because a raw artifact carries the project ref
 * (in URLs, hostnames and error bodies), pooler hostnames and sometimes an
 * email. A RUNLOG that cites `evidence/<ts>` is therefore citing something the
 * reader cannot open. `out/<date>/` is the public half: the same artifact with
 * refs, project hostnames, pooler hosts and emails replaced by placeholders,
 * and a facts.md next to it so numbers can be quoted by paste.
 *
 * Redaction is by shape, not by a list: any 20-lowercase-letter token (the
 * project ref shape), `<ref>.supabase.co` and `db.<ref>.supabase.co`, the
 * `aws-N-<region>.pooler.supabase.com` hosts, and anything that looks like an
 * email. The gitignore carves experiments/<name>/out/ out of the global out/
 * rule (the literal patterns are in .gitignore; a star-slash here would close
 * this comment).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { renderFacts } from "../src/facts";
import type { RunArtifact } from "../src/types";

const [src, expDir, ...rest] = process.argv.slice(2);
if (!src || !expDir) {
  console.error("usage: bun scripts/publish-evidence.ts <run.json> <experiment-dir> [--only IDS]");
  process.exit(2);
}
const onlyIdx = rest.indexOf("--only");
const only = onlyIdx >= 0 ? (rest[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : undefined;

export function redact(text: string): string {
  return text
    .replace(/\bdb\.[a-z]{20}\.supabase\.co\b/g, "db.<ref>.supabase.co")
    .replace(/\b[a-z]{20}\.supabase\.co\b/g, "<ref>.supabase.co")
    .replace(/\baws-\d-[a-z0-9-]+\.pooler\.supabase\.com\b/g, "<pooler-host>")
    .replace(/\b[a-z]{20}\b/g, "<ref>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
}

const raw = await Bun.file(src).text();
const redacted = redact(raw);
const run = JSON.parse(redacted) as RunArtifact;
if (only?.length) {
  const lower = only.map((o) => o.toLowerCase());
  run.results = run.results.filter((r) => lower.some((o) => r.id.toLowerCase() === o || r.id.toLowerCase().startsWith(o)));
}
run.ref = "<ref>";
const date = run.startedAt.slice(0, 10);
const outDir = resolve(expDir, "out", date);
await mkdir(outDir, { recursive: true });
const jsonName = basename(src);
await writeFile(join(outDir, jsonName), JSON.stringify(run, null, 2));
await writeFile(join(outDir, jsonName.replace(/\.json$/, ".facts.md")), renderFacts(run, { only }));
const leftover = redacted.match(/\b[a-z]{20}\b/g)?.length ?? 0;
console.log(`published ${jsonName} -> ${outDir} (${run.results.length} results; ${leftover} unredacted ref-shaped tokens remain)`);
if (leftover) process.exit(1);
