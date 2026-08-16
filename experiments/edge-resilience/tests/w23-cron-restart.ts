/**
 * W23 - pg_cron across a restart
 *
 * Measures whether a cron job continues to run/resound correctly across
 * a project restart.
 *
 * Steps:
 * 1. SQL: Create table `public.w23_hb(ts timestamptz default now())`.
 *    Ensure `pg_cron` extension is installed.
 *    Schedule `cron.schedule('w23-hb', '* * * * *', $$insert into public.w23_hb default values$$)`.
 * 2. Wait for 2 heartbeat rows (150s budget, poll every 10s).
 * 3. Restart the project: `POST /projects/{ref}/restart` via mgmt.
 *    Record restart start; poll the REST API (probe table) until HTTP 200
 *    (120s budget) - record the outage seconds.
 * 4. Wait 4 minutes post-restart, then count `w23_hb` rows once.
 * 5. Record: rows before, outage window, rows after, and diff (skip/double
 *    inference is left to the reader).
 *
 * Pass criteria: heartbeat gaps + outage window recorded verbatim. Any
 * measured behavior passes.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W23",
  title: "pg_cron across a restart",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const ref = ctx.ref;
    const dbPw = ctx.dbPassword;
    const measurements: Record<string, string | number> = {};

    if (!dbPw) {
      return {
        id: "W23",
        title: this.title,
        status: "skip",
        detail: "missing dbPassword",
      };
    }

    const runSql = async (query: string) => {
      const res = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
      if (res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 400)}`);
      return res;
    };

    const cleanup = async () => {
      await runSql(`cron.unschedule('w23-hb')`).catch(() => {});
      await runSql(`DROP TABLE IF EXISTS public.w23_hb`).catch(() => {});
    };

    try {
      // 1. Setup
      await runSql(`DROP TABLE IF EXISTS public.w23_hb`);
      await runSql(`CREATE EXTENSION IF NOT EXISTS pg_cron`);
      await runSql(`CREATE TABLE public.w23_hb(ts timestamptz default now())`);
      await runSql(`SELECT cron.schedule('w23-hb', '* * * * *', $$insert into public.w23_hb default values$$)`);

      // 2. Wait for 2 rows
      const hbStart = Date.now();
      let rowsBefore = 0;
      while (Date.now() - hbStart < 150_000) {
        const res = await runSql(`SELECT count(*) FROM public.w23_hb`);
        const count = (res.json as any[])?.[0]?.count || 0;
        if (Number(count) >= 2) {
          rowsBefore = Number(count);
          break;
        }
        await new Promise((r) => setTimeout(r, 10000));
      }
      if (rowsBefore === 0) throw new Error("Failed to seed heartbeat rows before restart");
      measurements["rows_before"] = rowsBefore;

      // 3. Restart
      const restartStart = Date.now();
      await mgmt(ctx, "POST", `/projects/${ref}/restart`);

      // Poll probe table until 200
      const probeStart = Date.now();
      const probeUrl = `https://${ctx.apiHost}/rest/v1/w_probe?select=id`;
      const probeHeaders = { apikey: ctx.anonKey!, Authorization: `Bearer ${ctx.anonKey!}` };

      let probeOk = false;
      while (Date.now() - probeStart < 120_000) {
        try {
          const res = await fetch(probeUrl, { headers: probeHeaders, signal: AbortSignal.timeout(10000) });
          if (res.ok) {
            probeOk = true;
            break;
          }
        } catch {
          // ignore network errors during outage
        }
        await new Promise((r) => setTimeout(r, 5000));
      }

      if (!probeOk) throw new Error("Project failed to come back online within timeout");
      measurements["outage_duration_ms"] = Date.now() - restartStart;

      // 4. Post-restart polling
      const postRestartStart = Date.now();
      while (Date.now() - postRestartStart < 240_000) {
        await new Promise((r) => setTimeout(r, 30000));
      }

      const resFinal = await runSql(`SELECT count(*) FROM public.w23_hb`);
      const rowsAfter = Number((resFinal.json as any[])?.[0]?.count || 0);
      measurements["rows_after"] = rowsAfter;

      const diff = rowsAfter - rowsBefore;
      measurements["rows_diff"] = diff;

      return {
        id: "W23",
        title: this.title,
        status: "pass",
        detail: `rows_before=${rowsBefore}, rows_after=${rowsAfter}, diff=${diff}`,
        measurements,
      };
    } catch (e: any) {
      return {
        id: "W23",
        title: this.title,
        status: "fail",
        detail: e.message,
        measurements,
      };
    } finally {
      await cleanup();
    }
  },
};

export default mod;
