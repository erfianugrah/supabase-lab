#!/usr/bin/env bun
/**
 * CLI entry. Discovers tests, plans the run, executes, writes one JSON
 * artifact plus a markdown report.
 *
 *   pvlab --tests ./tests --where runner --out ./out
 *   pvlab --tests ./tests --where local --only T20 --destructive
 */
import { $ } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCtx, toolVersions } from "./ctx";
import { planRun } from "./plan";
import { renderMarkdown } from "./report";
import type { RunArtifact, TestModule, TestResult, Where } from "./types";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/**
 * Compiled binaries carry a generated static registry (bun build --compile
 * bundles only statically-reachable code). Running from source falls back to
 * scanning the directory, so a newly dropped test works without a rebuild.
 */
async function loadTests(dir: string): Promise<TestModule[]> {
  try {
    const gen = (await import("./tests.generated")) as { tests?: TestModule[] };
    if (gen.tests?.length) return gen.tests;
  } catch {
    // no generated registry - fall through to directory scan
  }

  const abs = resolve(dir);
  const files = (await readdir(abs)).filter(
    (f) => (f.endsWith(".ts") || f.endsWith(".js")) && !f.endsWith(".test.ts"),
  );
  const mods: TestModule[] = [];
  for (const f of files.sort()) {
    const m = (await import(resolve(abs, f))) as { default?: TestModule };
    if (m.default?.id) mods.push(m.default);
    else console.warn(`  ${f}: no default-exported TestModule, ignored`);
  }
  return mods;
}

async function labCommit(): Promise<string | undefined> {
  try {
    return (await $`git rev-parse --short HEAD`.quiet().text()).trim();
  } catch {
    return undefined;
  }
}

/** Merge artifacts from both vantages into one report. */
async function mergeMode(files: string[], outDir: string): Promise<void> {
  const parts: RunArtifact[] = [];
  for (const f of files) parts.push(JSON.parse(await Bun.file(f).text()) as RunArtifact);
  if (!parts.length) throw new Error("no artifacts to merge");
  const first = parts[0]!;
  const merged: RunArtifact = {
    startedAt: parts.map((p) => p.startedAt).sort()[0]!,
    finishedAt: parts.map((p) => p.finishedAt).sort().at(-1)!,
    where: first.where,
    region: first.region,
    ref: parts.find((p) => p.ref)?.ref ?? "",
    experiment: first.experiment,
    labCommit: first.labCommit,
    toolVersions: Object.assign({}, ...parts.map((p) => p.toolVersions)),
    // Skips from one vantage are noise when the other vantage ran the test.
    results: parts
      .flatMap((p) => p.results)
      .filter(
        (r, _i, all) =>
          !(r.status === "skip" && /runs on "/.test(r.detail ?? "") &&
            all.some((o) => o.id === r.id && o.status !== "skip")),
      ),
  };
  await $`mkdir -p ${outDir}`.quiet();
  await Bun.write(`${outDir}/merged.json`, JSON.stringify(merged, null, 2));
  await Bun.write(`${outDir}/REPORT.md`, renderMarkdown(merged));
  console.log(`merged ${parts.length} artifacts -> ${outDir}/REPORT.md`);
}

const main = async () => {
  const mergeArg = arg("merge");
  if (mergeArg) {
    await mergeMode(mergeArg.split(",").map((s) => s.trim()).filter(Boolean), arg("out", "./out")!);
    return;
  }
  const where = (arg("where", "runner") as Where) ?? "runner";
  const testsDir = arg("tests", "./tests")!;
  const outDir = arg("out", "./out")!;
  // Which experiment this run belongs to. The registry is shared, so the label
  // has to come from the invocation - the report title is otherwise a lie the
  // moment a second experiment uses the same binary.
  const experiment = arg("experiment") ?? process.env.PVLAB_EXPERIMENT;
  const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);

  const ctx = await buildCtx({ where });
  const modules = await loadTests(testsDir);

  if (flag("list")) {
    console.log(`registered tests (${modules.length}):`);
    for (const m of modules.sort((a, b) => a.id.localeCompare(b.id, "en"))) {
      console.log(
        `  ${m.id.padEnd(6)} ${m.where.padEnd(6)} ` +
          `${m.destructive ? "destructive " : "            "}` +
          `${(m.requires ?? []).join(",") || "-"}  ${m.title}`,
      );
    }
    return;
  }
  const { run, skipped } = planRun(modules, {
    where,
    capabilities: ctx.capabilities,
    only,
    allowDestructive: flag("destructive"),
  });

  console.log(
    `pvlab: ${run.length} to run, ${skipped.length} skipped ` +
      `(vantage=${where}, capabilities=${[...ctx.capabilities].sort().join(",") || "none"})`,
  );

  const startedAt = new Date().toISOString();
  const results: TestResult[] = [...skipped];

  for (const m of run) {
    console.log(`\n[${m.id}] ${m.title}${m.destructive ? " (destructive)" : ""}`);
    const t0 = performance.now();
    try {
      const r = await m.run(ctx);
      const arr = Array.isArray(r) ? r : [r];
      for (const one of arr) {
        one.durationMs = Math.round(performance.now() - t0);
        results.push(one);
        console.log(`  -> ${one.status}${one.detail ? `: ${one.detail}` : ""}`);
      }
    } catch (e) {
      // A thrown error is a harness/test bug, distinct from a measured failure.
      results.push({
        id: m.id,
        title: m.title,
        status: "fail",
        detail: `test threw: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Math.round(performance.now() - t0),
      });
      console.log(`  -> threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const artifact: RunArtifact = {
    startedAt,
    finishedAt: new Date().toISOString(),
    where,
    region: ctx.region,
    ref: ctx.ref,
    experiment,
    labCommit: await labCommit(),
    toolVersions: await toolVersions(),
    results,
  };

  await $`mkdir -p ${outDir}`.quiet();
  const stamp = startedAt.replace(/[:.]/g, "-");
  await Bun.write(`${outDir}/run-${stamp}.json`, JSON.stringify(artifact, null, 2));
  await Bun.write(`${outDir}/run-${stamp}.md`, renderMarkdown(artifact));

  const failed = results.filter((r) => r.status === "fail").length;
  console.log(
    `\nwrote ${outDir}/run-${stamp}.{json,md} - ` +
      `${results.filter((r) => r.status === "pass").length} pass, ${failed} fail, ` +
      `${results.filter((r) => r.status === "skip").length} skip`,
  );
  // Exit 0 even with measured failures: they are data. Non-zero only if the
  // harness itself could not produce an artifact.
};

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
