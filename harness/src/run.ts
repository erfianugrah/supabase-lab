#!/usr/bin/env bun
/**
 * CLI entry. Discovers tests, plans the run, executes, writes one JSON
 * artifact plus a markdown report.
 *
 *   pvlab --tests ./tests --where runner --out ./out
 *   pvlab --tests ./tests --where local --only T20 --destructive
 *   pvlab --diff evidence/a/run-1.json,evidence/b/run-2.json --out evidence/diff
 *   pvlab --facts evidence/a/run-1.json --only EF08,EF09   # measurements as markdown
 */
import { $ } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCtx, readProjectRegion, toolVersions } from "./ctx";
import { planRun } from "./plan";
import { diffArtifacts, renderDiffMarkdown } from "./diff";
import { renderFacts } from "./facts";
import { renderMarkdown } from "./report";
import { preventIdleSleep, suspendedMs, withHostSuspension } from "./host-pause";
import { createDrainWatch, settleModule, unsettledDetail } from "./settle";
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
    projectRegion: parts.find((p) => p.projectRegion)?.projectRegion,
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

/**
 * `--diff prev.json,cur.json` - compare two artifacts and write the result.
 * Placed beside mergeMode and dispatched before buildCtx for the same reason:
 * this is an offline operation on files and must not need a credential.
 */
async function diffMode(files: string[], outDir: string): Promise<void> {
  if (files.length !== 2) throw new Error("--diff needs exactly two artifact paths, oldest first");
  const [prevPath, curPath] = files as [string, string];
  const prev = JSON.parse(await Bun.file(prevPath).text()) as RunArtifact;
  const cur = JSON.parse(await Bun.file(curPath).text()) as RunArtifact;
  const md = renderDiffMarkdown(diffArtifacts(prev, cur));
  await $`mkdir -p ${outDir}`.quiet();
  await Bun.write(`${outDir}/diff.md`, md);
  console.log(md);
}

const main = async () => {
  const mergeArg = arg("merge");
  if (mergeArg) {
    await mergeMode(mergeArg.split(",").map((s) => s.trim()).filter(Boolean), arg("out", "./out")!);
    return;
  }
  const diffArg = arg("diff");
  if (diffArg) {
    await diffMode(diffArg.split(",").map((t) => t.trim()).filter(Boolean), arg("out", "./out")!);
    return;
  }
  // `--facts run.json [--only ids]` - measurements as markdown, to paste into
  // a RUNLOG or a reference doc instead of retyping. Offline, like --diff.
  const factsArg = arg("facts");
  if (factsArg) {
    const run = JSON.parse(await Bun.file(factsArg).text()) as RunArtifact;
    const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
    console.log(renderFacts(run, { only }));
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

  // A sleeping orchestrator makes every timing across the sleep wrong (host-pause.ts).
  preventIdleSleep();
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
    experiment,
    allowDestructive: flag("destructive"),
  });

  console.log(
    `pvlab: ${run.length} to run, ${skipped.length} skipped ` +
      `(vantage=${where}, capabilities=${[...ctx.capabilities].sort().join(",") || "none"})`,
  );

  // Read before any module runs: a module may delete the project it targets.
  const projectRegion = await readProjectRegion(ctx);
  const startedAt = new Date().toISOString();
  const results: TestResult[] = [...skipped];

  // A module whose promise never settles must not end the run with exit 0
  // and no artifact (settle.ts): it is recorded as failed and the run goes on.
  const unsettled: string[] = [];
  for (const m of run) {
    console.log(`\n[${m.id}] ${m.title}${m.destructive ? " (destructive)" : ""}`);
    const t0 = performance.now();
    const w0 = Date.now();
    const outcome = await settleModule(() => m.run(ctx), drainWatch, m.timeoutMs);
    const suspended = suspendedMs(w0, Date.now(), t0, performance.now());
    if (outcome.kind === "settled") {
      const arr = Array.isArray(outcome.value) ? outcome.value : [outcome.value];
      for (const raw of arr) {
        const one = withHostSuspension(raw, suspended);
        one.durationMs = Math.round(performance.now() - t0);
        results.push(one);
        console.log(`  -> ${one.status}${one.detail ? `: ${one.detail}` : ""}`);
      }
      continue;
    }
    // A thrown error is a harness/test bug, distinct from a measured failure;
    // so is a module that never settled.
    const e = outcome.kind === "threw" ? outcome.error : undefined;
    const detail =
      outcome.kind === "threw"
        ? `test threw: ${e instanceof Error ? e.message : String(e)}`
        : unsettledDetail(outcome);
    if (outcome.kind !== "threw") unsettled.push(m.id);
    const failed = withHostSuspension({ id: m.id, title: m.title, status: "fail", detail }, suspended);
    failed.durationMs = Math.round(performance.now() - t0);
    results.push(failed);
    console.log(`  -> ${outcome.kind === "threw" ? "threw" : outcome.kind}: ${detail.replace(/^test threw: /, "")}`);
  }

  const artifact: RunArtifact = {
    startedAt,
    finishedAt: new Date().toISOString(),
    where,
    region: ctx.region,
    projectRegion,
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
  // Exit 0 even with measured failures: they are data. 1 if the harness
  // itself could not produce an artifact; 2 if it did, but a module never
  // settled. Explicit exit: a timed-out module may still hold a handle that
  // would keep the process alive.
  if (unsettled.length) {
    console.error(`pvlab: ${unsettled.join(", ")} did not settle (recorded as fail) - exit 2`);
    process.exit(2);
  }
};

let mainDone = false;
// A drain while no module is pending and main() unfinished means the harness
// itself hung outside a module (ctx, an artifact write): no artifact, not exit 0.
const drainWatch = createDrainWatch(undefined, () => {
  if (mainDone) return;
  console.error("harness error: the event loop drained before the run finished (outside any module); no artifact");
  process.exitCode = 1;
});

main()
  .then(() => {
    mainDone = true;
  })
  .catch((e) => {
    console.error("harness error:", e);
    process.exit(1);
  });
