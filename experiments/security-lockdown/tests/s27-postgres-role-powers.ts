/**
 * S27 - what the project's `postgres` role can do with roles it creates
 * Role-management steps with no run behind them: a
 * restore role with CREATEDB, an analytics login with BYPASSRLS and
 * pg_read_all_data, changing a cron job's user.
 *
 *   S27a  `create role` as postgres: the pg_auth_members row PostgreSQL 16+
 *         adds for the creator (admin / inherit / set options and grantor),
 *         whether postgres can SET ROLE to it, self-grant it, and drop its own
 *         ADMIN OPTION
 *   S27b  attributes postgres can hand out: LOGIN, CREATEDB, CREATEROLE,
 *         BYPASSRLS, REPLICATION; and pg_read_all_data / pg_write_all_data
 *   S27c  a BYPASSRLS + pg_read_all_data login: what it reads from an RLS
 *         table with no matching policy, and a password rotation
 *   S27d  `create database` as postgres
 *   S27e  cron.alter_job changing a job's username, and cron.schedule_in_database
 *         naming another user
 *   S27f  roles present on a fresh project that other answers named
 *         (supabase_etl_admin)
 *
 * Every statement runs on one connection as postgres through the Supavisor
 * session pooler (IPv4), not the Management API route. Each probe records the
 * SQLSTATE or ok. Self-provisioned Pro-org Micro, deleted in finally.
 * Passwords are generated here and never written to results.
 */
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { createProject, deleteProject, sleep } from "../lib/project.js";

const pw = () => `${crypto.randomUUID().replaceAll("-", "")}Xy9`;

async function connect(host: string, user: string, password: string): Promise<Client> {
  const c = new Client({
    host, port: 5432, user, password, database: "postgres",
    ssl: { rejectUnauthorized: false, servername: host },
    connectionTimeoutMillis: 15_000, query_timeout: 30_000, application_name: "pvlab-s27",
  });
  c.on("error", () => {});
  await c.connect();
  return c;
}

/** Run one statement; "ok" or the SQLSTATE plus a short message. */
async function tryq(c: Client, sql: string): Promise<{ ok: boolean; tag: string; rows: Record<string, unknown>[] }> {
  try {
    const r = await c.query(sql);
    return { ok: true, tag: "ok", rows: r.rows as Record<string, unknown>[] };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, tag: `${err.code ?? "?"} ${(err.message ?? "").slice(0, 90)}`, rows: [] };
  }
}

const mod: TestModule = {
  id: "S27",
  title: "postgres and the roles it creates: membership options, grantable attributes, BYPASSRLS readers, create database, cron users",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 30 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    if (!ctx.orgs.pro) return [{ id: "S27", title: mod.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    let c: Client | undefined;
    try {
      const p = await createProject(ctx, "pvlab-s27-", (r) => {
        ref = r;
        ctx.log(`S27 project ${r}`);
      });
      // Supavisor can refuse a brand-new tenant for a few seconds.
      for (let i = 0; i < 12 && !c; i++) {
        try { c = await connect(p.poolerHost, p.poolerUser, p.dbPass); } catch { await sleep(5_000); }
      }
      if (!c) throw new Error("could not connect as postgres through the session pooler");
      const me = await tryq(c, "select current_user::text as u, (select rolsuper from pg_roles where rolname = current_user) as su, (select rolcreaterole from pg_roles where rolname = current_user) as cr, (select rolcreatedb from pg_roles where rolname = current_user) as cdb, (select rolbypassrls from pg_roles where rolname = current_user) as bypass, current_setting('createrole_self_grant') as self_grant");
      const m = me.rows[0] ?? {};
      out.push({
        id: "S27s",
        title: "Setup: connected as postgres through the session pooler",
        status: me.ok ? "info" : "fail",
        detail: `created in ${p.createS} s, ${p.pgVersion}. current_user ${String(m.u)}, superuser ${String(m.su)}, createrole ${String(m.cr)}, createdb ${String(m.cdb)}, bypassrls ${String(m.bypass)}, createrole_self_grant '${String(m.self_grant)}'.`,
        measurements: { pg: p.pgVersion, rolsuper: String(m.su), rolcreaterole: String(m.cr), rolcreatedb: String(m.cdb), rolbypassrls: String(m.bypass), createrole_self_grant: String(m.self_grant ?? "") },
      });

      // ---------------- S27a: the creator's membership in a role it creates.
      const mk = await tryq(c, "create role sec27_r nologin");
      const mem = await tryq(c, `
select m.admin_option, m.inherit_option, m.set_option, g.rolname as grantor
from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member join pg_roles g on g.oid = m.grantor
where r.rolname = 'sec27_r' and u.rolname = current_user`);
      const row = mem.rows[0] ?? {};
      const setRole = await tryq(c, "set role sec27_r");
      await tryq(c, "reset role");
      const selfGrant = await tryq(c, "grant sec27_r to postgres with set true, inherit true");
      const setAfter = await tryq(c, "set role sec27_r");
      await tryq(c, "reset role");
      const dropAdmin = await tryq(c, "revoke admin option for sec27_r from postgres");
      const memAfter = await tryq(c, `select g.rolname as grantor, m.admin_option, m.set_option from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member join pg_roles g on g.oid = m.grantor where r.rolname = 'sec27_r' and u.rolname = current_user order by g.rolname`);
      const ma = { n: memAfter.rows.length, rows: memAfter.rows.map((x) => `${String(x.grantor)}(admin ${String(x.admin_option)}, set ${String(x.set_option)})`).join(", ") };
      const dropRole = await tryq(c, "drop role sec27_r");
      out.push({
        id: "S27a",
        title: "postgres's membership in a role it creates",
        status: mk.ok ? "info" : "fail",
        detail: `create role sec27_r -> ${mk.tag}. Rows for postgres in pg_auth_members: ${mem.rows.length}; admin_option ${String(row.admin_option)}, inherit_option ${String(row.inherit_option)}, set_option ${String(row.set_option)}, grantor ${String(row.grantor)}. SET ROLE sec27_r -> ${setRole.tag}. Self-grant WITH SET TRUE, INHERIT TRUE -> ${selfGrant.tag}; SET ROLE after -> ${setAfter.tag}. REVOKE ADMIN OPTION FOR sec27_r FROM postgres -> ${dropAdmin.tag}; rows after ${ma.n}: ${ma.rows}. DROP ROLE -> ${dropRole.tag}.`,
        measurements: {
          create_role: mk.tag, membership_rows: mem.rows.length, admin_option: String(row.admin_option), inherit_option: String(row.inherit_option),
          set_option: String(row.set_option), grantor: String(row.grantor ?? ""), set_role_before_self_grant: setRole.tag, self_grant: selfGrant.tag,
          set_role_after_self_grant: setAfter.tag, revoke_own_admin: dropAdmin.tag, rows_after_revoke: ma.rows, drop_role: dropRole.tag,
        },
      });

      // ---------------- S27b: attributes and predefined roles postgres can hand out.
      const attrs: Record<string, string> = {};
      for (const a of ["login", "createdb", "createrole", "bypassrls", "replication"]) {
        const r = await tryq(c, `create role sec27_attr_${a} ${a}`);
        attrs[a] = r.tag;
        await tryq(c, `drop role if exists sec27_attr_${a}`);
      }
      await tryq(c, "create role sec27_g nologin");
      const readAll = await tryq(c, "grant pg_read_all_data to sec27_g");
      const writeAll = await tryq(c, "grant pg_write_all_data to sec27_g");
      const signal = await tryq(c, "grant pg_signal_backend to sec27_g");
      await tryq(c, "drop role if exists sec27_g");
      out.push({
        id: "S27b",
        title: "role attributes and predefined roles postgres can grant",
        status: "info",
        detail: `create role with: ${Object.entries(attrs).map(([k, v]) => `${k} -> ${v}`).join("; ")}. grant pg_read_all_data -> ${readAll.tag}; pg_write_all_data -> ${writeAll.tag}; pg_signal_backend -> ${signal.tag}.`,
        measurements: { ...Object.fromEntries(Object.entries(attrs).map(([k, v]) => [`attr_${k}`, v])), grant_read_all: readAll.tag, grant_write_all: writeAll.tag, grant_signal_backend: signal.tag },
      });

      // ---------------- S27c: a BYPASSRLS + pg_read_all_data login reading an RLS table.
      const pw1 = pw();
      const pw2 = pw();
      const setupC = await tryq(c, `
create table public.sec27_secret (id int primary key, body text);
insert into public.sec27_secret values (1, 'a'), (2, 'b');
alter table public.sec27_secret enable row level security;
alter table public.sec27_secret force row level security;
create role sec27_reader login bypassrls password '${pw1}';
grant pg_read_all_data to sec27_reader;`);
      const readerUser = p.poolerUser.replace(/^postgres\./, "sec27_reader.");
      let readerRows = -1;
      let readerTag = "";
      let writeTag = "";
      try {
        const rc = await connect(p.poolerHost, readerUser, pw1);
        const r = await tryq(rc, "select count(*)::int as n from public.sec27_secret");
        readerRows = Number(r.rows[0]?.n ?? -1);
        readerTag = r.tag;
        writeTag = (await tryq(rc, "insert into public.sec27_secret values (3, 'c')")).tag;
        await rc.end();
      } catch (e) {
        readerTag = `connect: ${(e as Error).message.slice(0, 80)}`;
      }
      const rotate = await tryq(c, `alter role sec27_reader password '${pw2}'`);
      const t0 = Date.now();
      let newOkS = -1;
      let oldRefusedS = -1;
      let oldCode = "";
      while (Date.now() - t0 < 60_000 && (newOkS < 0 || oldRefusedS < 0)) {
        if (newOkS < 0) { try { const x = await connect(p.poolerHost, readerUser, pw2); await x.end(); newOkS = (Date.now() - t0) / 1000; } catch { /* not yet */ } }
        if (oldRefusedS < 0) { try { const x = await connect(p.poolerHost, readerUser, pw1); await x.end(); } catch (e) { oldRefusedS = (Date.now() - t0) / 1000; oldCode = String((e as { code?: string }).code ?? (e as Error).message.slice(0, 40)); } }
        await sleep(1_000);
      }
      out.push({
        id: "S27c",
        title: "a BYPASSRLS + pg_read_all_data login made by postgres reads past RLS; rotation through the session pooler",
        status: setupC.ok ? "info" : "fail",
        detail: `Setup (table with RLS enabled and FORCED, no policy; role LOGIN BYPASSRLS + pg_read_all_data) -> ${setupC.tag}. As sec27_reader over Supavisor session 5432: count -> ${readerTag}, ${readerRows} of 2 rows; insert -> ${writeTag}. alter role ... password -> ${rotate.tag}; new password first accepted at ${newOkS.toFixed(1)} s, first failed connect with the old one at ${oldRefusedS.toFixed(1)} s (error ${oldCode}; 1 s poll plus connect time, session pooler only).`,
        measurements: { setup: setupC.tag, reader_rows: readerRows, reader_select: readerTag, reader_insert: writeTag, rotate: rotate.tag, new_pw_ok_s: Number(newOkS.toFixed(1)), old_pw_refused_s: Number(oldRefusedS.toFixed(1)), old_pw_error: oldCode },
      });

      // ---------------- S27d: create database.
      const cdb = await tryq(c, "create database sec27_db");
      const dbs = await tryq(c, "select datname from pg_database where datname = 'sec27_db'");
      const ddb = cdb.ok ? await tryq(c, "drop database sec27_db") : { tag: "-" };
      out.push({
        id: "S27d",
        title: "create database as postgres",
        status: "info",
        detail: `create database sec27_db -> ${cdb.tag}; listed in pg_database ${dbs.rows.length === 1}; drop -> ${ddb.tag}.`,
        measurements: { create_database: cdb.tag, listed: String(dbs.rows.length === 1), drop_database: ddb.tag },
      });

      // ---------------- S27e: pg_cron job users.
      const ext = await tryq(c, "create extension if not exists pg_cron");
      await tryq(c, "create role sec27_job nologin");
      const sched = await tryq(c, "select cron.schedule('sec27', '0 0 1 1 *', 'select 1') as id");
      const jobId = Number(sched.rows[0]?.id ?? -1);
      const alter = jobId > 0 ? await tryq(c, `select cron.alter_job(${jobId}, username := 'sec27_job')`) : { tag: "no job" };
      const inDb = await tryq(c, "select cron.schedule_in_database('sec27b', '0 0 1 1 *', 'select 1', 'postgres', 'sec27_job') as id");
      const users = await tryq(c, "select jobname, username from cron.job where jobname like 'sec27%' order by jobname");
      out.push({
        id: "S27e",
        title: "pg_cron: changing a job's user as postgres",
        status: ext.ok ? "info" : "fail",
        detail: `create extension pg_cron -> ${ext.tag}; schedule -> ${sched.tag} (job ${jobId}). cron.alter_job(username := 'sec27_job') -> ${alter.tag}. cron.schedule_in_database(..., username 'sec27_job') -> ${inDb.tag}. Jobs afterwards: ${users.rows.map((r) => `${String(r.jobname)}=${String(r.username)}`).join(", ") || "none"}.`,
        measurements: { schedule: sched.tag, alter_job_username: alter.tag, schedule_in_database_other_user: inDb.tag, jobs_after: users.rows.map((r) => `${String(r.jobname)}=${String(r.username)}`).join(",") },
      });

      // ---------------- S27f: roles on a fresh project.
      const roles = await tryq(c, "select rolname, rolcanlogin, rolreplication, rolbypassrls from pg_roles where rolname in ('supabase_etl_admin', 'supabase_read_only_user', 'supabase_replication_admin', 'supabase_privileged_role') order by rolname");
      out.push({
        id: "S27f",
        title: "named platform roles present on a fresh project",
        status: "info",
        detail: roles.rows.map((r) => `${String(r.rolname)} (login ${String(r.rolcanlogin)}, replication ${String(r.rolreplication)}, bypassrls ${String(r.rolbypassrls)})`).join("; ") || `none of the four (${roles.tag})`,
        measurements: { present: roles.rows.map((r) => String(r.rolname)).join(",") || "none" },
      });
    } catch (e) {
      out.push({ id: "S27x", title: "S27 aborted", status: "fail", detail: (e as Error).message.slice(0, 300) });
    } finally {
      if (c) await c.end().catch(() => {});
      if (ref) {
        const d = await deleteProject(ctx, ref);
        out.push({
          id: "S27z",
          title: "Teardown",
          status: d.deleteStatus >= 200 && d.deleteStatus < 300 ? "info" : "fail",
          detail: `DELETE ${d.deleteStatus}, gone from GET /projects after ${d.goneS} s`,
          measurements: { delete_status: d.deleteStatus, gone_s: d.goneS },
        });
      }
    }
    return out;
  },
};
export default mod;
