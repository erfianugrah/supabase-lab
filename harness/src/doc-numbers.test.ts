import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { figuresOnLine, isMeasuredLine, liveModuleBases, moduleIdPattern } from "./doc-numbers";

const EXPERIMENTS = resolve(import.meta.dir, "../../experiments");
const live = moduleIdPattern(liveModuleBases(EXPERIMENTS));

describe("liveModuleBases", () => {
  test("reads the module ids off experiments/*/tests file names, upper-cased", () => {
    const bases = new Set(liveModuleBases(EXPERIMENTS));
    for (const id of ["EF01", "DC01", "TPA01", "OB03", "RR01", "RP08", "CK01", "RT01", "AR01", "NL01", "IT01", "SP01", "LO01", "MS01", "TL01", "AU01", "Z01", "ITL1"]) {
      expect(bases.has(id)).toBe(true);
    }
    expect([...bases].every((b) => /^[A-Z]+\d+$/.test(b))).toBe(true);
  });
});

describe("isMeasuredLine", () => {
  test("multi-letter module ids on main mark a line as measured", () => {
    for (const line of [
      "| DC16 | 4XL | 12,019 req/s |",
      "- TPA08: JWKS fetch took 412 ms",
      "OB03d polled 37 times over 600 s",
      "| RR04 | same-region replica lag 180 ms |",
      "CK06 re-run: 3 of 3 checkpoints in 9.4 s",
      "RT05a held 2,500 channels",
      "- RP08 returned 1,204 rows",
      "Z01e woke in 1,850 ms",
      "ITL1 remapped 400 stored copies",
      "SD11 took 312 s",
      "CR01a4 and S21b2 sub-results",
      "L10E-a refused at 1,001",
    ]) {
      expect({ line, measured: isMeasuredLine(line, live) }).toEqual({ line, measured: true });
    }
  });

  test("a prefix in the registry covers ids not yet in the tree (prefix and digit width, not the exact id)", () => {
    const withUi = moduleIdPattern(["UI01", "DC01", "H01", "R01"]);
    for (const line of ["UI03 upgrade took 1,234 s", "H04 idle drop at 600 s", "R27 is 512 MB", "DC01b at 3,000 req/s"]) {
      expect({ line, measured: isMeasuredLine(line, withUi) }).toEqual({ line, measured: true });
    }
  });

  test("the word measured still counts", () => {
    expect(isMeasuredLine("We measured 1,234 ms end to end.", live)).toBe(true);
  });

  test("ordinary prose with numbers is not read as a module id", () => {
    for (const line of [
      "Run on 2026-10-26 from ap-southeast-1.",
      "The pooler listens on port 6543 and 5432.",
      "Fixed in commit adc597c (and 7505077).",
      "Tracked as card #236 and #257.",
      "Store the dump in S3 over IPv4 and HTTP/2.",
      "Built for x86_64 and arm64, Node 22, Postgres 17.6.",
      "e2e test, sha256 digest, base64 body, UTF8 text",
    ]) {
      expect({ line, measured: isMeasuredLine(line, live) }).toEqual({ line, measured: false });
    }
  });
});

describe("figuresOnLine", () => {
  test("thousands separators dropped; dates, small counts and HTTP codes skipped", () => {
    expect(figuresOnLine("| DC16 | 12,019 req/s, 429 after 1,500 on 2026-10-26, 30 s |")).toEqual(["12019", "1500"]);
  });

  test("commit ids, run artifact names and version strings are not figures", () => {
    expect(figuresOnLine("lab commit 848b9f3 plus 661afdf, `oha` 1.16.0 for DC07, 4.5 s receiver")).toEqual(["4.5"]);
    expect(figuresOnLine("| `run-2026-10-26T00-24-19-000Z` | AR06d | `out/2026-10-23/run-2026-10-23T08-17-52-950Z.json` |")).toEqual([]);
  });
});
