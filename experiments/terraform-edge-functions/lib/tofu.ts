/**
 * OpenTofu plumbing for TF01: stage a scratch copy of tf/ with generated
 * function sources, run tofu in it, and read counts out of the output.
 *
 * Counting is done on the human-readable output because the claim under test
 * is "what tofu REPORTED", and the report is what an operator reads. Every
 * count taken here is later compared with the Management API's own listing;
 * nothing in this file decides whether a function landed.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TF_DIR = join(import.meta.dir, "..", "tf");

export interface Stage {
  dir: string;
  cleanup: () => Promise<void>;
}

export interface StageVars {
  project_ref: string;
  slugs: string[];
  secrets?: Record<string, string>;
  manage_secrets?: boolean;
}

/** Copy tf/ to a scratch dir (with its committed lock file) and write sources + vars. */
export async function stage(vars: StageVars, source: (slug: string) => string): Promise<Stage> {
  const dir = await mkdtemp(join(tmpdir(), "pvlab-tf-"));
  await cp(TF_DIR, dir, { recursive: true });
  await writeSources(dir, vars.slugs, source);
  await writeVars(dir, vars);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeSources(dir: string, slugs: string[], source: (slug: string) => string): Promise<void> {
  for (const slug of slugs) {
    const p = join(dir, "functions", slug, "index.ts");
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, source(slug));
  }
}

export async function writeVars(dir: string, vars: StageVars): Promise<void> {
  await writeFile(join(dir, "terraform.tfvars.json"), JSON.stringify(vars));
}

export interface TofuRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export async function tofu(dir: string, args: string[], pat: string, timeoutMs = 900_000): Promise<TofuRun> {
  const cache = join(tmpdir(), "pvlab-tf-plugin-cache");
  await mkdir(cache, { recursive: true });
  const t0 = performance.now();
  const proc = Bun.spawn(["tofu", ...args], {
    cwd: dir,
    env: {
      ...process.env,
      SUPABASE_ACCESS_TOKEN: pat,
      TF_IN_AUTOMATION: "1",
      TF_PLUGIN_CACHE_DIR: cache,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, stdout, stderr, ms: Math.round(performance.now() - t0) };
}

export const init = (dir: string, pat: string) => tofu(dir, ["init", "-input=false", "-no-color"], pat, 300_000);

export const apply = (dir: string, pat: string, parallelism?: number) =>
  tofu(dir, ["apply", "-auto-approve", "-input=false", "-no-color", ...(parallelism ? [`-parallelism=${parallelism}`] : [])], pat);

export const destroy = (dir: string, pat: string, parallelism?: number) =>
  tofu(dir, ["destroy", "-auto-approve", "-input=false", "-no-color", ...(parallelism ? [`-parallelism=${parallelism}`] : [])], pat);

/** Exit 0 = no changes, 2 = changes pending, 1 = error. */
export const plan = (dir: string, pat: string, parallelism?: number) =>
  tofu(dir, ["plan", "-detailed-exitcode", "-input=false", "-no-color", ...(parallelism ? [`-parallelism=${parallelism}`] : [])], pat);

export interface Counts {
  /** "Creation complete" lines - what tofu reported as created. */
  created: number;
  modified: number;
  destroyed: number;
  errors: number;
  /** Distinct first lines of `Error:` blocks, verbatim and truncated. */
  errorTexts: string[];
  /** The `Apply complete!` / `Destroy complete!` summary, or "" when absent. */
  summary: string;
  /** `Plan: X to add, Y to change, Z to destroy.` as a triple, or null. */
  planned: { add: number; change: number; destroy: number } | null;
  /** Resources the refresh reported as gone from the remote side. */
  deletedOutside: number;
  /** First `Error:` block verbatim (headline plus the paragraph under it), for the evidence column. */
  errorSample: string;
  /** For "inconsistent result after apply" errors: which attributes moved, e.g. `.version:24|.updated_at:24`. */
  inconsistentAttrs: string;
}

export function counts(out: TofuRun): Counts {
  const text = `${out.stdout}\n${out.stderr}`;
  const n = (re: RegExp) => (text.match(re) ?? []).length;
  const errorTexts = [...new Set([...text.matchAll(/Error: (.*)/g)].map((m) => (m[1] ?? "").slice(0, 160)))].slice(0, 6);
  const sample = /Error: [\s\S]*?(?:\n\n(?=Error: )|$)/.exec(text)?.[0] ?? "";
  const attrs = new Map<string, number>();
  for (const m of text.matchAll(/unexpected new value: (\.\w+)/g)) attrs.set(m[1] ?? "", (attrs.get(m[1] ?? "") ?? 0) + 1);
  const summary = /(?:Apply|Destroy) complete! Resources: .*?\./.exec(text)?.[0] ?? "";
  const p = /Plan: (\d+) to add, (\d+) to change, (\d+) to destroy/.exec(text);
  return {
    created: n(/Creation complete/g),
    modified: n(/Modifications complete/g),
    destroyed: n(/Destruction complete/g),
    errors: n(/^Error: /gm),
    errorTexts,
    summary,
    planned: p ? { add: Number(p[1]), change: Number(p[2]), destroy: Number(p[3]) } : null,
    deletedOutside: n(/has been deleted/g),
    errorSample: sample.replace(/\s+/g, " ").slice(0, 600),
    inconsistentAttrs: [...attrs.entries()].map(([k, v]) => `${k}:${v}`).join("|"),
  };
}

/** Addresses in tofu's state, e.g. `supabase_edge_function.fn["x"]`. */
export async function stateList(dir: string, pat: string): Promise<string[]> {
  const r = await tofu(dir, ["state", "list"], pat, 60_000);
  return r.exitCode === 0
    ? r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
}

/** Needs an initialised dir: provider_selections is empty before `tofu init`. */
export async function version(dir: string): Promise<{ tofu: string; provider: string }> {
  try {
    const v = JSON.parse(await Bun.$`tofu version -json`.cwd(dir).quiet().text()) as {
      terraform_version?: string;
      provider_selections?: Record<string, string>;
    };
    const prov = Object.entries(v.provider_selections ?? {}).find(([k]) => k.endsWith("supabase/supabase"))?.[1];
    return { tofu: v.terraform_version ?? "unknown", provider: prov ?? "unknown" };
  } catch {
    return { tofu: "absent", provider: "unknown" };
  }
}
