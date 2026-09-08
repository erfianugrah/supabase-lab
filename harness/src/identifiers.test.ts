/**
 * No project ref, hostname or email in tracked prose.
 *
 * This repo is public. A project ref is a 20-lowercase-letter token, which is
 * also the shape of `<ref>.supabase.co` hostnames, pooler users
 * (`postgres.<ref>`) and the ids that turn up in copied error bodies. The
 * confidentiality sweep before every 2026-09-02 commit was a hand-run `rg`
 * with that day's refs pasted in; a hand-run check is an intention. This test
 * scans every tracked markdown file, every published `out/` artifact and, since
 * 2026-09-07, every tracked source, config and script file for the SHAPE, so a
 * ref that was never in anyone's list still fails. The source scan was added
 * after a history sweep found four modules and a rendered wrangler.jsonc
 * carrying refs as constants at HEAD while the prose scan passed.
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
  // the all-a placeholder a gateway fixture uses for a ref-shaped scope
  "aaaaaaaaaaaaaaaaaaaa",
]);

const REF = /\b[a-z]{20}\b/g;
/**
 * Credential identifiers the PLATFORM writes into its own output, which no
 * hand-written redaction list anticipated. The Management API appends a
 * provenance comment to statements it runs (`-- user: pat:<digits>`, or
 * `oauth:<uuid>` for an OAuth client), and audit-integrity A03d keeps that
 * footer verbatim as evidence - so four published artifacts carried the
 * account's real PAT id on 2026-09-08. The ref scan passed on all four,
 * because a PAT id is not ref-shaped.
 */
const CRED = /\bpat:\d+|\boauth:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/**
 * Deliberately-synthetic credential fixtures, the same idea as the placeholder
 * refs in ALLOW: redact.test.ts has to contain the SHAPE to prove the redactor
 * removes it. Two entries, both counted-up digits. Add to this only for another
 * fixture, never to excuse a real value.
 */
const CRED_ALLOW = new Set<string>(["pat:1234567", "oauth:0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"]);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Example addresses are fine: example.com, the reserved lab.test / lab.invalid
// fixture domains, and the disposable-domain LIKE pattern S19 sends.
const EMAIL_ALLOW = /@example\.(com|org|net)$|@supabase\.com$|@lab\.(test|invalid)$|^%@mailinator\.com$/;

/**
 * Tracked prose and published artifacts, PLUS untracked files that git would
 * accept on the next `git add` (not ignored). A raw artifact sitting one
 * `git add -A` away from public is the case a tracked-only scan misses; the
 * first run of this test found exactly that in two experiments' out/ dirs.
 */
const SCAN = ["*.md", "experiments/*/out/**", "*.ts", "*.tf", "*.tfvars", "*.jsonc", "*.sh", "Makefile", "*/Makefile", "*.yaml", "*.yml", "*.toml"];
const SKIP = /node_modules\/|\.lock$|\.lock\.hcl$|\/dist\//;

async function trackedProse(): Promise<string[]> {
  const tracked = await $`git -C ${ROOT} ls-files -- ${SCAN}`.quiet().text();
  const untracked = await $`git -C ${ROOT} ls-files --others --exclude-standard -- ${SCAN}`.quiet().text();
  return [...new Set(`${tracked}\n${untracked}`.split("\n").map((l) => l.trim()))].filter((l) => l && !SKIP.test(l));
}

describe("tracked prose, source and config carry no project ref, hostname, email or credential id", async () => {
  const files = await trackedProse();
  test("there is prose to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });
  for (const rel of files) {
    test(rel, async () => {
      const text = await Bun.file(resolve(ROOT, rel)).text();
      const refs = [...new Set((text.match(REF) ?? []).filter((t) => !ALLOW.has(t)))];
      const emails = [...new Set((text.match(EMAIL) ?? []).filter((e) => !EMAIL_ALLOW.test(e)))];
      const creds = [...new Set((text.match(CRED) ?? []).filter((c) => !CRED_ALLOW.has(c)))];
      expect({ refs, emails, creds }).toEqual({ refs: [], emails: [], creds: [] });
    });
  }
});
