/**
 * Shared driver for RW02, RW03 and RW05: every (target, size, case) gets RW_REPS
 * fresh fixtures, one measured statement each, and one TestResult carrying the
 * median and range of every measured key plus the per-rep raw values.
 */
import type { Ctx, TestResult } from "../../../harness/src/types";
import type { Case } from "./cases";
import { buildFixture, hasFunction, measure, type Measured, reps, rigUp, sizes, summarise, targets, withConn } from "./rig";

export async function runMatrix(
  ctx: Ctx,
  id: string,
  title: string,
  cases: Case[],
  opts: { checkpointBefore?: boolean } = {},
): Promise<TestResult[]> {
  const checkpointBefore = opts.checkpointBefore ?? true;
  const out: TestResult[] = [];
  for (const t of targets()) {
    if (!(await rigUp(t))) {
      out.push({ id: `${id}-${t.role}`, title, status: "skip", detail: `${t.role} not answering on 127.0.0.1:${t.port} (run \`make local-up\`)` });
      continue;
    }
    for (const n of sizes()) {
      for (const cs of cases) {
        const rid = `${id}-${t.role}-${n}-${cs.key}`;
        if (cs.needsFunction && !(await withConn(t, (c) => hasFunction(c, cs.needsFunction!)))) {
          out.push({ id: rid, title, status: "skip", detail: `${cs.needsFunction} not present on ${t.role}` });
          continue;
        }
        const runs: Measured[] = [];
        try {
          for (let i = 0; i < reps(); i++) {
            if (!checkpointBefore) await withConn(t, (c) => c.query("checkpoint"));
            await buildFixture(t, n, cs.variant);
            const m = await measure(t, cs.stmt, cs.pre ?? [], checkpointBefore);
            runs.push(m);
            ctx.log(
              `${rid} rep ${i + 1}: versions=${m.row_versions} xmax_stmt=${m.rows_xmax_stmt} wal=${m.wal_bytes} fpi=${m.wal_fpi} dead=${m.stats_n_dead_tup} ms=${m.exec_ms}`,
            );
          }
        } catch (e) {
          out.push({ id: rid, title, status: "fail", detail: `error: ${(e as Error).message}` });
          continue;
        }
        const s = summarise(runs);
        // Cross-checks: rows survive, and the stats counter agrees with the
        // xmin count once flushed. A disagreement is recorded, not hidden.
        const rowsOk = runs.every((r) => r.rows_after === n);
        const statsOk = runs.every((r) => r.stats_n_tup_upd === r.row_versions);
        out.push({
          id: rid,
          title,
          status: rowsOk && statsOk ? "pass" : "info",
          detail:
            `${t.image}, ${n} rows, ${cs.variant}; ${runs.length} reps; checkpoint ${checkpointBefore ? "right before the statement" : "before the fixture build"}` +
            (rowsOk ? "" : "; ROW COUNT CHANGED") +
            (statsOk ? "" : "; stats n_tup_upd disagrees with the xmin count on at least one rep"),
          measurements: { target: t.role, rows: n, case: cs.key, ...s },
          evidence: JSON.stringify({ stmt: cs.stmt, pre: cs.pre ?? [], runs }, null, 1),
        });
      }
    }
  }
  return out;
}

export type { Measured };
