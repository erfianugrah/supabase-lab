/**
 * No project ref, hostname or email in tracked prose.
 *
 * This repo is public. A project ref is a 20-lowercase-letter token, which is
 * also the shape of `<ref>.supabase.co` hostnames, pooler users
 * (`postgres.<ref>`) and the ids that turn up in copied error bodies. The
 * confidentiality sweep before every 2026-09-02 commit was a hand-run `rg`
 * with that day's refs pasted in; a hand-run check is an intention. This test
 * scans every tracked markdown file and every published `out/` artifact for the
 * SHAPE, so a ref that was never in anyone's list still fails.
 *
 * Allowlist: 20-letter tokens that are ordinary words or identifiers. Add to it
 * deliberately; a growing list is the signal to stop and look.
 */
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

const ALLOW = new Set<string>([
  // ordinary English long enough to match the ref shape
  "internationalization",
  "counterrevolutionary",
  "electroencephalogram",
  "uncharacteristically",
  // the alphabet, used as the placeholder ref in plan docs and fixtures
  "abcdefghijklmnopqrst",
]);

const REF = /\b[a-z]{20}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Example addresses are fine; the lab uses example.com for fixtures.
const EMAIL_ALLOW = /@example\.(com|org|net)$|@supabase\.com$/;

/**
 * Tracked prose and published artifacts, PLUS untracked files that git would
 * accept on the next `git add` (not ignored). A raw artifact sitting one
 * `git add -A` away from public is the case a tracked-only scan misses; the
 * first run of this test found exactly that in two experiments' out/ dirs.
 */
async function trackedProse(): Promise<string[]> {
  const tracked = await $`git -C ${ROOT} ls-files -- '*.md' 'experiments/*/out/**'`.quiet().text();
  const untracked = await $`git -C ${ROOT} ls-files --others --exclude-standard -- '*.md' 'experiments/*/out/**'`.quiet().text();
  return [...new Set(`${tracked}\n${untracked}`.split("\n").map((l) => l.trim()))].filter(
    (l) => l && !l.includes("node_modules/"),
  );
}

describe("tracked prose carries no project ref, project hostname or email", async () => {
  const files = await trackedProse();
  test("there is prose to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });
  for (const rel of files) {
    test(rel, async () => {
      const text = await Bun.file(resolve(ROOT, rel)).text();
      const refs = [...new Set((text.match(REF) ?? []).filter((t) => !ALLOW.has(t)))];
      const emails = [...new Set((text.match(EMAIL) ?? []).filter((e) => !EMAIL_ALLOW.test(e)))];
      expect({ refs, emails }).toEqual({ refs: [], emails: [] });
    });
  }
});
