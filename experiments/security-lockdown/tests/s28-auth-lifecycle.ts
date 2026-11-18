/**
 * S28 - Auth lifecycle questions with no run behind them.
 *
 *   S28a  TOTP: the enrol URI's parameters, then the same code verified on a
 *         second challenge inside its 30 s step
 *   S28b  custom access token hook keyed on a role table: a role change, the
 *         token already held, and the token after a refresh
 *   S28c  admin DELETE of a user: the held access token on the Data API and
 *         on GET /auth/v1/user, and its refresh token
 *   S28d  ban_duration: the same three, plus a new password sign-in
 *   S28e  admin DELETE of a user who owns a Storage object
 *   S28f  soft delete (should_soft_delete): the row afterwards, sign-in, and
 *         creating a user with the same email
 *
 * Self-provisioned Pro-org project (lib/project.ts), deleted in finally.
 * Passwords and TOTP secrets are generated or read here and never recorded.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { errCode, httpBody, waitFor } from "../lib/sec.js";
import { createProject, deleteProject, sleep } from "../lib/project.js";

async function q(ctx: Ctx, ref: string, query: string): Promise<{ ok: boolean; json: unknown; text: string }> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, 60_000);
  return { ok: r.status >= 200 && r.status < 300, json: r.json, text: r.text.slice(0, 300) };
}

function claims(token: string): Record<string, unknown> {
  try {
    const b64 = (token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
  } catch {
    return {};
  }
}

function base32(s: string): Uint8Array<ArrayBuffer> {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const out = new Uint8Array(new ArrayBuffer(Math.floor(bits.length / 8)));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

async function totp(secret: string, atMs: number, step = 30, digits = 6): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = Math.floor(atMs / 1000 / step);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, counter);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const at = (i: number) => h[i] ?? 0;
  const o = at(h.length - 1) & 0xf;
  const n = ((at(o) & 0x7f) << 24) | (at(o + 1) << 16) | (at(o + 2) << 8) | at(o + 3);
  return String(n % 10 ** digits).padStart(digits, "0");
}

const mod: TestModule = {
  id: "S28",
  title: "Auth lifecycle: TOTP reuse, hook role change, deleted and banned users' tokens, Storage owners, soft delete",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 30 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    if (!ctx.orgs.pro) return [{ id: "S28", title: mod.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    try {
      const p = await createProject(ctx, "pvlab-s28-", (r) => {
        ref = r;
        ctx.log(`S28 project ${r}`);
      });
      const base = `https://${p.host}`;
      const rest = `${base}/rest/v1`;
      const setup = await q(ctx, ref, `
create table public.s28_docs (id int primary key, body text);
insert into public.s28_docs values (1, 'a'), (2, 'b'), (3, 'c');
alter table public.s28_docs enable row level security;
grant select on public.s28_docs to authenticated;
create policy s28_any on public.s28_docs for select to authenticated using (true);
create table public.s28_roles (user_id uuid primary key, role text not null);
create table public.s28_role_docs (id int primary key);
insert into public.s28_role_docs values (1), (2), (3);
alter table public.s28_role_docs enable row level security;
grant select on public.s28_role_docs to authenticated;
create policy s28_editor on public.s28_role_docs for select to authenticated using ((auth.jwt() ->> 'user_role') = 'editor');
create or replace function public.s28_hook(event jsonb) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r text;
begin
  select role into r from public.s28_roles where user_id = (event ->> 'user_id')::uuid;
  return jsonb_set(event, '{claims,user_role}', to_jsonb(coalesce(r, 'none')));
end $$;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.s28_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.s28_hook(jsonb) from anon, authenticated, public;
notify pgrst, 'reload schema';
`);
      out.push({ id: "S28s", title: "Setup", status: setup.ok ? "info" : "fail", detail: `created in ${p.createS} s, ${p.pgVersion}; setup ${setup.ok ? "ok" : setup.text}`, measurements: { create_s: p.createS, pg: p.pgVersion } });
      if (!setup.ok) return out;

      const admin = (method: string, path: string, body?: unknown) => httpBody(`${base}/auth/v1/admin${path}`, { method, key: p.service, body });
      const mkUser = async (tag: string) => {
        const email = `s28-${tag}-${Date.now()}@example.com`;
        const password = `${crypto.randomUUID()}Aa1!`;
        const c = await admin("POST", "/users", { email, password, email_confirm: true });
        const id = String((c.json as { id?: string } | undefined)?.id ?? "");
        return { email, password, id, status: c.status };
      };
      const signIn = (email: string, password: string) =>
        httpBody(`${base}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: p.anon }, body: { email, password } });
      const refresh = (rt: string) =>
        httpBody(`${base}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: p.anon }, body: { refresh_token: rt } });
      const tok = (r: { json: unknown }) => {
        const j = (r.json ?? {}) as { access_token?: string; refresh_token?: string };
        return { at: String(j.access_token ?? ""), rt: String(j.refresh_token ?? "") };
      };
      const readAs = async (at: string, table = "s28_docs") => {
        const r = await httpBody(`${rest}/${table}?select=id`, { headers: { apikey: p.anon, Authorization: `Bearer ${at}` } });
        return { status: r.status, rows: Array.isArray(r.json) ? r.json.length : -1, code: r.status >= 400 ? errCode(r.json, r.text) : "" };
      };
      const whoAmI = async (at: string) => {
        const r = await httpBody(`${base}/auth/v1/user`, { headers: { apikey: p.anon, Authorization: `Bearer ${at}` } });
        return `${r.status}${r.status >= 400 ? ` ${errCode(r.json, r.text)}` : ""}`;
      };
      await waitFor(async () => (await httpBody(`${rest}/s28_docs?select=id`, { key: p.service })).status === 200, 90_000);

      // ---------------- S28a: TOTP
      const u1 = await mkUser("totp");
      const t1 = tok(await signIn(u1.email, u1.password));
      const enrol = await httpBody(`${base}/auth/v1/factors`, { method: "POST", headers: { apikey: p.anon, Authorization: `Bearer ${t1.at}` }, body: { factor_type: "totp", friendly_name: "s28" } });
      const ej = (enrol.json ?? {}) as { id?: string; totp?: { secret?: string; uri?: string } };
      const secret = ej.totp?.secret ?? "";
      const uri = new URL(ej.totp?.uri ?? "otpauth://totp/x?secret=");
      const params = { algorithm: uri.searchParams.get("algorithm") ?? "(absent)", digits: uri.searchParams.get("digits") ?? "(absent)", period: uri.searchParams.get("period") ?? "(absent)" };
      const secretBits = base32(secret).length * 8;
      const fid = ej.id ?? "";
      const challenge = async () => {
        const c = await httpBody(`${base}/auth/v1/factors/${fid}/challenge`, { method: "POST", headers: { apikey: p.anon, Authorization: `Bearer ${t1.at}` }, body: {} });
        return String((c.json as { id?: string } | undefined)?.id ?? "");
      };
      const verify = (cid: string, code: string) =>
        httpBody(`${base}/auth/v1/factors/${fid}/verify`, { method: "POST", headers: { apikey: p.anon, Authorization: `Bearer ${t1.at}` }, body: { challenge_id: cid, code } });
      // Start at the beginning of a step so both verifies land inside it.
      const into = Date.now() % 30_000;
      if (into > 15_000) await sleep(30_000 - into + 500);
      const tCode = Date.now();
      const code = await totp(secret, tCode);
      const v1 = await verify(await challenge(), code);
      const v2 = await verify(await challenge(), code);
      const sameStep = Math.floor(Date.now() / 30_000) === Math.floor(tCode / 30_000);
      const aal = claims(tok(v1).at).aal;
      out.push({
        id: "S28a",
        title: "TOTP: enrol parameters, and one code verified on two challenges",
        status: enrol.status === 200 ? "info" : "fail",
        detail: `Enrol -> ${enrol.status}; URI algorithm ${params.algorithm}, digits ${params.digits}, period ${params.period}; secret ${secretBits} bits. First challenge verified with a locally computed code -> ${v1.status} (aal ${String(aal ?? "-")}). A new challenge verified with the same code in the same 30 s step -> ${v2.status}${v2.status >= 400 ? ` ${errCode(v2.json, v2.text)}` : ""}.`,
        measurements: { enrol_status: enrol.status, uri_algorithm: params.algorithm, uri_digits: params.digits, uri_period: params.period, secret_bits: secretBits, first_verify: v1.status, first_aal: String(aal ?? "-"), reuse_verify: v2.status, reuse_code: v2.status >= 400 ? errCode(v2.json, v2.text).slice(0, 80) : "accepted", same_step: String(sameStep) },
      });

      // ---------------- S28b: hook role change vs the held token
      const u2 = await mkUser("role");
      await q(ctx, ref, `insert into public.s28_roles values ('${u2.id}', 'editor')`);
      const hookPatch = await mgmt(ctx, "PATCH", `/projects/${ref}/config/auth`, { hook_custom_access_token_enabled: true, hook_custom_access_token_uri: "pg-functions://postgres/public/s28_hook" });
      let s2 = await signIn(u2.email, u2.password);
      const live = await waitFor(async () => {
        s2 = await signIn(u2.email, u2.password);
        return claims(tok(s2).at).user_role === "editor";
      }, 120_000, 5_000);
      const t2 = tok(s2);
      const r0 = await readAs(t2.at, "s28_role_docs");
      await q(ctx, ref, `update public.s28_roles set role = 'viewer' where user_id = '${u2.id}'`);
      const r1 = await readAs(t2.at, "s28_role_docs");
      const rf = await refresh(t2.rt);
      const t2b = tok(rf);
      const r2 = await readAs(t2b.at, "s28_role_docs");
      out.push({
        id: "S28b",
        title: "a role change through the access token hook: the held token keeps the old claim until refresh",
        status: live.ok ? "info" : "fail",
        detail: `Hook PATCH -> ${hookPatch.status}, claim user_role=editor after ${live.elapsedS} s. Policy keyed on auth.jwt()->>'user_role' = 'editor'. Editor token -> ${r0.status}, ${r0.rows} of 3 rows. Role set to viewer in the table; same token -> ${r1.status}, ${r1.rows} rows (claim ${String(claims(t2.at).user_role)}). Refresh -> ${rf.status}, new claim ${String(claims(t2b.at).user_role ?? "-")}, read -> ${r2.status}, ${r2.rows} rows. Access token lifetime ${Number(claims(t2.at).exp ?? 0) - Number(claims(t2.at).iat ?? 0)} s.`,
        measurements: { hook_live_s: live.elapsedS, rows_editor_token: r0.rows, rows_held_token_after_change: r1.rows, refresh_status: rf.status, claim_after_refresh: String(claims(t2b.at).user_role ?? "-"), rows_after_refresh: r2.rows, token_lifetime_s: Number(claims(t2.at).exp ?? 0) - Number(claims(t2.at).iat ?? 0) },
      });
      await mgmt(ctx, "PATCH", `/projects/${ref}/config/auth`, { hook_custom_access_token_enabled: false });

      // ---------------- S28c: deleted user's held tokens
      const u3 = await mkUser("del");
      const t3 = tok(await signIn(u3.email, u3.password));
      const del = await admin("DELETE", `/users/${u3.id}`);
      await sleep(2_000);
      const c1 = await readAs(t3.at);
      const c2 = await whoAmI(t3.at);
      const c3 = await refresh(t3.rt);
      out.push({
        id: "S28c",
        title: "admin DELETE of a user: what the held tokens still do",
        status: "info",
        detail: `DELETE /admin/users -> ${del.status}. Held access token on the Data API (policy to authenticated using true) -> ${c1.status}, ${c1.rows} rows${c1.code ? ` ${c1.code}` : ""}; on GET /auth/v1/user -> ${c2}; refresh token -> ${c3.status}${c3.status >= 400 ? ` ${errCode(c3.json, c3.text)}` : ""}.`,
        measurements: { delete_status: del.status, rest_status: c1.status, rest_rows: c1.rows, user_endpoint: c2.slice(0, 80), refresh_status: c3.status },
      });

      // ---------------- S28d: banned user's held tokens
      const u4 = await mkUser("ban");
      const t4 = tok(await signIn(u4.email, u4.password));
      const ban = await admin("PUT", `/users/${u4.id}`, { ban_duration: "1h" });
      await sleep(2_000);
      const b1 = await readAs(t4.at);
      const b2 = await whoAmI(t4.at);
      const b3 = await refresh(t4.rt);
      const b4 = await signIn(u4.email, u4.password);
      out.push({
        id: "S28d",
        title: "ban_duration: what the held tokens still do",
        status: "info",
        detail: `PUT ban_duration 1h -> ${ban.status}. Held access token on the Data API -> ${b1.status}, ${b1.rows} rows; on GET /auth/v1/user -> ${b2}; refresh -> ${b3.status}${b3.status >= 400 ? ` ${errCode(b3.json, b3.text)}` : ""}; new password sign-in -> ${b4.status}${b4.status >= 400 ? ` ${errCode(b4.json, b4.text)}` : ""}.`,
        measurements: { ban_status: ban.status, rest_status: b1.status, rest_rows: b1.rows, user_endpoint: b2.slice(0, 80), refresh_status: b3.status, signin_status: b4.status },
      });

      // ---------------- S28e: deleting a user who owns a Storage object
      const u5 = await mkUser("owner");
      const t5 = tok(await signIn(u5.email, u5.password));
      const svc = { apikey: p.service, Authorization: `Bearer ${p.service}` };
      const mkB = await httpBody(`${base}/storage/v1/bucket`, { method: "POST", headers: svc, body: { id: "s28", name: "s28", public: false } });
      await q(ctx, ref, "create policy s28_ins on storage.objects for insert to authenticated with check (bucket_id = 's28');");
      const up = await fetch(`${base}/storage/v1/object/s28/u5.txt`, { method: "POST", headers: { apikey: p.anon, Authorization: `Bearer ${t5.at}`, "Content-Type": "text/plain" }, body: "s28", signal: AbortSignal.timeout(15_000) });
      await up.text();
      const own0 = await q(ctx, ref, `select owner::text as o, owner_id from storage.objects where bucket_id = 's28' and name = 'u5.txt'`);
      const delOwner = await admin("DELETE", `/users/${u5.id}`);
      const own1 = await q(ctx, ref, `select owner::text as o, owner_id from storage.objects where bucket_id = 's28' and name = 'u5.txt'`);
      const row = (r: { json: unknown }) => {
        const x = (Array.isArray(r.json) ? r.json[0] : undefined) as { o?: string; owner_id?: string } | undefined;
        return x ? `owner ${x.o ? "set" : "null"}, owner_id ${x.owner_id ? "set" : "null"}` : "no row";
      };
      out.push({
        id: "S28e",
        title: "admin DELETE of a user who owns a Storage object",
        status: "info",
        detail: `Bucket -> ${mkB.status}; upload as the user -> ${up.status}; object row before: ${row(own0)}. DELETE /admin/users -> ${delOwner.status}${delOwner.status >= 400 ? ` ${errCode(delOwner.json, delOwner.text)}` : ""}; object row after: ${row(own1)}.`,
        measurements: { upload_status: up.status, before: row(own0), delete_status: delOwner.status, delete_error: delOwner.status >= 400 ? errCode(delOwner.json, delOwner.text).slice(0, 80) : "-", after: row(own1) },
      });

      // ---------------- S28f: soft delete
      const u6 = await mkUser("soft");
      const soft = await admin("DELETE", `/users/${u6.id}`, { should_soft_delete: true });
      const srow = await q(ctx, ref, `select deleted_at is not null as deleted, email = '${u6.email}' as email_kept, email is null as email_null, encrypted_password is null or encrypted_password = '' as pw_cleared from auth.users where id = '${u6.id}'`);
      const sr = (Array.isArray(srow.json) ? srow.json[0] : {}) as Record<string, unknown>;
      const ssign = await signIn(u6.email, u6.password);
      const again = await admin("POST", "/users", { email: u6.email, password: `${crypto.randomUUID()}Aa1!`, email_confirm: true });
      out.push({
        id: "S28f",
        title: "soft delete: the row, sign-in, and the same email again",
        status: "info",
        detail: `DELETE /admin/users {should_soft_delete: true} -> ${soft.status}. Row still present: ${srow.ok && Array.isArray(srow.json) && srow.json.length === 1}; deleted_at set ${String(sr.deleted ?? "-")}, email unchanged ${String(sr.email_kept ?? "-")}, email null ${String(sr.email_null ?? "-")}, password cleared ${String(sr.pw_cleared ?? "-")}. Sign-in with the old password -> ${ssign.status}${ssign.status >= 400 ? ` ${errCode(ssign.json, ssign.text)}` : ""}. Admin create with the same email -> ${again.status}${again.status >= 400 ? ` ${errCode(again.json, again.text)}` : ""}.`,
        measurements: { soft_status: soft.status, row_present: String(srow.ok && Array.isArray(srow.json) && srow.json.length === 1), deleted_at_set: String(sr.deleted ?? "-"), email_unchanged: String(sr.email_kept ?? "-"), password_cleared: String(sr.pw_cleared ?? "-"), signin_status: ssign.status, recreate_status: again.status },
      });
    } catch (e) {
      out.push({ id: "S28x", title: "S28 aborted", status: "fail", detail: (e as Error).message.slice(0, 300) });
    } finally {
      if (ref) {
        const d = await deleteProject(ctx, ref);
        out.push({ id: "S28z", title: "Teardown", status: d.deleteStatus >= 200 && d.deleteStatus < 300 ? "info" : "fail", detail: `DELETE ${d.deleteStatus}, gone from GET /projects after ${d.goneS} s`, measurements: { delete_status: d.deleteStatus, gone_s: d.goneS } });
      }
    }
    return out;
  },
};
export default mod;
