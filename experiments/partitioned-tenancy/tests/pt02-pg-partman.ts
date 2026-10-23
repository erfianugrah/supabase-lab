/**
 * PT02 - pg_partman on a managed project: does the documented setup run, can
 * maintenance be scheduled, and do children pg_partman creates carry the
 * parent's RLS and grants?
 *
 * SIDE: managed Pro-org Micro project (lib/project.ts). KEYS: SQL as postgres
 * through the Management query endpoint and the session pooler (port 5432);
 * Data API reads with the legacy anon JWT. Docs under test:
 * guides/database/extensions/pg_partman (schema `partman`, create_parent with
 * p_type 'range', run_maintenance_proc, pg_cron schedule).
 *
 *   PT02a  pg_available_extensions rows for pg_partman*, installed version
 *          after the documented `create extension ... with schema partman`,
 *          shared_preload_libraries and pg_partman_bgw.* settings (is the
 *          background worker loaded?).
 *   PT02b  create_parent on public.pm_events (daily, premake 3, start 10 days
 *          back) whose parent has RLS + a tenant policy: children created,
 *          default partition, template table, inherit_privileges default.
 *   PT02c  the children: relrowsecurity, policy count, anon SELECT privilege,
 *          and an anon Data API read of today's child.
 *   PT02d  run_maintenance_proc through the Management query endpoint and
 *          through a session connection (CALL with internal COMMITs).
 *   PT02e  RLS enabled on the template table + inherit_privileges = true,
 *          premake raised, maintenance run: do the NEW children get RLS?
 *   PT02f  pg_cron job `call partman.run_maintenance_proc()` every minute:
 *          job_run_details status and children added, then unscheduled.
 *   PT02g  retention '5 days' with retention_keep_table = true: children
 *          detached, detached tables still present and anon-readable via
 *          the Data API? Then keep_table = false at '3 days': dropped.
 *
 * Everything here is `info` except setup steps the docs promise (PT02a create,
 * PT02b create_parent, PT02d manual maintenance), which pass/fail.
 *
 * DESTRUCTIVE: creates schema partman, extensions pg_partman and pg_cron, and
 * tables on the shared PT project; PT99 deletes the project.
 *
 * Not settled here: pg_partman sub-partitioning, LIST/id-based sets, or
 * maintenance cost on large children.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  awaitExposed,
  brief,
  codeOf,
  currentProject,
  ensureProject,
  pgSession,
  rest,
  rowCount,
  skipWithoutPro,
  sleep,
  sql,
  sqlOk,
  tenantsSeen,
  type PtProject,
} from "../lib/project.js";

const CHILDREN = `select count(*)::int as n from pg_inherits where inhparent = 'public.pm_events'::regclass`;
const CHILD_META = `
select c.relname, c.relrowsecurity as rls,
  (select count(*) from pg_policy pol where pol.polrelid = c.oid)::int as policies,
  has_table_privilege('anon', c.oid, 'select') as anon_select
from pg_inherits i join pg_class c on c.oid = i.inhrelid
where i.inhparent = 'public.pm_events'::regclass order by c.relname`;

async function count(ctx: Ctx, p: PtProject, q: string): Promise<number> {
  const r = await sqlOk(ctx, p.ref, q);
  return Number(r[0]?.n ?? -1);
}

const mod: TestModule = {
  id: "PT02",
  title: "pg_partman setup, maintenance and what its children inherit",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "PT02");
    if (skip) return skip;
    const results: TestResult[] = [];
    let p: PtProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "PT02", title: "PT02", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const red = (s: string) => brief(currentProject(), s, 300);
    try {
      // ---- PT02a ----
      const avail = await sqlOk(ctx, p.ref, `select name, default_version from pg_available_extensions where name like 'pg_partman%' order by 1`);
      const create = await sql(ctx, p.ref, `create schema if not exists partman; create extension if not exists pg_partman with schema partman;`);
      const inst = await sql(ctx, p.ref, `select extversion as v from pg_extension where extname = 'pg_partman'`);
      const spl = await sql(ctx, p.ref, `select setting as s from pg_settings where name = 'shared_preload_libraries'`);
      const bgw = await sql(ctx, p.ref, `select count(*)::int as n from pg_settings where name like 'pg_partman_bgw%'`);
      const splText = String(spl.rows?.[0]?.s ?? spl.error ?? "");
      results.push({
        id: "PT02a",
        title: "PT02a: pg_partman availability and the documented create extension",
        status: create.status < 300 && inst.rows?.[0]?.v ? "pass" : "fail",
        detail: `available: ${avail.map((r) => `${r.name}@${r.default_version}`).join(",") || "none"}; create ${create.status} ${red(create.error ?? "")}; installed ${String(inst.rows?.[0]?.v ?? "")}; pg_partman_bgw in shared_preload_libraries=${splText.includes("pg_partman_bgw")}; pg_partman_bgw.* settings=${String(bgw.rows?.[0]?.n ?? "?")}`,
        measurements: {
          partman_available: avail.map((r) => `${r.name}@${r.default_version}`).join(","),
          partman_create_status: create.status,
          partman_installed: String(inst.rows?.[0]?.v ?? ""),
          bgw_preloaded: splText.includes("pg_partman_bgw") ? 1 : 0,
          bgw_settings: Number(bgw.rows?.[0]?.n ?? -1),
        },
      });

      // ---- PT02b ----
      await sqlOk(
        ctx,
        p.ref,
        `create table public.pm_events (
           id bigint generated by default as identity,
           tenant_id int not null,
           created_at timestamptz not null,
           payload jsonb,
           primary key (created_at, id)
         ) partition by range (created_at);
         alter table public.pm_events enable row level security;
         create policy tenant_read on public.pm_events for select to authenticated
           using (tenant_id = (select (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::int));`,
      );
      const cp = await sql(
        ctx,
        p.ref,
        `select partman.create_parent(
           p_parent_table := 'public.pm_events',
           p_control := 'created_at',
           p_type := 'range',
           p_interval := '1 day',
           p_premake := 3,
           p_start_partition := to_char(now() - interval '10 days', 'YYYY-MM-DD')
         ) as ok`,
      );
      const cfg = await sql(
        ctx,
        p.ref,
        `select template_table, inherit_privileges::text as inherit_privileges, premake, coalesce(retention, '') as retention
         from partman.part_config where parent_table = 'public.pm_events'`,
      );
      const nAfterCreate = await count(ctx, p, CHILDREN);
      const hasDefault = await count(ctx, p, `select count(*)::int as n from pg_class where relname = 'pm_events_default'`);
      const c0 = cfg.rows?.[0] ?? {};
      results.push({
        id: "PT02b",
        title: "PT02b: create_parent on an RLS-enabled parent (daily, premake 3, start 10 days back)",
        status: cp.status < 300 && nAfterCreate > 0 ? "pass" : "fail",
        detail: `create_parent ${cp.status} ${red(cp.error ?? "")}; children=${nAfterCreate}; default partition=${hasDefault}; template=${String(c0.template_table ?? "")}; inherit_privileges=${String(c0.inherit_privileges ?? "")}`,
        measurements: {
          create_parent_status: cp.status,
          children_after_create: nAfterCreate,
          default_partition: hasDefault,
          template_table: String(c0.template_table ?? ""),
          inherit_privileges_default: String(c0.inherit_privileges ?? ""),
        },
      });

      // ---- PT02c ----
      await sqlOk(
        ctx,
        p.ref,
        `insert into public.pm_events (tenant_id, created_at, payload)
         select t, now() - make_interval(days => d) + interval '1 minute', jsonb_build_object('d', d)
         from generate_series(0, 9) d, generate_series(1, 2) t`,
      );
      const meta = await sqlOk(ctx, p.ref, CHILD_META);
      const today = String((await sqlOk(ctx, p.ref, `select 'pm_events_p' || to_char(now(), 'YYYYMMDD') as t`))[0]?.t);
      const exp = await awaitExposed(ctx, p, `/rest/v1/${today}?select=id&limit=1`, 45_000);
      const aChild = await rest(p.host, `/rest/v1/${today}?select=id,tenant_id`, p.keys.anon);
      const childCode = codeOf(aChild);
      const aParent = await rest(p.host, `/rest/v1/pm_events?select=id,tenant_id`, p.keys.anon);
      const withRls = meta.filter((r) => r.rls === true).length;
      const withPol = meta.filter((r) => Number(r.policies) > 0).length;
      const anonSel = meta.filter((r) => r.anon_select === true).length;
      results.push({
        id: "PT02c",
        title: "PT02c: what pg_partman's children carry (RLS, policies, anon grant)",
        status: "info",
        detail: `children ${meta.length}: rls on ${withRls}, with policies ${withPol}, anon select ${anonSel}; anon read of ${today.replace(/\d{8}$/, "<today>")} ${aChild.status} rows=${rowCount(aChild)} [${tenantsSeen(aChild)}] (cache ${exp}s); anon via parent rows=${rowCount(aParent)}`,
        measurements: {
          children: meta.length,
          children_rls_on: withRls,
          children_with_policies: withPol,
          children_anon_select: anonSel,
          child_anon_status: aChild.status,
          child_anon_code: childCode,
          child_anon_rows: rowCount(aChild),
          child_anon_tenants: tenantsSeen(aChild),
          parent_anon_rows: rowCount(aParent),
        },
      });

      // ---- PT02d ----
      const before = await count(ctx, p, CHILDREN);
      await sqlOk(ctx, p.ref, `update partman.part_config set premake = 5 where parent_table = 'public.pm_events'`);
      const viaApi = await sql(ctx, p.ref, `call partman.run_maintenance_proc()`);
      const afterApi = await count(ctx, p, CHILDREN);
      await sqlOk(ctx, p.ref, `update partman.part_config set premake = 7 where parent_table = 'public.pm_events'`);
      const s = await pgSession(p);
      const viaSession = await s.query(`call partman.run_maintenance_proc()`);
      await s.close();
      const afterSession = await count(ctx, p, CHILDREN);
      results.push({
        id: "PT02d",
        title: "PT02d: run_maintenance_proc via the Management query endpoint and via a session",
        status: afterSession > afterApi || afterApi > before ? "pass" : "fail",
        detail: `children ${before}; premake 5 + CALL via query endpoint: ${viaApi.status} ${red(viaApi.error ?? "")} -> ${afterApi}; premake 7 + CALL via session pooler: ${viaSession.error ? `${viaSession.code} ${red(viaSession.error)}` : "ok"} (${viaSession.ms} ms) -> ${afterSession}`,
        measurements: {
          maint_api_status: viaApi.status,
          maint_api_error: (viaApi.error ?? "").slice(0, 120),
          children_before: before,
          children_after_api: afterApi,
          maint_session_ok: viaSession.error ? 0 : 1,
          maint_session_ms: viaSession.ms,
          children_after_session: afterSession,
        },
      });

      // ---- PT02e ----
      const tmpl = String(c0.template_table ?? "");
      const known = new Set(meta.map((r) => String(r.relname)));
      for (const r of await sqlOk(ctx, p.ref, CHILD_META)) known.add(String(r.relname));
      const tmplRls = tmpl ? await sql(ctx, p.ref, `alter table ${tmpl} enable row level security`) : { status: 0, error: "no template" };
      await sqlOk(ctx, p.ref, `update partman.part_config set inherit_privileges = true, premake = 9 where parent_table = 'public.pm_events'`);
      const s2 = await pgSession(p);
      const m2 = await s2.query(`call partman.run_maintenance_proc()`);
      await s2.close();
      const meta2 = (await sqlOk(ctx, p.ref, CHILD_META)).filter((r) => !known.has(String(r.relname)));
      results.push({
        id: "PT02e",
        title: "PT02e: RLS on the template table + inherit_privileges, then new children",
        status: "info",
        detail: `template rls ${tmplRls.status} ${red(tmplRls.error ?? "")}; maintenance ${m2.error ? red(m2.error) : "ok"}; new children ${meta2.length}: rls on ${meta2.filter((r) => r.rls === true).length}, with policies ${meta2.filter((r) => Number(r.policies) > 0).length}, anon select ${meta2.filter((r) => r.anon_select === true).length}`,
        measurements: {
          template_rls_status: tmplRls.status,
          new_children: meta2.length,
          new_children_rls_on: meta2.filter((r) => r.rls === true).length,
          new_children_with_policies: meta2.filter((r) => Number(r.policies) > 0).length,
          new_children_anon_select: meta2.filter((r) => r.anon_select === true).length,
        },
      });

      // ---- PT02f ----
      const cron = await sql(ctx, p.ref, `create extension if not exists pg_cron`);
      await sqlOk(ctx, p.ref, `update partman.part_config set premake = 12 where parent_table = 'public.pm_events'`);
      const beforeCron = await count(ctx, p, CHILDREN);
      const job = await sql(ctx, p.ref, `select cron.schedule('pt-partman-maint', '* * * * *', $$call partman.run_maintenance_proc()$$) as id`);
      const jobId = Number(job.rows?.[0]?.id ?? -1);
      const t0 = Date.now();
      let runs: Record<string, unknown>[] = [];
      while (Date.now() - t0 < 180_000) {
        await sleep(15_000);
        runs = (await sql(ctx, p.ref, `select status, coalesce(return_message, '') as msg from cron.job_run_details where jobid = ${jobId} order by start_time`)).rows ?? [];
        if (runs.some((r) => r.status === "succeeded" || r.status === "failed")) break;
      }
      const waitedS = Math.round((Date.now() - t0) / 1000);
      const afterCron = await count(ctx, p, CHILDREN);
      await sql(ctx, p.ref, `select cron.unschedule('pt-partman-maint')`);
      const r0 = runs.find((r) => r.status === "succeeded" || r.status === "failed") ?? runs[0] ?? {};
      results.push({
        id: "PT02f",
        title: "PT02f: maintenance scheduled with pg_cron (every minute)",
        status: "info",
        detail: `pg_cron create ${cron.status} ${red(cron.error ?? "")}; schedule ${job.status} ${red(job.error ?? "")}; first run ${String(r0.status ?? "none")} "${red(String(r0.msg ?? ""))}" after <=${waitedS}s; children ${beforeCron} -> ${afterCron}`,
        measurements: {
          cron_create_status: cron.status,
          cron_schedule_status: job.status,
          cron_first_status: String(r0.status ?? "none"),
          cron_first_message: red(String(r0.msg ?? "")).slice(0, 120),
          cron_wait_s: waitedS,
          children_before_cron: beforeCron,
          children_after_cron: afterCron,
        },
      });

      // ---- PT02g ----
      const beforeRet = await count(ctx, p, CHILDREN);
      await sqlOk(ctx, p.ref, `update partman.part_config set retention = '5 days', retention_keep_table = true where parent_table = 'public.pm_events'`);
      const s3 = await pgSession(p);
      const m3 = await s3.query(`call partman.run_maintenance_proc()`);
      const afterKeep = await count(ctx, p, CHILDREN);
      const detached = await sqlOk(
        ctx,
        p.ref,
        `select c.relname, c.relrowsecurity as rls, has_table_privilege('anon', c.oid, 'select') as anon_select, c.reltuples
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'pm_events_p%'
           and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid) order by 1`,
      );
      // Run 1 read the oldest detached table, which held no rows; read the newest one (rows inserted up to 9 days back).
      let detAnon = { status: 0, rows: -1, tenants: "", cacheS: -1, table: "" };
      if (detached.length) {
        const t = String(detached[detached.length - 1]?.relname);
        detAnon.table = t;
        const cacheS = await awaitExposed(ctx, p, `/rest/v1/${t}?select=id&limit=1`, 45_000);
        const r = await rest(p.host, `/rest/v1/${t}?select=id,tenant_id`, p.keys.anon);
        const n = Number((await sqlOk(ctx, p.ref, `select count(*)::int as n from public.${t}`))[0]?.n ?? -1);
        detAnon = { status: r.status, rows: rowCount(r), tenants: tenantsSeen(r), cacheS, table: `${t.replace(/\d{8}$/, "<date>")} holding ${n} rows` };
      }
      await sqlOk(ctx, p.ref, `update partman.part_config set retention = '3 days', retention_keep_table = false where parent_table = 'public.pm_events'`);
      const m4 = await s3.query(`call partman.run_maintenance_proc()`);
      await s3.close();
      const afterDrop = await count(ctx, p, CHILDREN);
      const leftDetached = await count(
        ctx,
        p,
        `select count(*)::int as n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
           and c.relname like 'pm_events_p%' and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)`,
      );
      results.push({
        id: "PT02g",
        title: "PT02g: retention - detach and keep, then drop",
        status: "info",
        detail: `children ${beforeRet}; retention 5 days keep_table: ${m3.error ? red(m3.error) : "ok"} -> ${afterKeep} attached, ${detached.length} detached kept (rls on ${detached.filter((r) => r.rls === true).length}, anon select ${detached.filter((r) => r.anon_select === true).length}); anon read of the newest detached table (${detAnon.table}) ${detAnon.status} rows=${detAnon.rows} tenants [${detAnon.tenants}] (schema cache ${detAnon.cacheS}s); retention 3 days drop: ${m4.error ? red(m4.error) : "ok"} -> ${afterDrop} attached, ${leftDetached} detached tables left`,
        measurements: {
          children_before_retention: beforeRet,
          children_after_keep: afterKeep,
          detached_kept: detached.length,
          detached_rls_on: detached.filter((r) => r.rls === true).length,
          detached_anon_select: detached.filter((r) => r.anon_select === true).length,
          detached_anon_status: detAnon.status,
          detached_anon_rows: detAnon.rows,
          detached_anon_tenants: detAnon.tenants,
          detached_read_table: detAnon.table,
          detached_schema_cache_s: detAnon.cacheS,
          children_after_drop: afterDrop,
          detached_left_after_drop: leftDetached,
        },
      });
    } catch (e) {
      results.push({ id: "PT02", title: "PT02", status: "fail", detail: red(e instanceof Error ? e.message : String(e)) });
    }
    return results;
  },
};
export default mod;
