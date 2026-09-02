/**
 * `pvlab --facts run.json [--only EF04,EF05]` - render a run artifact's
 * measurements as markdown tables, one per result id, so prose quotes a number
 * by pasting it rather than recalling it.
 *
 * Why this exists: every wrong figure a reviewer caught in the 2026-09-02
 * write-ups (12,022 for a sent length recorded as 12,019; "1,800 chains per
 * second" for what the artifact records as nested calls; a 15 s pass band
 * quoted as a measurement) was a number retyped from memory of the run. The
 * artifact had the right value every time. This renders it.
 *
 * Offline by construction, like --diff: dispatched before buildCtx, needs no
 * credential, touches no network. Pure so it is unit-testable on a fixture.
 */
import type { RunArtifact, TestResult } from "./types";

export interface FactsOptions {
  /** Result ids to include (case-insensitive prefix match: "EF05" matches EF05a). Empty = all. */
  only?: string[];
  /** Include `detail` under each table. Default true. */
  detail?: boolean;
}

function wanted(id: string, only?: string[]): boolean {
  if (!only?.length) return true;
  const lower = id.toLowerCase();
  return only.some((o) => lower === o.toLowerCase() || lower.startsWith(o.toLowerCase()));
}

/** Markdown-escape a cell: pipes and newlines would break the table. */
function cell(v: unknown): string {
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function renderFacts(run: RunArtifact, opts: FactsOptions = {}): string {
  const out: string[] = [];
  const stamp = run.startedAt.slice(0, 19).replace("T", " ");
  out.push(`# Facts from ${run.experiment ?? "run"} - ${stamp} UTC`);
  out.push("");
  out.push(
    `Source artifact: run started ${run.startedAt}, finished ${run.finishedAt}, vantage ${run.where}, region ${run.region}` +
      (run.labCommit ? `, lab commit ${run.labCommit}` : "") +
      ". Project ref omitted on purpose.",
  );
  out.push("");
  const results: TestResult[] = run.results.filter((r) => wanted(r.id, opts.only));
  if (!results.length) {
    out.push("_no results matched_");
    return out.join("\n");
  }
  for (const r of results) {
    out.push(`## ${r.id} - ${r.title} (${r.status})`);
    out.push("");
    const m = r.measurements ?? {};
    const keys = Object.keys(m);
    if (keys.length) {
      out.push("| key | value |");
      out.push("|---|---|");
      for (const k of keys) out.push(`| ${cell(k)} | ${cell(m[k])} |`);
    } else {
      out.push("_no measurements_");
    }
    if (opts.detail !== false && r.detail) {
      out.push("");
      out.push(`detail: ${cell(r.detail)}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

/**
 * Every number a fact table could be quoted from, as a set of canonical
 * strings: integers and decimals as they appear, with thousands separators
 * removed. Used by the evidence check to ask "does this figure exist in the
 * artifact at all", which is the question a reviewer asks by hand.
 */
export function numbersIn(run: RunArtifact, only?: string[]): Set<string> {
  const found = new Set<string>();
  const add = (v: unknown) => {
    for (const tok of String(v).matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) found.add(tok[0].replace(/,/g, ""));
  };
  for (const r of run.results) {
    if (!wanted(r.id, only)) continue;
    add(r.detail ?? "");
    for (const v of Object.values(r.measurements ?? {})) add(v);
    add(r.evidence ?? "");
  }
  return found;
}
