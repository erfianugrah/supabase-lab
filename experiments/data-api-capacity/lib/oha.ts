/**
 * `oha` with a per-request record, for modules that need what happened WHEN
 * (DC18's latency over time, DC19's fast answers inside a burst) rather than
 * DC04's whole-step summary.
 *
 * `--db-url` writes one sqlite row per request that got an HTTP answer (any
 * status: a local 404 run on 2026-10-27 wrote all 20); requests that ended in
 * a client-side error (timeout, connect failure) are not rows and appear only
 * in the summary's errorDistribution. `start` and `end` are seconds from the
 * run's start.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface OhaRow {
  start: number;
  end: number;
  duration: number;
  status: number;
}

export interface OhaRun {
  /** Wall-clock ms when oha was spawned; row times are relative to about this. */
  t0: number;
  rps: number;
  successRate: number;
  statuses: string;
  /** Client-side errors by message (timeouts, connect failures): requests with no row. */
  errors: Record<string, number>;
  rows: OhaRow[];
  /** Set when the summary could not be parsed. */
  raw: string;
}

const fmt = (o?: Record<string, number>) =>
  Object.entries(o ?? {})
    .sort()
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");

/** Run oha with `args` (everything but the output flags and the URL) against `url`. */
export function runOhaRecorded(url: string, args: string[], headers: Record<string, string>): Promise<OhaRun> {
  const dir = mkdtempSync(join(tmpdir(), "pvlab-oha-"));
  const db = join(dir, "run.db");
  const all = [...args, "--no-tui", "--output-format", "json", "--db-url", db];
  for (const [k, v] of Object.entries(headers)) all.push("-H", `${k}: ${v}`);
  all.push(url);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn("oha", all, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("close", () => {
      let rows: OhaRow[] = [];
      const q = spawnSync("sqlite3", ["-json", db, "select start, end, duration, status from oha order by start"], { maxBuffer: 512 * 1024 * 1024 });
      try {
        const txt = q.stdout.toString().trim();
        rows = txt ? (JSON.parse(txt) as OhaRow[]) : [];
      } catch {
        rows = [];
      }
      rmSync(dir, { recursive: true, force: true });
      try {
        const j = JSON.parse(out) as {
          summary: { requestsPerSec: number; successRate: number };
          statusCodeDistribution?: Record<string, number>;
          errorDistribution?: Record<string, number>;
        };
        resolve({
          t0,
          rps: Math.round(j.summary.requestsPerSec),
          successRate: Math.round(j.summary.successRate * 1000) / 1000,
          statuses: fmt(j.statusCodeDistribution) || "none",
          errors: j.errorDistribution ?? {},
          rows,
          raw: "",
        });
      } catch {
        resolve({ t0, rps: -1, successRate: 0, statuses: "none", errors: {}, rows, raw: (err || out).slice(0, 300) });
      }
    });
  });
}

export const errorsText = (e: Record<string, number>) => fmt(e).slice(0, 300) || "none";

export const pct = (xs: number[], p: number): number => {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
