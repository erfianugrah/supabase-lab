/**
 * Shared steps for the AV modules: advisor fetches with throttle backoff, an
 * audit run over a pooler session, and the project state AV01-AV03 share.
 * The project itself comes from data-api-defaults/lib/project.ts (one
 * Pro-org project per process, memoised); the Makefile sets its name prefix
 * to pvlab-av- so `make clean` finds only this experiment's leftovers.
 */
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { pgSession, type DdProject } from "../../data-api-defaults/lib/project.js";
import { fetchAudit, runAudit, type AuditRun } from "./audit.js";
import { lintKey, lintsFrom, type Lint } from "./matrix.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Advisors {
  securityStatus: number;
  performanceStatus: number;
  lints: Lint[];
}

async function getLints(ctx: Ctx, ref: string, kind: "security" | "performance"): Promise<{ status: number; lints: Lint[] }> {
  for (let i = 0; i < 4; i++) {
    const r = await mgmt(ctx, "GET", `/projects/${ref}/advisors/${kind}`, undefined, 60_000);
    if (r.status === 429 || r.throttled) {
      await sleep(15_000 * (i + 1));
      continue;
    }
    return { status: r.status, lints: lintsFrom(r.json) };
  }
  return { status: 429, lints: [] };
}

export async function fetchAdvisors(ctx: Ctx, ref: string): Promise<Advisors> {
  const s = await getLints(ctx, ref, "security");
  const p = await getLints(ctx, ref, "performance");
  return { securityStatus: s.status, performanceStatus: p.status, lints: [...s.lints, ...p.lints] };
}

export const keySet = (a: Advisors): string => a.lints.map(lintKey).sort().join("\n");

export async function auditOnce(p: DdProject): Promise<AuditRun> {
  const text = await fetchAudit();
  const s = await pgSession(p);
  try {
    return await runAudit(s, text);
  } finally {
    await s.close();
  }
}

/** One line per lint, for evidence. */
export const lintLines = (ls: Lint[]): string =>
  ls
    .map((l) => `${l.level} ${l.name}: ${String(l.detail ?? "").replace(/\s+/g, " ").slice(0, 220)}`)
    .sort()
    .join("\n");

export const auditLines = (run: AuditRun): string =>
  run.rows.map((r) => `${r.severity} ${r.check}: ${r.object}`).join("\n");

/** Count rows per key. */
export function tally(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}
