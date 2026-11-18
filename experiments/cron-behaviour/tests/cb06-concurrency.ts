/**
 * CB06 - how many pg_cron jobs run at once on a hosted project, and what a job
 * that cannot start reports.
 *
 * The Supabase pg_cron page recommends no more than 8 concurrent jobs; the lab
 * had only read `cron.max_running_jobs` (32). Two stages, each with every job
 * scheduled for one specific UTC minute (`M H * * *`), so they all fire once on
 * the same boundary and do not fire again while the stage is read; jobs are
 * unscheduled only after every run should have ended:
 *
 *   CB06a  16 jobs, each `select pg_sleep(40)`
 *   CB06b  40 jobs, each `select pg_sleep(30)` - above max_running_jobs, and
 *          near a Micro's max_connections when cron opens a connection per job
 *
 * Per stage: the peak number of backends running the sleep (pg_stat_activity
 * sampled every 2 s through the Management API, which can itself be refused
 * when connections run out), the spread of start_time across the jobs' first
 * runs, and each run's status and return_message from cron.job_run_details.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { cronFacts, ensureProject, errText, schedule, skipWithout, sleep, sql, sqlOk } from "../lib/cb.js";

interface Stage {
  peakRunning: number;
  samples: number;
  sampleErrors: number;
  firstSampleError: string;
  startSpreadS: number;
  statuses: string;
  messages: string;
  maxOverlap: number;
  runsSeen: number;
}

async function runStage(ctx: Ctx, ref: string, tag: string, n: number, sleepS: number): Promise<Stage> {
  const names = Array.from({ length: n }, (_, i) => `cb06-${tag}-${String(i + 1).padStart(2, "0")}`);
  // Fire on the minute after next, so all n jobs are in before it; pg_cron
  // reads schedules in cron.timezone, GMT on hosted (checked in CB06s).
  const fireAt = (Math.floor(Date.now() / 60_000) + 2) * 60_000;
  const at = new Date(fireAt);
  const spec = `${at.getUTCMinutes()} ${at.getUTCHours()} * * *`;
  const ids: number[] = [];
  for (const name of names) ids.push((await schedule(ctx, ref, name, spec, `select pg_sleep(${sleepS})`)).jobid);
  await sleep(Math.max(0, fireAt - Date.now()));

  // Sample the sleepers until they should all have finished.
  let peak = 0;
  let samples = 0;
  let sampleErrors = 0;
  let firstSampleError = "";
  // Long enough for a queued second wave to finish too.
  const until = fireAt + (2 * sleepS + 30) * 1000;
  while (Date.now() < until) {
    const r = await sql(ctx, ref, `select count(*)::int as n from pg_stat_activity where query = 'select pg_sleep(${sleepS})' and state = 'active'`, 15_000);
    samples++;
    if (r.error) {
      sampleErrors++;
      if (!firstSampleError) firstSampleError = r.error.slice(0, 120);
    } else peak = Math.max(peak, Number(r.rows[0]?.n ?? 0));
    await sleep(2_000);
  }

  const rows = await sqlOk(
    ctx,
    ref,
    `select d.jobid, d.status, coalesce(d.return_message, '') as msg,
       (extract(epoch from d.start_time) * 1000)::bigint as s,
       coalesce((extract(epoch from d.end_time) * 1000)::bigint, -1) as e
     from cron.job_run_details d
     where d.jobid in (${ids.join(",")})
       and d.start_time >= to_timestamp(${fireAt / 1000}) - interval '5 seconds'
     order by d.jobid`,
  );
  await sql(ctx, ref, `select cron.unschedule(jobid) from cron.job where jobname like 'cb06-${tag}-%'`);
  const starts = rows.map((r) => Number(r.s)).filter((x) => x > 0);
  const statusCount = new Map<string, number>();
  const msgCount = new Map<string, number>();
  for (const r of rows) {
    statusCount.set(String(r.status), (statusCount.get(String(r.status)) ?? 0) + 1);
    const m = String(r.msg).replace(/\s+/g, " ").slice(0, 60);
    msgCount.set(m, (msgCount.get(m) ?? 0) + 1);
  }
  // Peak overlap from the recorded intervals (succeeded/failed runs only).
  const ev: Array<[number, number]> = [];
  for (const r of rows) if (Number(r.s) > 0 && Number(r.e) > 0) ev.push([Number(r.s), 1], [Number(r.e), -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let maxOverlap = 0;
  for (const [, d] of ev) { cur += d; maxOverlap = Math.max(maxOverlap, cur); }
  return {
    peakRunning: peak,
    samples,
    sampleErrors,
    firstSampleError,
    startSpreadS: starts.length ? Math.round((Math.max(...starts) - Math.min(...starts)) / 100) / 10 : -1,
    statuses: [...statusCount].map(([k, v]) => `${k} x${v}`).join(", ") || "none",
    messages: [...msgCount].map(([k, v]) => `"${k}" x${v}`).join(", ") || "none",
    maxOverlap,
    runsSeen: rows.length,
  };
}

const mod: TestModule = {
  id: "CB06",
  title: "pg_cron concurrency: 16 and 40 jobs scheduled for one minute",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 20 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "CB06", this.title);
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      await sql(ctx, p.ref, "create extension if not exists pg_cron");
      const f = await cronFacts(ctx, p.ref);
      const setting = (n: string) => String(f.settings.find((r) => r.name === n)?.setting ?? "?");
      const mc = await sqlOk(ctx, p.ref, "select current_setting('max_connections') as mc, current_setting('superuser_reserved_connections') as sr, coalesce(current_setting('cron.timezone', true), 'unset') as tz");
      out.push({
        id: "CB06s",
        title: "pg_cron and connection settings",
        status: "info",
        detail: `pg_cron ${f.version}; cron.max_running_jobs ${setting("cron.max_running_jobs")}; cron.use_background_workers ${setting("cron.use_background_workers")}; cron.host ${setting("cron.host")}; cron.timezone ${String(mc[0]?.tz)}; max_connections ${String(mc[0]?.mc)}; superuser_reserved_connections ${String(mc[0]?.sr)}; ${p.pgVersion}`,
        measurements: {
          pg_cron: f.version,
          max_running_jobs: setting("cron.max_running_jobs"),
          use_background_workers: setting("cron.use_background_workers"),
          max_connections: String(mc[0]?.mc),
          superuser_reserved: String(mc[0]?.sr),
        },
      });
      for (const [id, tag, n, s] of [["CB06a", "a", 16, 40], ["CB06b", "b", 40, 30]] as const) {
        const r = await runStage(ctx, p.ref, tag, n, s);
        out.push({
          id,
          title: `${n} jobs of pg_sleep(${s}) scheduled for one minute`,
          status: "info",
          detail: `Peak backends running the sleep: ${r.peakRunning} (${r.samples} samples every 2 s, ${r.sampleErrors} refused${r.firstSampleError ? `, first: ${r.firstSampleError}` : ""}). Runs recorded for that minute: ${r.runsSeen} of ${n}; statuses ${r.statuses}; peak overlap from start/end times ${r.maxOverlap}; first-to-last start spread ${r.startSpreadS} s. Return messages: ${r.messages}.`,
          measurements: {
            jobs: n,
            peak_running_sampled: r.peakRunning,
            samples: r.samples,
            sample_errors: r.sampleErrors,
            runs_recorded: r.runsSeen,
            statuses: r.statuses,
            peak_overlap_recorded: r.maxOverlap,
            start_spread_s: r.startSpreadS,
            return_messages: r.messages.slice(0, 300),
          },
        });
        await sleep(15_000);
      }
    } catch (e) {
      out.push({ id: "CB06x", title: "CB06 aborted", status: "fail", detail: errText(e) });
    } finally {
      const p = await ensureProject(ctx).catch(() => undefined);
      if (p) await sql(ctx, p.ref, "select cron.unschedule(jobid) from cron.job where jobname like 'cb06-%'");
    }
    return out;
  },
};
export default mod;
