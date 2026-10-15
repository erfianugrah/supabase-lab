/**
 * LV02 - what does each customer-settable Postgres logging knob add to
 * `postgres_logs` per statement, and which role does it have to be set on to
 * reach Data API traffic?
 *
 * One throwaway Pro-org project (ap-southeast-1). Every setting is applied the
 * way a customer can: `alter role <role> set ...` from a session as the
 * `postgres` role through the shared pooler (the docs list these as settable
 * at role level through supautils). Vantage: this machine.
 *
 * Workload per condition, in its own window, after a 45 s pause with no Data
 * API traffic (PostgREST closes idle pool connections after
 * db-pool-max-idletime, 30 s by default per its docs, so the next request opens
 * a connection that picks up the role setting):
 *   - REST: WORK anon GETs (Data API: authenticator logs in, switches to anon)
 *   - SQL:  WORK statements in one new `postgres` session through the shared
 *           pooler (Supavisor, session mode, 5432), then WORK more in one
 *           direct session (db.<ref>.supabase.co:5432, IPv6). Each session
 *           first records the log settings it is actually running with and
 *           its backend's age, because a pooler can hand out a server
 *           connection opened before the role setting changed.
 *
 *   LV02a  defaults (log_statement=ddl, log_min_duration_statement=-1)
 *   LV02b  postgres:      log_statement = 'all'
 *   LV02c  authenticator: log_statement = 'all'
 *   LV02d  anon:          log_statement = 'all'
 *   LV02e  postgres:      log_min_duration_statement = 0
 *   LV02f  authenticator: log_min_duration_statement = 0
 *   LV02g  postgres:      pgaudit.log = 'all'
 *   LV02h  defaults, an RPC that does RAISE NOTICE, called WORK times over REST
 *   LV02i  defaults, an RPC that does RAISE LOG, called WORK times over REST
 *   LV02j  `alter role authenticator reset all` after setting log_statement:
 *          does the setting survive (read back from pg_db_role_setting)?
 *
 * Reported per condition: postgres_logs rows and size proxy per REST request
 * and per SQL statement (window counts; the defaults row is the baseline).
 * Pass/fail: none. Not settled: log_connections / log_disconnections (listed
 * as CLI only on the custom-postgres-config docs page), auto_explain, the Dashboard's
 * project-level config path, statements run by platform roles.
 *
 * DESTRUCTIVE: creates and deletes one project; runs about 14-17 minutes.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { dropProject, makeProject, sleep, sql } from "../../observability-surface/lib/ob";
import { PREFIX, directSession, footprint, hist, postgresSession, sendN } from "../lib/lv";

const WORK = Number(process.env.LV02_WORK ?? 50);
const DRAIN_MS = 45_000;

interface Cond {
  id: string;
  label: string;
  set: string[];
  reset: string[];
  rpc?: "lv_notice" | "lv_log";
}

const CONDS: Cond[] = [
  { id: "LV02a", label: "defaults", set: [], reset: [] },
  { id: "LV02b", label: "postgres log_statement=all", set: ["alter role postgres set log_statement = 'all'"], reset: ["alter role postgres reset log_statement"] },
  { id: "LV02c", label: "authenticator log_statement=all", set: ["alter role authenticator set log_statement = 'all'"], reset: ["alter role authenticator reset log_statement"] },
  { id: "LV02d", label: "anon log_statement=all", set: ["alter role anon set log_statement = 'all'"], reset: ["alter role anon reset log_statement"] },
  { id: "LV02e", label: "postgres log_min_duration_statement=0", set: ["alter role postgres set log_min_duration_statement = 0"], reset: ["alter role postgres reset log_min_duration_statement"] },
  { id: "LV02f", label: "authenticator log_min_duration_statement=0", set: ["alter role authenticator set log_min_duration_statement = 0"], reset: ["alter role authenticator reset log_min_duration_statement"] },
  { id: "LV02g", label: "postgres pgaudit.log=all", set: ["alter role postgres set pgaudit.log = 'all'"], reset: ["alter role postgres reset pgaudit.log"] },
  { id: "LV02h", label: "defaults, RPC with RAISE NOTICE", set: [], reset: [], rpc: "lv_notice" },
  { id: "LV02i", label: "defaults, RPC with RAISE LOG", set: [], reset: [], rpc: "lv_log" },
];

const mod: TestModule = {
  id: "LV02",
  title: "Postgres logging knobs: postgres_logs added per statement, and which role reaches Data API traffic",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "LV02", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    let ref = "";
    try {
      const proj = await makeProject(ctx, "lv02", PREFIX);
      ref = proj.ref;
      const pc = proj.ctx;
      const url = `https://${pc.apiHost}`;
      const anon = { apikey: pc.anonKey!, authorization: `Bearer ${pc.anonKey}` };
      const ddl = await sql(
        pc,
        `create table public.lv2(id int primary key, v text); insert into public.lv2 values (1, 'seed');
         alter table public.lv2 enable row level security; create policy lv2_read on public.lv2 for select to anon using (true);
         create or replace function public.lv_notice(m text) returns int language plpgsql as $$ begin raise notice 'lv notice %', m; return 1; end $$;
         create or replace function public.lv_log(m text) returns int language plpgsql as $$ begin raise log 'lv log %', m; return 1; end $$;
         grant execute on function public.lv_notice(text), public.lv_log(text) to anon;
         notify pgrst, 'reload schema';`,
      );
      if (ddl.status >= 300) throw new Error(`ddl: ${ddl.error}`);
      const admin = await postgresSession(pc, ref);
      const settings = (await admin.query("select name, setting from pg_settings where name in ('log_statement','log_min_duration_statement','log_min_messages','log_connections','shared_preload_libraries')")).rows as Array<{ name: string; setting: string }>;
      await sleep(10_000);

      const rows: Array<{ c: Cond; m: Record<string, number | string>; paths: Record<string, { t0: number; t1: number; err: string; seen: string }> }> = [];
      for (const c of CONDS) {
        const errs: string[] = [];
        for (const s of c.set) await admin.query(s).catch((e: Error) => errs.push(`${s}: ${e.message}`));
        await sleep(DRAIN_MS);
        const tag = `lv${c.id.slice(-1)}${Date.now().toString(36)}`;
        // REST window
        const r0 = Date.now();
        const restHist = c.rpc
          ? await sendN(WORK, (i) => fetch(`${url}/rest/v1/rpc/${c.rpc}`, { method: "POST", headers: { ...anon, "content-type": "application/json" }, body: JSON.stringify({ m: `${tag}-${i}` }) }))
          : await sendN(WORK, (i) => fetch(`${url}/rest/v1/lv2?select=id&v=neq.${tag}-${i}`, { headers: anon }));
        const r1 = Date.now();
        await sleep(5000);
        // SQL windows: one new `postgres` session per path (role settings apply at
        // server-session start). Each records the settings it actually runs with.
        const paths: Record<string, { t0: number; t1: number; err: string; seen: string }> = {};
        if (!c.rpc) {
          for (const path of ["pooler", "direct"] as const) {
            const t0 = Date.now();
            let err = "";
            let seen = "";
            try {
              const sess = path === "pooler" ? await postgresSession(pc, ref) : await directSession(pc, ref);
              try {
                const st = (await sess.query("select current_setting('log_statement') as ls, current_setting('log_min_duration_statement') as lmd, current_setting('pgaudit.log', true) as pa, (select backend_start from pg_stat_activity where pid = pg_backend_pid()) as bs")).rows[0] as { ls: string; lmd: string; pa: string | null; bs: Date };
                seen = `log_statement=${st.ls} log_min_duration_statement=${st.lmd} pgaudit.log=${st.pa ?? "-"} backend_age_s=${Math.round((Date.now() - new Date(st.bs).getTime()) / 1000)}`;
                for (let i = 0; i < WORK; i++) await sess.query(`select '${tag}-${path}-${i}' as m, count(*) from public.lv2`);
              } finally {
                await sess.end().catch(() => null);
              }
            } catch (e) {
              err = (e as Error).message;
            }
            paths[path] = { t0, t1: Date.now(), err, seen };
            await sleep(6000);
          }
        }
        // the reset is itself a logged DDL statement; keep it out of every padded window
        await sleep(6000);
        for (const s of c.reset) await admin.query(s).catch((e: Error) => errs.push(`${s}: ${e.message}`));
        rows.push({ c, m: { r0, r1, rest_status: hist(restHist), set_errors: errs.join("; ") || "none" }, paths });
        await sleep(5000);
      }

      // LV02j: does `reset all` clear a role setting set through supautils?
      await admin.query("alter role authenticator set log_statement = 'all'");
      const resetAll = await admin.query("alter role authenticator reset all").then(
        () => "ok",
        (e: Error) => e.message,
      );
      const after = (await admin.query("select coalesce(array_to_string(setconfig, ', '), '') as cfg from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'authenticator'")).rows[0] as { cfg?: string } | undefined;
      await admin.query("alter role authenticator reset log_statement");
      const cleared = (await admin.query("select coalesce(array_to_string(setconfig, ', '), '') as cfg from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'authenticator'")).rows[0] as { cfg?: string } | undefined;
      await admin.end();

      await sleep(180_000); // ingestion tail
      for (const { c, m, paths } of rows) {
        const rest = await footprint(pc, Number(m.r0) - 1000, Number(m.r1) + 5000, "source = 'postgres_logs'");
        await sleep(1500);
        const pr = rest.counts[0] ?? { rows: 0, bytes: 0 };
        const meas: Record<string, number | string> = {
          work: WORK,
          rest_status: m.rest_status as string,
          rest_window_postgres_logs_rows: pr.rows,
          rest_postgres_logs_rows_per_request: Math.round((pr.rows / WORK) * 100) / 100,
          rest_postgres_logs_bytes_per_request: Math.round(pr.bytes / WORK),
          set_errors: m.set_errors as string,
        };
        let err = rest.error;
        for (const [path, p] of Object.entries(paths)) {
          const sq = await footprint(pc, p.t0 - 1000, p.t1 + 5000, "source = 'postgres_logs'");
          await sleep(1500);
          const ps = sq.counts[0] ?? { rows: 0, bytes: 0 };
          err ||= sq.error;
          meas[`sql_${path}_session_settings`] = p.seen || "n/a";
          meas[`sql_${path}_postgres_logs_rows`] = ps.rows;
          meas[`sql_${path}_rows_per_statement`] = Math.round((ps.rows / WORK) * 100) / 100;
          meas[`sql_${path}_bytes_per_statement`] = Math.round(ps.bytes / WORK);
          meas[`sql_${path}_error`] = p.err || "none";
        }
        out.push({ id: c.id, title: `${c.id}: ${c.label}`, status: err ? "fail" : "info", detail: err || undefined, measurements: meas });
      }
      out.push({
        id: "LV02j",
        title: "LV02j: `alter role authenticator reset all` after setting log_statement",
        status: "info",
        measurements: {
          reset_all_result: resetAll,
          authenticator_config_after_reset_all: after?.cfg ?? "(no row)",
          authenticator_config_after_reset_log_statement: cleared?.cfg ?? "(no row)",
          defaults: settings.map((s) => `${s.name}=${s.setting}`).join(", "),
        },
      });
    } catch (e) {
      out.push({ id: "LV02", title: "LV02", status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await dropProject(ctx, ref);
    }
    return out;
  },
};
export default mod;
