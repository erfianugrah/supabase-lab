/**
 * UI06 - pg_cron and pgmq across the upgrade window.
 *
 * Waits until PVLAB_UI_SETTLE_S (default 180) have passed since UI03 saw the
 * project healthy on the new major, then reads:
 *
 *   UI06a  ui-tick (every 5 s): last tick on the old major, first on the new
 *          one, the gap between them and the runs that gap implies were
 *          never started; ticks and median cadence on the new major.
 *   UI06b  ui-minute (every minute): the same for the cron-syntax job.
 *   UI06c  cron.job_run_details since the POST: runs by status, the distinct
 *          failure messages, and rows whose start_time falls inside the gap.
 *   UI06d  pgmq after: ticks on the new major that sent, read and archived,
 *          plus a direct send / read / archive / metrics round trip.
 *   UI06e  every acknowledged write looked up again after the settle through
 *          a fresh session-pooler connection and the direct connection (UI04c
 *          read through the Management API), against a visibility artifact.
 *
 * DESTRUCTIVE: runs against the shared project after UI03.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { QUEUE, ensureProject, errText, pgClient, redact, skipWithoutPro, sleep, sql, state } from "../lib/ui.js";

const SETTLE_S = Number(process.env.PVLAB_UI_SETTLE_S || 180);

async function window(ctx: Ctx, ref: string, table: string, oldMajor: string, newMajor: string) {
  const r = await sql(
    ctx,
    ref,
    `with o as (select max(at) as last_old, count(*) as n_old from ${table} where server_version like '${oldMajor}.%'),
          n as (select min(at) as first_new, count(*) as n_new from ${table} where server_version like '${newMajor}.%'),
          g as (select extract(epoch from at - lag(at) over (order by id)) as d, server_version from ${table})
     select o.last_old::text as last_old, n.first_new::text as first_new, o.n_old, n.n_new,
            extract(epoch from n.first_new - o.last_old) as gap_s,
            (select percentile_cont(0.5) within group (order by d) from g where d is not null and server_version like '${newMajor}.%') as med_new
     from o, n`,
  );
  const x = r.rows?.[0] ?? {};
  return {
    error: r.error,
    lastOld: String(x.last_old ?? ""),
    firstNew: String(x.first_new ?? ""),
    nOld: Number(x.n_old ?? 0),
    nNew: Number(x.n_new ?? 0),
    gapS: x.gap_s == null ? -1 : Number(x.gap_s),
    medNew: x.med_new == null ? -1 : Number(x.med_new),
  };
}

const mod: TestModule = {
  id: "UI06",
  title: "pg_cron and pgmq across the upgrade window",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "UI06");
    if (skip) return skip;
    const u = state.upgrade;
    const b = state.baseline;
    if (!u || !b || !u.doneAt) return [{ id: "UI06", title: "UI06", status: "skip", detail: "no completed UI03 upgrade in this process" }];
    const p = await ensureProject(ctx);
    const ref = p.ref;
    const wait = u.doneAt + SETTLE_S * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    const oldMajor = u.fromVersion.split(".")[0] ?? "";
    const newMajor = u.toVersion.split(".")[0] ?? "";
    const interval = b.cronSchedule === "5 seconds" ? 5 : 60;
    const out: TestResult[] = [];

    const t = await window(ctx, ref, "public.ui_ticks", oldMajor, newMajor);
    const missedTick = t.gapS > 0 ? Math.max(0, Math.round(t.gapS / interval) - 1) : -1;
    const postIso = new Date(u.postAt).toISOString();
    out.push({
      id: "UI06a",
      title: `UI06a: ui-tick (${b.cronSchedule}) across the window`,
      status: t.error ? "fail" : t.nNew > 0 ? "pass" : "fail",
      detail: t.error
        ? t.error
        : `POST at ${postIso}; last tick on ${oldMajor} ${t.lastOld}, first on ${newMajor} ${t.firstNew}; gap ${t.gapS.toFixed(1)} s = about ${missedTick} runs never started; ${t.nNew} ticks on ${newMajor} so far (median gap ${t.medNew.toFixed(2)} s); first new tick ${((Date.parse(t.firstNew) - u.doneAt) / 1000).toFixed(0)} s after UI03 saw it healthy`,
      measurements: {
        ticks_old: t.nOld,
        ticks_new: t.nNew,
        tick_gap_s: Number(t.gapS.toFixed(1)),
        tick_runs_missed: missedTick,
        tick_median_gap_new_s: Number(t.medNew.toFixed(2)),
        last_old_after_post_s: Number(((Date.parse(t.lastOld) - u.postAt) / 1000).toFixed(1)),
        first_new_after_healthy_s: Number(((Date.parse(t.firstNew) - u.doneAt) / 1000).toFixed(1)),
      },
    });

    const m = await window(ctx, ref, "public.ui_minute", oldMajor, newMajor);
    out.push({
      id: "UI06b",
      title: "UI06b: ui-minute ('* * * * *') across the window",
      status: m.error ? "fail" : m.nNew > 0 ? "pass" : "fail",
      detail: m.error ? m.error : `last on ${oldMajor} ${m.lastOld}, first on ${newMajor} ${m.firstNew}; gap ${m.gapS.toFixed(1)} s = about ${m.gapS > 0 ? Math.max(0, Math.round(m.gapS / 60) - 1) : -1} minutes skipped; ${m.nNew} runs on ${newMajor}`,
      measurements: { minute_old: m.nOld, minute_new: m.nNew, minute_gap_s: Number(m.gapS.toFixed(1)) },
    });

    const since = new Date(u.postAt - 60_000).toISOString();
    const st = await sql(
      ctx,
      ref,
      `select j.jobname, d.status, count(*) as n, min(d.start_time)::text as first, max(d.start_time)::text as last
       from cron.job_run_details d left join cron.job j using (jobid)
       where d.start_time >= '${since}' group by 1, 2 order by 1, 2`,
    );
    const fails = await sql(
      ctx,
      ref,
      `select status, left(coalesce(return_message, ''), 200) as msg, count(*) as n, min(start_time)::text as first, max(start_time)::text as last
       from cron.job_run_details where status <> 'succeeded' group by 1, 2 order by n desc limit 10`,
    );
    const inGap =
      t.lastOld && t.firstNew
        ? await sql(
            ctx,
            ref,
            `select status, count(*) as n from cron.job_run_details where start_time > '${t.lastOld}' and start_time < '${t.firstNew}' group by 1 order by 1`,
          )
        : { rows: [], error: "no window" };
    const notOk = (fails.rows ?? []).reduce((s, r) => s + Number(r.n), 0);
    out.push({
      id: "UI06c",
      title: "UI06c: cron.job_run_details around the window",
      status: st.error || fails.error ? "fail" : "info",
      detail: `since POST-60s: ${(st.rows ?? []).map((r) => `${String(r.jobname)} ${String(r.status)}=${String(r.n)}`).join(", ")}; non-succeeded rows overall ${notOk}${(fails.rows ?? []).length ? ` (${(fails.rows ?? []).map((r) => `${String(r.status)} x${String(r.n)}: ${String(r.msg)}`).join(" | ")})` : ""}; rows started inside the tick gap: ${(inGap.rows ?? []).map((r) => `${String(r.status)}=${String(r.n)}`).join(", ") || "none"}`,
      measurements: { non_succeeded_runs: notOk, runs_in_gap: (inGap.rows ?? []).reduce((s, r) => s + Number(r.n), 0) },
      evidence: redact(JSON.stringify({ byStatus: st.rows ?? st.error, failures: fails.rows ?? fails.error, inGap: inGap.rows ?? inGap.error }, null, 1)),
    });

    const ticksNew = await sql(
      ctx,
      ref,
      `select count(*) as n, count(*) filter (where sent is not null and read_n > 0) as moved, sum(archived_n) as arch, sum(deleted_n) as del
       from public.ui_ticks where server_version like '${newMajor}.%'`,
    );
    const rt = await sql(
      ctx,
      ref,
      `with s as (select * from pgmq.send('${QUEUE}', '{"direct": true}'::jsonb) as id)
       select (select id from s)::text as sent`,
    );
    const rd = await sql(ctx, ref, `select msg_id::text as id from pgmq.read('${QUEUE}', 30, 1)`);
    const rid = String(rd.rows?.[0]?.id ?? "");
    const ar = rid ? await sql(ctx, ref, `select pgmq.archive('${QUEUE}', ${rid}::bigint) as ok`) : { rows: [], error: "nothing read" };
    const mt = await sql(ctx, ref, `select queue_length::text as len, total_messages::text as total from pgmq.metrics('${QUEUE}')`);
    const tn = ticksNew.rows?.[0] ?? {};
    out.push({
      id: "UI06d",
      title: "UI06d: pgmq on the new major",
      status: !rt.error && rid && !ar.error && String(ar.rows?.[0]?.ok) === "true" && Number(tn.moved) > 0 ? "pass" : "fail",
      detail: `${String(tn.moved)}/${String(tn.n)} new-major ticks sent and read (archived ${String(tn.arch)}, deleted ${String(tn.del)}); direct send ${rt.error ?? String(rt.rows?.[0]?.sent)}, read ${rd.error ?? (rid || "none")}, archive ${ar.error ?? String(ar.rows?.[0]?.ok)}; metrics ${mt.error ?? `length ${String(mt.rows?.[0]?.len)}, total ${String(mt.rows?.[0]?.total)}`}`,
      measurements: { new_ticks: Number(tn.n ?? 0), new_ticks_moved: Number(tn.moved ?? 0), direct_round_trip: !rt.error && rid && !ar.error ? "ok" : "failed" },
    });
    // Visibility re-check: the lost writes again, after the settle, through a fresh session-pooler connection
    // and, if it connects from here, the direct connection (UI04c read them through the Management API).
    const acked = u.attempts.filter((x) => x.ok);
    for (const path of ["session", "direct"] as const) {
      let detail = "";
      let missing = -1;
      try {
        const c = await pgClient(ctx, p, path, 10_000);
        try {
          const r = await c.client.query("select src, seq from public.ui_client");
          const have = new Set(r.rows.map((x: { src: string; seq: number }) => `${x.src}:${Number(x.seq)}`));
          missing = acked.filter((x) => !have.has(`${x.src}:${x.seq}`)).length;
          detail = `${acked.length - missing}/${acked.length} acknowledged writes visible (${r.rows.length} rows)`;
        } finally {
          await c.client.end().catch(() => {});
        }
      } catch (e) {
        detail = `could not read: ${redact(errText(e))}`;
      }
      out.push({
        id: `UI06e-${path}`,
        title: `UI06e: acknowledged writes visible after the settle, read through the ${path === "session" ? "session pooler" : "direct connection"}`,
        status: missing < 0 ? "skip" : missing === 0 ? "pass" : "fail",
        detail,
        measurements: { missing },
      });
    }
    return out;
  },
};
export default mod;
