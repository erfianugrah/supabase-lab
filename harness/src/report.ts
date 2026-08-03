/**
 * Generic renderer: walks results and their `measurements`, so a new test
 * appears in the report without any renderer change.
 */
import type { RunArtifact, TestResult } from "./types";

const STATUS_ORDER = ["fail", "pass", "info", "skip"] as const;

function measurementKeys(results: TestResult[]): string[] {
  const keys: string[] = [];
  for (const r of results) {
    for (const k of Object.keys(r.measurements ?? {})) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  return keys;
}

function escapePipes(v: unknown): string {
  return String(v ?? "").replace(/\|/g, "\\|");
}

export function renderMarkdown(a: RunArtifact): string {
  const out: string[] = [];
  const counts = STATUS_ORDER.map(
    (s) => [s, a.results.filter((r) => r.status === s).length] as const,
  ).filter(([, n]) => n > 0);

  out.push(`# ${a.experiment ? `${a.experiment} run` : "supabase-lab run"} - ${a.startedAt}`);
  out.push("");
  out.push(
    `Project \`${a.ref}\` | region ${a.region} | vantage ${a.where}` +
      (a.labCommit ? ` | lab \`${a.labCommit}\`` : ""),
  );
  out.push("");
  out.push(counts.map(([s, n]) => `**${n} ${s}**`).join(" | "));
  out.push("");

  out.push("## Results");
  out.push("");
  out.push("| Test | Status | Detail |");
  out.push("|---|---|---|");
  for (const s of STATUS_ORDER) {
    for (const r of a.results.filter((x) => x.status === s)) {
      out.push(
        `| ${r.id} ${escapePipes(r.title)} | ${r.status} | ${escapePipes(r.detail)} |`,
      );
    }
  }
  out.push("");

  const measured = a.results.filter((r) => r.measurements && Object.keys(r.measurements).length);
  if (measured.length) {
    const keys = measurementKeys(measured);
    out.push("## Measurements");
    out.push("");
    out.push(`| Test | ${keys.join(" | ")} |`);
    out.push(`|---|${keys.map(() => "---").join("|")}|`);
    for (const r of measured) {
      const row = keys.map((k) => escapePipes(r.measurements?.[k] ?? ""));
      out.push(`| ${r.id} | ${row.join(" | ")} |`);
    }
    out.push("");
  }

  const withEvidence = a.results.filter((r) => r.evidence);
  if (withEvidence.length) {
    out.push("## Evidence");
    out.push("");
    for (const r of withEvidence) {
      out.push(`### ${r.id} ${r.title}`);
      out.push("");
      out.push("```");
      out.push(r.evidence!.trim());
      out.push("```");
      out.push("");
    }
  }

  out.push("## Provenance");
  out.push("");
  out.push(`- started: ${a.startedAt}, finished: ${a.finishedAt}`);
  for (const [k, v] of Object.entries(a.toolVersions)) out.push(`- ${k}: ${v}`);
  out.push("");
  return out.join("\n");
}
