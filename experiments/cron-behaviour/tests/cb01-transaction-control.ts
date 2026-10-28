/**
 * CB01 - a procedure that COMMITs inside its loop, run by pg_cron.
 *
 *   CB01a  pg_cron version, every cron.* setting (use_background_workers,
 *          log_run, ...) with its pg_settings context
 *   CB01b  `CALL proc()` scheduled as the whole command, as the whole command
 *          with an error at iteration k, and with other statements before or
 *          after it in the same command string: per variant the run status,
 *          return_message, the rows the loop committed and how many distinct
 *          transactions wrote them. Control: the same CALL through the
 *          Management API query endpoint.
 *
 * Each variant gets an interval schedule ('30 seconds'; falls back to every
 * minute if refused) and is unscheduled after its first finished run.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { cronFacts, ensureProject, errText, runs, schedule, scrub, skipWithout, sleep, sql, sqlOk, unschedule, waitRuns } from "../lib/cb.js";

const SETUP = `
create table if not exists public.cb_tx (
  id bigserial primary key, tag text not null, i int not null,
  xid xid8 not null default pg_current_xact_id(), at timestamptz not null default clock_timestamp());
alter table public.cb_tx enable row level security;
create or replace procedure public.cb_loop(p_tag text, n int, fail_at int default 0) language plpgsql as $p$
begin
  for i in 1..n loop
    if i = fail_at then raise exception 'cb_loop % failing at iteration %', p_tag, i; end if;
    insert into public.cb_tx(tag, i) values (p_tag, i);
    commit;
  end loop;
end $p$;
`;

const N = 5;
const VARIANTS: { tag: string; cmd: string }[] = [
  { tag: "solo", cmd: `CALL public.cb_loop('solo', ${N})` },
  { tag: "err", cmd: `CALL public.cb_loop('err', ${N}, 3)` },
  { tag: "pre", cmd: `select 1; CALL public.cb_loop('pre', ${N})` },
  { tag: "post", cmd: `CALL public.cb_loop('post', ${N}); select 1` },
  { tag: "two", cmd: `CALL public.cb_loop('two', ${N}); CALL public.cb_loop('two', ${N})` },
];

const mod: TestModule = {
  id: "CB01",
  title: "pg_cron and a procedure that COMMITs: CALL alone, with an error, with other statements",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 40 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "CB01", this.title);
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      const f = await cronFacts(ctx, p.ref);
      const setting = (n: string) => String(f.settings.find((s) => s.name === n)?.setting ?? "absent");
      const m: Record<string, string | number> = { pg_cron_version: f.version, create_s: p.createS };
      for (const s of f.settings) m[String(s.name)] = `${s.setting} (${s.context})`;
      out.push({
        id: "CB01a",
        title: "pg_cron version and cron.* settings (setting, pg_settings context)",
        status: "info",
        detail: `${p.pgVersion}; pg_cron ${f.version}; cron.use_background_workers=${setting("cron.use_background_workers")}, cron.log_run=${setting("cron.log_run")}, cron.timezone=${setting("cron.timezone")}`,
        measurements: m,
      });

      await sqlOk(ctx, p.ref, SETUP);
      const ctl = await sql(ctx, p.ref, `CALL public.cb_loop('mgmt', ${N})`);
      const jobs: { tag: string; cmd: string; jobid: number; schedule: string }[] = [];
      for (const v of VARIANTS) {
        const s = await schedule(ctx, p.ref, `cb01-${v.tag}`, "30 seconds", v.cmd);
        jobs.push({ ...v, jobid: s.jobid, schedule: s.schedule });
      }
      // Unschedule each job as soon as it has one finished run, so each variant runs once.
      const pending = new Set(jobs.map((j) => j.tag));
      const t0 = Date.now();
      while (pending.size > 0 && Date.now() - t0 < 150_000) {
        for (const j of jobs) {
          if (!pending.has(j.tag)) continue;
          const rs = await runs(ctx, p.ref, j.jobid);
          if (rs.some((r) => r.status !== "running" && r.status !== "starting")) {
            await unschedule(ctx, p.ref, `cb01-${j.tag}`);
            pending.delete(j.tag);
          }
        }
        await sleep(2_000);
      }
      for (const t of pending) await unschedule(ctx, p.ref, `cb01-${t}`);
      // A run in flight when its job was unscheduled still finishes.
      for (const j of jobs) await waitRuns(ctx, p.ref, j.jobid, (await runs(ctx, p.ref, j.jobid)).length, 30_000);
      const rows = await sqlOk(
        ctx,
        p.ref,
        "select tag, count(*)::int as n, count(distinct xid)::int as xids, string_agg(i::text, ',' order by id) as iters from public.cb_tx group by tag",
      );
      const byTag = new Map(rows.map((r) => [String(r.tag), r]));
      const mm: Record<string, string | number> = {
        schedule: jobs[0]?.schedule ?? "",
        mgmt_control: ctl.error ? `ERROR ${ctl.error}`.slice(0, 160) : `ok rows=${Number(byTag.get("mgmt")?.n ?? 0)}`,
      };
      const lines: string[] = [];
      for (const j of jobs) {
        const rs = await runs(ctx, p.ref, j.jobid);
        const first = rs.find((r) => r.status !== "running" && r.status !== "starting");
        const t = byTag.get(j.tag);
        const kept = Number(t?.n ?? 0);
        const xids = Number(t?.xids ?? 0);
        const runsN = rs.length;
        mm[`${j.tag}_status`] = first?.status ?? "no finished run";
        mm[`${j.tag}_message`] = (first?.msg ?? "").slice(0, 160);
        mm[`${j.tag}_rows_kept`] = kept;
        mm[`${j.tag}_distinct_xids`] = xids;
        mm[`${j.tag}_runs_seen`] = runsN;
        lines.push(`${j.tag} [${j.cmd}]: ${first?.status ?? "none"} "${(first?.msg ?? "").slice(0, 100)}"; rows ${kept} (iters ${String(t?.iters ?? "-")}) in ${xids} xids over ${runsN} run(s)`);
      }
      out.push({
        id: "CB01b",
        title: "CALL of a COMMITting procedure as the pg_cron command, by command shape",
        status: "info",
        detail: scrub(`${lines.join(" | ")} | Management API control: ${String(mm.mgmt_control)}`),
        measurements: mm,
      });
    } catch (e) {
      out.push({ id: "CB01", title: this.title, status: "fail", detail: scrub(errText(e)) });
    }
    return out;
  },
};
export default mod;
