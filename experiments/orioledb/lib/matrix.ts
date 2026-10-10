/**
 * Shared driver for OR02: every (target, size, case) gets OR_REPS fresh
 * fixtures, one measured statement each, and one TestResult carrying the
 * median and range of every measured key plus the per-rep raw values.
 *
 * The SQL is imported from experiments/redundant-writes/lib/cases.ts so the
 * statements cannot drift from the local re-run they are compared against.
 */
import type { Ctx, TestResult } from "../../../harness/src/types";
import { UPDATE_CASES, UPSERT_CASES, type Case } from "../../redundant-writes/lib/cases";
import { mgmt } from "../../../harness/src/mgmt";
import { ensurePair, withConn } from "./pair";
import { buildFixture, hasFunction, measure, summarise, type Measured, type Target } from "./rig";

export const ALL_CASES: Case[] = [...UPSERT_CASES, ...UPDATE_CASES];

/** The 1,000,000-row size runs only these (time); every case runs at the smaller size. */
export const BIG_CASES = new Set([
  "upsert_plain_identical",
  "upsert_guarded_identical",
  "update_plain_identical",
  "update_guarded_identical",
]);

export const reps = (): number => {
  const n = Number(process.env.OR_REPS ?? "3");
  return Number.isFinite(n) && n > 0 ? n : 3;
};

export const sizes = (): number[] =>
  (process.env.OR_SIZES ?? "100000,1000000")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

export const bigThreshold = (): number => Number(process.env.OR_BIG_FROM ?? "1000000");

/** The three project x access-method combinations. A heap project cannot hold an OrioleDB table (OR05). */
export async function targets(ctx: Ctx): Promise<Target[]> {
  const p = await ensurePair(ctx);
  const only = (process.env.OR_TARGETS ?? "oriole_oriole,oriole_heap,heap_heap").split(",").map((s) => s.trim());
  const all: Target[] = [
    { key: "oriole_oriole", proj: p.oriole, am: "orioledb", label: "OrioleDB project, USING orioledb table" },
    { key: "oriole_heap", proj: p.oriole, am: "heap", label: "OrioleDB project, USING heap table" },
    { key: "heap_heap", proj: p.heap, am: "heap", label: "heap control project, heap table" },
  ];
  return all.filter((t) => only.includes(t.key));
}

/** Filesystem usage from `GET /config/disk/util` (bytes), or -1 when unreadable. */
export async function diskUsed(ctx: Ctx, ref: string): Promise<{ used: number; avail: number }> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/disk/util`);
  const m = ((r.json ?? {}) as { metrics?: { fs_used_bytes?: number; fs_avail_bytes?: number } }).metrics;
  return { used: m?.fs_used_bytes ?? -1, avail: m?.fs_avail_bytes ?? -1 };
}

export async function runMatrix(ctx: Ctx, id: string, title: string, cases: Case[]): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const t of await targets(ctx)) {
    for (const n of sizes()) {
      for (const cs of cases) {
        if (n >= bigThreshold() && !BIG_CASES.has(cs.key)) continue;
        const rid = `${id}-${t.key}-${n}-${cs.key}`;
        let hasFn = true;
        if (cs.needsFunction) {
          try {
            hasFn = await withConn(t.proj, (c) => hasFunction(c, cs.needsFunction!));
          } catch (e) {
            out.push({ id: rid, title, status: "fail", detail: `error: ${(e as Error).message.slice(0, 300)}` });
            continue;
          }
        }
        if (cs.needsFunction && !hasFn) {
          out.push({ id: rid, title, status: "skip", detail: `${cs.needsFunction} not present on ${t.key}` });
          continue;
        }
        const runs: Measured[] = [];
        const disk: Array<{ used: number; avail: number }> = [];
        let av = { autovacuumOff: true, error: "" };
        try {
          for (let i = 0; i < reps(); i++) {
            av = await buildFixture(t, n, cs.variant);
            const m = await measure(t, cs.stmt, cs.pre ?? []);
            runs.push(m);
            disk.push(await diskUsed(ctx, t.proj.ref));
            ctx.log(
              `${rid} rep ${i + 1}: versions=${m.row_versions} wal=${m.wal_bytes} fpi=${m.wal_fpi} dead=${m.stats_n_dead_tup} ms=${m.exec_ms}`,
            );
          }
        } catch (e) {
          const d = await diskUsed(ctx, t.proj.ref).catch(() => ({ used: -1, avail: -1 }));
          out.push({
            id: rid,
            title,
            status: "fail",
            detail: `error after ${runs.length} completed rep(s): ${(e as Error).message.slice(0, 300)}`,
            measurements: { target: t.key, rows: n, case: cs.key, completed_reps: runs.length, disk_used_bytes_at_failure: d.used, disk_avail_bytes_at_failure: d.avail },
            evidence: JSON.stringify({ stmt: cs.stmt, completed_runs: runs, disk_after_each_rep: disk }, null, 1),
          });
          continue;
        }
        const s = summarise(runs);
        const rowsOk = runs.every((r) => r.rows_after === n);
        out.push({
          id: rid,
          title,
          status: rowsOk ? "pass" : "info",
          detail:
            `${t.label}, ${n} rows, ${cs.variant}; ${runs.length} reps; no CHECKPOINT available` +
            (rowsOk ? "" : "; ROW COUNT CHANGED") +
            (av.autovacuumOff ? "" : `; autovacuum_enabled reloption refused: ${av.error}`),
          measurements: {
            target: t.key,
            rows: n,
            case: cs.key,
            autovacuum_reloption_accepted: av.autovacuumOff ? 1 : 0,
            disk_used_bytes_after_last_rep: disk.at(-1)?.used ?? -1,
            disk_avail_bytes_after_last_rep: disk.at(-1)?.avail ?? -1,
            ...s,
          },
          evidence: JSON.stringify({ stmt: cs.stmt, pre: cs.pre ?? [], runs, disk_after_each_rep: disk }, null, 1),
        });
      }
    }
  }
  return out;
}
