/**
 * RR06 - a read replica on a project that also has a custom domain.
 *
 * The read replicas guide says requests through a custom domain are not routed
 * through the load balancer and points at the dedicated endpoints instead. That
 * leaves an app with a custom domain (OAuth callbacks, SAML EntityID) three
 * shapes for sending reads to a replica: a second supabase-js client on the load
 * balancer host fed the token from the Auth client (`accessToken`), the same on
 * the replica's own host, or a proxy on its own hostname that splits by method.
 * This module measures each, with a token the Auth server issued THROUGH the
 * custom domain.
 *
 *   RR06a  primary (Small, ap-southeast-1), pitr_7, schema, two users
 *   RR06b  read replica in the same region; replica host; load balancer host
 *   RR06c  custom domain: add-on, initialize, DNS (Cloudflare), verify, activate, serving
 *   RR06d  sign in through the custom domain; that token on the custom, load
 *          balancer, replica and primary hosts: rows under RLS, auth.uid(), node
 *   RR06e  split: anon GETs through the custom host and through the load
 *          balancer, interleaved; user-token reads through the custom host
 *   RR06f  two clients: Auth on the custom host, data on the load balancer with
 *          `accessToken` reading the Auth client's session; writes; a refresh
 *   RR06g  a Worker on its own hostname: GET/HEAD /rest/v1 to the load balancer,
 *          the rest to the custom domain; one supabase-js client through it
 *   RR06p  teardown: Worker, custom hostname, DNS records, replica, project
 *
 * The node is read from `pg_is_in_recovery()` in each response, never latency.
 *
 * DESTRUCTIVE and BILLABLE: Small primary, Small replica, pitr_7, custom_domain.
 * Env: PVLAB_ORG_PRO; PVLAB_ENDPOINT_CUSTOM_DOMAIN (host in a Cloudflare zone
 * the key pair can edit); PVLAB_ENDPOINT_WORKER_DOMAIN (optional, RR06g);
 * CLOUDFLARE_API_KEY, CLOUDFLARE_EMAIL (+ CLOUDFLARE_ACCOUNT_ID for RR06g);
 * PVLAB_RR_KEEP=1 skips teardown; PVLAB_RR_REFS_FILE appends the created ref.
 */
import { appendFileSync } from "node:fs";
import { Resolver, resolve4 } from "node:dns/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { addRecord, cfAvailable, removeRecords, zoneId } from "../../hostname-path/lib/cfdns";
import { activateWithRetry } from "../../static-hosting/lib/activate";
import { PREFIX, applyAddon, connectSession, errText, findLoadBalancer, forRef, poolerConfig, selectedAddons, sleep, waitProjectHealthy, type PoolerEntry } from "../lib/rr";
import { parseNode } from "../lib/rerouting";
import { tokKind } from "./rr03-replica-rls-rpc";

const REGION = process.env.PVLAB_RR6_REGION ?? "ap-southeast-1";
const SPLIT_N = 200;
const WORKER_NAME = "pvlab-rr06-split";

export const SCHEMA = `
create table if not exists public.rr_marker (id bigserial primary key, tag text not null, written_at timestamptz not null default clock_timestamp());
insert into public.rr_marker(tag) values ('seed');
grant select on public.rr_marker to anon, authenticated;
create or replace function public.rr_whoami() returns json language sql stable as $$
  select json_build_object('in_recovery', pg_is_in_recovery(), 'pm', extract(epoch from pg_postmaster_start_time())::bigint)
$$;
create table if not exists public.rr6_docs (id bigserial primary key, tenant_id uuid not null, title text not null);
alter table public.rr6_docs enable row level security;
create policy rr6_docs_own on public.rr6_docs for select to authenticated using (tenant_id = (select auth.uid()));
grant select on public.rr6_docs to anon, authenticated;
create or replace view public.rr6_docs_v with (security_invoker = true) as
  select d.id, d.tenant_id, d.title, pg_is_in_recovery() as in_recovery, auth.uid() as uid from public.rr6_docs d;
grant select on public.rr6_docs_v to anon, authenticated;
create table if not exists public.rr6_touch (id bigserial primary key, uid uuid, at timestamptz not null default clock_timestamp());
grant select, insert on public.rr6_touch to anon, authenticated;
grant usage on sequence public.rr6_touch_id_seq to anon, authenticated;
create or replace function public.rr6_touch() returns json language plpgsql volatile as $$
begin
  insert into public.rr6_touch(uid) values (auth.uid());
  return json_build_object('in_recovery', pg_is_in_recovery(), 'uid', auth.uid(), 'wrote', true);
end;
$$;
grant execute on function public.rr_whoami(), public.rr6_touch() to anon, authenticated;
notify pgrst, 'reload schema';
`;

/* ---------- helpers ---------- */

export const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString()) as Record<string, unknown>;
export const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;

export interface HostnameCfg {
  status?: string;
  data?: { result?: { ssl?: { validation_records?: { txt_name?: string; txt_value?: string }[] }; ownership_verification?: { type?: string; name?: string; value?: string } } };
}
export function wantedTxt(cfg: HostnameCfg): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const r of cfg.data?.result?.ssl?.validation_records ?? []) if (r.txt_name && r.txt_value) out.push({ name: r.txt_name, value: r.txt_value });
  const ov = cfg.data?.result?.ownership_verification;
  if (ov?.name && ov.value && ov.type?.toLowerCase() === "txt") out.push({ name: ov.name, value: ov.value });
  return out;
}

/** Row-level summary of a read of rr6_docs_v: count, which node(s), whose uid, rows of another tenant. */
export interface ViewRead {
  ok: boolean;
  rows: number;
  node: string;
  uid: string;
  foreign: number;
  err?: string;
}
export async function viewRead(c: SupabaseClient, label: (u?: string | null) => string): Promise<ViewRead> {
  try {
    const r = await c.from("rr6_docs_v").select("*");
    if (r.error) return { ok: false, rows: 0, node: "none", uid: "-", foreign: 0, err: `${r.status} ${r.error.code ?? ""} ${(r.error.message ?? "").slice(0, 60)}` };
    const rows = (r.data ?? []) as { tenant_id: string; in_recovery: boolean; uid: string | null }[];
    return {
      ok: true,
      rows: rows.length,
      node: [...new Set(rows.map((x) => (x.in_recovery ? "replica" : "primary")))].join("+") || "no-rows",
      uid: [...new Set(rows.map((x) => label(x.uid)))].join("+") || "-",
      foreign: rows.filter((x) => x.tenant_id !== x.uid).length,
    };
  } catch (e) {
    return { ok: false, rows: 0, node: "none", uid: "-", foreign: 0, err: errText(e).slice(0, 80) };
  }
}
export function tallyViews(vs: ViewRead[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const v of vs) {
    const k = v.ok ? `${v.node} rows=${v.rows} uid=${v.uid} foreign=${v.foreign}` : `ERR ${v.err}`;
    t[k] = (t[k] ?? 0) + 1;
  }
  return t;
}
export const tallyStr = (t: Record<string, number>) => Object.entries(t).map(([k, v]) => `${k}: ${v}`).join("; ");

export async function anonNode(base: string, anon: string): Promise<string> {
  try {
    const r = await fetch(`${base}/rest/v1/rpc/rr_whoami`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` }, signal: AbortSignal.timeout(15_000) });
    const p = parseNode(r.status, await r.text());
    return p.node ?? p.err ?? `HTTP ${r.status}`;
  } catch (e) {
    return `ERR ${errText(e).slice(0, 60)}`;
  }
}
export function count(xs: string[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const x of xs) t[x] = (t[x] ?? 0) + 1;
  return t;
}

/** Wait until `host` resolves on the system resolver and answers rr_whoami with a node. */
async function waitServing(host: string, anon: string, budgetMs: number): Promise<{ s: number | "never"; last: string }> {
  const t0 = Date.now();
  let last = "";
  // Ask 1.1.1.1 first: a system-resolver lookup made before the record exists
  // caches the miss for the zone's SOA minimum (1800 s on the lab zone), which
  // is how the first RR06g run (2026-10-28) never saw a deployed Worker.
  const pub = new Resolver();
  pub.setServers(["1.1.1.1"]);
  while (Date.now() - t0 < budgetMs && !(await pub.resolve4(host).catch(() => [] as string[])).length) {
    last = "no A record on 1.1.1.1";
    await sleep(5_000);
  }
  while (Date.now() - t0 < budgetMs) {
    const ips = await resolve4(host).catch(() => [] as string[]);
    if (ips.length) {
      last = await anonNode(`https://${host}`, anon);
      if (last === "primary" || last === "replica") return { s: Math.round((Date.now() - t0) / 1000), last };
    } else last = "no A record on the system resolver";
    await sleep(10_000);
  }
  return { s: "never", last };
}

export async function wrangler(args: string[]): Promise<{ code: number; tail: string }> {
  const proc = Bun.spawn(["bunx", "wrangler", ...args], { cwd: `${import.meta.dir}/../worker`, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, tail: (o + e).trim().split("\n").slice(-3).join(" | ").slice(0, 300) };
}

const mod: TestModule = {
  id: "RR06",
  title: "Read replica with a custom domain: routing through the custom host, a custom-host token on the load balancer, two clients, a splitting Worker",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const host = ctx.endpoints.custom_domain ?? "";
    const workerHost = ctx.endpoints.worker_domain ?? "";
    const redact = (s: string) => {
      let r = s;
      if (ref) r = r.split(ref).join("<ref>");
      if (replicaId) r = r.split(replicaId).join("<replica-id>");
      if (host) r = r.split(host).join("<custom-host>");
      if (workerHost) r = r.split(workerHost).join("<worker-host>");
      return r;
    };
    const push = (r: TestResult) => {
      r.detail = r.detail ? redact(r.detail) : r.detail;
      r.evidence = r.evidence ? redact(r.evidence) : r.evidence;
      out.push(r);
      ctx.log(`${r.id} ${r.status}${r.detail ? `: ${r.detail.slice(0, 260)}` : ""}`);
    };
    const org = ctx.orgs.pro;
    if (!org) return [{ id: "RR06", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    if (!host) return [{ id: "RR06", title: this.title, status: "skip", detail: "PVLAB_ENDPOINT_CUSTOM_DOMAIN not set" }];
    if (!cfAvailable()) return [{ id: "RR06", title: this.title, status: "skip", detail: "no CLOUDFLARE_API_KEY/CLOUDFLARE_EMAIL in the environment" }];
    const keep = process.env.PVLAB_RR_KEEP === "1";
    const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
    let ref = "";
    let replicaId = "";
    let domainStarted = false;
    let workerDeployed = false;
    const dnsNames = new Set<string>([host, `_acme-challenge.${host}`, `_cf-custom-hostname.${host}`]);
    const t00 = Date.now();

    try {
      /* ---- RR06a ---- */
      const name = `${PREFIX}${Date.now()}`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name,
        db_pass: dbPass,
        region_selection: { type: "specific", code: REGION },
        desired_instance_size: "small",
      });
      ref = String((create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "");
      if (ref && process.env.PVLAB_RR_REFS_FILE) appendFileSync(process.env.PVLAB_RR_REFS_FILE, `${ref} ${name} ${new Date().toISOString()} RR06\n`);
      if (create.status !== 201 || !ref) {
        push({ id: "RR06a", title: `create primary (Small, ${REGION})`, status: "fail", detail: `HTTP ${create.status}: ${create.text.slice(0, 300)}` });
        return out;
      }
      ctx.log(`primary created (${name}); waiting healthy`);
      const h = await waitProjectHealthy(ctx, ref);
      if (h.status !== "ACTIVE_HEALTHY") {
        push({ id: "RR06a", title: `create primary (Small, ${REGION})`, status: "fail", detail: `${h.status} after ${h.waitedS}s` });
        return out;
      }
      const pctx = forRef(ctx, ref);
      const primaryBase = `https://${ref}.supabase.co`;
      const customBase = `https://${host}`;
      const have = await selectedAddons(pctx, ref);
      const pitr = have.includes("pitr_7") ? { status: 0, text: "already" } : await applyAddon(pctx, ref, "pitr", "pitr_7");
      const ddl = await sql(pctx, SCHEMA);
      let keys: Awaited<ReturnType<typeof fetchKeys>> | undefined;
      for (let i = 0; i < 18 && !keys; i++) {
        try {
          keys = await fetchKeys(pctx);
        } catch {
          await sleep(10_000);
        }
      }
      if (!keys || ddl.status >= 300) {
        push({ id: "RR06a", title: "schema and keys", status: "fail", detail: `schema HTTP ${ddl.status} ${ddl.error}; keys ${keys ? "ok" : "absent"}` });
        return out;
      }
      const anon = keys.anon;
      const svc = keys.service;
      const users: { label: string; email: string; password: string; id: string }[] = [];
      const tag = Date.now();
      for (const label of ["A", "B"]) {
        const email = `rr06-${label.toLowerCase()}-${tag}` + "@" + "example.com";
        const password = `${crypto.randomUUID()}Aa1!`;
        let id = "";
        for (let i = 0; i < 12 && !id; i++) {
          const r = await fetch(`${primaryBase}/auth/v1/admin/users`, {
            method: "POST",
            headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, email_confirm: true }),
          }).catch(() => null);
          id = r ? String(((await r.json().catch(() => ({}))) as { id?: string }).id ?? "") : "";
          if (!id) await sleep(10_000);
        }
        users.push({ label, email, password, id });
      }
      const A = users[0]!;
      const B = users[1]!;
      const other = crypto.randomUUID();
      const seed = await sql(
        pctx,
        `insert into public.rr6_docs(tenant_id, title) select '${A.id}'::uuid, 'a' || g from generate_series(1,3) g;
         insert into public.rr6_docs(tenant_id, title) select '${B.id}'::uuid, 'b' || g from generate_series(1,5) g;
         insert into public.rr6_docs(tenant_id, title) select '${other}'::uuid, 'o' || g from generate_series(1,2) g;`,
      );
      const label = (u?: string | null) => (u === undefined ? "-" : u === null ? "null" : u === A.id ? "A" : u === B.id ? "B" : "other");
      push({
        id: "RR06a",
        title: `primary (Small, ${REGION}), pitr_7, schema (RLS table rr6_docs, view, rr6_touch), users A and B, seed 3/5/2 rows`,
        status: pitr.status < 300 && seed.status < 300 && A.id && B.id ? "pass" : "fail",
        detail: `healthy after ${h.waitedS}s; pitr_7 ${pitr.status || "already"}; schema HTTP ${ddl.status}; seed HTTP ${seed.status}; users ${users.filter((u) => u.id).length}/2`,
        measurements: { healthy_after_s: h.waitedS, region: REGION },
      });
      if (!A.id || !B.id) return out;

      /* ---- RR06b: replica ---- */
      const t1 = Date.now();
      let setup = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/setup`, { read_replica_region: REGION });
      while (setup.status >= 300 && setup.status !== 402 && Date.now() - t1 < 12 * 60_000) {
        await sleep(30_000);
        setup = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/setup`, { read_replica_region: REGION });
      }
      let replica: PoolerEntry | undefined;
      let servedS: number | string = "never";
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
            } catch {}
          }
          await sleep(15_000);
        }
      }
      if (!replica || servedS === "never") {
        push({ id: "RR06b", title: "read replica", status: "fail", detail: `setup HTTP ${setup.status} ${setup.text.slice(0, 200)}; served ${servedS}` });
        return out;
      }
      replicaId = replica.identifier;
      const replicaBase = `https://${replicaId}.supabase.co`;
      let rn = await anonNode(replicaBase, anon);
      for (let i = 0; i < 18 && rn !== "replica"; i++) {
        await sleep(10_000);
        rn = await anonNode(replicaBase, anon);
      }
      const lb = await findLoadBalancer(pctx, ref, anon);
      push({
        id: "RR06b",
        title: `read replica in ${REGION}; replica host; load balancer host`,
        status: lb.url && rn === "replica" ? "pass" : "fail",
        detail: `setup HTTP ${setup.status}; first session connection after ${servedS}s; replica host answers ${rn}; load balancer ${lb.url ? lb.url.replace(/^https:\/\//, "") : "NOT found"}`,
        measurements: { replica_served_after_s: servedS },
      });
      if (!lb.url) return out;
      const lbBase = lb.url;

      /* ---- RR06c: custom domain ---- */
      domainStarted = true;
      const addon = await applyAddon(pctx, ref, "custom_domain", "cd_default");
      const init = await mgmt(pctx, "POST", `/projects/${ref}/custom-hostname/initialize`, { custom_hostname: host });
      if (init.status >= 300) {
        push({ id: "RR06c", title: "custom domain", status: "fail", detail: `add-on HTTP ${addon.status}; initialize HTTP ${init.status} ${init.text.slice(0, 200)}` });
        return out;
      }
      const zone = await zoneId(host);
      const notes: string[] = [];
      const cname = await addRecord(zone, "CNAME", host, `${ref}.supabase.co`);
      notes.push(`CNAME ${cname.status}${cname.error ? ` ${cname.error}` : ""}`);
      const written = new Set<string>();
      const tD = Date.now();
      const writeWanted = async (cfg: HostnameCfg) => {
        for (const w of wantedTxt(cfg)) {
          const k = `${w.name}=${w.value}`;
          if (written.has(k)) continue;
          const r = await addRecord(zone, "TXT", w.name, w.value);
          written.add(k);
          dnsNames.add(w.name);
          notes.push(`TXT ${w.name.split(".")[0]} ${r.status} at ${Math.round((Date.now() - tD) / 1000)}s`);
        }
      };
      await writeWanted((init.json ?? {}) as HostnameCfg);
      let cfg: HostnameCfg = {};
      let verifiedS: number | string = "never";
      while (Date.now() - tD < 20 * 60_000) {
        const rv = await mgmt(pctx, "POST", `/projects/${ref}/custom-hostname/reverify`);
        cfg = (rv.json ?? {}) as HostnameCfg;
        await writeWanted(cfg);
        if ((cfg.status ?? "") >= "3_challenge_verified") {
          verifiedS = Math.round((Date.now() - tD) / 1000);
          break;
        }
        await sleep(20_000);
      }
      if (verifiedS === "never") {
        push({ id: "RR06c", title: "custom domain", status: "fail", detail: `${notes.join(", ")}; not verified (status ${cfg.status ?? "?"})` });
        return out;
      }
      const tA = Date.now();
      let st = cfg.status ?? "";
      while (st < "4_origin_setup_completed" && Date.now() - tA < 12 * 60_000) {
        await sleep(10_000);
        st = (((await mgmt(pctx, "GET", `/projects/${ref}/custom-hostname`)).json ?? {}) as HostnameCfg).status ?? "";
      }
      const act = await activateWithRetry(async () => {
        const a = await mgmt(pctx, "POST", `/projects/${ref}/custom-hostname/activate`);
        return { status: a.status, text: a.text };
      }, (ms) => sleep(ms).then(() => undefined));
      let activeS: number | string = "never";
      while (Date.now() - tA < 15 * 60_000) {
        const g = (await mgmt(pctx, "GET", `/projects/${ref}/custom-hostname`)).json as HostnameCfg | undefined;
        if ((g?.status ?? "") >= "5_services_reconfigured") {
          activeS = Math.round((Date.now() - tA) / 1000);
          break;
        }
        await sleep(10_000);
      }
      const serving = await waitServing(host, anon, 10 * 60_000);
      // HP03d: Auth starts using the custom host a few seconds after 5_; give it margin.
      await sleep(30_000);
      push({
        id: "RR06c",
        title: "custom domain up: add-on, initialize, DNS, verify, activate; host serves rr_whoami",
        status: serving.s !== "never" ? "pass" : "fail",
        detail: `add-on HTTP ${addon.status}; ${notes.join(", ")}; verified ${verifiedS}s; activate first ${act.first}, ${act.attempts} attempt(s); reconfigured ${activeS}s; custom host answered ${serving.last} after ${serving.s}s`,
        measurements: { verified_s: verifiedS, active_s: activeS, serving_s: serving.s, activate_attempts: act.attempts },
      });
      if (serving.s === "never") return out;
      const hostsAll: [string, string][] = [
        ["custom", customBase],
        ["lb", lbBase],
        ["replica", replicaBase],
        ["primary", primaryBase],
      ];

      /* ---- RR06d: a token issued through the custom domain, on every host ---- */
      let tokA = "";
      {
        const m: Record<string, string | number> = {};
        const ev: string[] = [];
        const authC = createClient(customBase, anon, noPersist);
        const si = await authC.auth.signInWithPassword({ email: A.email, password: A.password });
        tokA = si.data.session?.access_token ?? "";
        const claims = tokA ? b64json(tokA.split(".")[1]!) : {};
        m.signin_custom = si.error ? `ERR ${si.error.status ?? ""} ${si.error.message}` : "ok";
        m.token = tokKind(tokA);
        m.token_iss = redact(String(claims.iss ?? ""));
        let allOk = !!tokA;
        if (tokA) {
          for (const [hn, base] of hostsAll) {
            const reads: ViewRead[] = [];
            const c = createClient(base, anon, { accessToken: async () => tokA });
            for (let i = 0; i < 10; i++) reads.push(await viewRead(c, label));
            m[`${hn}_accessToken_x10`] = tallyStr(tallyViews(reads));
            const raw = await fetch(`${base}/rest/v1/rr6_docs_v?select=*`, { headers: { apikey: anon, Authorization: `Bearer ${tokA}` } }).catch(() => null);
            m[`${hn}_raw_http`] = raw?.status ?? 0;
            if (hn !== "replica") {
              const u = await fetch(`${base}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${tokA}` } }).catch(() => null);
              m[`${hn}_auth_user_http`] = u?.status ?? 0;
            }
            if (reads.some((r) => !r.ok || r.rows !== 3 || r.uid !== "A" || r.foreign !== 0)) allOk = false;
            ev.push(`${hn}: ${tallyStr(tallyViews(reads))}`);
          }
        }
        push({
          id: "RR06d",
          title: "sign in through the custom domain; that user token on the custom, load balancer, replica and primary hosts (accessToken client, 10 reads each)",
          status: allOk ? "pass" : "fail",
          detail: `sign-in ${m.signin_custom}, ${m.token}, iss ${m.token_iss}; ${ev.join(" | ")}`,
          measurements: m,
        });
      }

      /* ---- RR06e: which node serves reads through the custom host ---- */
      {
        const viaCustom: string[] = [];
        const viaLb: string[] = [];
        for (let i = 0; i < SPLIT_N; i++) {
          viaCustom.push(await anonNode(customBase, anon));
          viaLb.push(await anonNode(lbBase, anon));
        }
        const userCustom: ViewRead[] = [];
        if (tokA) {
          const c = createClient(customBase, anon, { accessToken: async () => tokA });
          for (let i = 0; i < 50; i++) userCustom.push(await viewRead(c, label));
        }
        const tc = count(viaCustom);
        const tl = count(viaLb);
        push({
          id: "RR06e",
          title: `split: ${SPLIT_N} anon GETs (rpc rr_whoami) through the custom host and the load balancer, interleaved; 50 user-token reads through the custom host`,
          status: "info",
          detail: `custom host ${JSON.stringify(tc)}; load balancer ${JSON.stringify(tl)}; user reads via custom host ${tallyStr(tallyViews(userCustom))}`,
          measurements: {
            custom_replica: tc.replica ?? 0,
            custom_primary: tc.primary ?? 0,
            lb_replica: tl.replica ?? 0,
            lb_primary: tl.primary ?? 0,
            custom_user_reads: tallyStr(tallyViews(userCustom)),
          },
        });
      }

      /* ---- RR06f: two clients (Auth on the custom host, data on the load balancer) ---- */
      {
        const m: Record<string, string | number> = {};
        const authC = createClient(customBase, anon, noPersist);
        const si = await authC.auth.signInWithPassword({ email: A.email, password: A.password });
        const tokenOf = async () => (await authC.auth.getSession()).data.session?.access_token ?? null;
        const dataLog: string[] = [];
        const dataC = createClient(lbBase, anon, {
          accessToken: tokenOf,
          global: {
            fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
              const req = new Request(input, init);
              dataLog.push(`${req.method} ${new URL(req.url).host}`);
              return fetch(req);
            }) as typeof fetch,
          },
        });
        const before: ViewRead[] = [];
        for (let i = 0; i < 50; i++) before.push(await viewRead(dataC, label));
        const writes: string[] = [];
        for (let i = 0; i < 5; i++) {
          const r = await dataC.rpc("rr6_touch");
          writes.push(r.error ? `ERR ${r.error.code}` : (r.data as { in_recovery?: boolean })?.in_recovery ? "replica" : "primary");
        }
        const ins = await dataC.from("rr6_touch").insert({ uid: A.id });
        const tok1 = (await tokenOf()) ?? "";
        const rf = await authC.auth.refreshSession();
        const tok2 = (await tokenOf()) ?? "";
        const after: ViewRead[] = [];
        for (let i = 0; i < 20; i++) after.push(await viewRead(dataC, label));
        let dataAuth = "";
        try {
          await dataC.auth.getSession();
          dataAuth = "no error";
        } catch (e) {
          dataAuth = errText(e).slice(0, 100);
        }
        const touched = await sql(pctx, `select count(*)::int as n from public.rr6_touch where uid = '${A.id}'`);
        m.signin = si.error ? `ERR ${si.error.message}` : "ok";
        m.reads_before_refresh = tallyStr(tallyViews(before));
        m.rpc_post_writes = JSON.stringify(count(writes));
        m.insert = ins.error ? `ERR ${ins.status} ${ins.error.code}` : `HTTP ${ins.status}`;
        m.rows_written = Number(touched.rows[0]?.n ?? -1);
        m.refresh = rf.error ? `ERR ${rf.error.message}` : "ok";
        m.token_changed = tok1 && tok2 && tok1 !== tok2 ? "yes" : "no";
        m.reads_after_refresh = tallyStr(tallyViews(after));
        m.data_client_auth_call = dataAuth;
        m.data_client_hosts = JSON.stringify(count(dataLog));
        const ok =
          !si.error &&
          !rf.error &&
          [...before, ...after].every((r) => r.ok && r.rows === 3 && r.uid === "A" && r.foreign === 0) &&
          writes.every((w) => w === "primary") &&
          !ins.error;
        push({
          id: "RR06f",
          title: "two clients: Auth on the custom host, data on the load balancer with accessToken from the Auth client's session; 50 reads, 5 POST rpc writes, 1 insert, refresh, 20 reads",
          status: ok ? "pass" : "fail",
          detail: Object.entries(m).map(([k, v]) => `${k} ${v}`).join("; "),
          measurements: m,
        });
      }

      /* ---- RR06g: a Worker that splits by method ---- */
      if (!workerHost || !process.env.CLOUDFLARE_ACCOUNT_ID) {
        push({ id: "RR06g", title: "splitting Worker", status: "skip", detail: "PVLAB_ENDPOINT_WORKER_DOMAIN or CLOUDFLARE_ACCOUNT_ID not set" });
      } else {
        const m: Record<string, string | number> = {};
        workerDeployed = true;
        const dep = await wrangler([
          "deploy", "rr06-split.js", "--name", WORKER_NAME, "--compatibility-date", "2026-09-01",
          // A *.workers.dev host needs no DNS of ours; any other host becomes a Workers Custom Domain.
          ...(workerHost.endsWith(".workers.dev") ? [] : ["--domain", workerHost]),
          "--var", `READ_ORIGIN:${lbBase}`, "--var", `WRITE_ORIGIN:${customBase}`,
        ]);
        m.deploy_exit = dep.code;
        const ws = dep.code === 0 ? await waitServing(workerHost, anon, 8 * 60_000) : { s: "never" as const, last: dep.tail };
        m.serving_s = ws.s;
        if (ws.s === "never") {
          push({ id: "RR06g", title: "splitting Worker", status: "fail", detail: `deploy exit ${dep.code} ${dep.tail}; serving ${ws.last}`, measurements: m });
        } else {
          const wBase = `https://${workerHost}`;
          const routes: string[] = [];
          const c = createClient(wBase, anon, {
            ...noPersist,
            global: {
              fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
                const res = await fetch(new Request(input, init));
                routes.push(`${new Request(input, init).method} ${res.headers.get("x-rr06-route") ?? "none"}`);
                return res;
              }) as typeof fetch,
            },
          });
          const si = await c.auth.signInWithPassword({ email: B.email, password: B.password });
          const reads: ViewRead[] = [];
          for (let i = 0; i < 100; i++) reads.push(await viewRead(c, label));
          const getRpc: string[] = [];
          for (let i = 0; i < 20; i++) {
            const r = await c.rpc("rr_whoami", {}, { get: true });
            getRpc.push(r.error ? `ERR ${r.error.code}` : (r.data as { in_recovery?: boolean })?.in_recovery ? "replica" : "primary");
          }
          const writes: string[] = [];
          for (let i = 0; i < 5; i++) {
            const r = await c.rpc("rr6_touch");
            writes.push(r.error ? `ERR ${r.error.code}` : (r.data as { in_recovery?: boolean })?.in_recovery ? "replica" : "primary");
          }
          const rf = await c.auth.refreshSession();
          const after: ViewRead[] = [];
          for (let i = 0; i < 20; i++) after.push(await viewRead(c, label));
          const redirect = await fetch(`${wBase}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent("http://localhost:3000/cb")}`, { redirect: "manual" }).catch(() => null);
          m.signin = si.error ? `ERR ${si.error.status ?? ""} ${si.error.message}` : "ok";
          m.reads = tallyStr(tallyViews(reads));
          m.reads_replica = reads.filter((r) => r.node === "replica").length;
          m.reads_primary = reads.filter((r) => r.node === "primary").length;
          m.rpc_get = JSON.stringify(count(getRpc));
          m.rpc_post_writes = JSON.stringify(count(writes));
          m.refresh = rf.error ? `ERR ${rf.error.message}` : "ok";
          m.reads_after_refresh = tallyStr(tallyViews(after));
          m.routes = JSON.stringify(count(routes));
          m.authorize_status = redirect?.status ?? 0;
          m.authorize_location_host = (() => {
            try {
              return redact(new URL(redirect?.headers.get("location") ?? "").host);
            } catch {
              return "none";
            }
          })();
          const ok = !si.error && !rf.error && [...reads, ...after].every((r) => r.ok && r.rows === 5 && r.uid === "B" && r.foreign === 0) && writes.every((w) => w === "primary");
          push({
            id: "RR06g",
            title: "a Worker on its own hostname (GET/HEAD /rest/v1 to the load balancer, the rest to the custom domain); one supabase-js client: sign-in, 100 reads, 20 GET rpc, 5 POST rpc, refresh, 20 reads",
            status: ok ? "pass" : "fail",
            detail: Object.entries(m).map(([k, v]) => `${k} ${v}`).join("; "),
            measurements: m,
          });
        }
      }
    } catch (e) {
      push({ id: "RR06x", title: "module aborted", status: "fail", detail: errText(e) });
    } finally {
      /* ---- RR06p ---- */
      if (ref && !keep) {
        const pctx = forRef(ctx, ref);
        const wdel = workerDeployed ? (await wrangler(["delete", "--name", WORKER_NAME, "--force"])).code : "n/a";
        let hdel: number | string = "n/a";
        let dns: number | string = "n/a";
        if (domainStarted) {
          hdel = (await mgmt(pctx, "DELETE", `/projects/${ref}/custom-hostname`).catch(() => null))?.status ?? 0;
          dns = await removeRecords(await zoneId(host), [...dnsNames]).catch(() => -1);
        }
        let rm = 0;
        if (replicaId) {
          rm = (await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/remove`, { database_identifier: replicaId }).catch(() => null))?.status ?? 0;
          await sleep(20_000);
        }
        let del = await mgmt(pctx, "DELETE", `/projects/${ref}`).catch(() => null);
        for (let i = 0; i < 6 && (del?.status ?? 0) >= 300; i++) {
          await sleep(30_000);
          del = await mgmt(pctx, "DELETE", `/projects/${ref}`).catch(() => null);
        }
        push({
          id: "RR06p",
          title: "teardown: Worker, custom hostname, DNS records, replica, project",
          status: (del?.status ?? 0) < 300 ? "pass" : "fail",
          detail: `wrangler delete exit ${wdel}; custom-hostname DELETE HTTP ${hdel}; DNS records removed ${dns}; replica remove HTTP ${rm || "n/a"}; project DELETE HTTP ${del?.status ?? 0}; run took ${Math.round((Date.now() - t00) / 60000)} min`,
          measurements: { project_delete_http: del?.status ?? 0, run_min: Math.round((Date.now() - t00) / 60000) },
        });
      } else if (ref) {
        ctx.log("project LEFT RUNNING (PVLAB_RR_KEEP=1) - delete it, the custom hostname and the DNS records by hand");
      }
    }
    return out;
  },
};
export default mod;
