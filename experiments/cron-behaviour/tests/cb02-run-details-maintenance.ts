/**
 * CB02 - keeping cron.job_run_details small, as `postgres`.
 *
 *   CB02a  owner of cron.job_run_details, postgres's DELETE privilege on it,
 *          a direct `delete ... where end_time < now() - interval '20 seconds'`
 *          through the Management API (rows removed or the error)
 *   CB02b  the same delete scheduled as a pg_cron job ('15 seconds') next to a
 *          filler job ('5 seconds'), sparing its own rows so each run stays
 *          readable: its runs' status and return_message, filler rows left
 *   CB02c  cron.log_run: SHOW, pg_settings context, and whether `postgres` can
 *          change it (SET in a session; ALTER ROLE postgres SET, reset at once)
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, runs, schedule, scrub, skipWithout, sleep, sql, sqlOk, tally, unschedule } from "../lib/cb.js";

const mod: TestModule = {
  id: "CB02",
  title: "cron.job_run_details maintenance as postgres, and cron.log_run",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 30 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "CB02", this.title);
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      // Make sure there is history to delete: a filler job running every 5 s.
      const fill = await schedule(ctx, p.ref, "cb02-fill", "5 seconds", "select 1");
      await sleep(40_000);

      const own = await sqlOk(
        ctx,
        p.ref,
        `select pg_get_userbyid(c.relowner) as owner,
           has_table_privilege('postgres', 'cron.job_run_details', 'DELETE') as can_delete,
           (select count(*)::int from cron.job_run_details) as rows_before
         from pg_class c where c.oid = 'cron.job_run_details'::regclass`,
      );
      const del = await sql(ctx, p.ref, "with d as (delete from cron.job_run_details where end_time < now() - interval '20 seconds' returning 1) select count(*)::int as removed from d");
      const after = await sqlOk(ctx, p.ref, "select count(*)::int as n from cron.job_run_details");
      out.push({
        id: "CB02a",
        title: "direct delete from cron.job_run_details as postgres (Management API)",
        status: "info",
        detail: `owner ${String(own[0]?.owner)}; postgres DELETE privilege ${String(own[0]?.can_delete)}; rows before ${String(own[0]?.rows_before)}; delete older than 20 s -> ${del.error ? `ERROR ${del.error}` : `${String(del.rows[0]?.removed)} removed`}; rows after ${String(after[0]?.n)}`,
        measurements: {
          owner: String(own[0]?.owner),
          postgres_can_delete: String(own[0]?.can_delete),
          rows_before: Number(own[0]?.rows_before ?? -1),
          removed: del.error ? `ERROR ${del.error}`.slice(0, 160) : Number(del.rows[0]?.removed ?? -1),
          rows_after: Number(after[0]?.n ?? -1),
        },
      });

      const purge = await schedule(ctx, p.ref, "cb02-purge", "15 seconds", "delete from cron.job_run_details where end_time < now() - interval '10 seconds' and jobid <> (select jobid from cron.job where jobname = 'cb02-purge')");
      await sleep(65_000);
      await unschedule(ctx, p.ref, "cb02-purge");
      await unschedule(ctx, p.ref, "cb02-fill");
      await sleep(5_000);
      const pr = await runs(ctx, p.ref, purge.jobid);
      const fr = await runs(ctx, p.ref, fill.jobid);
      out.push({
        id: "CB02b",
        title: "the same delete as a pg_cron job",
        status: "info",
        detail: `purge schedule '${purge.schedule}', ${pr.length} runs recorded: ${tally(pr.map((r) => `${r.status} "${r.msg}"`))}; filler '${fill.schedule}' rows left ${fr.length}`,
        measurements: {
          purge_schedule: purge.schedule,
          purge_runs: pr.length,
          purge_status: tally(pr.map((r) => r.status)),
          purge_messages: tally(pr.map((r) => r.msg)).slice(0, 200),
          filler_rows_left: fr.length,
        },
      });

      const show = await sql(ctx, p.ref, "show cron.log_run");
      const ctxRow = await sqlOk(ctx, p.ref, "select setting, context from pg_settings where name = 'cron.log_run'");
      const setSess = await sql(ctx, p.ref, "set cron.log_run = off; select current_setting('cron.log_run') as v");
      const alterRole = await sql(ctx, p.ref, "alter role postgres set cron.log_run = off");
      if (!alterRole.error) await sql(ctx, p.ref, "alter role postgres reset cron.log_run");
      const alterSys = await sql(ctx, p.ref, "alter system set cron.log_run = off");
      if (!alterSys.error) await sql(ctx, p.ref, "alter system reset cron.log_run");
      const res = (r: { error: string; rows: Record<string, unknown>[] }) => (r.error ? `ERROR ${r.error}` : `ok${r.rows[0]?.v !== undefined ? ` (${String(r.rows[0]?.v)})` : ""}`).slice(0, 180);
      out.push({
        id: "CB02c",
        title: "cron.log_run: value, context, settable by postgres?",
        status: "info",
        detail: `show ${show.error ? `ERROR ${show.error}` : String(show.rows[0]?.cron_log_run ?? JSON.stringify(show.rows[0]))}; context ${String(ctxRow[0]?.context)}; SET in session: ${res(setSess)}; ALTER ROLE postgres SET: ${res(alterRole)}; ALTER SYSTEM: ${res(alterSys)}`,
        measurements: {
          log_run: String(ctxRow[0]?.setting),
          context: String(ctxRow[0]?.context),
          set_session: res(setSess),
          alter_role: res(alterRole),
          alter_system: res(alterSys),
        },
      });
    } catch (e) {
      out.push({ id: "CB02", title: this.title, status: "fail", detail: scrub(errText(e)) });
    }
    return out;
  },
};
export default mod;
