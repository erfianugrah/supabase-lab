/**
 * DC09 - Which function-level `set statement_timeout` a Data API request
 * honours, and whether it does anything outside the Data API.
 *
 * DC03b measured a top-level plpgsql function declared `set
 * statement_timeout = '30s'` running a 12 s sleep to 200 under every key.
 * Two readings fit that:
 *   H1  PostgREST reads the called function's settings from its schema cache
 *       and applies them (PostgREST docs: "hoisted function settings",
 *       `db-hoisted-tx-settings`, default includes statement_timeout) before
 *       the statement runs; Postgres arms the statement timer when the
 *       statement starts, so a SET that runs mid-statement (any nested
 *       function, or a function called outside PostgREST) does not move it.
 *   H2  Postgres honours a function's SET mid-statement, nested or not.
 * H1 predicts arm b (plain outer, inner `set 30s`) fails 57014 at about the
 * caller's 8 s, arm c (outer 30 s, inner 2 s) answers 200, and the pooler and
 * pg_cron arms fail at the caller's timeout. H2 predicts the opposite in each.
 *
 * Every Data API call: anon key plus a signed-in confirmed user's access
 * token (role `authenticated`, 8 s role default per DC03a). Each function
 * returns `current_setting('statement_timeout')` as it saw it, so a 200 shows
 * which value was in force inside. Client times include the round trip from
 * the orchestrator.
 *
 *   DC09a  control: dc_sleep(12) (no setting).
 *   DC09b  arm 1: outer `set 30s` calls inner (no setting), 12 s.
 *   DC09c  arm 2: outer (no setting) calls inner `set 30s`, 12 s.
 *   DC09d  arm 3: outer `set 30s` calls inner `set 2s`, 12 s.
 *   DC09e  arm 4: `language sql stable` with `set 30s`, by GET /rpc and POST /rpc.
 *   DC09f  arm 5: SECURITY DEFINER, `set search_path = ''`, `set 30s`.
 *   DC09g  arm 6: function `set 120s` sleeping 70 s (Supabase timeouts guide:
 *          client queries have a max-configurable timeout of 60 s): status,
 *          code, time and headers the client gets, whether the backend kept
 *          running after the answer, executions started and finished
 *          (non-transactional sequences), whether its write committed, and
 *          PostgREST / edge log rows for its User-Agent.
 *   DC09h  arm 7: `alter function ... set statement_timeout = '30s'` on a
 *          function without one: call right after the ALTER, then after
 *          `notify pgrst, 'reload schema'`. Also records the event triggers
 *          present (a DDL watcher would reload the schema cache by itself).
 *   DC09i  arm 8a: pg_cron jobs `set statement_timeout = '8s'; select f(12)`
 *          for the control, the top-level 30 s function and arm 2's outer:
 *          cron.job_run_details status, message and duration.
 *   DC09j  arm 8b: a session-mode pooler connection as postgres, `set
 *          statement_timeout = '8s'`, `set role authenticated`, then the same
 *          three calls (one psql process per call).
 *
 * n = 3 per arm unless the row says otherwise. Not settled here: PostgREST's
 * hoisting code path (source not read), other hoisted settings, functions
 * called from views or RLS policies, `alter database` timeouts.
 *
 * DESTRUCTIVE: creates functions, a table, sequences and pg_cron jobs on the
 * shared project (jobs unscheduled at the end); DC99 deletes the project.
 */
import { spawn } from "node:child_process";
import { mgmt } from "../../../harness/src/mgmt.js";
import { logsQuery } from "../../../harness/src/platform.js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  ensureProject,
  errText,
  fmtCounts,
  logLinesByUaPrefix,
  redact,
  request,
  skipWithoutPro,
  sleep,
  sql,
  untilHealthy,
  type DcProject,
  type HttpResult,
} from "../lib/dc.js";

const N = Number(process.env.PVLAB_DC09_N || 3);
const SLEEP_S = 12;

const SETUP = `
create or replace function public.dc9_inner_plain(s double precision) returns text
  language plpgsql as $$ begin perform pg_sleep(s); return current_setting('statement_timeout'); end $$;
create or replace function public.dc9_inner_30(s double precision) returns text
  language plpgsql set statement_timeout = '30s' as $$ begin perform pg_sleep(s); return current_setting('statement_timeout'); end $$;
create or replace function public.dc9_inner_2(s double precision) returns text
  language plpgsql set statement_timeout = '2s' as $$ begin perform pg_sleep(s); return current_setting('statement_timeout'); end $$;
create or replace function public.dc9_outer30_plain(s double precision) returns text
  language plpgsql set statement_timeout = '30s' as $$ declare o text := current_setting('statement_timeout'); begin return 'outer=' || o || ' inner=' || public.dc9_inner_plain(s); end $$;
create or replace function public.dc9_outerplain_30(s double precision) returns text
  language plpgsql as $$ declare o text := current_setting('statement_timeout'); begin return 'outer=' || o || ' inner=' || public.dc9_inner_30(s); end $$;
create or replace function public.dc9_outer30_2(s double precision) returns text
  language plpgsql set statement_timeout = '30s' as $$ declare o text := current_setting('statement_timeout'); begin return 'outer=' || o || ' inner=' || public.dc9_inner_2(s); end $$;
create or replace function public.dc9_stable_sql_30(s double precision) returns text
  language sql stable set statement_timeout = '30s' as $$ select current_setting('statement_timeout') from (select pg_sleep(s)) z $$;
create or replace function public.dc9_definer_30(s double precision) returns text
  language plpgsql security definer set search_path = '' set statement_timeout = '30s'
  as $$ begin perform pg_catalog.pg_sleep(s); return pg_catalog.current_setting('statement_timeout'); end $$;
create or replace function public.dc9_alter(s double precision) returns text
  language plpgsql as $$ begin perform pg_sleep(s); return current_setting('statement_timeout'); end $$;
create sequence if not exists public.dc9_started;
create sequence if not exists public.dc9_finished;
create table if not exists public.dc9_done (tag text, at timestamptz default now());
create or replace function public.dc9_sleep_120(s double precision, tag text) returns text
  language plpgsql set statement_timeout = '120s' as $$
  begin
    perform nextval('public.dc9_started');
    perform pg_sleep(s);
    perform nextval('public.dc9_finished');
    insert into public.dc9_done(tag) values (tag);
    return current_setting('statement_timeout');
  end $$;
grant usage, select on sequence public.dc9_started, public.dc9_finished to authenticated;
grant insert, select on public.dc9_done to authenticated;
grant execute on all functions in schema public to anon, authenticated, service_role;
notify pgrst, 'reload schema';`;

interface Call {
  status: number;
  code: string;
  ms: number;
  body: string;
}

function userHeaders(p: DcProject, ua?: string): Record<string, string> {
  return { apikey: p.keys.anon, Authorization: `Bearer ${p.userJwt}`, ...(ua ? { "User-Agent": ua } : {}) };
}

async function callFn(p: DcProject, fn: string, args: Record<string, unknown>, method: "POST" | "GET" = "POST", ua?: string, timeoutMs = 60_000): Promise<HttpResult> {
  if (method === "GET") {
    const qs = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString();
    return request(p.host, "GET", `/rest/v1/rpc/${fn}?${qs}`, userHeaders(p, ua), undefined, timeoutMs);
  }
  return request(p.host, "POST", `/rest/v1/rpc/${fn}`, userHeaders(p, ua), args, timeoutMs);
}

const short = (r: Call | HttpResult) => `${r.status}${r.code && r.code !== "client" ? ` ${r.code}` : ""} @${(r.ms / 1000).toFixed(1)}s${r.status === 200 ? ` ${r.body.slice(0, 40)}` : ""}`;

/** n sequential calls, measurements prefixed. */
async function arm(p: DcProject, label: string, fn: string, method: "POST" | "GET" = "POST"): Promise<{ meas: Record<string, number | string>; line: string }> {
  const meas: Record<string, number | string> = {};
  const rs: HttpResult[] = [];
  for (let i = 0; i < N; i++) rs.push(await callFn(p, fn, { s: SLEEP_S }, method));
  rs.forEach((r, i) => {
    meas[`${label}_${i + 1}_status`] = r.status;
    meas[`${label}_${i + 1}_code`] = r.code || "none";
    meas[`${label}_${i + 1}_ms`] = r.ms;
    meas[`${label}_${i + 1}_body`] = r.status === 200 ? r.body.slice(0, 80) : r.message.slice(0, 80);
  });
  return { meas, line: `${label}: ${rs.map(short).join(", ")}` };
}

/** One psql process per call against the session-mode pooler; wall time measured here. */
function psqlCall(conninfo: string, password: string, statements: string[], timeoutMs = 60_000): Promise<{ ok: boolean; ms: number; out: string }> {
  return new Promise((resolve) => {
    const args = ["-X", "-tA", "-v", "ON_ERROR_STOP=1", conninfo];
    for (const s of statements) args.push("-c", s);
    const t0 = performance.now();
    const child = spawn("psql", args, { env: { ...process.env, PGPASSWORD: password } });
    let buf = "";
    child.stdout.on("data", (d) => (buf += String(d)));
    child.stderr.on("data", (d) => (buf += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, ms: Math.round(performance.now() - t0), out: buf.replace(/\s+/g, " ").trim().slice(0, 200) });
    });
  });
}

const mod: TestModule = {
  id: "DC09",
  title: "Function-level statement_timeout: nested, hoisted, past 60 s, after ALTER, and outside the Data API",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC09");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      const readyS = await untilHealthy(p, 10, 600);
      if (readyS < 0) throw new Error("Data API not answering 10 consecutive pings within 600 s");
      const setup = await sql(ctx, p.ref, SETUP);
      if (setup.error) throw new Error(`setup: ${setup.error}`);
      // Wait until the schema cache serves the last function created.
      for (let i = 0; i < 30; i++) {
        const r = await callFn(p, "dc9_inner_plain", { s: 0 });
        if (r.status === 200) break;
        await sleep(2_000);
      }
      const rc = await sql(ctx, p.ref, "select rolname, coalesce(rolconfig::text, 'null') as cfg from pg_roles where rolname in ('authenticated','authenticator','postgres') order by 1");
      const roles = Object.fromEntries((rc.rows ?? []).map((r) => [`rolconfig_${r.rolname}`, String(r.cfg)]));

      // DC09a-f: Data API arms.
      const arms: [string, string, string, string, "POST" | "GET"][] = [
        ["DC09a", "control: dc_sleep (no function setting), 12 s", "control", "dc_sleep", "POST"],
        ["DC09b", "arm 1: outer set 30s calls inner (no setting), 12 s", "outer30_innerplain", "dc9_outer30_plain", "POST"],
        ["DC09c", "arm 2: outer (no setting) calls inner set 30s, 12 s", "outerplain_inner30", "dc9_outerplain_30", "POST"],
        ["DC09d", "arm 3: outer set 30s calls inner set 2s, 12 s", "outer30_inner2", "dc9_outer30_2", "POST"],
      ];
      for (const [id, title, label, fn, method] of arms) {
        const a = await arm(p, label, fn, method);
        out.push({ id, title, status: "info", detail: a.line, measurements: id === "DC09a" ? { ...roles, ...a.meas } : a.meas });
      }
      const eGet = await arm(p, "stable_sql_get", "dc9_stable_sql_30", "GET");
      const ePost = await arm(p, "stable_sql_post", "dc9_stable_sql_30", "POST");
      out.push({ id: "DC09e", title: "arm 4: language sql stable, set 30s, 12 s, by GET /rpc and POST /rpc", status: "info", detail: `${eGet.line}; ${ePost.line}`, measurements: { ...eGet.meas, ...ePost.meas } });
      const f = await arm(p, "definer", "dc9_definer_30", "POST");
      out.push({ id: "DC09f", title: "arm 5: security definer, set search_path = '', set 30s, 12 s", status: "info", detail: f.line, measurements: f.meas });

      // DC09g: 70 s under a 120 s function timeout.
      {
        const g: Record<string, number | string> = {};
        const tag = `pvlab-dc09g-${Date.now().toString(36)}`;
        const before = await sql(ctx, p.ref, "select (select last_value from public.dc9_started) as s, (select is_called from public.dc9_started) as sc, (select last_value from public.dc9_finished) as f, (select is_called from public.dc9_finished) as fc");
        const cnt = (row: Record<string, unknown> | undefined, k: "s" | "f") => (row ? (row[`${k}c`] ? Number(row[k]) : 0) : -1);
        const s0 = cnt(before.rows?.[0], "s");
        const f0 = cnt(before.rows?.[0], "f");
        const t0 = Date.now();
        const calls = Array.from({ length: N }, (_, i) => callFn(p, "dc9_sleep_120", { s: 70, tag: `${tag}-${i}` }, "POST", `${tag}-${i}`, 200_000));
        const rs = await Promise.all(calls);
        const answeredAtS = Math.round((Date.now() - t0) / 100) / 10;
        // Did the backends keep running after the client had its answer?
        const running: number[] = [];
        let lastRunningS = -1;
        while (Date.now() - t0 < 100_000) {
          const a = await sql(ctx, p.ref, "select count(*)::int as n from pg_stat_activity where query like '%dc9_sleep_120%' and state = 'active' and pid <> pg_backend_pid()", 20_000);
          const n = Number(a.rows?.[0]?.n ?? -1);
          running.push(n);
          if (n > 0) lastRunningS = Math.round((Date.now() - t0) / 1000);
          if (n === 0) break;
          await sleep(5_000);
        }
        await sleep(3_000);
        const after = await sql(ctx, p.ref, `select (select last_value from public.dc9_started) as s, (select is_called from public.dc9_started) as sc, (select last_value from public.dc9_finished) as f, (select is_called from public.dc9_finished) as fc, (select count(*)::int from public.dc9_done where tag like '${tag}%') as done`);
        const row = after.rows?.[0];
        const pl = await logLinesByUaPrefix(ctx, p.ref, "postgrest_logs", tag);
        const el = await logLinesByUaPrefix(ctx, p.ref, "edge_logs", tag, 120);
        rs.forEach((r, i) => {
          g[`req${i + 1}_status`] = r.status;
          g[`req${i + 1}_code`] = r.code || "none";
          g[`req${i + 1}_ms`] = r.ms;
          g[`req${i + 1}_body`] = redact(r.body || r.message).slice(0, 160);
        });
        g.response_headers_req1 = redact(JSON.stringify(rs[0]?.headers ?? {})).slice(0, 600);
        g.all_answered_s = answeredAtS;
        g.active_backend_reads_after_answer = running.join(",");
        g.last_seen_running_s = lastRunningS;
        g.executions_started = cnt(row, "s") - s0;
        g.executions_finished = cnt(row, "f") - f0;
        g.rows_committed = Number(row?.done ?? -1);
        g.postgrest_lines = pl.lines.length;
        g.postgrest_lines_by_status = fmtCounts(pl.lines.reduce((m, l) => ({ ...m, [l.status]: (m[l.status] ?? 0) + 1 }), {} as Record<string, number>)) || "none";
        g.edge_rows = el.lines.length;
        g.edge_rows_by_status = fmtCounts(el.lines.reduce((m, l) => ({ ...m, [l.status]: (m[l.status] ?? 0) + 1 }), {} as Record<string, number>)) || "none";
        out.push({
          id: "DC09g",
          title: `arm 6: function set 120s sleeping 70 s, ${N} concurrent requests`,
          status: "info",
          detail:
            `${rs.map(short).join(", ")}; backends active after the answers: ${running.join(",")} (last seen ${lastRunningS} s after send); ` +
            `executions started ${g.executions_started}, finished ${g.executions_finished}, rows committed ${g.rows_committed}; ` +
            `PostgREST lines ${g.postgrest_lines} (${g.postgrest_lines_by_status}), edge rows ${g.edge_rows} (${g.edge_rows_by_status})`,
          measurements: g,
          evidence: redact(rs[0]?.body || rs[0]?.message || ""),
        });
      }

      // DC09h: ALTER FUNCTION on an existing function.
      {
        const h: Record<string, number | string> = {};
        const et = await sql(ctx, p.ref, "select string_agg(evtname || ':' || evtevent || ':' || evtenabled, ',' order by evtname) as t from pg_event_trigger");
        h.event_triggers = String(et.rows?.[0]?.t ?? "none");
        const base = await arm(p, "before_alter", "dc9_alter");
        const tAlter = Date.now();
        const al = await sql(ctx, p.ref, "alter function public.dc9_alter(double precision) set statement_timeout = '30s'");
        h.alter_status = al.status;
        const imm: HttpResult[] = [];
        const sentAt: number[] = [];
        for (let i = 0; i < N; i++) {
          sentAt.push(Date.now());
          imm.push(await callFn(p, "dc9_alter", { s: SLEEP_S }));
        }
        imm.forEach((r, i) => {
          h[`after_alter_${i + 1}_status`] = r.status;
          h[`after_alter_${i + 1}_code`] = r.code || "none";
          h[`after_alter_${i + 1}_ms`] = r.ms;
          // Run 2026-10-26 computed this as (now - ALTER sent - call 1 ms) after all N calls, so its 24.3 includes calls 2 and 3.
          h[`after_alter_${i + 1}_sent_s_after_alter`] = Math.round((sentAt[i]! - tAlter) / 100) / 10;
        });
        await sql(ctx, p.ref, "notify pgrst, 'reload schema'");
        await sleep(5_000);
        const rel = await arm(p, "after_reload_schema", "dc9_alter");
        // Schema cache reloads PostgREST logged around the ALTER.
        const back = Math.ceil((Date.now() - tAlter) / 1000) + 30;
        const lg = await logsQuery({ ...ctx, ref: p.ref }, `select timestamp, event_message from logs where source = 'postgrest_logs' and event_message like '%chema cache%' and timestamp > now() - interval ${back} second order by timestamp limit 50`, 1).catch(() => ({ rows: [] as Record<string, unknown>[] }));
        const lrows = lg.rows.map(
          (x) => `${((Date.parse(`${String(x.timestamp ?? "").replace(/Z?$/, "Z")}`) - tAlter) / 1000).toFixed(1)}s ${String(x.event_message ?? "").slice(0, 60)}`,
        );
        h.schema_cache_log_lines_rel_alter = lrows.join(" | ").slice(0, 600) || "none";
        out.push({
          id: "DC09h",
          title: "arm 7: alter function ... set statement_timeout = '30s', called right after and after a schema reload, 12 s",
          status: "info",
          detail: `${base.line}; after ALTER: ${imm.map(short).join(", ")}; ${rel.line}; event triggers ${h.event_triggers}`,
          measurements: { ...base.meas, ...h, ...rel.meas },
          evidence: redact(String(h.schema_cache_log_lines_rel_alter)),
        });
      }

      // DC09i: pg_cron.
      {
        const i: Record<string, number | string> = {};
        let ext = await sql(ctx, p.ref, "create extension if not exists pg_cron with schema pg_catalog");
        if (ext.error) ext = await sql(ctx, p.ref, "create extension if not exists pg_cron");
        i.create_extension = ext.error ? `error: ${ext.error.slice(0, 120)}` : "ok";
        const ver = await sql(ctx, p.ref, "select extversion as v, (select setting from pg_settings where name = 'cron.use_background_workers') as bg from pg_extension where extname = 'pg_cron'");
        i.pg_cron_version = String(ver.rows?.[0]?.v ?? "absent");
        i.cron_use_background_workers = String(ver.rows?.[0]?.bg ?? "unknown");
        const jobs: [string, string][] = [
          ["control", "dc_sleep"],
          ["toplevel30", "dc_sleep_long"],
          ["outerplain_inner30", "dc9_outerplain_30"],
        ];
        const ids: Record<string, number> = {};
        for (const [label, fn] of jobs) {
          const r = await sql(ctx, p.ref, `select cron.schedule('dc9-${label}', '20 seconds', $$set statement_timeout = '8s'; select public.${fn}(${SLEEP_S})$$) as id`);
          ids[label] = Number(r.rows?.[0]?.id ?? -1);
          i[`${label}_schedule`] = r.error ? `error: ${r.error.slice(0, 120)}` : String(ids[label]);
        }
        const detail: string[] = [];
        if (Object.values(ids).every((x) => x > 0)) {
          // Wait for N finished runs per job (20 s apart), then unschedule.
          const t0 = Date.now();
          let rows: Record<string, unknown>[] = [];
          while (Date.now() - t0 < (N * 20 + 60) * 1000) {
            await sleep(15_000);
            const q = await sql(ctx, p.ref, `select jobid, status, return_message, round(extract(epoch from end_time - start_time)::numeric * 1000)::int as ms from cron.job_run_details where jobid in (${Object.values(ids).join(",")}) and end_time is not null order by start_time`);
            rows = q.rows ?? [];
            if (Object.values(ids).every((id) => rows.filter((r) => Number(r.jobid) === id).length >= N)) break;
          }
          for (const [label] of jobs) await sql(ctx, p.ref, `select cron.unschedule('dc9-${label}')`);
          for (const [label] of jobs) {
            const mine = rows.filter((r) => Number(r.jobid) === ids[label]).slice(0, N);
            mine.forEach((r, k) => {
              i[`${label}_${k + 1}_status`] = String(r.status);
              i[`${label}_${k + 1}_ms`] = Number(r.ms);
              i[`${label}_${k + 1}_message`] = String(r.return_message ?? "").slice(0, 100);
            });
            detail.push(`${label}: ${mine.map((r) => `${r.status} @${(Number(r.ms) / 1000).toFixed(1)}s ${String(r.return_message ?? "").slice(0, 50)}`).join(", ") || "no runs"}`);
          }
        } else detail.push(`not scheduled: ${JSON.stringify(i).slice(0, 200)}`);
        out.push({ id: "DC09i", title: "arm 8a: pg_cron jobs with set statement_timeout = '8s', 12 s sleeps", status: "info", detail: detail.join("; "), measurements: i });
      }

      // DC09j: pooler session mode, set role authenticated.
      {
        const j: Record<string, number | string> = {};
        const pr = await mgmt(ctx, "GET", `/projects/${p.ref}/config/database/pooler`);
        const recs = (Array.isArray(pr.json) ? pr.json : [pr.json]) as Record<string, unknown>[];
        const rec = recs.find((r) => r?.pool_mode === "session") ?? recs[0];
        const host = String(rec?.db_host ?? "");
        const user = String(rec?.db_user ?? "");
        if (!p.dbPass || !host || !user) {
          out.push({ id: "DC09j", title: "arm 8b: pooler", status: "skip", detail: !p.dbPass ? "reused project: no db password in memory" : `pooler config not readable (HTTP ${pr.status})` });
        } else {
          const conninfo = `host=${host} port=5432 user=${user} dbname=postgres sslmode=require connect_timeout=15 application_name=pvlab-dc09j`;
          const pre = ["set statement_timeout = '8s'", "set role authenticated"];
          const base = await psqlCall(conninfo, p.dbPass, [...pre, "select current_user, current_setting('statement_timeout')"]);
          j.baseline_ok = base.ok ? 1 : 0;
          j.baseline_ms = base.ms;
          j.baseline_out = redact(base.out).slice(0, 120);
          const det: string[] = [`baseline ${base.ok ? "ok" : "fail"} ${base.ms} ms (${redact(base.out).slice(0, 60)})`];
          for (const [label, fn] of [["control", "dc_sleep"], ["toplevel30", "dc_sleep_long"], ["outerplain_inner30", "dc9_outerplain_30"]] as const) {
            const rs: { ok: boolean; ms: number; out: string }[] = [];
            for (let k = 0; k < N; k++) rs.push(await psqlCall(conninfo, p.dbPass, [...pre, `select public.${fn}(${SLEEP_S})`]));
            rs.forEach((r, k) => {
              j[`${label}_${k + 1}_ok`] = r.ok ? 1 : 0;
              j[`${label}_${k + 1}_ms`] = r.ms;
              j[`${label}_${k + 1}_out`] = redact(r.out).slice(0, 100);
            });
            det.push(`${label}: ${rs.map((r) => `${r.ok ? "ok" : "error"} @${(r.ms / 1000).toFixed(1)}s ${r.ok ? r.out.slice(0, 30) : r.out.includes("statement timeout") ? "57014" : r.out.slice(0, 60)}`).join(", ")}`);
          }
          out.push({ id: "DC09j", title: "arm 8b: session pooler as postgres, set statement_timeout 8s, set role authenticated, 12 s sleeps", status: "info", detail: redact(det.join("; ")), measurements: j });
        }
      }
    } catch (e) {
      out.push({ id: "DC09", title: this.title, status: "fail", detail: `threw: ${redact(errText(e))}` });
    }
    return out;
  },
};
export default mod;
