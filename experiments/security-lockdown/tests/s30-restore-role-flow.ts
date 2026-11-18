/**
 * S30 - a restore role made by postgres, end to end, and what pg_dump keeps of
 * RLS (work-supabase-lab#328).
 *
 *   S30a  pg_dump (local client) of a schema with a table that has RLS enabled
 *         and forced, a policy, and a function: whether the plain-text dump
 *         carries ENABLE / FORCE ROW LEVEL SECURITY and CREATE POLICY, and
 *         whether each is written ALTER TABLE or ALTER TABLE ONLY
 *   S30b  postgres creates a LOGIN CREATEDB role and hands it an application
 *         role WITH ADMIN OPTION; the restore role creates a database,
 *         pg_restore --no-owner loads the dump into it as that role, and the
 *         restored table's relrowsecurity, relforcerowsecurity, policy count,
 *         owner and the rows its owner sees under FORCE are read back; then
 *         the owner turns FORCE off and counts the restored rows
 *   S30c  what the ADMIN OPTION handover lets the restore role do: grant the
 *         application role to another role, and revoke it again
 *
 * Every connection goes through the Supavisor session pooler (IPv4); the dump
 * and restore run as local pg_dump / pg_restore with the password in the
 * environment, never in argv. Self-provisioned Pro-org project, deleted in
 * finally. Passwords are generated here and never recorded.
 */
import { $ } from "bun";
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { createProject, deleteProject, sleep, type Project } from "../lib/project.js";

const pw = () => `${crypto.randomUUID().replaceAll("-", "")}Xy9`;

async function connect(p: Project, user: string, password: string, database = "postgres"): Promise<Client> {
  const c = new Client({
    host: p.poolerHost, port: 5432, user, password, database,
    ssl: { rejectUnauthorized: false, servername: p.poolerHost },
    connectionTimeoutMillis: 15_000, query_timeout: 60_000, application_name: "pvlab-s30",
  });
  c.on("error", () => {});
  await c.connect();
  return c;
}

async function tryq(c: Client, sql: string): Promise<{ ok: boolean; tag: string; rows: Record<string, unknown>[] }> {
  try {
    const r = await c.query(sql);
    return { ok: true, tag: "ok", rows: r.rows as Record<string, unknown>[] };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, tag: `${err.code ?? "?"} ${(err.message ?? "").slice(0, 90)}`, rows: [] };
  }
}

/** libpq URL with no password: the password goes in PGPASSWORD. */
const url = (p: Project, user: string, db: string) => `postgresql://${encodeURIComponent(user)}@${p.poolerHost}:5432/${db}?sslmode=require`;

const mod: TestModule = {
  id: "S30",
  title: "a restore role made by postgres (CREATEDB, ADMIN OPTION, pg_restore --no-owner), and RLS in pg_dump",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 30 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    if (!ctx.orgs.pro) return [{ id: "S30", title: mod.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    let c: Client | undefined;
    const dir = await Bun.$`mktemp -d`.text().then((s) => s.trim());
    try {
      const p = await createProject(ctx, "pvlab-s30-", (r) => {
        ref = r;
        ctx.log(`S30 project ${r}`);
      });
      for (let i = 0; i < 12 && !c; i++) {
        try { c = await connect(p, p.poolerUser, p.dbPass); } catch { await sleep(5_000); }
      }
      if (!c) throw new Error("could not connect as postgres through the session pooler");
      const setup = await tryq(c, `
create schema s30src;
create table s30src.notes (id int primary key, owner text not null, body text);
insert into s30src.notes select g, 'u' || (g % 3), 'n' || g from generate_series(1, 9) g;
alter table s30src.notes enable row level security;
alter table s30src.notes force row level security;
create policy s30_own on s30src.notes for select using (owner = current_user);
create function s30src.note_count() returns bigint language sql stable as $$ select count(*) from s30src.notes $$;`);
      out.push({ id: "S30s", title: "Setup", status: setup.ok ? "info" : "fail", detail: `created in ${p.createS} s, ${p.pgVersion}; source schema ${setup.tag}`, measurements: { create_s: p.createS, pg: p.pgVersion } });
      if (!setup.ok) return out;

      // ---------------- S30a: what pg_dump keeps
      const plain = `${dir}/s30.sql`;
      const custom = `${dir}/s30.dump`;
      const env = { ...process.env, PGPASSWORD: p.dbPass };
      const d1 = await $`pg_dump --schema=s30src --no-owner --no-privileges -f ${plain} ${url(p, p.poolerUser, "postgres")}`.env(env).quiet().nothrow();
      const d2 = await $`pg_dump --schema=s30src -Fc -f ${custom} ${url(p, p.poolerUser, "postgres")}`.env(env).quiet().nothrow();
      const text = d1.exitCode === 0 ? await Bun.file(plain).text() : "";
      const has = (re: RegExp) => re.test(text);
      const form = (what: string) => {
        const m = text.match(new RegExp(`ALTER TABLE (ONLY )?s30src\\.notes ${what} ROW LEVEL SECURITY;`));
        return m ? (m[1] ? "ALTER TABLE ONLY" : "ALTER TABLE") : "absent";
      };
      const enableForm = form("ENABLE");
      const forceForm = form("FORCE");
      const dumpKeeps = {
        enable: enableForm !== "absent",
        force: forceForm !== "absent",
        policy: has(/CREATE POLICY s30_own ON s30src\.notes/),
        func: has(/CREATE FUNCTION s30src\.note_count\(\)/),
      };
      out.push({
        id: "S30a",
        title: "pg_dump of a schema with RLS enabled and forced",
        status: d1.exitCode === 0 && dumpKeeps.enable && dumpKeeps.force && dumpKeeps.policy ? "pass" : "fail",
        detail: `Local pg_dump ${(await $`pg_dump --version`.text()).trim()} through the session pooler as postgres. Plain dump exit ${d1.exitCode}${d1.exitCode ? ` (${d1.stderr.toString().trim().slice(0, 120)})` : ""}; custom-format dump exit ${d2.exitCode}. Plain dump carries ENABLE ROW LEVEL SECURITY ${dumpKeeps.enable} (as ${enableForm}), FORCE ROW LEVEL SECURITY ${dumpKeeps.force} (as ${forceForm}), CREATE POLICY ${dumpKeeps.policy}, the function ${dumpKeeps.func}.`,
        measurements: { dump_exit: d1.exitCode, custom_exit: d2.exitCode, enable_rls: String(dumpKeeps.enable), enable_form: enableForm, force_rls: String(dumpKeeps.force), force_form: forceForm, create_policy: String(dumpKeeps.policy), function: String(dumpKeeps.func) },
      });

      // ---------------- S30b: the restore role
      const rpw = pw();
      const roles = await tryq(c, `
create role s30_restorer login createdb password '${rpw}';
create role s30_app nologin;
grant s30_app to s30_restorer with admin option;
create role s30_reader nologin;`);
      const restorerUser = p.poolerUser.replace(/^postgres\./, "s30_restorer.");
      let rc: Client | undefined;
      for (let i = 0; i < 12 && !rc; i++) {
        try { rc = await connect(p, restorerUser, rpw); } catch { await sleep(5_000); }
      }
      const mkdb = rc ? await tryq(rc, "create database s30_restored") : { ok: false, tag: "restorer could not connect", rows: [] };
      await sleep(3_000);
      const renv = { ...process.env, PGPASSWORD: rpw };
      const rs = mkdb.ok
        ? await $`pg_restore --no-owner --no-privileges -d ${url(p, restorerUser, "s30_restored")} ${custom}`.env(renv).quiet().nothrow()
        : undefined;
      let state = "not read";
      let m: Record<string, unknown> = {};
      if (mkdb.ok) {
        try {
          const vc = await connect(p, restorerUser, rpw, "s30_restored");
          const r = await tryq(vc, `
select c.relrowsecurity as rls, c.relforcerowsecurity as force, pg_get_userbyid(c.relowner) as owner,
  (select count(*)::int from pg_policy where polrelid = c.oid) as policies,
  (select count(*)::int from s30src.notes) as rows_seen_by_owner
from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 's30src' and c.relname = 'notes'`);
          m = r.rows[0] ?? {};
          // Without FORCE the table owner bypasses RLS, so this counts what was restored.
          const nf = await tryq(vc, "alter table s30src.notes no force row level security");
          const n = nf.ok ? await tryq(vc, "select count(*)::int as n from s30src.notes") : nf;
          m.rows_restored = n.ok ? n.rows[0]?.n : n.tag.slice(0, 60);
          state = r.ok ? `relrowsecurity ${String(m.rls)}, relforcerowsecurity ${String(m.force)}, owner ${String(m.owner)}, policies ${String(m.policies)}, rows visible to the owner under FORCE ${String(m.rows_seen_by_owner)} (the source held 9); after NO FORCE ROW LEVEL SECURITY the owner counted ${String(m.rows_restored)} rows` : r.tag;
          await vc.end();
        } catch (e) {
          state = `connect to s30_restored: ${(e as Error).message.slice(0, 90)}`;
        }
      }
      const rsErr = rs ? rs.stderr.toString().trim().split("\n").filter(Boolean) : [];
      out.push({
        id: "S30b",
        title: "the restore role: create database, pg_restore --no-owner, RLS on the restored table",
        status: mkdb.ok && rs?.exitCode === 0 ? "info" : "fail",
        detail: `As postgres: create role s30_restorer LOGIN CREATEDB, s30_app granted to it WITH ADMIN OPTION -> ${roles.tag}. As s30_restorer over the session pooler: create database -> ${mkdb.tag}. pg_restore --no-owner --no-privileges into it as s30_restorer -> exit ${rs?.exitCode ?? "-"}${rsErr.length ? ` (${rsErr.length} stderr lines; first: ${rsErr[0]?.slice(0, 120)})` : ""}. Restored table: ${state}.`,
        measurements: { roles: roles.tag.slice(0, 60), create_database: mkdb.tag.slice(0, 60), restore_exit: rs?.exitCode ?? -1, restore_stderr_lines: rsErr.length, relrowsecurity: String(m.rls ?? "-"), relforcerowsecurity: String(m.force ?? "-"), owner: String(m.owner ?? "-"), policies: String(m.policies ?? "-"), rows_visible_to_owner: String(m.rows_seen_by_owner ?? "-"), rows_restored: String(m.rows_restored ?? "-") },
      });

      // ---------------- S30c: the ADMIN OPTION handover
      const g = rc ? await tryq(rc, "grant s30_app to s30_reader") : { tag: "-" };
      const mem = await tryq(c, "select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where r.rolname = 's30_app' and u.rolname = 's30_reader'");
      const rv = rc ? await tryq(rc, "revoke s30_app from s30_reader") : { tag: "-" };
      const other = rc ? await tryq(rc, "grant pg_read_all_data to s30_reader") : { tag: "-" };
      out.push({
        id: "S30c",
        title: "what ADMIN OPTION on an application role lets the restore role do",
        status: "info",
        detail: `As s30_restorer: grant s30_app to s30_reader -> ${g.tag} (membership rows afterwards ${String(mem.rows[0]?.n ?? "?")}); revoke it -> ${rv.tag}; grant pg_read_all_data (no ADMIN on it) to s30_reader -> ${other.tag}.`,
        measurements: { grant_app: g.tag.slice(0, 60), membership_rows: String(mem.rows[0]?.n ?? "?"), revoke_app: rv.tag.slice(0, 60), grant_read_all: other.tag.slice(0, 80) },
      });
      if (rc) await rc.end().catch(() => {});
    } catch (e) {
      out.push({ id: "S30x", title: "S30 aborted", status: "fail", detail: (e as Error).message.slice(0, 300) });
    } finally {
      if (c) await c.end().catch(() => {});
      await $`rm -f ${dir}/s30.sql ${dir}/s30.dump`.quiet().nothrow();
      await $`rmdir ${dir}`.quiet().nothrow();
      if (ref) {
        const d = await deleteProject(ctx, ref);
        out.push({ id: "S30z", title: "Teardown", status: d.deleteStatus >= 200 && d.deleteStatus < 300 ? "info" : "fail", detail: `DELETE ${d.deleteStatus}, gone from GET /projects after ${d.goneS} s`, measurements: { delete_status: d.deleteStatus, gone_s: d.goneS } });
      }
    }
    return out;
  },
};
export default mod;
