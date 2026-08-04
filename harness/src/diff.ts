/**
 * Compare two run artifacts at the measurement level.
 *
 * platform-facts was built to be re-run and diffed, but the Makefile's advice
 * was to diff two rendered reports - and those carry timestamps, a lab commit,
 * tool versions and per-test durations, so every re-run diffs dirty and the one
 * entitlement that moved is invisible. The unit that matters is
 * (test id, measurement key).
 */
import type { RunArtifact, TestResult } from "./types";

export interface MeasurementChange {
  id: string;
  key: string;
  /** null when the key did not exist in the previous run. */
  from: string | number | null;
  /** null when the key has vanished. */
  to: string | number | null;
}

export interface StatusChange {
  id: string;
  from: TestResult["status"];
  to: TestResult["status"];
}

export interface ArtifactDiff {
  added: string[];
  removed: string[];
  changed: MeasurementChange[];
  statusChanged: StatusChange[];
  /** Measurements compared and found identical - the denominator. */
  unchanged: number;
}

function byId(a: RunArtifact): Map<string, TestResult> {
  return new Map(a.results.map((r) => [r.id, r]));
}

/**
 * Only `measurements` is compared. TestResult's own fields - durationMs above
 * all - are run metadata and are never part of a diff.
 */
function measurements(r: TestResult | undefined): Record<string, string | number> {
  return r?.measurements ?? {};
}

export function diffArtifacts(prev: RunArtifact, cur: RunArtifact): ArtifactDiff {
  const a = byId(prev);
  const b = byId(cur);

  const added = [...b.keys()].filter((id) => !a.has(id)).sort();
  const removed = [...a.keys()].filter((id) => !b.has(id)).sort();

  const changed: MeasurementChange[] = [];
  const statusChanged: StatusChange[] = [];
  let unchanged = 0;

  for (const id of [...a.keys()].filter((k) => b.has(k)).sort()) {
    const before = a.get(id)!;
    const after = b.get(id)!;
    if (before.status !== after.status) {
      statusChanged.push({ id, from: before.status, to: after.status });
    }
    const mb = measurements(before);
    const ma = measurements(after);
    for (const key of [...new Set([...Object.keys(mb), ...Object.keys(ma)])].sort()) {
      const from = key in mb ? mb[key]! : null;
      const to = key in ma ? ma[key]! : null;
      if (from === to) unchanged += 1;
      else changed.push({ id, key, from, to });
    }
  }

  return { added, removed, changed, statusChanged, unchanged };
}

export function renderDiffMarkdown(d: ArtifactDiff): string {
  const quiet =
    !d.added.length && !d.removed.length && !d.changed.length && !d.statusChanged.length;
  if (quiet) {
    return `# Platform diff\n\nno change across ${d.unchanged} measurements.\n`;
  }

  const lines = ["# Platform diff", ""];
  if (d.statusChanged.length) {
    lines.push("## Status changes", "", "| id | from | to |", "| --- | --- | --- |");
    for (const s of d.statusChanged) lines.push(`| ${s.id} | ${s.from} | ${s.to} |`);
    lines.push("");
  }
  if (d.changed.length) {
    lines.push(
      "## Changed measurements",
      "",
      "| id | key | before | after |",
      "| --- | --- | --- | --- |",
    );
    for (const c of d.changed) {
      lines.push(`| ${c.id} | ${c.key} | ${c.from ?? "(absent)"} | ${c.to ?? "(absent)"} |`);
    }
    lines.push("");
  }
  if (d.added.length) lines.push(`Added tests: ${d.added.join(", ")}`, "");
  if (d.removed.length) lines.push(`Removed tests: ${d.removed.join(", ")}`, "");
  lines.push(`${d.unchanged} measurement${d.unchanged === 1 ? "" : "s"} unchanged.`);
  return lines.join("\n");
}
