/**
 * Pure scheduling logic: which tests run, in what order, and which are skipped
 * with what reason. Kept free of I/O so it is unit-testable without infra.
 */
import type { Capability, TestModule, TestResult, Where } from "./types";

export interface PlanOptions {
  where: Where;
  capabilities: Set<Capability>;
  /** Only these ids (case-insensitive). Empty = all. */
  only?: string[];
  /** Only modules from this experiment dir. Empty = all experiments. */
  experiment?: string;
  /** Destructive tests are excluded unless this is true. */
  allowDestructive?: boolean;
}

export interface Plan {
  /** In execution order: read-only first, destructive last. */
  run: TestModule[];
  /** Pre-computed skip results, emitted as-is into the artifact. */
  skipped: TestResult[];
}

function missingCapabilities(m: TestModule, have: Set<Capability>): Capability[] {
  return (m.requires ?? []).filter((c) => !have.has(c));
}

export function planRun(modules: TestModule[], opts: PlanOptions): Plan {
  const only = opts.only?.map((s) => s.toLowerCase());
  const run: TestModule[] = [];
  const skipped: TestResult[] = [];

  for (const m of modules) {
    const skip = (detail: string) =>
      skipped.push({ id: m.id, title: m.title, status: "skip", detail });

    if (only?.length && !only.includes(m.id.toLowerCase())) continue;

    if (opts.experiment && m.experiment !== opts.experiment) continue;

    if (m.where !== opts.where) {
      skip(`runs on "${m.where}", this process is "${opts.where}"`);
      continue;
    }

    const missing = missingCapabilities(m, opts.capabilities);
    if (missing.length) {
      skip(`missing capability: ${missing.join(", ")}`);
      continue;
    }

    if (m.destructive && !opts.allowDestructive) {
      skip("destructive; re-run with --destructive to include");
      continue;
    }

    run.push(m);
  }

  // Read-only first so a destructive test cannot rob the battery of results.
  run.sort((a, b) => {
    const d = Number(a.destructive ?? false) - Number(b.destructive ?? false);
    return d !== 0 ? d : a.id.localeCompare(b.id, "en");
  });

  skipped.sort((a, b) => a.id.localeCompare(b.id, "en"));
  return { run, skipped };
}
