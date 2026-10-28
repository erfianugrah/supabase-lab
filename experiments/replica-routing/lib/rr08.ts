/**
 * Pure helpers for RR08 (hot-standby conflicts against Data API reads).
 *
 * A read is `GET /rest/v1/rpc/rr8_list?p_ms=N`: a stable function that scans
 * ranges of `rr8_items` for N ms and returns which node ran it. A failed read
 * is classified by the PostgREST error body's SQLSTATE: 40001 is a recovery
 * conflict cancel (only a standby raises it), 57014 a statement timeout.
 */
import { pct, round } from "./rr";

export interface VacuumTuples {
  removed: number;
  remain: number;
  notRemovable: number;
  cutoffAgeXids?: number;
}

/** The `tuples:` (and `removable cutoff:`) lines of a VACUUM VERBOSE report (PG15+ wording). */
export function parseVacuumVerbose(text: string): VacuumTuples | null {
  const m = /tuples: (\d+) removed, (\d+) remain, (\d+) are dead but not yet removable/.exec(text);
  if (!m) return null;
  const c = /removable cutoff: \d+, which was (\d+) XIDs old/.exec(text);
  return {
    removed: Number(m[1]),
    remain: Number(m[2]),
    notRemovable: Number(m[3]),
    ...(c ? { cutoffAgeXids: Number(c[1]) } : {}),
  };
}

export interface ReadClass {
  kind: "ok" | "40001" | "57014" | "other";
  node?: "primary" | "replica";
  serverMs?: number;
  staleMs?: number;
  text?: string;
}

/** HTTP status + body of `rpc/rr8_list` -> served (and by which node) or how it failed. */
export function classifyRead(status: number, body: string, fetchErr?: string): ReadClass {
  if (status === 0) return { kind: "other", text: `fetch ${fetchErr ?? "failed"}`.slice(0, 120) };
  let j: Record<string, unknown> | undefined;
  try {
    j = JSON.parse(body) as Record<string, unknown>;
  } catch {
    j = undefined;
  }
  if (status === 200 && j && typeof j.in_recovery === "boolean") {
    return {
      kind: "ok",
      node: j.in_recovery ? "replica" : "primary",
      ...(typeof j.ms === "number" ? { serverMs: j.ms } : {}),
      ...(typeof j.stale_ms === "number" ? { staleMs: j.stale_ms } : {}),
    };
  }
  const code = j ? String(j.code ?? "") : "";
  if (code === "40001" || code === "57014") {
    const text = [j?.message, j?.details].filter((x) => typeof x === "string" && x).join(" / ");
    return { kind: code, text };
  }
  const t = j ? [code, j.message, j.details].filter((x) => typeof x === "string" && x).join(" ") : body;
  return { kind: "other", text: `HTTP ${status} ${t.replace(/\s+/g, " ").trim()}`.trim().slice(0, 120) };
}

/** Contiguous runs of points whose staleMs exceeds the threshold. */
export function staleEpisodes(points: { t: number; staleMs: number }[], thresholdMs: number): { startT: number; endT: number; maxStaleMs: number }[] {
  const out: { startT: number; endT: number; maxStaleMs: number }[] = [];
  let cur: { startT: number; endT: number; maxStaleMs: number } | null = null;
  for (const p of points) {
    if (p.staleMs > thresholdMs) {
      if (!cur) cur = { startT: p.t, endT: p.t, maxStaleMs: p.staleMs };
      else {
        cur.endT = p.t;
        cur.maxStaleMs = Math.max(cur.maxStaleMs, p.staleMs);
      }
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function statsOf(xs: number[], d = 1): { n: number; p50: number | "none"; p95: number | "none"; max: number | "none" } {
  if (!xs.length) return { n: 0, p50: "none", p95: "none", max: "none" };
  return { n: xs.length, p50: round(pct(xs, 50), d), p95: round(pct(xs, 95), d), max: round(Math.max(...xs), d) };
}

/** `a x2, b x1`, most frequent first. */
export function tallyBy(keys: string[]): string {
  const t: Record<string, number> = {};
  for (const k of keys) t[k] = (t[k] ?? 0) + 1;
  const e = Object.entries(t).sort((a, b) => b[1] - a[1]);
  return e.length ? e.map(([k, n]) => `${k} x${n}`).join(", ") : "none";
}
