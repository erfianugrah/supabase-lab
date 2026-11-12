/**
 * S24 - per-service Postgres login roles on a managed project.
 *
 * The question: if each system gets its own `create role ... login password`
 * with grants limited to its own schema, what can that login actually do on
 * each connection path, and how fast does a password rotation apply? The
 * roles guide recommends a separate user per service; nothing in this lab had
 * measured the least-privilege half of that or a rotation (rls-wire-claims
 * only showed a custom role logging in over the poolers; MS04 saw Supavisor
 * refuse a recreated role's password for about a minute, once).
 *
 * Self-provisioned: one Pro-org Micro, created and deleted in this process
 * (lib/project.ts, as S23). Setup runs through the Management API query
 * route. Two service roles:
 *   svc_app_a: USAGE on svc_a, SELECT/INSERT on svc_a.orders, SELECT on public.shared
 *   svc_app_b: USAGE on svc_b, SELECT on svc_b.payroll, SELECT on public.shared
 * public.shared has RLS on with one policy per role (owner = current_user), and
 * public.internal_notes is created with no grant to either role.
 *
 * Paths: direct 5432 and the dedicated pooler 6543 on db.<ref> (IPv6 from this
 * vantage), Supavisor session 5432 and transaction 6543 on the shared pooler
 * host. A path that refuses the first login is recorded and skipped after that.
 *
 * Passwords are generated here and never written to results or evidence.
 */
import { promises as dns } from "node:dns";
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { createProject, deleteProject, sleep, type Project } from "../lib/project.js";

const DB = "postgres";
const ROLE_A = "svc_app_a";
const ROLE_B = "svc_app_b";
const ROTATE_MAX_MS = 180_000;
const ROTATE_STEP_MS = 1_000;

const pw = () => `${crypto.randomUUID().replaceAll("-", "")}Xy9`;

interface PathDef {
  name: string;
  host: string;
  port: number;
  user: (role: string) => string;
  /**
   * db.<ref> is AAAA-only. On the macOS orchestrator `dns.lookup` (getaddrinfo)
   * answers ENOTFOUND for it while the system resolver and `dns.resolve6`
   * return the address and TCP 5432/6543 over IPv6 connects (checked
   * 2026-11-12; IPv6 here rides tunnel interfaces only). So these paths
   * resolve AAAA themselves and dial the literal.
   */
  v6?: boolean;
}

function pathsFor(p: Project): PathDef[] {
  const db = `db.${p.ref}.supabase.co`;
  return [
    { name: "direct_5432", host: db, port: 5432, user: (r) => r, v6: true },
    { name: "supavisor_session_5432", host: p.poolerHost, port: 5432, user: (r) => `${r}.${p.ref}` },
    { name: "supavisor_tx_6543", host: p.poolerHost, port: 6543, user: (r) => `${r}.${p.ref}` },
    { name: "dedicated_6543", host: db, port: 6543, user: (r) => r, v6: true },
  ];
}

interface Conn {
  client?: Client;
  ms: number;
  code?: string;
  err?: string;
}

async function connect(path: PathDef, role: string, password: string): Promise<Conn> {
  const t0 = performance.now();
  let host = path.host;
  if (path.v6) {
    try {
      const addrs = await dns.resolve6(path.host);
      if (!addrs[0]) throw Object.assign(new Error("no AAAA"), { code: "ENOTFOUND" });
      host = addrs[0];
    } catch (e) {
      const err = e as { code?: string; message?: string };
      const code = err.code === "ENODATA" ? "ENOTFOUND" : err.code;
      return { ms: Math.round(performance.now() - t0), code, err: `resolve6: ${(err.message ?? String(e)).slice(0, 120)}` };
    }
  }
  const c = new Client({
    host,
    port: path.port,
    user: path.user(role),
    password,
    database: DB,
    ssl: { rejectUnauthorized: false, servername: path.host },
    connectionTimeoutMillis: 15_000,
    query_timeout: 15_000,
    application_name: "pvlab-s24",
  });
  c.on("error", () => {});
  try {
    await c.connect();
    return { client: c, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    try {
      await c.end();
    } catch {}
    const err = e as { code?: string; message?: string };
    return { ms: Math.round(performance.now() - t0), code: err.code, err: (err.message ?? String(e)).slice(0, 200) };
  }
}

/** An auth refusal is worth retrying (a pooler may not know a new role yet); a network failure is not. */
function authRefusal(c: Conn): boolean {
  return c.code === "28P01" || c.code === "28000" || /password|authenticat|tenant|not found/i.test(c.err ?? "");
}

/** db.<ref> does not resolve for the first minutes of a new project (run 1: ENOTFOUND 1 s after setup). */
function dnsMiss(c: Conn): boolean {
  return c.code === "ENOTFOUND" || c.code === "EAI_AGAIN";
}

/**
 * First login after the role exists: retry auth refusals up to `authMaxMs` and
 * DNS misses up to `dnsMaxMs`, report how long it took and what it last saw.
 */
async function firstLogin(
  path: PathDef,
  role: string,
  password: string,
  since: number,
  authMaxMs = 120_000,
  dnsMaxMs = 420_000,
): Promise<Conn & { attempts: number; sinceS: number; dnsMisses: number }> {
  let attempts = 0;
  let dnsMisses = 0;
  for (;;) {
    attempts++;
    const c = await connect(path, role, password);
    const elapsed = Date.now() - since;
    const sinceS = Math.round(elapsed / 100) / 10;
    if (dnsMiss(c)) dnsMisses++;
    const retry = (authRefusal(c) && elapsed < authMaxMs) || (dnsMiss(c) && elapsed < dnsMaxMs);
    if (c.client || !retry) return { ...c, attempts, sinceS, dnsMisses };
    await sleep(dnsMiss(c) ? 10_000 : 3_000);
  }
}

async function end(c?: Client) {
  try {
    await c?.end();
  } catch {}
}

/** "ok <first value>" or "denied <sqlstate>" / "err <sqlstate> <message>". */
async function attempt(c: Client, query: string): Promise<string> {
  try {
    const r = await c.query(query);
    const row = r.rows?.[0] as Record<string, unknown> | undefined;
    const v = row ? Object.values(row)[0] : undefined;
    return v === undefined ? "ok" : `ok ${String(v)}`;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "42501") return "denied 42501";
    return `err ${err.code ?? "?"} ${(err.message ?? String(e)).slice(0, 120)}`;
  }
}

async function adminSql(ctx: Ctx, ref: string, query: string): Promise<{ ok: boolean; json: unknown; text: string }> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, 60_000);
  return { ok: r.status >= 200 && r.status < 300, json: r.json, text: r.text.slice(0, 300) };
}

/** Per role: query -> expected prefix. */
function checksFor(role: string): Array<{ key: string; query: string; expect: string }> {
  const own = role === ROLE_A ? "svc_a.orders" : "svc_b.payroll";
  const other = role === ROLE_A ? "svc_b.payroll" : "svc_a.orders";
  const ownSchema = role === ROLE_A ? "svc_a" : "svc_b";
  const base = [
    { key: "whoami", query: "select current_user::text as u", expect: `ok ${role}` },
    { key: "own_read", query: `select count(*)::int as n from ${own}`, expect: "ok" },
    { key: "other_schema_read", query: `select count(*)::int as n from ${other}`, expect: "denied" },
    { key: "rls_shared_rows", query: "select count(*)::int as n from public.shared", expect: "ok 1" },
    { key: "ungranted_public_table", query: "select count(*)::int as n from public.internal_notes", expect: "denied" },
    { key: "auth_users", query: "select count(*)::int as n from auth.users", expect: "denied" },
    { key: "storage_objects", query: "select count(*)::int as n from storage.objects", expect: "denied" },
    { key: "ddl_own_schema", query: `create table ${ownSchema}.s24_ddl_${role}(i int)`, expect: "denied" },
    { key: "ddl_public", query: `create table public.s24_ddl_${role}(i int)`, expect: "denied" },
    { key: "set_role_postgres", query: "set role postgres", expect: "denied" },
    { key: "create_role", query: `create role s24_child_${role}`, expect: "denied" },
  ];
  if (role === ROLE_A) base.splice(2, 0, { key: "own_write", query: "insert into svc_a.orders(note) values ('s24') returning id", expect: "ok" });
  return base;
}

function matches(got: string, expect: string): boolean {
  return got === expect || got.startsWith(`${expect} `) || (expect === "ok" && got.startsWith("ok"));
}

const SETUP = (pa: string, pb: string) => `
create schema svc_a;
create schema svc_b;
create table svc_a.orders (id bigint generated always as identity primary key, note text);
insert into svc_a.orders (note) values ('a1'), ('a2');
create table svc_b.payroll (id bigint generated always as identity primary key, amount int);
insert into svc_b.payroll (amount) values (100), (200), (300);
create table public.shared (id int primary key, owner text not null);
insert into public.shared values (1, '${ROLE_A}'), (2, '${ROLE_B}'), (3, 'someone_else');
alter table public.shared enable row level security;
create table public.internal_notes (id int primary key, body text);
insert into public.internal_notes values (1, 'no grant to the service roles');
create role ${ROLE_A} login password '${pa}' nosuperuser nocreatedb nocreaterole noinherit;
create role ${ROLE_B} login password '${pb}' nosuperuser nocreatedb nocreaterole noinherit;
grant usage on schema svc_a to ${ROLE_A};
grant select, insert on svc_a.orders to ${ROLE_A};
grant usage on schema svc_b to ${ROLE_B};
grant select on svc_b.payroll to ${ROLE_B};
grant select on public.shared to ${ROLE_A}, ${ROLE_B};
create policy shared_own_rows on public.shared for select to ${ROLE_A}, ${ROLE_B} using (owner = current_user);
select 1 as done;
`;

const mod: TestModule = {
  id: "S24",
  title: "Per-service Postgres login roles: least-privilege grants, RLS and password rotation per connection path",
  where: "local",
  // `org` is only set from PVLAB_ORG_SLUGS; the Pro org arrives as ctx.orgs.pro and is checked in run().
  requires: ["pat"],
  destructive: true,
  timeoutMs: 40 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    if (!ctx.orgs.pro) return [{ id: "S24", title: mod.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    try {
      const p = await createProject(ctx, "pvlab-s24-", (r) => {
        ref = r;
        ctx.log(`S24 project ${r}`);
      });
      const pwA = pw();
      const pwB = pw();
      const setup = await adminSql(ctx, ref, SETUP(pwA, pwB));
      out.push({
        id: "S24a",
        title: "Setup: two service roles, own-schema grants, RLS policy on public.shared",
        status: setup.ok ? "info" : "fail",
        detail: setup.ok ? `project created in ${p.createS} s, ${p.pgVersion}` : "setup SQL failed",
        measurements: { create_s: p.createS, pg: p.pgVersion, setup_http_ok: String(setup.ok) },
        evidence: setup.ok ? undefined : setup.text,
      });
      if (!setup.ok) return out;
      const tSetup = Date.now();

      // Which role the Management API query route runs as, for the record.
      const who = await adminSql(ctx, ref, "select current_user::text as u, session_user::text as s");
      ctx.log(`S24 mgmt query role: ${JSON.stringify(who.json)}`);

      const paths = pathsFor(p);
      const live: PathDef[] = [];
      for (const path of paths) {
        for (const [role, password] of [
          [ROLE_A, pwA],
          [ROLE_B, pwB],
        ] as const) {
          const c = await firstLogin(path, role, password, tSetup);
          const m: Record<string, number | string> = {
            path: path.name,
            role,
            connect_ms: c.ms,
            login_attempts: c.attempts,
            dns_misses: c.dnsMisses,
            first_login_after_setup_s: c.sinceS,
          };
          if (!c.client) {
            out.push({
              id: `S24b-${path.name}-${role}`,
              title: `${role} on ${path.name}`,
              status: "fail",
              detail: `login failed: ${c.code ?? ""} ${c.err ?? ""}`.trim(),
              measurements: { ...m, login: `fail ${c.code ?? "?"}` },
            });
            continue;
          }
          m.login = "ok";
          const misses: string[] = [];
          for (const chk of checksFor(role)) {
            const got = await attempt(c.client, chk.query);
            m[chk.key] = got;
            if (!matches(got, chk.expect)) misses.push(`${chk.key}: got "${got}", expected "${chk.expect}"`);
          }
          await end(c.client);
          if (role === ROLE_A && !live.includes(path)) live.push(path);
          out.push({
            id: `S24b-${path.name}-${role}`,
            title: `${role} on ${path.name}`,
            status: misses.length === 0 ? "pass" : "fail",
            detail: misses.length === 0 ? "every check matched least privilege" : misses.join("; "),
            measurements: m,
          });
        }
      }

      // Password rotation: ALTER ROLE ... PASSWORD at t0, then poll each live path
      // with the new and the old password until both settle or ROTATE_MAX_MS.
      if (live.length > 0) {
        const pwA2 = pw();
        const t0 = Date.now();
        const alter = await adminSql(ctx, ref, `alter role ${ROLE_A} password '${pwA2}'; select 1 as done;`);
        const state = new Map<string, { newOkS?: number; oldFailS?: number; oldLastCode?: string; newLastCode?: string }>();
        for (const path of live) state.set(path.name, {});
        while (Date.now() - t0 < ROTATE_MAX_MS) {
          for (const path of live) {
            const s = state.get(path.name)!;
            if (s.newOkS === undefined) {
              const n = await connect(path, ROLE_A, pwA2);
              if (n.client) s.newOkS = Math.round((Date.now() - t0) / 100) / 10;
              else s.newLastCode = n.code ?? n.err?.slice(0, 60);
              await end(n.client);
            }
            if (s.oldFailS === undefined) {
              const o = await connect(path, ROLE_A, pwA);
              if (!o.client) {
                s.oldFailS = Math.round((Date.now() - t0) / 100) / 10;
                s.oldLastCode = o.code ?? o.err?.slice(0, 60);
              }
              await end(o.client);
            }
          }
          if ([...state.values()].every((s) => s.newOkS !== undefined && s.oldFailS !== undefined)) break;
          await sleep(ROTATE_STEP_MS);
        }
        for (const path of live) {
          const s = state.get(path.name)!;
          const settled = s.newOkS !== undefined && s.oldFailS !== undefined;
          out.push({
            id: `S24c-${path.name}`,
            title: `Password rotation on ${path.name}`,
            status: alter.ok ? "info" : "fail",
            detail: settled
              ? `new password accepted at ${s.newOkS} s, old refused from ${s.oldFailS} s`
              : `not settled within ${ROTATE_MAX_MS / 1000} s (new ok: ${s.newOkS ?? "never"}, old refused: ${s.oldFailS ?? "never"})`,
            measurements: {
              path: path.name,
              new_pw_ok_s: s.newOkS ?? -1,
              old_pw_refused_s: s.oldFailS ?? -1,
              // Old refused before new accepted = a stretch where neither password logs in (poll-step resolution).
              neither_works_s: s.newOkS !== undefined && s.oldFailS !== undefined ? Math.max(0, Math.round((s.newOkS - s.oldFailS) * 10) / 10) : -1,
              old_refusal: s.oldLastCode ?? "",
              new_last_error: s.newOkS === undefined ? (s.newLastCode ?? "") : "",
              poll_step_s: ROTATE_STEP_MS / 1000,
            },
          });
        }
      }

      // The dashboard Read-only role: attributes and what it sees on an RLS table.
      const ro = await adminSql(
        ctx,
        ref,
        `select r.rolname::text as role, r.rolbypassrls as bypassrls, r.rolcanlogin as canlogin, r.rolsuper as super,
           pg_has_role(r.oid, 'pg_read_all_data', 'member') as read_all_data,
           pg_has_role(r.oid, 'pg_write_all_data', 'member') as write_all_data
         from pg_roles r where r.rolname = 'supabase_read_only_user'`,
      );
      const row = (Array.isArray(ro.json) ? ro.json[0] : undefined) as Record<string, unknown> | undefined;
      const asRo = await adminSql(ctx, ref, "begin; set local role supabase_read_only_user; select count(*)::int as n from public.shared; commit;");
      const roRows = Array.isArray(asRo.json) ? String((asRo.json[0] as { n?: number } | undefined)?.n ?? "") : "";
      out.push({
        id: "S24d",
        title: "Dashboard Read-only role (supabase_read_only_user): attributes and rows seen on an RLS table",
        status: row ? "info" : "fail",
        detail: row
          ? `bypassrls=${row.bypassrls}, pg_read_all_data=${row.read_all_data}, rows of public.shared seen=${roRows || `n/a (${asRo.text.slice(0, 80)})`} of 3`
          : `role not found: ${ro.text.slice(0, 120)}`,
        measurements: {
          bypassrls: String(row?.bypassrls ?? ""),
          read_all_data: String(row?.read_all_data ?? ""),
          write_all_data: String(row?.write_all_data ?? ""),
          canlogin: String(row?.canlogin ?? ""),
          shared_rows_seen: roRows || "n/a",
        },
        evidence: asRo.ok ? undefined : asRo.text,
      });
      out.push({
        id: "S24e",
        title: "Management API query route role",
        status: "info",
        detail: JSON.stringify(who.json).slice(0, 120),
      });
    } catch (e) {
      out.push({ id: "S24x", title: "S24 aborted", status: "fail", detail: (e as Error).message.slice(0, 300) });
    } finally {
      if (ref) {
        const d = await deleteProject(ctx, ref);
        out.push({
          id: "S24z",
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
