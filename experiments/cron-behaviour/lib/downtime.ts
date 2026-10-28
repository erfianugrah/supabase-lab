/**
 * One downtime event observed through pg_cron's own records.
 *
 * Jobs running across the event:
 *   cb-min    '* * * * *'   insert ('min') into cb_tick
 *   cb-10s    '10 seconds'  insert ('10s') into cb_tick
 *   cb-sleep-<kind>  once, at a fixed minute: select pg_sleep(120); the event
 *             is triggered about 15 s after this run is seen `running`.
 * cb_tick stores clock_timestamp() and pg_postmaster_start_time() per row, so
 * each row says which postmaster wrote it. A Management API probe (`select
 * now(), pg_postmaster_start_time()` every 2 s, 8 s timeout) times the outage
 * from this side. After the new postmaster answers, the module watches for
 * OBS_MS more, then reads cb_tick and cron.job_run_details.
 *
 * Catch-up is read two ways: an every-minute run more than LATE_MS after its
 * minute boundary (a missed instant executed late), and more every-minute
 * runs after recovery than minute boundaries passed since the new postmaster
 * started. For the interval job: the shortest gap between consecutive runs
 * after recovery (a burst would show gaps well under 10 s).
 */
import type { Ctx, TestResult } from "../../../harness/src/types.js";
import { type CbProject, hms, r1, runs, schedule, scrub, sleep, sql, sqlOk, tally, unschedule } from "./cb.js";

const OBS_MS = Number(process.env.PVLAB_CB_OBS_S ?? 240) * 1000;
const LATE_MS = 5_000;
const PROBE_Q = "select (extract(epoch from now()) * 1000)::bigint as now_ms, (extract(epoch from pg_postmaster_start_time()) * 1000)::bigint as pm_ms";

export const TICK_SQL = `
create table if not exists public.cb_tick (
  id bigserial primary key, job text not null,
  at timestamptz not null default clock_timestamp(),
  pm timestamptz not null default pg_postmaster_start_time());
alter table public.cb_tick enable row level security;
`;

export interface Trigger {
  /** HTTP status of the operation's request, and its body (first 200 chars). */
  status: number;
  text: string;
  /** Local ms when the accepted request was sent. */
  sentAt: number;
  retries: number;
}

interface Tick {
  job: string;
  at: number;
  pm: number;
}

export async function observeEvent(
  ctx: Ctx,
  p: CbProject,
  id: string,
  kind: string,
  trigger: () => Promise<Trigger>,
  maxRecoverMs: number,
): Promise<TestResult[]> {
  const out: TestResult[] = [];
  await sqlOk(ctx, p.ref, TICK_SQL);
  await schedule(ctx, p.ref, "cb-min", "* * * * *", "insert into public.cb_tick(job) values ('min')");
  const s10 = await schedule(ctx, p.ref, "cb-10s", "10 seconds", "insert into public.cb_tick(job) values ('10s')");
  // Two every-minute ticks before the event, so the "before" side exists.
  for (let i = 0; i < 40; i++) {
    const c = await sqlOk(ctx, p.ref, "select count(*) filter (where job = 'min')::int as m, count(*) filter (where job = '10s')::int as s from public.cb_tick");
    if (Number(c[0]?.m) >= 2 && Number(c[0]?.s) >= 3) break;
    await sleep(5_000);
  }

  // The in-flight job: once, at the next minute at least 25 s away, in cron.timezone.
  const tzRow = await sqlOk(ctx, p.ref, "select coalesce(nullif(current_setting('cron.timezone', true), ''), 'GMT') as tz, extract(second from now())::float8 as s");
  const tz = String(tzRow[0]?.tz ?? "GMT");
  const ahead = Number(tzRow[0]?.s ?? 0) > 35 ? 2 : 1;
  const at = await sqlOk(ctx, p.ref, `select to_char((date_trunc('minute', now()) + interval '${ahead} minute') at time zone '${tz}', 'MI HH24') as mh`);
  const [mi, hh] = String(at[0]?.mh ?? "0 0").split(" ").map(Number);
  const sleepName = `cb-sleep-${kind}`;
  const sj = await schedule(ctx, p.ref, sleepName, `${mi} ${hh} * * *`, "select pg_sleep(120)");
  let sleepRunning = false;
  for (let i = 0; i < 75 && !sleepRunning; i++) {
    const rs = await runs(ctx, p.ref, sj.jobid);
    sleepRunning = rs.some((r) => r.status === "running");
    if (!sleepRunning) await sleep(2_000);
  }
  if (sleepRunning) await sleep(15_000);

  const pre = await sqlOk(ctx, p.ref, PROBE_Q);
  const pm0 = Number(pre[0]?.pm_ms);
  const trg = await trigger();
  const tPost = trg.sentAt;
  console.error(`[${id}] ${kind}: request HTTP ${trg.status} after ${trg.retries} retries; sleep job running=${sleepRunning}`);
  let lastOk = Date.now();
  let firstFail = -1;
  let firstOkNew = -1;
  let pm1 = -1;
  let fails = 0;
  let oks = 0;
  if (trg.status < 300) {
    while (Date.now() - tPost < maxRecoverMs) {
      const t = Date.now();
      const r = await sql(ctx, p.ref, PROBE_Q, 8_000);
      const pm = Number(r.rows[0]?.pm_ms ?? Number.NaN);
      if (!r.error && Number.isFinite(pm)) {
        oks++;
        if (pm !== pm0) {
          firstOkNew = Date.now();
          pm1 = pm;
          break;
        }
        if (firstFail < 0) lastOk = Date.now();
      } else {
        fails++;
        if (firstFail < 0) firstFail = t;
      }
      await sleep(Math.max(0, 2_000 - (Date.now() - t)));
    }
  }
  if (pm1 > 0) {
    console.error(`[${id}] ${kind}: new postmaster answered ${r1((firstOkNew - tPost) / 1000)} s after the request; observing ${OBS_MS / 1000} s`);
    await sleep(OBS_MS);
  }
  const tRead = await sqlOk(ctx, p.ref, "select (extract(epoch from now()) * 1000)::bigint as t");
  const readMs = Number(tRead[0]?.t);
  const since = `to_timestamp(${(tPost - 300_000) / 1000})`;
  const ticks: Tick[] = (
    await sqlOk(
      ctx,
      p.ref,
      `select job, (extract(epoch from at) * 1000)::bigint as at, (extract(epoch from pm) * 1000)::bigint as pm from public.cb_tick where at >= ${since} order by at`,
    )
  ).map((r) => ({ job: String(r.job), at: Number(r.at), pm: Number(r.pm) }));
  const minJob = (await sqlOk(ctx, p.ref, "select jobid from cron.job where jobname = 'cb-min'"))[0]?.jobid;
  const minRuns = (await runs(ctx, p.ref, Number(minJob))).filter((r) => r.startMs >= tPost - 300_000);
  const s10Runs = (await runs(ctx, p.ref, s10.jobid)).filter((r) => r.startMs >= tPost - 300_000);
  const sleepRuns = await runs(ctx, p.ref, sj.jobid);
  await unschedule(ctx, p.ref, sleepName);

  const m: Record<string, string | number> = {
    kind,
    request_status: trg.status,
    request_retries: trg.retries,
    sleep_job_running_at_request: String(sleepRunning),
    probe_first_fail_after_request_s: firstFail > 0 ? r1((firstFail - tPost) / 1000) : -1,
    probe_last_ok_before_s: r1((lastOk - tPost) / 1000),
    probe_new_postmaster_after_request_s: firstOkNew > 0 ? r1((firstOkNew - tPost) / 1000) : -1,
    probe_outage_s: firstOkNew > 0 ? r1((firstOkNew - lastOk) / 1000) : -1,
    probe_fails: fails,
    postmaster_changed: String(pm1 > 0),
    old_postmaster_start: hms(pm0),
    new_postmaster_start: hms(pm1),
    request_sent: hms(tPost),
  };
  if (trg.status >= 300) m.request_body = scrub(trg.text.slice(0, 160));
  if (pm1 < 0) {
    out.push({ id: `${id}a`, title: `${kind}: no new postmaster observed`, status: "fail", detail: scrub(`request HTTP ${trg.status}; ${fails} failed probes, ${oks} ok; no new postmaster within ${maxRecoverMs / 1000} s`), measurements: m });
    return out;
  }

  const before = (job: string) => ticks.filter((t) => t.job === job && t.pm === pm0);
  const after = (job: string) => ticks.filter((t) => t.job === job && t.pm !== pm0);
  const anyBefore = ticks.filter((t) => t.pm === pm0).at(-1)?.at ?? -1;
  const anyAfter = ticks.find((t) => t.pm !== pm0)?.at ?? -1;
  m.db_last_tick_before = hms(anyBefore);
  m.db_first_tick_after = hms(anyAfter);
  m.db_tick_gap_s = anyBefore > 0 && anyAfter > 0 ? r1((anyAfter - anyBefore) / 1000) : -1;

  // Every-minute job.
  const mb = before("min").at(-1)?.at ?? -1;
  const ma = after("min");
  const mFirst = ma[0]?.at ?? -1;
  const MIN = 60_000;
  const missed: string[] = [];
  if (mb > 0 && mFirst > 0) for (let b = (Math.floor(mb / MIN) + 1) * MIN; b < Math.floor(mFirst / MIN) * MIN; b += MIN) missed.push(hms(b).slice(0, 5));
  const late = ma.filter((t) => t.at % MIN > LATE_MS);
  const boundariesAfter = Math.floor(readMs / MIN) - Math.floor(pm1 / MIN);
  const dupMinutes = ma.length - new Set(ma.map((t) => Math.floor(t.at / MIN))).size;
  m.min_last_before = hms(mb);
  m.min_first_after = hms(mFirst);
  m.min_gap_s = mb > 0 && mFirst > 0 ? r1((mFirst - mb) / 1000) : -1;
  m.min_missed_n = missed.length;
  m.min_missed_instants = missed.join(" ") || "none";
  m.min_runs_after = ma.length;
  m.min_boundaries_after_restart = boundariesAfter;
  m.min_runs_late = late.length;
  m.min_late_offsets_s = late.map((t) => r1((t.at % MIN) / 1000)).join(",") || "none";
  m.min_same_minute_dups = dupMinutes;
  m.min_after_offsets_s = ma.map((t) => r1((t.at % MIN) / 1000)).join(",");
  m.min_details = tally(minRuns.map((r) => (r.status === "succeeded" ? r.status : `${r.status} "${r.msg.slice(0, 60)}"`)));

  // Interval job.
  const sb = before("10s").at(-1)?.at ?? -1;
  const sa = after("10s");
  const sFirst = sa[0]?.at ?? -1;
  const gaps = sa.slice(1).map((t, i) => t.at - (sa[i]?.at ?? t.at));
  m.s10_last_before = hms(sb);
  m.s10_first_after = hms(sFirst);
  m.s10_gap_s = sb > 0 && sFirst > 0 ? r1((sFirst - sb) / 1000) : -1;
  m.s10_missed_n = sb > 0 && sFirst > 0 ? Math.max(0, Math.round((sFirst - sb) / 10_000) - 1) : -1;
  m.s10_first_after_new_postmaster_s = sFirst > 0 ? r1((sFirst - pm1) / 1000) : -1;
  m.s10_runs_after = sa.length;
  m.s10_min_interval_after_s = gaps.length ? r1(Math.min(...gaps) / 1000) : -1;
  m.s10_max_interval_after_s = gaps.length ? r1(Math.max(...gaps) / 1000) : -1;
  m.s10_details = tally(s10Runs.map((r) => (r.status === "succeeded" ? r.status : `${r.status} "${r.msg.slice(0, 60)}"`)));

  // In-flight job.
  const inflight = sleepRuns[0];
  const reruns = sleepRuns.filter((r) => r.startMs >= pm1);
  m.sleep_runs_total = sleepRuns.length;
  m.sleep_inflight_status = inflight?.status ?? "none";
  m.sleep_inflight_message = (inflight?.msg ?? "").slice(0, 120);
  m.sleep_inflight_start = hms(inflight?.startMs ?? -1);
  m.sleep_inflight_end = hms(inflight?.endMs ?? -1);
  m.sleep_inflight_end_minus_new_postmaster_s = inflight && inflight.endMs > 0 ? r1((inflight.endMs - pm1) / 1000) : -1;
  m.sleep_reruns_after_restart = reruns.length;

  const catchUp = late.length > 0 || dupMinutes > 0 || ma.length > boundariesAfter;
  out.push({
    id: `${id}a`,
    title: `${kind}: downtime window and the every-minute and 10-second jobs across it`,
    status: "info",
    detail: scrub(
      `request ${hms(tPost)}; probe outage ${String(m.probe_outage_s)} s, new postmaster answered ${String(m.probe_new_postmaster_after_request_s)} s after the request; ` +
        `every-minute: last before ${String(m.min_last_before)}, first after ${String(m.min_first_after)} (gap ${String(m.min_gap_s)} s), instants missed ${missed.length} [${String(m.min_missed_instants)}], ` +
        `runs after ${ma.length} for ${boundariesAfter} boundaries since the new postmaster, late runs ${late.length}, same-minute duplicates ${dupMinutes} -> ${catchUp ? "CATCH-UP seen" : "no catch-up"}; ` +
        `10 s: gap ${String(m.s10_gap_s)} s (about ${String(m.s10_missed_n)} runs not started), first ${String(m.s10_first_after_new_postmaster_s)} s after the new postmaster start, intervals after ${String(m.s10_min_interval_after_s)}-${String(m.s10_max_interval_after_s)} s`,
    ),
    measurements: m,
  });
  out.push({
    id: `${id}b`,
    title: `${kind}: a pg_sleep(120) run in flight at the event`,
    status: "info",
    detail: scrub(
      `running at request: ${sleepRunning}; that run's row: ${inflight?.status ?? "none"} "${(inflight?.msg ?? "").slice(0, 100)}", start ${hms(inflight?.startMs ?? -1)}, end ${hms(inflight?.endMs ?? -1)}; ` +
        `runs of the job after the new postmaster started: ${reruns.length} (next scheduled run is a day later)`,
    ),
    measurements: {
      sleep_job_running_at_request: String(sleepRunning),
      inflight_status: m.sleep_inflight_status,
      inflight_message: m.sleep_inflight_message,
      inflight_end_minus_new_postmaster_s: m.sleep_inflight_end_minus_new_postmaster_s,
      reruns_after_restart: reruns.length,
      runs_total: sleepRuns.length,
    },
  });
  return out;
}
