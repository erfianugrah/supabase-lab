#!/usr/bin/env bun
/**
 * Scaffold a test module with the doc-comment skeleton the RUNLOGs and the
 * docs site depend on.
 *
 *   bun scripts/new-module.ts <experiment> <ID> <slug> "<one-line question>"
 *   bun scripts/new-module.ts edge-function-limits EF12 free-wall-clock "wall clock on a Free project"
 *
 * The skeleton encodes what three review passes on 2026-09-02 kept finding
 * missing: which side/key/project a row measures, a per-row id list, the
 * DESTRUCTIVE/cleanup note, and a "what this does not settle" line. It also
 * starts from the shared platform helpers so the query endpoint's 201, the
 * logs endpoint's time window and the deploy-landed read are not rediscovered.
 */
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const [experiment, id, slug, question] = process.argv.slice(2);
if (!experiment || !id || !slug) {
  console.error('usage: bun scripts/new-module.ts <experiment> <ID> <slug> "<one-line question>"');
  process.exit(2);
}
const file = resolve(import.meta.dir, "../../experiments", experiment, "tests", `${id.toLowerCase()}-${slug}.ts`);
if (existsSync(file)) {
  console.error(`${file} exists`);
  process.exit(1);
}
const q = question ?? "<one line: the question this module answers>";
const src = `/**
 * ${id} - ${q}
 *
 * Name the SIDE, KEY and PROJECT every row measures (managed vs self-hosted,
 * legacy HS256 vs ES256 vs API key, which of several projects); a reader of
 * the RUNLOG must not have to reconstruct it.
 *
 *   ${id}a  <first row: what is sent, what is expected, docs figure if any>
 *   ${id}b  <second row>
 *
 * Pass means the platform did what the docs say at the boundary probed; fail
 * is a measured disagreement, not a harness error. Quote the platform's error
 * text verbatim in \`detail\` and keep every number in \`measurements\` so
 * \`pvlab --facts\` can render it.
 *
 * Not settled by this module: <what a reader might assume it covers and it
 * does not>.
 *
 * DESTRUCTIVE: <what it creates>; deleted in finally. Self-skips without
 * <capability or endpoint>.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys, sql } from "../../../harness/src/platform";

const mod: TestModule = {
  id: "${id}",
  title: "${q}",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "${id}", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    try {
      const probe = await sql(ctx, "select 1 as one");
      out.push({
        id: "${id}a",
        title: "<row title>",
        status: probe.status < 300 ? "pass" : "fail",
        detail: probe.status < 300 ? "<what happened, with the number>" : probe.error,
        measurements: { status: probe.status, anon_key_present: keys.anon ? 1 : 0 },
      });
    } catch (e) {
      out.push({ id: "${id}", title: this.title, status: "fail", detail: \`threw: \${e instanceof Error ? e.message : String(e)}\` });
    } finally {
      out.push({ id: "${id}z", title: "cleanup", status: "pass", detail: "<what was removed>" });
    }
    return out;
  },
};
export default mod;
`;
await writeFile(file, src);
console.log(`wrote ${file}\nnext: fill the rows, then \`bun run gen\` in harness/ (or \`bun run build\`) and add the module to the experiment Makefile's id list and RUNLOG table.`);
