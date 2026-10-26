/**
 * UI05 - VACUUM (FREEZE, VERBOSE) after the upgrade.
 *
 * For cron.job_run_details, the pgmq queue and archive tables and the two
 * busy public tables: age(relfrozenxid) and relfrozenxid before, then
 * `VACUUM (FREEZE, VERBOSE) <table>` through the session pooler as
 * `postgres` (VERBOSE output arrives as INFO notices, which the Management
 * API query endpoint does not return), then the same reading after.
 * pass = no error, no "skipping" warning, and relfrozenxid moved forward.
 *
 * DESTRUCTIVE: runs against the shared project after UI03.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { FREEZE_TABLES, ensureProject, errText, frozenAges, poolerClient, redact, skipWithoutPro, sql, state } from "../lib/ui.js";

const mod: TestModule = {
  id: "UI05",
  title: "VACUUM (FREEZE, VERBOSE) on cron and pgmq tables after the upgrade",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "UI05");
    if (skip) return skip;
    if (!state.upgrade) return [{ id: "UI05", title: "UI05", status: "skip", detail: "no UI03 upgrade in this process" }];
    const p = await ensureProject(ctx);
    const out: TestResult[] = [];
    const before = await frozenAges(ctx, p.ref);
    let conn;
    let path = "session pooler";
    const results: Record<string, { ms: number; err: string; notices: string[] }> = {};
    try {
      conn = await poolerClient(ctx, p);
    } catch (e) {
      // Fallback: the Management API query endpoint (no VERBOSE output comes back).
      path = `Management API (pooler failed: ${redact(errText(e))})`;
      for (const t of FREEZE_TABLES) {
        const t0 = Date.now();
        const r = await sql(ctx, p.ref, `vacuum (freeze, verbose) ${t}`, 300_000);
        results[t] = { ms: Date.now() - t0, err: r.error ?? "", notices: [] };
      }
    }
    if (conn) try {
      const who = await conn.client.query("select current_user as u, current_setting('server_version') as v");
      ctx.log(`UI05: vacuum as ${String(who.rows[0]?.u)} on ${String(who.rows[0]?.v)}`);
      for (const t of FREEZE_TABLES) {
        conn.notices.length = 0;
        const t0 = Date.now();
        let err = "";
        try {
          await conn.client.query(`vacuum (freeze, verbose) ${t}`);
        } catch (e) {
          err = errText(e);
        }
        results[t] = { ms: Date.now() - t0, err, notices: [...conn.notices] };
      }
    } finally {
      await conn.client.end().catch(() => {});
    }
    const after = await frozenAges(ctx, p.ref);
    for (const t of FREEZE_TABLES) {
      const b = before.rows.find((r) => r.rel === t);
      const a = after.rows.find((r) => r.rel === t);
      const r = results[t]!;
      const skipped = r.notices.some((n) => /skipping|permission denied/i.test(n));
      const advanced = Boolean(b && a && a.relfrozenxid !== b.relfrozenxid && a.xid_age <= b.xid_age);
      // The VERBOSE lines worth quoting: the header and the relfrozenxid/relminmxid lines.
      const key = r.notices.filter((n) => /vacuuming|aggressiv|relfrozenxid|relminmxid|tuples:|pages:|skipping|WARNING/i.test(n));
      out.push({
        id: `UI05-${t}`,
        title: `UI05: VACUUM (FREEZE, VERBOSE) ${t}`,
        status: !r.err && !skipped && advanced ? "pass" : "fail",
        detail: `${r.err ? `error: ${r.err}; ` : ""}${skipped ? "skipped (warning); " : ""}age ${b?.xid_age ?? "?"} -> ${a?.xid_age ?? "?"}, relfrozenxid ${b?.relfrozenxid ?? "?"} -> ${a?.relfrozenxid ?? "?"}, mxid_age ${b?.mxid_age ?? "?"} -> ${a?.mxid_age ?? "?"}; ${r.ms} ms via ${path}; ${r.notices.length} notices; owner ${a?.owner ?? "?"}`,
        measurements: {
          age_before: b?.xid_age ?? -1,
          age_after: a?.xid_age ?? -1,
          relfrozenxid_before: b?.relfrozenxid ?? "?",
          relfrozenxid_after: a?.relfrozenxid ?? "?",
          mxid_age_before: b?.mxid_age ?? -1,
          mxid_age_after: a?.mxid_age ?? -1,
          vacuum_ms: r.ms,
          owner: a?.owner ?? "?",
        },
        evidence: redact((key.length ? key : r.notices).join("\n").slice(0, 4000)),
      });
    }
    return out;
  },
};
export default mod;
