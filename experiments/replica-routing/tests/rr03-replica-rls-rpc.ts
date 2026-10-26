/**
 * RR03 - user JWTs, RLS and RPC routing on a read replica, and the load
 * balancer's split when the primary and the replica share a region.
 *
 * Shape: a Small primary and a Small replica in the SAME region
 * (ap-southeast-1 by default), `pitr_7`, probed from a Singapore workstation
 * and from Edge Functions pinned with `x-region`. RR01/RR02 used a Tokyo
 * primary and a Singapore replica with the anon key only; this module adds
 * signed-in users, the new API keys and every function volatility.
 *
 * Every read names the node that ran it (`pg_is_in_recovery()`), never
 * latency. Rows that carry no body (HEAD) are classified through the view
 * `rr3_where` (one row, `in_recovery`): a HEAD with `count=exact` and
 * `in_recovery=eq.true` counts 1 on the replica and 0 on the primary.
 *
 *   RR03a  create the primary (Small, same region as the replica)
 *   RR03b  `pitr_7`, schema (RLS table, views, five functions), two users,
 *          seed rows, probe Edge Function
 *   RR03c  read replica in the same region; replica host; load balancer host
 *   RR03d  user JWTs through supabase-js and raw fetch on the load balancer,
 *          the replica host and the primary host: rows, auth.uid(), node, per
 *          client pattern (accessToken option, global Authorization header,
 *          auth.setSession, signInWithPassword on that host)
 *   RR03e  keys: legacy anon JWT, sb_publishable_, sb_secret_, legacy
 *          service_role, the ES256 user JWT, an HS256 user JWT minted with the
 *          legacy secret when the Management API returns it
 *   RR03f  RPC routing through the load balancer: each function by GET
 *          (`{ get: true }`) and POST; touch() by GET, which node refused it
 *   RR03g  HEAD + count=exact and GET + count=exact through the load balancer
 *   RR03h  same-region split: 200 GETs from this vantage and from Edge
 *          Functions (ap-southeast-1 200, two far regions 50 each)
 *   RR03i  lag under steady writes: 50 rows/s for 300 s, stale_ms through the
 *          load balancer, the replica host and the primary host; replay_lag
 *   RR03k  edge_logs on the load balancer host: redirect identifier per
 *          method and path, Cloudflare colo, chosen region
 *   RR03p  teardown
 *
 * DESTRUCTIVE and BILLABLE: Small primary + Small replica + `pitr_7`.
 * Env: PVLAB_ORG_PRO; PVLAB_RR_KEEP=1 skips teardown; PVLAB_RR_REFS_FILE
 * appends the created ref; PVLAB_RR3_REGION / PVLAB_RR3_REPLICA_REGION;
 * PVLAB_RR3_LAG_S (300) / PVLAB_RR3_LAG_RATE (50).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { fetchKeys, logsQuery, sql } from "../../../harness/src/platform";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PREFIX,
  applyAddon,
  connectSession,
  deployProbeFn,
  errText,
  findLoadBalancer,
  forRef,
  pct,
  poolerConfig,
  round,
  selectedAddons,
  sleep,
  waitProjectHealthy,
  type PoolerEntry,
} from "../lib/rr";
import { parseNode } from "../lib/rerouting";

const REGION = process.env.PVLAB_RR3_REGION ?? "ap-southeast-1";
const REPLICA_REGION = process.env.PVLAB_RR3_REPLICA_REGION ?? REGION;
const REPEAT = 5;
const SPLIT_N = 200;
const EDGE_VANTAGES: [string, number][] = [
  [REGION, 200],
  ["us-east-1", 50],
  ["eu-west-1", 50],
];
const LAG_S = Number(process.env.PVLAB_RR3_LAG_S ?? 300);
const LAG_RATE = Number(process.env.PVLAB_RR3_LAG_RATE ?? 50);
const READ_EVERY_MS = 250;

const SCHEMA = `
create table if not exists public.rr_marker (
  id bigserial primary key,
  tag text not null,
  written_at timestamptz not null default clock_timestamp()
);
insert into public.rr_marker(tag) values ('seed');
grant select on public.rr_marker to anon, authenticated;
create or replace function public.rr_whoami() returns json language sql stable as $$
  select json_build_object('in_recovery', pg_is_in_recovery(), 'addr', inet_server_addr()::text,
    'pm', extract(epoch from pg_postmaster_start_time())::bigint,
    'max_id', (select coalesce(max(id), 0) from public.rr_marker), 'now', clock_timestamp())
$$;
create or replace function public.rr_node() returns json language sql stable as $$
  select json_build_object(
    'in_recovery', pg_is_in_recovery(),
    'pm', extract(epoch from pg_postmaster_start_time())::bigint,
    'max_id', m.id,
    'stale_ms', round(extract(epoch from (clock_timestamp() - m.written_at)) * 1000)::bigint)
  from (select id, written_at from public.rr_marker order by id desc limit 1) m
$$;

create table if not exists public.rr3_docs (id bigserial primary key, tenant_id uuid not null, title text not null);
alter table public.rr3_docs enable row level security;
create policy rr3_docs_own on public.rr3_docs for select to authenticated using (tenant_id = (select auth.uid()));
grant select on public.rr3_docs to anon, authenticated;
create or replace view public.rr3_docs_v with (security_invoker = true) as
  select d.id, d.tenant_id, d.title, pg_is_in_recovery() as in_recovery, auth.uid() as uid from public.rr3_docs d;
grant select on public.rr3_docs_v to anon, authenticated;
create or replace view public.rr3_where as select pg_is_in_recovery() as in_recovery;
grant select on public.rr3_where to anon, authenticated;
create table if not exists public.rr3_touch (id bigserial primary key, uid uuid, at timestamptz not null default clock_timestamp());
grant select, insert on public.rr3_touch to anon, authenticated;
grant usage on sequence public.rr3_touch_id_seq to anon, authenticated;

create or replace function public.rr3_node() returns json language sql stable as $$
  select json_build_object('in_recovery', pg_is_in_recovery(), 'pm', extract(epoch from pg_postmaster_start_time())::bigint,
    'uid', auth.uid(), 'role', current_user, 'claim_role', auth.jwt()->>'role')
$$;
create or replace function public.list_docs_invoker() returns json language sql stable as $$
  select json_build_object('in_recovery', pg_is_in_recovery(), 'uid', auth.uid(), 'role', current_user,
    'n', (select count(*) from public.rr3_docs),
    'foreign', (select count(*) from public.rr3_docs where tenant_id is distinct from auth.uid()))
$$;
create or replace function public.list_docs_definer() returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('in_recovery', pg_is_in_recovery(), 'uid', auth.uid(), 'role', current_user,
    'n', (select count(*) from public.rr3_docs d where d.tenant_id = auth.uid()),
    'all_rows', (select count(*) from public.rr3_docs))
$$;
create or replace function public.list_docs_volatile() returns json language sql volatile as $$
  select json_build_object('in_recovery', pg_is_in_recovery(), 'uid', auth.uid(), 'role', current_user,
    'n', (select count(*) from public.rr3_docs),
    'foreign', (select count(*) from public.rr3_docs where tenant_id is distinct from auth.uid()))
$$;
create or replace function public.touch() returns json language plpgsql volatile as $$
begin
  insert into public.rr3_touch(uid) values (auth.uid());
  return json_build_object('in_recovery', pg_is_in_recovery(), 'uid', auth.uid(), 'role', current_user, 'wrote', true);
exception when others then
  -- re-raise with the original SQLSTATE and message; the detail names the node that refused it
  raise exception using errcode = SQLSTATE, message = SQLERRM,
    detail = format('in_recovery=%s', pg_is_in_recovery());
end;
$$;
grant execute on function public.rr_whoami(), public.rr_node(), public.rr3_node(), public.list_docs_invoker(),
  public.list_docs_definer(), public.list_docs_volatile(), public.touch() to anon, authenticated, service_role;
notify pgrst, 'reload schema';
`;

/* ---------- helpers ---------- */

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString()) as Record<string, unknown>;

/** What a header value is, never its value: `jwt ES256+kid role=authenticated`, `sb_publishable`, `none`. */
export function tokKind(v?: string | null): string {
  if (!v) return "none";
  const t = v.replace(/^Bearer\s+/i, "");
  if (t.startsWith("sb_publishable_")) return "sb_publishable";
  if (t.startsWith("sb_secret_")) return "sb_secret";
  const p = t.split(".");
  if (p.length !== 3) return "opaque";
  try {
    const h = b64json(p[0]!);
    const c = b64json(p[1]!);
    return `jwt ${h.alg}${h.kid ? "+kid" : ""} role=${c.role}`;
  } catch {
    return "jwt?";
  }
}

/** A fetch for supabase-js that records method, path and the KIND of auth headers sent. */
function capturingFetch(log: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    log.push(`${req.method} ${u.pathname}${u.search ? "?" + u.searchParams.toString().replace(/[a-z]{20}/g, "<ref>").slice(0, 80) : ""} apikey=${tokKind(req.headers.get("apikey"))} auth=${tokKind(req.headers.get("authorization"))}`);
    return fetch(req);
  }) as typeof fetch;
}

interface Body {
  node?: "primary" | "replica";
  uid?: string | null;
  role?: string;
  n?: number;
  foreign?: number;
  all_rows?: number;
  code?: string;
  detail?: string;
  msg?: string;
}
function readBody(data: unknown, error: { code?: string; details?: string; message?: string } | null): Body {
  if (error) return { code: error.code ?? "", detail: (error.details ?? "").slice(0, 60), msg: (error.message ?? "").slice(0, 70) };
  const o = (typeof data === "string" ? JSON.parse(data) : data) as Record<string, unknown> | null;
  if (!o || typeof o.in_recovery !== "boolean") return { msg: JSON.stringify(data)?.slice(0, 60) };
  return {
    node: o.in_recovery ? "replica" : "primary",
    uid: (o.uid as string | null) ?? null,
    role: o.role as string | undefined,
    n: o.n as number | undefined,
    foreign: o.foreign as number | undefined,
    all_rows: o.all_rows as number | undefined,
  };
}

interface Call {
  status: number;
  text: string;
  headers: Headers | null;
  err?: string;
}
async function call(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Call> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
    return { status: res.status, text: await res.text(), headers: res.headers };
  } catch (e) {
    return { status: 0, text: "", headers: null, err: errText(e).slice(0, 80) };
  }
}
function rawBody(c: Call): Body {
  if (!c.status) return { msg: c.err };
  try {
    const j = JSON.parse(c.text) as Record<string, unknown>;
    if (c.status >= 300) return { code: String(j.code ?? j.message ?? j.msg ?? "").slice(0, 70), detail: String(j.details ?? "").slice(0, 60) };
    return readBody(j, null);
  } catch {
    return { msg: c.text.replace(/\s+/g, " ").slice(0, 60) };
  }
}

function mintHS256(secret: string, claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = enc({ alg: "HS256", typ: "JWT" });
  const p = enc(claims);
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}

function pgClient(e: PoolerEntry, password: string, queryTimeoutMs?: number): Client {
  const c = new Client({
    host: e.db_host,
    port: 5432,
    user: e.db_user,
    password,
    database: e.db_name || "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    ...(queryTimeoutMs ? { query_timeout: queryTimeoutMs } : {}),
  });
  c.on("error", () => {});
  return c;
}

const supabaseJsVersion = (): string => {
  try {
    const req = createRequire(import.meta.url);
    const pj = req.resolve("@supabase/supabase-js/package.json");
    return String((JSON.parse(readFileSync(pj, "utf8")) as { version?: string }).version ?? "?");
  } catch {
    return "?";
  }
};

const mod: TestModule = {
  id: "RR03",
  title: "Read replica: user JWTs, RLS, API keys, RPC volatility and HEAD routing, same-region split, lag under steady writes",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const push = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id} ${r.status}${r.detail ? `: ${r.detail.slice(0, 260)}` : ""}`);
    };
    const org = ctx.orgs.pro;
    if (!org) return [{ id: "RR03", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const keep = process.env.PVLAB_RR_KEEP === "1";
    const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
    let ref = "";
    let replicaId = "";
    const t00 = Date.now();
    const jsVer = supabaseJsVersion();

    try {
      /* ---- RR03a ---- */
      const name = `${PREFIX}${Date.now()}`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name,
        db_pass: dbPass,
        region_selection: { type: "specific", code: REGION },
        desired_instance_size: "small",
      });
      ref = String((create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "");
      if (ref && process.env.PVLAB_RR_REFS_FILE) appendFileSync(process.env.PVLAB_RR_REFS_FILE, `${ref} ${name} ${new Date().toISOString()} RR03\n`);
      if (create.status !== 201 || !ref) {
        push({ id: "RR03a", title: `create primary (Small, ${REGION})`, status: "fail", detail: `HTTP ${create.status}: ${create.text.slice(0, 300)}` });
        return out;
      }
      ctx.log(`primary created (${name}); waiting healthy`);
      const h = await waitProjectHealthy(ctx, ref);
      push({
        id: "RR03a",
        title: `create primary (Small, ${REGION})`,
        status: h.status === "ACTIVE_HEALTHY" ? "pass" : "fail",
        detail: `create HTTP ${create.status}; ${h.status} after ${h.waitedS}s; supabase-js ${jsVer}`,
        measurements: { create_http: create.status, healthy_after_s: h.waitedS, region: REGION, replica_region: REPLICA_REGION, supabase_js: jsVer },
      });
      if (h.status !== "ACTIVE_HEALTHY") return out;
      const pctx = forRef(ctx, ref);
      const primaryBase = `https://${ref}.supabase.co`;

      /* ---- RR03b ---- */
      const have = await selectedAddons(pctx, ref);
      const pitr = have.includes("pitr_7") ? { status: 0, text: "already" } : await applyAddon(pctx, ref, "pitr", "pitr_7");
      const ddl = await sql(pctx, SCHEMA);
      let keys: Awaited<ReturnType<typeof fetchKeys>> | undefined;
      let keysErr = "";
      for (let i = 0; i < 18 && !keys; i++) {
        try {
          keys = await fetchKeys(pctx);
        } catch (e) {
          keysErr = errText(e);
          await sleep(10_000);
        }
      }
      if (!keys || ddl.status >= 300) {
        push({ id: "RR03b", title: "schema and keys", status: "fail", detail: `schema HTTP ${ddl.status} ${ddl.error}; keys ${keysErr}` });
        return out;
      }
      const anon = keys.anon;
      const svc = keys.service;
      // Two users through the Auth admin API on the primary host, then a password grant each.
      const users: { label: string; email: string; password: string; id: string; access: string; refresh: string }[] = [];
      const tag = Date.now();
      const authErr: string[] = [];
      for (const label of ["A", "B"]) {
        const email = `rr03-${label.toLowerCase()}-${tag}` + "@" + "example.com";
        const password = `${crypto.randomUUID()}Aa1!`;
        let id = "";
        for (let i = 0; i < 12 && !id; i++) {
          const mk = await call(`${primaryBase}/auth/v1/admin/users`, {
            method: "POST",
            headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, email_confirm: true }),
          });
          try {
            id = String((JSON.parse(mk.text) as { id?: string }).id ?? "");
          } catch {}
          if (!id) {
            authErr.push(`${label} create ${mk.status || mk.err}`);
            await sleep(10_000);
          }
        }
        users.push({ label, email, password, id, access: "", refresh: "" });
      }
      for (const u of users) {
        const mainClient = createClient(primaryBase, anon, { auth: { persistSession: false, autoRefreshToken: false } });
        const r = await mainClient.auth.signInWithPassword({ email: u.email, password: u.password });
        if (r.data.session) {
          u.access = r.data.session.access_token;
          u.refresh = r.data.session.refresh_token;
        } else authErr.push(`${u.label} sign-in ${r.error?.message ?? "?"}`);
        // No signOut here: signOut({ scope: "local" }) calls POST /logout, which ends the
        // session server-side, and a later setSession with that token then fails with
        // "Auth session missing!" (run 1, 2026-10-26). Each user gets a fresh client.
      }
      const A = users[0]!;
      const B = users[1]!;
      const other = crypto.randomUUID();
      const seed = await sql(
        pctx,
        `insert into public.rr3_docs(tenant_id, title) select '${A.id}'::uuid, 'a' || g from generate_series(1,3) g;
         insert into public.rr3_docs(tenant_id, title) select '${B.id}'::uuid, 'b' || g from generate_series(1,5) g;
         insert into public.rr3_docs(tenant_id, title) select '${other}'::uuid, 'o' || g from generate_series(1,2) g;`,
      );
      const dep = await deployProbeFn(pctx, ref);
      const tokA = A.access ? b64json(A.access.split(".")[1]!) : {};
      push({
        id: "RR03b",
        title: "pitr_7, schema (RLS table rr3_docs, views, five functions), two users, seed 3/5/2 rows, probe Edge Function",
        status: pitr.status < 300 && seed.status < 300 && A.access && B.access ? "pass" : "fail",
        detail: `pitr_7 ${pitr.status || "already"}; schema HTTP ${ddl.status}; seed HTTP ${seed.status}${seed.error ? ` ${seed.error}` : ""}; users ${users.filter((u) => u.access).length}/2 signed in${authErr.length ? ` (${authErr.join("; ")})` : ""}; user token ${tokKind(A.access)}, iss ${String(tokA.iss ?? "").replace(ref, "<ref>")}; publishable ${keys.publishable ? "present" : "absent"}, secret ${keys.secret ? "present" : "absent"}; function deploy HTTP ${dep.status}`,
        measurements: {
          pitr_http: pitr.status || "already",
          schema_http: ddl.status,
          seed_http: seed.status,
          users_signed_in: users.filter((u) => u.access).length,
          user_token: tokKind(A.access),
          user_token_iss: String(tokA.iss ?? "").replace(ref, "<ref>"),
          anon_key: tokKind(anon),
          publishable_key: keys.publishable ? "present" : "absent",
          secret_key: keys.secret ? "present" : "absent",
          fn_deploy_http: dep.status,
        },
      });
      if (!A.access || !B.access) return out;

      /* ---- RR03c: replica ---- */
      const t1 = Date.now();
      let setup = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/setup`, { read_replica_region: REPLICA_REGION });
      const attempts = [`0s HTTP ${setup.status} ${setup.text.slice(0, 160)}`];
      while (setup.status >= 300 && setup.status !== 402 && Date.now() - t1 < 12 * 60_000) {
        await sleep(30_000);
        setup = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/setup`, { read_replica_region: REPLICA_REGION });
        attempts.push(`${Math.round((Date.now() - t1) / 1000)}s HTTP ${setup.status} ${setup.text.slice(0, 160)}`);
      }
      let replica: PoolerEntry | undefined;
      let servedS: number | string = "never";
      let lastErr = "";
      if (setup.status < 300) {
        const t2 = Date.now();
        while (Date.now() - t2 < 30 * 60_000) {
          replica = (await poolerConfig(pctx, ref).catch(() => [])).find((e) => e.database_type === "READ_REPLICA");
          if (replica) {
            try {
              const c = await connectSession(replica, dbPass, 1, 0);
              await c.end();
              servedS = Math.round((Date.now() - t1) / 1000);
              break;
            } catch (e) {
              lastErr = errText(e);
            }
          }
          await sleep(15_000);
        }
      }
      if (!replica || servedS === "never") {
        push({ id: "RR03c", title: "read replica", status: "fail", detail: `setup ${attempts[attempts.length - 1]}; served ${servedS}; ${lastErr}`, evidence: attempts.join("\n") });
        return out;
      }
      replicaId = replica.identifier;
      const primaryEntry = (await poolerConfig(pctx, ref)).find((e) => e.database_type === "PRIMARY")!;
      const replicaBase = `https://${replicaId}.supabase.co`;
      let replicaUp = await call(`${replicaBase}/rest/v1/rpc/rr_node`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
      for (let i = 0; i < 18 && parseNode(replicaUp.status, replicaUp.text).node !== "replica"; i++) {
        await sleep(10_000);
        replicaUp = await call(`${replicaBase}/rest/v1/rpc/rr_node`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
      }
      const lb = await findLoadBalancer(pctx, ref, anon);
      push({
        id: "RR03c",
        title: `read-replicas/setup ${REPLICA_REGION} (primary ${REGION}); replica host; load balancer host`,
        status: lb.url ? "pass" : "fail",
        detail: `setup ${attempts[attempts.length - 1]!.replace(/\s+$/, "")}; first session connection after ${servedS}s; replica host rr_node HTTP ${replicaUp.status}; load balancer ${lb.url ? lb.url.replace(ref, "<ref>").replace(/^https:\/\//, "") : "NOT found"} (candidates ${lb.tried.join(",")})`,
        measurements: { setup_http: setup.status, setup_attempts: attempts.length, served_after_s: servedS, replica_rest_http: replicaUp.status },
        evidence: attempts.join("\n"),
      });
      if (!lb.url) return out;
      const lbBase = lb.url;
      const lbHost = new URL(lbBase).hostname;
      const hosts: [string, string][] = [
        ["lb", lbBase],
        ["replica", replicaBase],
        ["primary", primaryBase],
      ];
      const uidLabel = (u?: string | null) => (u === undefined ? "-" : u === null ? "null" : u === A.id ? "A" : u === B.id ? "B" : "other");
      const fmt = (b: Body, extra = "") =>
        b.node
          ? `${b.node} uid=${uidLabel(b.uid)}${b.role ? ` role=${b.role}` : ""}${b.n !== undefined ? ` n=${b.n}` : ""}${b.foreign !== undefined ? ` foreign=${b.foreign}` : ""}${b.all_rows !== undefined ? ` all_rows=${b.all_rows}` : ""}${extra}`
          : `ERR ${b.code ?? ""} ${b.detail ?? ""} ${b.msg ?? ""}`.replace(/\s+/g, " ").trim();

      /* ---- RR03d: user JWTs, RLS, auth.uid() per client pattern ---- */
      {
        const m: Record<string, string> = {};
        const ev: string[] = [];
        const viewRead = async (c: SupabaseClient) => {
          const r = await c.from("rr3_docs_v").select("*");
          if (r.error) return `ERR ${r.status} ${r.error.code ?? ""} ${(r.error.message ?? "").slice(0, 60)}`;
          const rows = (r.data ?? []) as { tenant_id: string; in_recovery: boolean; uid: string | null }[];
          const nodes = [...new Set(rows.map((x) => (x.in_recovery ? "replica" : "primary")))].join("+") || "no-rows";
          const uids = [...new Set(rows.map((x) => uidLabel(x.uid)))].join("+") || "-";
          const foreign = rows.filter((x) => x.tenant_id !== x.uid).length;
          return `rows=${rows.length} node=${nodes} uid=${uids} foreign=${foreign}`;
        };
        const rpcRead = async (c: SupabaseClient) => {
          const r = await c.rpc("rr3_node", {}, { get: true });
          return r.error ? `ERR ${r.status} ${r.error.code ?? ""} ${(r.error.message ?? "").slice(0, 60)}` : fmt(readBody(r.data, null));
        };
        for (const [hn, base] of hosts) {
          for (const u of [A, B]) {
            // (1) accessToken option
            const log1: string[] = [];
            const c1 = createClient(base, anon, { accessToken: async () => u.access, global: { fetch: capturingFetch(log1) } });
            m[`${hn}_${u.label}_accessToken_view`] = await viewRead(c1);
            m[`${hn}_${u.label}_accessToken_rpc`] = await rpcRead(c1);
            // (2) global Authorization header
            const log2: string[] = [];
            const c2 = createClient(base, anon, {
              auth: { persistSession: false, autoRefreshToken: false },
              global: { headers: { Authorization: `Bearer ${u.access}` }, fetch: capturingFetch(log2) },
            });
            m[`${hn}_${u.label}_header_view`] = await viewRead(c2);
            m[`${hn}_${u.label}_header_rpc`] = await rpcRead(c2);
            // (3) auth.setSession on a client for this host
            const log3: string[] = [];
            const c3 = createClient(base, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: capturingFetch(log3) } });
            const ss = await c3.auth.setSession({ access_token: u.access, refresh_token: u.refresh });
            m[`${hn}_${u.label}_setSession`] = ss.error ? `ERR ${ss.error.status ?? ""} ${(ss.error.message ?? "").slice(0, 60)}` : "ok";
            m[`${hn}_${u.label}_setSession_view`] = await viewRead(c3);
            // (4) raw fetch, anon apikey + user bearer
            const H = { apikey: anon, Authorization: `Bearer ${u.access}` };
            const rv = await call(`${base}/rest/v1/rr3_docs_v?select=*`, { headers: H });
            let rvs = `HTTP ${rv.status}`;
            try {
              const rows = JSON.parse(rv.text) as { tenant_id: string; in_recovery: boolean; uid: string }[];
              if (Array.isArray(rows))
                rvs = `rows=${rows.length} node=${[...new Set(rows.map((x) => (x.in_recovery ? "replica" : "primary")))].join("+") || "no-rows"} uid=${[...new Set(rows.map((x) => uidLabel(x.uid)))].join("+") || "-"} foreign=${rows.filter((x) => x.tenant_id !== x.uid).length}`;
            } catch {}
            m[`${hn}_${u.label}_raw_view`] = rvs;
            m[`${hn}_${u.label}_raw_rpc`] = fmt(rawBody(await call(`${base}/rest/v1/rpc/rr3_node`, { headers: H })));
            if (u === A) ev.push(`${hn} accessToken: ${log1.slice(0, 2).join(" | ")}`, `${hn} header: ${log2.slice(0, 2).join(" | ")}`, `${hn} setSession: ${log3.join(" | ")}`);
          }
          // anon, no user: RLS gives zero rows
          const c0 = createClient(base, anon, { auth: { persistSession: false, autoRefreshToken: false } });
          m[`${hn}_anon_view`] = await viewRead(c0);
          m[`${hn}_anon_rpc`] = await rpcRead(c0);
          // (5) signInWithPassword on a client for this host, then that token on the replica host
          const c4 = createClient(base, anon, { auth: { persistSession: false, autoRefreshToken: false } });
          const si = await c4.auth.signInWithPassword({ email: B.email, password: B.password });
          if (si.data.session) {
            const p = b64json(si.data.session.access_token.split(".")[1]!);
            m[`${hn}_signIn`] = `ok ${tokKind(si.data.session.access_token)} iss=${String(p.iss ?? "").replace(ref, "<ref>").replace(replicaId, "<replica-id>")}`;
            m[`${hn}_signIn_view`] = await viewRead(c4);
            const onReplica = await call(`${replicaBase}/rest/v1/rpc/rr3_node`, { headers: { apikey: anon, Authorization: `Bearer ${si.data.session.access_token}` } });
            m[`${hn}_signIn_token_on_replica_host`] = fmt(rawBody(onReplica));
          } else m[`${hn}_signIn`] = `ERR ${si.error?.status ?? ""} ${(si.error?.message ?? "").slice(0, 60)}`;
        }
        push({
          id: "RR03d",
          title: `user JWTs (2 users) through supabase-js ${jsVer} and raw fetch on the load balancer, replica and primary hosts: rows of rr3_docs_v (RLS), auth.uid(), node`,
          status: "info",
          detail: ["lb_A_accessToken_view", "lb_A_header_view", "lb_A_setSession", "replica_A_accessToken_view", "replica_B_header_view", "replica_A_setSession", "replica_signIn", "lb_signIn", "lb_anon_view"]
            .map((k) => `${k} ${m[k]}`)
            .join("; "),
          measurements: m,
          evidence: ev.join("\n"),
        });
      }

      /* ---- RR03e: keys ---- */
      {
        const m: Record<string, string> = {};
        let hsToken = "";
        const pg = await mgmt(pctx, "GET", `/projects/${ref}/postgrest`);
        const legacySecret = String((pg.json as { jwt_secret?: string } | undefined)?.jwt_secret ?? "");
        m.legacy_secret_from_postgrest_config = legacySecret ? "returned" : `absent (HTTP ${pg.status})`;
        if (legacySecret) {
          const claims = { ...b64json(A.access.split(".")[1]!) };
          hsToken = mintHS256(legacySecret, claims);
        }
        const pub = keys.publishable ?? "";
        const sec = keys.secret ?? "";
        const combos: [string, Record<string, string>][] = [
          ["anon_jwt", { apikey: anon, Authorization: `Bearer ${anon}` }],
          ["publishable_apikey_only", { apikey: pub }],
          ["publishable_bearer_publishable", { apikey: pub, Authorization: `Bearer ${pub}` }],
          ["publishable_plus_user_es256", { apikey: pub, Authorization: `Bearer ${A.access}` }],
          ["anon_plus_user_es256", { apikey: anon, Authorization: `Bearer ${A.access}` }],
          ...(hsToken ? ([["anon_plus_user_hs256", { apikey: anon, Authorization: `Bearer ${hsToken}` }]] as [string, Record<string, string>][]) : []),
          ...(hsToken ? ([["publishable_plus_user_hs256", { apikey: pub, Authorization: `Bearer ${hsToken}` }]] as [string, Record<string, string>][]) : []),
          ["service_role_jwt", { apikey: svc, Authorization: `Bearer ${svc}` }],
          ["secret_apikey_only", { apikey: sec }],
        ];
        for (const [hn, base] of hosts) {
          for (const [k, H] of combos) {
            if (!H.apikey) {
              m[`${hn}_${k}`] = "key absent";
              continue;
            }
            const r = await call(`${base}/rest/v1/rpc/list_docs_invoker`, { headers: H });
            m[`${hn}_${k}`] = `${r.status} ${fmt(rawBody(r))}`;
          }
          // supabase-js with the publishable key, anonymous and with the user token
          const log: string[] = [];
          const cp = createClient(base, pub, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: capturingFetch(log) } });
          const r1 = await cp.rpc("list_docs_invoker", {}, { get: true });
          m[`${hn}_js_publishable`] = `${r1.status} ${fmt(readBody(r1.data, r1.error))}`;
          const cpu = createClient(base, pub, { accessToken: async () => A.access, global: { fetch: capturingFetch(log) } });
          const r2 = await cpu.rpc("list_docs_invoker", {}, { get: true });
          m[`${hn}_js_publishable_accessToken`] = `${r2.status} ${fmt(readBody(r2.data, r2.error))}`;
          if (hn === "lb") m.js_publishable_headers_sent = log.join(" | ");
        }
        push({
          id: "RR03e",
          title: "API keys and token types on GET rpc/list_docs_invoker (stable, invoker, RLS) per host",
          status: "info",
          detail: Object.entries(m)
            .filter(([k]) => k.startsWith("replica_"))
            .map(([k, v]) => `${k} ${v}`)
            .join("; "),
          measurements: m,
        });
      }

      /* ---- RR03f: RPC routing by volatility and method ---- */
      {
        const m: Record<string, string> = {};
        const ev: string[] = [];
        const before = await sql(pctx, "select count(*)::int as n from public.rr3_touch");
        const log: string[] = [];
        const c = createClient(lbBase, anon, { accessToken: async () => A.access, global: { fetch: capturingFetch(log) } });
        for (const fn of ["rr3_node", "list_docs_invoker", "list_docs_definer", "list_docs_volatile", "touch"]) {
          for (const how of ["get", "post"] as const) {
            const t: Record<string, number> = {};
            for (let i = 0; i < REPEAT; i++) {
              const r = how === "get" ? await c.rpc(fn, {}, { get: true }) : await c.rpc(fn);
              const k = `${r.status} ${fmt(readBody(r.data, r.error))}`;
              t[k] = (t[k] ?? 0) + 1;
            }
            m[`lb_${fn}_${how}`] = Object.entries(t)
              .map(([k, n]) => `${k} x${n}`)
              .join(" | ");
          }
          // Reference: the same function by GET and POST on the replica's own host and the primary's (raw fetch).
          for (const [hn, base] of hosts.slice(1)) {
            const H = { apikey: anon, Authorization: `Bearer ${A.access}` };
            const g = await call(`${base}/rest/v1/rpc/${fn}`, { headers: H });
            const p = await call(`${base}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: "{}" });
            m[`${hn}_${fn}_get`] = `${g.status} ${fmt(rawBody(g))}`;
            m[`${hn}_${fn}_post`] = `${p.status} ${fmt(rawBody(p))}`;
          }
        }
        const after = await sql(pctx, "select count(*)::int as n from public.rr3_touch");
        m.touch_rows_before = String(before.rows[0]?.n ?? "?");
        m.touch_rows_after = String(after.rows[0]?.n ?? "?");
        ev.push(...[...new Set(log.map((l) => l.replace(/\?.*? apikey/, " apikey")))]);
        push({
          id: "RR03f",
          title: `RPC routing through the load balancer by function volatility and method (supabase-js rpc with and without { get: true }, user A, ${REPEAT} each); replica and primary hosts by raw fetch`,
          status: "info",
          detail: Object.entries(m)
            .filter(([k]) => k.startsWith("lb_"))
            .map(([k, v]) => `${k} ${v}`)
            .join("; "),
          measurements: m,
          evidence: `requests sent by supabase-js (method path apikey/auth kind):\n${ev.join("\n")}`,
        });
      }

      /* ---- RR03g: HEAD and GET with count=exact ---- */
      {
        const m: Record<string, string> = {};
        const log: string[] = [];
        const c = createClient(lbBase, anon, { accessToken: async () => A.access, global: { fetch: capturingFetch(log) } });
        const tally = (xs: string[]) => {
          const t: Record<string, number> = {};
          for (const x of xs) t[x] = (t[x] ?? 0) + 1;
          return Object.entries(t)
            .map(([k, n]) => `${k} x${n}`)
            .join(" | ");
        };
        const head: string[] = [];
        const getc: string[] = [];
        const headDocs: string[] = [];
        for (let i = 0; i < 10; i++) {
          const h1 = await c.from("rr3_where").select("*", { count: "exact", head: true }).eq("in_recovery", true);
          head.push(h1.error ? `ERR ${h1.status} ${h1.error.code ?? h1.error.message}` : `${h1.status} ${h1.count === 1 ? "replica" : h1.count === 0 ? "primary" : `count=${h1.count}`}`);
          const g1 = await c.from("rr3_where").select("*", { count: "exact" });
          const rows = (g1.data ?? []) as { in_recovery: boolean }[];
          getc.push(g1.error ? `ERR ${g1.status} ${g1.error.code}` : `${g1.status} ${rows[0]?.in_recovery ? "replica" : "primary"} count=${g1.count}`);
          const h2 = await c.from("rr3_docs").select("*", { count: "exact", head: true });
          headDocs.push(h2.error ? `ERR ${h2.status} ${h2.error.code}` : `${h2.status} count=${h2.count}`);
        }
        m.head_count_exact_rr3_where = tally(head);
        m.get_count_exact_rr3_where = tally(getc);
        m.head_count_exact_rr3_docs_userA = tally(headDocs);
        // The same HEAD on the replica's own host (raw).
        const rh = await call(`${replicaBase}/rest/v1/rr3_where?select=*&in_recovery=eq.true`, { method: "HEAD", headers: { apikey: anon, Authorization: `Bearer ${A.access}`, Prefer: "count=exact" } });
        m.replica_host_head = `${rh.status} content-range ${rh.headers?.get("content-range") ?? "none"} content-type ${rh.headers?.get("content-type") ?? "none"}`;
        const rg = await call(`${replicaBase}/rest/v1/rr3_where?select=*&in_recovery=eq.true`, { headers: { apikey: anon, Authorization: `Bearer ${A.access}`, Prefer: "count=exact" } });
        m.replica_host_get_count = `${rg.status} content-range ${rg.headers?.get("content-range") ?? "none"} body ${rg.text.replace(/\s+/g, " ").slice(0, 80)}`;
        const ph = await call(`${primaryBase}/rest/v1/rr3_where?select=*&in_recovery=eq.true`, { method: "HEAD", headers: { apikey: anon, Authorization: `Bearer ${A.access}`, Prefer: "count=exact" } });
        m.primary_host_head = `${ph.status} content-range ${ph.headers?.get("content-range") ?? "none"}`;
        m.methods_sent = [...new Set(log.map((l) => l.split(" ")[0]))].join(",");
        push({
          id: "RR03g",
          title: "HEAD + count=exact and GET + count=exact through the load balancer (10 each; node from view rr3_where)",
          status: "info",
          detail: Object.entries(m)
            .map(([k, v]) => `${k} ${v}`)
            .join("; "),
          measurements: m,
        });
      }

      /* ---- RR03h: same-region split ---- */
      {
        // Sequence string per vantage: P primary, R replica, E error. `switches`
        // counts adjacent changes: strict alternation gives n-1, independent
        // 50/50 draws about n/2, sticky routing near 0.
        const seqStats = (seq: string) => {
          let sw = 0;
          for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) sw++;
          let run = 0;
          let maxRun = 0;
          for (let i = 0; i < seq.length; i++) {
            run = i && seq[i] === seq[i - 1] ? run + 1 : 1;
            maxRun = Math.max(maxRun, run);
          }
          return { switches: sw, max_run: maxRun };
        };
        const local = async (n: number, close: boolean) => {
          let seq = "";
          const msBy: Record<string, number[]> = { P: [], R: [] };
          for (let i = 0; i < n; i++) {
            const t0 = performance.now();
            const r = await call(`${lbBase}/rest/v1/rpc/rr_whoami`, { headers: { apikey: anon, Authorization: `Bearer ${anon}`, ...(close ? { Connection: "close" } : {}) } });
            const ms = performance.now() - t0;
            const nn = parseNode(r.status, r.text);
            const c = nn.node === "replica" ? "R" : nn.node === "primary" ? "P" : "E";
            seq += c;
            if (c !== "E" && i > 0) msBy[c]!.push(ms);
          }
          return { seq, msBy };
        };
        for (const [id, n, close] of [["RR03h0", SPLIT_N, false], ["RR03h0c", 50, true]] as const) {
          const { seq, msBy } = await local(n, close);
          const cnt = (c: string) => seq.split("").filter((x) => x === c).length;
          push({
            id,
            title: `same-region split: ${n} sequential GET rpc/rr_whoami through the load balancer from this vantage (anon${close ? ", Connection: close" : ", keep-alive"})`,
            status: "info",
            detail: `primary ${cnt("P")}, replica ${cnt("R")}, errors ${cnt("E")}; switches ${seqStats(seq).switches}, longest run ${seqStats(seq).max_run}; p50 primary ${round(pct(msBy.P!, 50))} ms, replica ${round(pct(msBy.R!, 50))} ms`,
            measurements: { n, primary: cnt("P"), replica: cnt("R"), errors: cnt("E"), ...seqStats(seq), p50_primary_ms: round(pct(msBy.P!, 50)), p50_replica_ms: round(pct(msBy.R!, 50)) },
            evidence: `sequence: ${seq}`,
          });
        }
        for (const [i, [region, n]] of EDGE_VANTAGES.entries()) {
          let status = 0;
          let served = "";
          let seq = "";
          let err = "";
          for (let a = 0; a < 2 && status !== 200; a++) {
            const r = await call(`${primaryBase}/functions/v1/${"rr-probe"}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${anon}`, "x-region": region },
              body: JSON.stringify({ targets: [{ name: "lb", url: lbBase }], n, anon }),
              timeoutMs: 150_000,
            });
            status = r.status;
            served = r.headers?.get("x-sb-edge-region") ?? "";
            err = r.err ?? (r.status === 200 ? "" : r.text.slice(0, 100));
            try {
              const j = JSON.parse(r.text) as { out?: { samples: { status: number; in_recovery?: boolean }[] }[] };
              seq = (j.out?.[0]?.samples ?? []).map((x) => (x.status !== 200 ? "E" : x.in_recovery ? "R" : "P")).join("");
            } catch {}
            if (status !== 200) await sleep(10_000);
          }
          const cnt = (c: string) => seq.split("").filter((x) => x === c).length;
          push({
            id: `RR03h${i + 1}`,
            title: `same-region split: ${n} GET rpc/rr_whoami through the load balancer from an Edge Function invoked with x-region ${region}`,
            status: "info",
            detail: `HTTP ${status}; served ${served || "?"}; primary ${cnt("P")}, replica ${cnt("R")}, errors ${cnt("E")}; switches ${seqStats(seq).switches}, longest run ${seqStats(seq).max_run}${err ? `; ${err}` : ""}`,
            measurements: { requested: region, fn_status: status, served_region: served, n, primary: cnt("P"), replica: cnt("R"), errors: cnt("E"), ...seqStats(seq) },
            evidence: `sequence: ${seq}`,
          });
        }
      }

      /* ---- RR03i: lag under steady writes ---- */
      {
        const stop = { v: false };
        const samples: Record<string, { node?: string; stale?: number; err?: string }[]> = { lb: [], replica: [], primary: [] };
        const replay: number[] = [];
        const replayErr: string[] = [];
        let rows = 0;
        let wErr = 0;
        let wLast = "";
        const writer = (async () => {
          const c = pgClient(primaryEntry, dbPass, 10_000);
          await c.connect();
          const t0 = performance.now();
          const every = 1000 / LAG_RATE;
          let i = 0;
          while (!stop.v) {
            const due = t0 + i * every;
            const wait = due - performance.now();
            if (wait > 0) await sleep(wait);
            i++;
            try {
              await c.query("insert into public.rr_marker(tag) values ('lag')");
              rows++;
            } catch (e) {
              wErr++;
              wLast = errText(e).slice(0, 80);
            }
          }
          await c.end().catch(() => {});
          return (performance.now() - t0) / 1000;
        })();
        const reader = (src: string, base: string) =>
          (async () => {
            while (!stop.v) {
              const r = await call(`${base}/rest/v1/rpc/rr_node`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` }, timeoutMs: 5000 });
              const n = parseNode(r.status, r.text);
              samples[src]!.push({ node: n.node, stale: n.staleMs, err: n.err ?? r.err });
              await sleep(READ_EVERY_MS);
            }
          })();
        const mon = (async () => {
          const c = pgClient(primaryEntry, dbPass, 10_000);
          try {
            await c.connect();
            while (!stop.v) {
              try {
                const r = await c.query<{ ms: string | null }>("select (extract(epoch from replay_lag) * 1000)::text as ms from pg_stat_replication limit 1");
                const v = r.rows[0]?.ms;
                if (v != null) replay.push(Number(v));
                else replayErr.push("no row or null");
              } catch (e) {
                replayErr.push(errText(e).slice(0, 80));
              }
              await sleep(5000);
            }
          } catch (e) {
            replayErr.push(`connect ${errText(e).slice(0, 80)}`);
          } finally {
            await c.end().catch(() => {});
          }
        })();
        await sleep(2000);
        const readers = hosts.map(([hn, base]) => reader(hn, base));
        await sleep(LAG_S * 1000);
        stop.v = true;
        const wallS = await writer;
        await Promise.all([...readers, mon]);
        const m: Record<string, number | string> = { lag_s: LAG_S, target_rows_per_s: LAG_RATE, rows_written: rows, achieved_rows_per_s: round(rows / wallS, 1), writer_errors: wErr };
        for (const [hn] of hosts) {
          const ss = samples[hn]!;
          const st = ss.filter((x) => x.stale !== undefined).map((x) => x.stale!);
          m[`${hn}_n`] = ss.length;
          m[`${hn}_replica`] = ss.filter((x) => x.node === "replica").length;
          m[`${hn}_primary`] = ss.filter((x) => x.node === "primary").length;
          m[`${hn}_errors`] = ss.filter((x) => !x.node).length;
          m[`${hn}_stale_p50_ms`] = pct(st, 50);
          m[`${hn}_stale_p95_ms`] = pct(st, 95);
          m[`${hn}_stale_max_ms`] = st.length ? Math.max(...st) : "none";
          m[`${hn}_stale_min_ms`] = st.length ? Math.min(...st) : "none";
        }
        m.replay_lag_samples = replay.length;
        m.replay_lag_p50_ms = replay.length ? round(pct(replay, 50), 1) : "none";
        m.replay_lag_p95_ms = replay.length ? round(pct(replay, 95), 1) : "none";
        m.replay_lag_max_ms = replay.length ? round(Math.max(...replay), 1) : "none";
        push({
          id: "RR03i",
          title: `lag under steady writes: ${LAG_RATE} single-row inserts/s for ${LAG_S} s on the primary; stale_ms of rpc/rr_node every ${READ_EVERY_MS} ms per host; pg_stat_replication.replay_lag every 5 s`,
          status: "info",
          detail: `rows ${rows} (${m.achieved_rows_per_s}/s, ${wErr} errors); lb replica ${m.lb_replica}/${m.lb_n} stale p50/p95/max ${m.lb_stale_p50_ms}/${m.lb_stale_p95_ms}/${m.lb_stale_max_ms} ms; replica host ${m.replica_stale_p50_ms}/${m.replica_stale_p95_ms}/${m.replica_stale_max_ms}; primary host ${m.primary_stale_p50_ms}/${m.primary_stale_p95_ms}/${m.primary_stale_max_ms}; replay_lag p50/p95/max ${m.replay_lag_p50_ms}/${m.replay_lag_p95_ms}/${m.replay_lag_max_ms} ms (n ${replay.length})`,
          measurements: m,
          evidence: `writer last error: ${wLast || "none"}\nreplay_lag errors: ${[...new Set(replayErr)].join("; ") || "none"}\nerror texts: ${hosts.map(([hn]) => `${hn}: ${[...new Set(samples[hn]!.filter((x) => !x.node).map((x) => x.err))].join("; ") || "none"}`).join(" | ")}`,
        });
      }

      /* ---- RR03k: edge_logs ---- */
      {
        const Q =
          "select log_attributes['request.method'] as method, log_attributes['request.path'] as path, " +
          "log_attributes['response.status_code'] as status, log_attributes['request.cf.colo'] as colo, " +
          "log_attributes['load_balancer_geo_aware_info.available_supabase_regions'] as available, " +
          "log_attributes['load_balancer_geo_aware_info.chosen_supabase_region'] as chosen, " +
          "log_attributes['load_balancer_redirect_identifier'] as redirect, count(*) as n " +
          `from logs where source = 'edge_logs' and log_attributes['request.host'] = '${lbHost}' ` +
          "group by method, path, status, colo, available, chosen, redirect order by n desc limit 300";
        let rows: Record<string, unknown>[] = [];
        let lastErr2 = "";
        const t0 = Date.now();
        // Ingestion lags: run 1 (2026-10-26) stopped at the first poll with 1,705 rows
        // while the module had sent several thousand. Poll until the total stops growing.
        let prevTotal = -1;
        while (Date.now() - t0 < 6 * 60_000) {
          await sleep(45_000);
          const q = await logsQuery(pctx, Q, 2);
          if (q.error) lastErr2 = q.error;
          if (q.rows.length) {
            rows = q.rows as Record<string, unknown>[];
            const total = rows.reduce((a, x) => a + Number(x.n ?? 0), 0);
            if (total === prevTotal) break;
            prevTotal = total;
          }
        }
        const target = (v: unknown) => {
          const s = String(v ?? "");
          return !s ? "none" : s === `${ref}.supabase.co` ? "primary" : s === `${replicaId}.supabase.co` ? "replica" : s.replace(ref, "<ref>");
        };
        const agg: Record<string, number> = {};
        for (const x of rows) {
          const path = String(x.path ?? "").replace(/^\/rest\/v1\//, "");
          const key = `${x.method} ${path} ${x.status} colo=${x.colo} chosen=${x.chosen} -> ${target(x.redirect)}`;
          agg[key] = (agg[key] ?? 0) + Number(x.n ?? 0);
        }
        const lines = Object.entries(agg)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k} n=${n}`);
        const m: Record<string, number | string> = { groups: rows.length, rows: rows.reduce((a, x) => a + Number(x.n ?? 0), 0) };
        for (const meth of ["GET", "HEAD", "POST"]) {
          for (const t of ["primary", "replica", "none"]) {
            const n = Object.entries(agg)
              .filter(([k]) => k.startsWith(`${meth} `) && k.endsWith(`-> ${t}`))
              .reduce((a, [, v]) => a + v, 0);
            if (n) m[`${meth}_to_${t}`] = n;
          }
        }
        m.available_regions = [...new Set(rows.map((x) => String(x.available ?? "")))].join(" / ");
        push({
          id: "RR03k",
          title: "edge_logs on the load balancer host: redirect identifier per method, path and status; Cloudflare colo; chosen region",
          status: "info",
          detail: `${m.rows} rows in ${rows.length} groups after ${Math.round((Date.now() - t0) / 1000)} s${lastErr2 ? `; last endpoint error ${lastErr2.slice(0, 80)}` : ""}`,
          measurements: m,
          evidence: lines.join("\n"),
        });
      }
    } catch (e) {
      push({ id: "RR03x", title: "module aborted", status: "fail", detail: errText(e) });
    } finally {
      /* ---- RR03p ---- */
      if (ref && !keep) {
        const pctx = forRef(ctx, ref);
        let rm = 0;
        if (replicaId) {
          const r = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/remove`, { database_identifier: replicaId }).catch(() => null);
          rm = r?.status ?? 0;
          await sleep(20_000);
        }
        let del = await mgmt(pctx, "DELETE", `/projects/${ref}`).catch(() => null);
        for (let i = 0; i < 6 && (del?.status ?? 0) >= 300; i++) {
          await sleep(30_000);
          del = await mgmt(pctx, "DELETE", `/projects/${ref}`).catch(() => null);
        }
        push({
          id: "RR03p",
          title: "teardown: replica removed, project deleted",
          status: (del?.status ?? 0) < 300 ? "pass" : "fail",
          detail: `replica remove HTTP ${rm || "n/a"}; project DELETE HTTP ${del?.status ?? 0}; run took ${Math.round((Date.now() - t00) / 60000)} min`,
          measurements: { replica_remove_http: rm, project_delete_http: del?.status ?? 0, run_min: Math.round((Date.now() - t00) / 60000) },
        });
      } else if (ref) {
        ctx.log("project LEFT RUNNING (PVLAB_RR_KEEP=1) - delete it by hand");
      }
    }
    return out;
  },
};
export default mod;
