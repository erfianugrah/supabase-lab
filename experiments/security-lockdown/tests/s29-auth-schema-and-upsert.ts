/**
 * S29 - what `postgres` can do to the auth schema, and what a Data API upsert
 * needs from RLS (work-supabase-lab#327).
 *
 *   S29a  as postgres over the Supavisor session pooler: CREATE OR REPLACE
 *         auth.uid(), VACUUM auth.users, ALTER TABLE auth.users SET
 *         (autovacuum_vacuum_scale_factor), CREATE INDEX on auth.users, a
 *         batched DELETE from auth.users
 *   S29b  a signed-in user upserting through PostgREST
 *         (Prefer: resolution=merge-duplicates) onto a row it owns: with
 *         INSERT and SELECT policies only, then with an UPDATE policy added
 *
 * Self-provisioned Pro-org project (lib/project.ts), deleted in finally.
 */
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { errCode, httpBody, waitFor } from "../lib/sec.js";
import { createProject, deleteProject, sleep } from "../lib/project.js";

async function tryq(c: Client, sql: string): Promise<string> {
  try {
    const r = await c.query(sql);
    return r.command === "DELETE" ? `ok, ${r.rowCount} deleted` : "ok";
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return `${err.code ?? "?"} ${(err.message ?? "").slice(0, 90)}`;
  }
}

const mod: TestModule = {
  id: "S29",
  title: "postgres against the auth schema, and the RLS a Data API upsert needs",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 20 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    if (!ctx.orgs.pro) return [{ id: "S29", title: mod.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    let c: Client | undefined;
    try {
      const p = await createProject(ctx, "pvlab-s29-", (r) => {
        ref = r;
        ctx.log(`S29 project ${r}`);
      });
      const base = `https://${p.host}`;
      out.push({ id: "S29s", title: "Setup", status: "info", detail: `created in ${p.createS} s, ${p.pgVersion}`, measurements: { create_s: p.createS, pg: p.pgVersion } });

      // ---------------- S29a: postgres and the auth schema
      // Users to delete in a batch.
      const admin = (body: unknown) => httpBody(`${base}/auth/v1/admin/users`, { method: "POST", key: p.service, body });
      let made = 0;
      for (let i = 0; i < 6; i++) if ((await admin({ email: `s29-b${i}-${Date.now()}@example.com`, password: `${crypto.randomUUID()}Aa1!`, email_confirm: true })).status === 200) made++;
      for (let i = 0; i < 12 && !c; i++) {
        try {
          const x = new Client({ host: p.poolerHost, port: 5432, user: p.poolerUser, password: p.dbPass, database: "postgres", ssl: { rejectUnauthorized: false, servername: p.poolerHost }, connectionTimeoutMillis: 15_000, query_timeout: 60_000 });
          x.on("error", () => {});
          await x.connect();
          c = x;
        } catch {
          await sleep(5_000);
        }
      }
      if (!c) throw new Error("could not connect as postgres through the session pooler");
      const owner = await c.query("select pg_get_userbyid(relowner) as o from pg_class where oid = 'auth.users'::regclass").then((r) => String(r.rows[0]?.o), () => "?");
      const uidOwner = await c.query("select pg_get_userbyid(proowner) as o from pg_proc where oid = 'auth.uid()'::regprocedure").then((r) => String(r.rows[0]?.o), () => "?");
      const replace = await tryq(c, "create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$");
      const vacuum = await tryq(c, "vacuum auth.users");
      const alter = await tryq(c, "alter table auth.users set (autovacuum_vacuum_scale_factor = 0.01)");
      const index = await tryq(c, "create index s29_idx on auth.users (last_sign_in_at)");
      const del = await tryq(c, "delete from auth.users where id in (select id from auth.users where email like 's29-b%' order by created_at limit 3)");
      out.push({
        id: "S29a",
        title: "postgres and the auth schema",
        status: "info",
        detail: `auth.users owner ${owner}; auth.uid() owner ${uidOwner}. As postgres over Supavisor session 5432: create or replace auth.uid() -> ${replace}; vacuum auth.users -> ${vacuum}; alter table auth.users set (autovacuum_vacuum_scale_factor) -> ${alter}; create index on auth.users -> ${index}; delete 3 of ${made} test users in one statement -> ${del}.`,
        measurements: { users_owner: owner, uid_owner: uidOwner, replace_uid: replace.slice(0, 80), vacuum_users: vacuum.slice(0, 80), alter_users_storage_param: alter.slice(0, 80), create_index_users: index.slice(0, 80), batched_delete: del.slice(0, 80) },
      });

      // ---------------- S29b: upsert needs an UPDATE policy?
      await tryq(c, `
create table public.s29_items (id int primary key, owner uuid not null default auth.uid(), v text);
alter table public.s29_items enable row level security;
grant select, insert, update on public.s29_items to authenticated;
create policy s29_ins on public.s29_items for insert to authenticated with check (owner = auth.uid());
create policy s29_sel on public.s29_items for select to authenticated using (owner = auth.uid());
notify pgrst, 'reload schema';`);
      const email = `s29-u-${Date.now()}@example.com`;
      const password = `${crypto.randomUUID()}Aa1!`;
      await admin({ email, password, email_confirm: true });
      const si = await httpBody(`${base}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: p.anon }, body: { email, password } });
      const at = String((si.json as { access_token?: string } | undefined)?.access_token ?? "");
      const h = { apikey: p.anon, Authorization: `Bearer ${at}`, Prefer: "resolution=merge-duplicates,return=representation" };
      await waitFor(async () => (await httpBody(`${base}/rest/v1/s29_items?select=id`, { headers: h })).status === 200, 90_000);
      const ins = await httpBody(`${base}/rest/v1/s29_items`, { method: "POST", headers: h, body: { id: 1, v: "first" } });
      const ups1 = await httpBody(`${base}/rest/v1/s29_items`, { method: "POST", headers: h, body: { id: 1, v: "second" } });
      const v1 = await c.query("select v from public.s29_items where id = 1").then((r) => String(r.rows[0]?.v), () => "?");
      await tryq(c, "create policy s29_upd on public.s29_items for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid()); notify pgrst, 'reload schema';");
      await sleep(3_000);
      const ups2 = await httpBody(`${base}/rest/v1/s29_items`, { method: "POST", headers: h, body: { id: 1, v: "third" } });
      const v2 = await c.query("select v from public.s29_items where id = 1").then((r) => String(r.rows[0]?.v), () => "?");
      const fmt = (r: { status: number; json: unknown; text: string }) => `${r.status}${r.status >= 400 ? ` ${errCode(r.json, r.text)}` : ""}`;
      out.push({
        id: "S29b",
        title: "a Data API upsert onto an owned row: INSERT + SELECT policies only, then with an UPDATE policy",
        status: "info",
        detail: `Signed-in user, POST with Prefer resolution=merge-duplicates. First insert -> ${fmt(ins)}. Upsert of the same id with INSERT and SELECT policies only -> ${fmt(ups1)}; stored value "${v1}". After adding an UPDATE policy (using and with check owner = auth.uid()) -> ${fmt(ups2)}; stored value "${v2}".`,
        measurements: { insert: ins.status, upsert_without_update_policy: ups1.status, upsert_without_code: ups1.status >= 400 ? errCode(ups1.json, ups1.text).slice(0, 80) : "-", value_after_first_upsert: v1, upsert_with_update_policy: ups2.status, value_after_second_upsert: v2 },
      });
    } catch (e) {
      out.push({ id: "S29x", title: "S29 aborted", status: "fail", detail: (e as Error).message.slice(0, 300) });
    } finally {
      if (c) await c.end().catch(() => {});
      if (ref) {
        const d = await deleteProject(ctx, ref);
        out.push({ id: "S29z", title: "Teardown", status: d.deleteStatus >= 200 && d.deleteStatus < 300 ? "info" : "fail", detail: `DELETE ${d.deleteStatus}, gone from GET /projects after ${d.goneS} s`, measurements: { delete_status: d.deleteStatus, gone_s: d.goneS } });
      }
    }
    return out;
  },
};
export default mod;
