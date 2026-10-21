/**
 * No experiment Makefile hardcodes the compiled harness.
 *
 * `bun run build` compiles for linux-x64 (package.json), so a recipe calling
 * `$(ROOT)/harness/dist/pvlab` dies on the macOS orchestrator with "exec format
 * error" (work-supabase-lab#180: 32 Makefiles on 2026-10-13). The switch lives
 * once in harness/pvlab.mk: `$(HARNESS_RUN)` is the binary on Linux and
 * `bun harness/src/run.ts` elsewhere, `$(HARNESS_BUILD)` compiles or only
 * regenerates the registry to match. A Makefile that uses either must include
 * that file.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const INCLUDE = "include $(ROOT)/harness/pvlab.mk";

export function scanRunner(file: string, src: string): string[] {
  const out: string[] = [];
  const lines = src.split("\n");
  lines.forEach((text, i) => {
    if (/^\s*#/.test(text)) return;
    if (text.includes("dist/pvlab")) out.push(`${file}:${i + 1} hardcoded dist/pvlab (use $(HARNESS_RUN))`);
  });
  if (/\$\(HARNESS_(RUN|BUILD)\)/.test(src) && !lines.some((l) => l.trim() === INCLUDE)) {
    out.push(`${file}: uses $(HARNESS_RUN) without '${INCLUDE}'`);
  }
  return out;
}

describe("scanner", () => {
  test("flags a hardcoded binary, ignores comments", () => {
    const src = ["ROOT := $(abspath ../..)", "# dist/pvlab is linux-x64", "probe:", "\t$(ROOT)/harness/dist/pvlab --where local"].join("\n");
    expect(scanRunner("t", src)).toEqual(["t:4 hardcoded dist/pvlab (use $(HARNESS_RUN))"]);
  });
  test("flags $(HARNESS_RUN) without the include", () => {
    expect(scanRunner("t", "probe:\n\t$(HARNESS_RUN) --where local")).toEqual([`t: uses $(HARNESS_RUN) without '${INCLUDE}'`]);
  });
  test("accepts the include form", () => {
    const src = ["ROOT := $(abspath ../..)", INCLUDE, "probe:", "\t@$(HARNESS_BUILD)", "\t$(HARNESS_RUN) --where local"].join("\n");
    expect(scanRunner("t", src)).toEqual([]);
  });
});

describe("no experiment Makefile hardcodes dist/pvlab", async () => {
  const files = (await Array.fromAsync(new Bun.Glob("experiments/*/Makefile").scan({ cwd: ROOT }))).sort();
  test("there are Makefiles to scan", () => {
    expect(files.length).toBeGreaterThan(20);
  });
  test("every Makefile", async () => {
    const offences: string[] = [];
    for (const rel of files) offences.push(...scanRunner(rel, await Bun.file(resolve(ROOT, rel)).text()));
    expect(offences).toEqual([]);
  });
});
