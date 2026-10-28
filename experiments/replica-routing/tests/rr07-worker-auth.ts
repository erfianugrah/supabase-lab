/**
 * RR07 - one branded API hostname in front of a project with a custom domain
 * and a read replica: a Cloudflare Worker on a Workers Custom Domain that sends
 * GET/HEAD /rest/v1/* to the API load balancer and everything else to the
 * custom domain (worker/rr06-split.js, unchanged). RR06g proved password
 * sign-in, refresh, reads and writes through it on a *.workers.dev host; this
 * module measures what RR06 left open:
 *
 *   RR07a  primary (Small), pitr_7, RR06 schema, users A and B, mock OIDC issuer
 *          (Edge Function, hostname-path lib/idp.ts) in the Keycloak slot
 *   RR07b  read replica in the same region; load balancer host
 *   RR07c  custom domain: add-on, initialize, DNS, verify, activate, serving
 *   RR07d  the Worker on a Workers Custom Domain in the same zone: time from the
 *          deploy to an answer on the zone's nameservers, on 1.1.1.1, and to a
 *          node-tagged rr_whoami through the system resolver
 *   RR07e  Worker hop latency: 50 anon GETs through the Worker and 50 straight
 *          to the load balancer, interleaved (order alternated), p50/p90
 *   RR07f  CORS headers: preflight and actual requests with an Origin for
 *          GET /rest/v1, POST /rest/v1/rpc, POST /auth/v1/token, through the
 *          Worker, the custom host and the load balancer
 *   RR07g  a real cross-origin fetch in headless Chromium (browser/cors-check.ts)
 *   RR07h-k OAuth (PKCE) round trip entered at the Worker, the custom host, the
 *          project host, and at the Worker with the callback hop sent through
 *          the Worker: redirect_uri, callback host, code exchange at the entry
 *   RR07l  the OAuth session through the Worker: rows under RLS, auth.uid(), node
 *   RR07m  SAML SSO through the Worker if the plan allows it (auth-providers
 *          lib/saml-idp.mjs in a container signs the Response)
 *   RR07p  teardown: Worker, Workers Custom Domain, its certificate, custom
 *          hostname, DNS records, auth providers, replica, project
 *
 * DESTRUCTIVE and BILLABLE: Small primary, Small replica, pitr_7, custom_domain.
 * Env: PVLAB_ORG_PRO; PVLAB_ENDPOINT_ZONE (a Cloudflare zone the key pair can
 * edit; the module makes `rr07-<epoch>` and `rr07w-<epoch>` in it);
 * CLOUDFLARE_API_KEY, CLOUDFLARE_EMAIL, CLOUDFLARE_ACCOUNT_ID. RR07m needs
 * docker with the oven/bun:1 image and openssl; RR07g needs `bun install` in
 * browser/ and a Playwright Chromium.
 */
import { appendFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Resolver, resolve4 } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { addRecord, cfAvailable, removeRecords, zoneId } from "../../hostname-path/lib/cfdns";
import { deployIdp, IDP_SLUG, SITE_URL } from "../../hostname-path/lib/idp";
import { activateWithRetry } from "../../static-hosting/lib/activate";
import { PREFIX, applyAddon, connectSession, errText, findLoadBalancer, forRef, pct, poolerConfig, round, selectedAddons, sleep, waitProjectHealthy, type PoolerEntry } from "../lib/rr";
import { anonNode, b64json, count, noPersist, SCHEMA, tallyStr, tallyViews, viewRead, wantedTxt, wrangler, type HostnameCfg, type ViewRead } from "./rr06-custom-domain";

const REGION = process.env.PVLAB_RR7_REGION ?? "ap-southeast-1";
const WORKER_NAME = "pvlab-rr07-split";
const ORIGIN = "https://app.example.test";
const LAT_N = 50;
const SAML_DOMAIN = "rr07-idp.example.com";
const SAML_ENTITY = "https://rr07-idp.example.com/idp";
const BUN_IMAGE = "oven/bun:1";
const SAML_IDP_SCRIPT = resolve(import.meta.dir, "../../auth-providers/lib/saml-idp.mjs");
const CF = "https://api.cloudflare.com/client/v4";

/* ---------- helpers ---------- */

function cfHeaders(): Record<string, string> {
  return { "X-Auth-Key": process.env.CLOUDFLARE_API_KEY ?? "", "X-Auth-Email": process.env.CLOUDFLARE_EMAIL ?? "", "Content-Type": "application/json" };
}
async function cf(method: string, path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${CF}${path}`, { method, headers: cfHeaders(), signal: AbortSignal.timeout(30_000) }).catch(() => null);
  return { status: r?.status ?? 0, json: r ? await r.json().catch(() => ({})) : {} };
}

/** Memory storage so a PKCE code verifier survives between signIn* and exchangeCodeForSession. */
function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const pkceClient = (base: string, anon: string) =>
  createClient(base, anon, { auth: { flowType: "pkce", storage: memStorage(), persistSession: true, autoRefreshToken: false, detectSessionInUrl: false } });

async function run(cmd: string[], timeoutMs = 240_000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: o + e };
}

const CORS_KEYS = ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-allow-credentials", "access-control-max-age", "access-control-expose-headers", "vary"];
function corsOf(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  for (const k of CORS_KEYS) o[k] = h.get(k) ?? "-";
  return o;
}

/**
 * A new Resolver per query. A Bun (1.3.x) Resolver instance keeps an ENOTFOUND
 * for its lifetime: on 2026-10-28 one instance polled every 3 s still said
 * ENOTFOUND 43 s after a new instance and dig both had the record, and RR07
 * run 1 waited 8 min on one. The module-level resolve4/lookup did the same
 * for 97 s. So: never ask before the record exists, and never reuse an instance.
 */
function fresh(servers: string[]): Resolver {
  const r = new Resolver();
  r.setServers(servers);
  return r;
}

/* ---------- module ---------- */

const mod: TestModule = {
  id: "RR07",
  title: "One branded hostname (a Worker on a Workers Custom Domain) in front of a custom domain and a read replica: serving time, hop latency, CORS, OAuth PKCE, SAML",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const zone = ctx.endpoints.zone ?? "";
    const epoch = Math.floor(Date.now() / 1000);
    const host = zone ? `rr07-${epoch}.${zone}` : "";
    const workerHost = zone ? `rr07w-${epoch}.${zone}` : "";
    let ref = "";
    let replicaId = "";
    const redact = (s: string) => {
      let r = s;
      if (ref) r = r.split(ref).join("<ref>");
      if (replicaId) r = r.split(replicaId).join("<replica-id>");
      if (host) r = r.split(host).join("<custom-host>");
      if (workerHost) r = r.split(workerHost).join("<worker-host>");
      if (zone) r = r.split(zone).join("<zone>");
      return r;
    };
    const push = (r: TestResult) => {
      r.detail = r.detail ? redact(r.detail) : r.detail;
      r.evidence = r.evidence ? redact(r.evidence) : r.evidence;
      if (r.measurements) for (const k of Object.keys(r.measurements)) if (typeof r.measurements[k] === "string") r.measurements[k] = redact(r.measurements[k] as string);
      out.push(r);
      ctx.log(`${r.id} ${r.status}${r.detail ? `: ${r.detail.slice(0, 300)}` : ""}`);
    };
    const org = ctx.orgs.pro;
    if (!org) return [{ id: "RR07", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    if (!zone) return [{ id: "RR07", title: this.title, status: "skip", detail: "PVLAB_ENDPOINT_ZONE not set" }];
    if (!cfAvailable() || !process.env.CLOUDFLARE_ACCOUNT_ID) return [{ id: "RR07", title: this.title, status: "skip", detail: "CLOUDFLARE_API_KEY/CLOUDFLARE_EMAIL/CLOUDFLARE_ACCOUNT_ID not in the environment" }];
    const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
    const keep = process.env.PVLAB_RR_KEEP === "1";
    const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
    let domainStarted = false;
    let workerDeployed = false;
    let samlDir = "";
    const dnsNames = new Set<string>([host, `_acme-challenge.${host}`, `_cf-custom-hostname.${host}`, workerHost]);
    const t00 = Date.now();

    try {
      /* ---- RR07a ---- */
      const name = `${PREFIX}${Date.now()}`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name,
        db_pass: dbPass,
        region_selection: { type: "specific", code: REGION },
        desired_instance_size: "small",
      });
      ref = String((create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "");
      if (ref && process.env.PVLAB_RR_REFS_FILE) appendFileSync(process.env.PVLAB_RR_REFS_FILE, `${ref} ${name} ${new Date().toISOString()} RR07\n`);
      if (create.status !== 201 || !ref) {
        push({ id: "RR07a", title: `create primary (Small, ${REGION})`, status: "fail", detail: `HTTP ${create.status}: ${create.text.slice(0, 300)}` });
        return out;
      }
      ctx.log(`primary created (${name}); waiting healthy`);
      const h = await waitProjectHealthy(ctx, ref);
      if (h.status !== "ACTIVE_HEALTHY") {
        push({ id: "RR07a", title: `create primary (Small, ${REGION})`, status: "fail", detail: `${h.status} after ${h.waitedS}s` });
        return out;
      }
      const pctx: Ctx = { ...forRef(ctx, ref), apiHost: `${ref}.supabase.co` };
      const primaryBase = `https://${ref}.supabase.co`;
      const customBase = `https://${host}`;
      const workerBase = `https://${workerHost}`;
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
        push({ id: "RR07a", title: "schema and keys", status: "fail", detail: `schema HTTP ${ddl.status} ${ddl.error}; keys ${keys ? "ok" : "absent"}` });
        return out;
      }
      const anon = keys.anon;
      const svc = keys.service;
      const users: { label: string; email: string; password: string; id: string }[] = [];
      const tag = Date.now();
      for (const label of ["A", "B"]) {
        const email = `rr07-${label.toLowerCase()}-${tag}` + "@" + "example.com";
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
      // Mock OIDC issuer in the Keycloak slot (hostname-path HP01/HP02).
      const idp = await deployIdp(pctx);
      const issuer = `${primaryBase}/functions/v1/${IDP_SLUG}`;
      const tK = Date.now();
      const kc = await mgmt(pctx, "PATCH", `/projects/${ref}/config/auth`, {
        external_keycloak_enabled: true,
        external_keycloak_client_id: "rr07-client",
        external_keycloak_secret: "unused-the-mock-issuer-ignores-client-auth",
        external_keycloak_url: issuer,
        site_url: SITE_URL,
        uri_allow_list: "http://localhost:3000/**",
      });
      let kcS: number | string = "never";
      while (Date.now() - tK < 180_000) {
        const s = await fetch(`${primaryBase}/auth/v1/settings`, { headers: { apikey: anon }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
        const j = (await s?.json().catch(() => ({}))) as { external?: Record<string, boolean> } | undefined;
        if (j?.external?.keycloak === true) {
          kcS = Math.round((Date.now() - tK) / 1000);
          break;
        }
        await sleep(3_000);
      }
      const oauthIds = new Map<string, string>();
      const label = (u?: string | null) =>
        u === undefined ? "-" : u === null ? "null" : u === A.id ? "A" : u === B.id ? "B" : oauthIds.has(u) ? oauthIds.get(u)! : "other";
      push({
        id: "RR07a",
        title: `primary (Small, ${REGION}), pitr_7, RR06 schema, users A and B, mock OIDC issuer in the Keycloak slot`,
        status: pitr.status < 300 && seed.status < 300 && A.id && B.id && idp.status < 300 && kcS !== "never" ? "pass" : "fail",
        detail: `healthy after ${h.waitedS}s; pitr_7 ${pitr.status || "already"}; schema HTTP ${ddl.status}; seed HTTP ${seed.status}; users ${users.filter((u) => u.id).length}/2; issuer deploy HTTP ${idp.status}${idp.error ? ` ${idp.error}` : ""}; keycloak PATCH ${kc.status}, in settings after ${kcS}s`,
        measurements: { healthy_after_s: h.waitedS, region: REGION, idp_deploy_http: idp.status, keycloak_patch_http: kc.status, keycloak_settled_s: kcS },
      });
      if (!A.id || !B.id) return out;

      /* ---- RR07b: replica ---- */
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
        push({ id: "RR07b", title: "read replica", status: "fail", detail: `setup HTTP ${setup.status} ${setup.text.slice(0, 200)}; served ${servedS}` });
        return out;
      }
      replicaId = replica.identifier;
      let rn = await anonNode(`https://${replicaId}.supabase.co`, anon);
      for (let i = 0; i < 18 && rn !== "replica"; i++) {
        await sleep(10_000);
        rn = await anonNode(`https://${replicaId}.supabase.co`, anon);
      }
      const lb = await findLoadBalancer(pctx, ref, anon);
      push({
        id: "RR07b",
        title: `read replica in ${REGION}; load balancer host`,
        status: lb.url && rn === "replica" ? "pass" : "fail",
        detail: `setup HTTP ${setup.status}; first session connection after ${servedS}s; replica host answers ${rn}; load balancer ${lb.url ? lb.url.replace(/^https:\/\//, "") : "NOT found"}`,
        measurements: { replica_served_after_s: servedS },
      });
      if (!lb.url) return out;
      const lbBase = lb.url;
      const lbHost = new URL(lbBase).host;
      const hostLabel = (hn: string) =>
        hn === workerHost ? "worker" : hn === host ? "custom" : hn === `${ref}.supabase.co` ? "project" : hn === lbHost ? "lb" : hn === "localhost:3000" ? "site-url" : hn ? redact(hn) : "-";
      const urlLabel = (u: string) => {
        try {
          const x = new URL(u);
          return `${hostLabel(x.host)}${x.pathname.replace(ref, "<ref>")}`;
        } catch {
          return u ? "unparsed" : "-";
        }
      };

      /* ---- RR07c: custom domain ---- */
      domainStarted = true;
      const addon = await applyAddon(pctx, ref, "custom_domain", "cd_default");
      const init = await mgmt(pctx, "POST", `/projects/${ref}/custom-hostname/initialize`, { custom_hostname: host });
      if (init.status >= 300) {
        push({ id: "RR07c", title: "custom domain", status: "fail", detail: `add-on HTTP ${addon.status}; initialize HTTP ${init.status} ${init.text.slice(0, 200)}` });
        return out;
      }
      const zid = await zoneId(host);
      const notes: string[] = [];
      const cname = await addRecord(zid, "CNAME", host, `${ref}.supabase.co`);
      notes.push(`CNAME ${cname.status}${cname.error ? ` ${cname.error}` : ""}`);
      const written = new Set<string>();
      const tD = Date.now();
      const writeWanted = async (cfg: HostnameCfg) => {
        for (const w of wantedTxt(cfg)) {
          const k = `${w.name}=${w.value}`;
          if (written.has(k)) continue;
          const r = await addRecord(zid, "TXT", w.name, w.value);
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
        push({ id: "RR07c", title: "custom domain", status: "fail", detail: `${notes.join(", ")}; not verified (status ${cfg.status ?? "?"})` });
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
      // The CNAME was written before any lookup, so asking 1.1.1.1 then the system resolver is safe here.
      const pub = fresh(["1.1.1.1"]);
      const tS = Date.now();
      let cLast = "";
      let cServingS: number | string = "never";
      while (Date.now() - tS < 10 * 60_000) {
        const ok1 = (await fresh(["1.1.1.1"]).resolve4(host).catch(() => [] as string[])).length > 0;
        const ok2 = ok1 && (await resolve4(host).catch(() => [] as string[])).length > 0;
        cLast = ok2 ? await anonNode(customBase, anon) : ok1 ? "no A record on the system resolver" : "no A record on 1.1.1.1";
        if (cLast === "primary" || cLast === "replica") {
          cServingS = Math.round((Date.now() - tS) / 1000);
          break;
        }
        await sleep(5_000);
      }
      push({
        id: "RR07c",
        title: "custom domain up: add-on, initialize, DNS, verify, activate; host serves rr_whoami",
        status: cServingS !== "never" ? "pass" : "fail",
        detail: `add-on HTTP ${addon.status}; ${notes.join(", ")}; verified ${verifiedS}s; activate first ${act.first}, ${act.attempts} attempt(s); reconfigured ${activeS}s; custom host answered ${cLast} ${cServingS}s after that`,
        measurements: { verified_s: verifiedS, active_s: activeS, serving_s: cServingS, activate_attempts: act.attempts },
      });
      if (cServingS === "never") return out;

      /* ---- RR07d: the Worker on a Workers Custom Domain ---- */
      workerDeployed = true;
      const tW0 = Date.now();
      const dep = await wrangler([
        "deploy", "rr06-split.js", "--name", WORKER_NAME, "--compatibility-date", "2026-09-01",
        "--domain", workerHost,
        "--var", `READ_ORIGIN:${lbBase}`, "--var", `WRITE_ORIGIN:${customBase}`,
      ]);
      const tW1 = Date.now();
      const sinceDeploy = () => Math.round((Date.now() - tW1) / 1000);
      const dm: Record<string, string | number> = { deploy_exit: dep.code, deploy_s: Math.round((tW1 - tW0) / 1000) };
      // Never ask a caching resolver before the record exists: ask the zone's own
      // nameservers first (they do not cache a miss), then 1.1.1.1, then the system resolver.
      const nsNames = await pub.resolveNs(zone).catch(() => [] as string[]);
      const nsIps = (await Promise.all(nsNames.map((n) => pub.resolve4(n).catch(() => [] as string[])))).flat();
      dm.zone_nameservers = nsIps.length;
      dm.deploy_output_names_custom_domain = /\(custom domain\)/.test(dep.tail) ? "yes" : "no";
      const wd = await cf("GET", `/accounts/${acct}/workers/domains?hostname=${workerHost}`);
      dm.workers_domain_listed = ((wd.json?.result ?? []) as { hostname: string }[]).some((d) => d.hostname === workerHost) ? "yes" : "no";
      let authS: number | string = "never";
      let pubS: number | string = "never";
      let wServingS: number | string = "never";
      let wLast = dep.code === 0 ? "" : dep.tail;
      if (dep.code === 0 && nsIps.length) {
        while (Date.now() - tW1 < 8 * 60_000) {
          if ((await fresh(nsIps).resolve4(workerHost).catch(() => [] as string[])).length) {
            authS = sinceDeploy();
            break;
          }
          await sleep(2_000);
        }
        if (authS !== "never") {
          while (Date.now() - tW1 < 8 * 60_000) {
            if ((await fresh(["1.1.1.1"]).resolve4(workerHost).catch(() => [] as string[])).length) {
              pubS = sinceDeploy();
              break;
            }
            await sleep(2_000);
          }
        }
        if (pubS !== "never") {
          while (Date.now() - tW1 < 10 * 60_000) {
            const ips = await resolve4(workerHost).catch(() => [] as string[]);
            wLast = ips.length ? await anonNode(workerBase, anon) : "no A record on the system resolver";
            if (wLast === "primary" || wLast === "replica") {
              wServingS = sinceDeploy();
              break;
            }
            await sleep(3_000);
          }
        }
      }
      dm.zone_ns_answer_s = authS;
      dm.public_resolver_answer_s = pubS;
      dm.serving_s = wServingS;
      dm.last = wLast.slice(0, 120);
      push({
        id: "RR07d",
        title: "the Worker on a Workers Custom Domain in the same zone: deploy, zone nameservers, 1.1.1.1, serving (seconds after the deploy exited)",
        status: wServingS !== "never" ? "pass" : "fail",
        detail: `wrangler deploy exit ${dep.code} in ${dm.deploy_s}s; A record on the zone's nameservers ${authS}s, on 1.1.1.1 ${pubS}s; rr_whoami through the Worker answered ${wLast} ${wServingS}s after the deploy${dep.code ? `; ${dep.tail}` : ""}`,
        measurements: dm,
      });
      if (wServingS === "never") return out;

      /* ---- RR07e: Worker hop latency ---- */
      {
        const timeGet = async (base: string): Promise<{ ms: number; node: string }> => {
          const t = performance.now();
          try {
            const r = await fetch(`${base}/rest/v1/rpc/rr_whoami`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` }, signal: AbortSignal.timeout(15_000) });
            const body = await r.text();
            const ms = performance.now() - t;
            const node = r.ok ? ((JSON.parse(body) as { in_recovery?: boolean }).in_recovery ? "replica" : "primary") : `HTTP ${r.status}`;
            return { ms, node };
          } catch (e) {
            return { ms: performance.now() - t, node: `ERR ${errText(e).slice(0, 40)}` };
          }
        };
        for (let i = 0; i < 5; i++) {
          await timeGet(workerBase);
          await timeGet(lbBase);
        }
        const w: { ms: number; node: string }[] = [];
        const l: { ms: number; node: string }[] = [];
        for (let i = 0; i < LAT_N; i++) {
          if (i % 2 === 0) {
            w.push(await timeGet(workerBase));
            l.push(await timeGet(lbBase));
          } else {
            l.push(await timeGet(lbBase));
            w.push(await timeGet(workerBase));
          }
        }
        const wm = w.filter((x) => !x.node.startsWith("ERR") && !x.node.startsWith("HTTP")).map((x) => x.ms);
        const lm = l.filter((x) => !x.node.startsWith("ERR") && !x.node.startsWith("HTTP")).map((x) => x.ms);
        const m = {
          n_each: LAT_N,
          worker_ok: wm.length,
          lb_ok: lm.length,
          worker_p50_ms: round(pct(wm, 50)),
          worker_p90_ms: round(pct(wm, 90)),
          lb_p50_ms: round(pct(lm, 50)),
          lb_p90_ms: round(pct(lm, 90)),
          p50_delta_ms: round(pct(wm, 50) - pct(lm, 50)),
          worker_nodes: JSON.stringify(count(w.map((x) => x.node))),
          lb_nodes: JSON.stringify(count(l.map((x) => x.node))),
        };
        push({
          id: "RR07e",
          title: `Worker hop latency: ${LAT_N} anon GET rpc/rr_whoami through the Worker and ${LAT_N} straight to the load balancer, interleaved, order alternated, after 5 warm-ups each`,
          status: wm.length === LAT_N && lm.length === LAT_N ? "info" : "fail",
          detail: `Worker p50 ${m.worker_p50_ms} ms p90 ${m.worker_p90_ms} ms; load balancer p50 ${m.lb_p50_ms} ms p90 ${m.lb_p90_ms} ms; p50 delta ${m.p50_delta_ms} ms; nodes via Worker ${m.worker_nodes}, via load balancer ${m.lb_nodes}`,
          measurements: m,
        });
      }

      /* ---- RR07f: CORS headers ---- */
      {
        const sb = createClient(primaryBase, anon, noPersist);
        const tokB = (await sb.auth.signInWithPassword({ email: B.email, password: B.password })).data.session?.access_token ?? "";
        const probes: { k: string; method: string; path: string; body?: string; bearer: boolean }[] = [
          { k: "rest_get", method: "GET", path: "/rest/v1/rr6_docs_v?select=*", bearer: true },
          { k: "rpc_post", method: "POST", path: "/rest/v1/rpc/rr6_touch", body: "{}", bearer: true },
          { k: "auth_token", method: "POST", path: "/auth/v1/token?grant_type=password", body: JSON.stringify({ email: B.email, password: B.password }), bearer: false },
        ];
        const targets: [string, string][] = [["worker", workerBase], ["custom", customBase], ["lb", lbBase]];
        const m: Record<string, string | number> = {};
        const seen: Record<string, Record<string, string>> = {};
        for (const p of probes) {
          for (const [tn, base] of targets) {
            const pre = await fetch(`${base}${p.path}`, {
              method: "OPTIONS",
              headers: { Origin: ORIGIN, "Access-Control-Request-Method": p.method, "Access-Control-Request-Headers": "apikey,authorization,content-type,x-client-info" },
              signal: AbortSignal.timeout(15_000),
            }).catch(() => null);
            const preC = pre ? corsOf(pre.headers) : {};
            seen[`${p.k}_${tn}_pre`] = preC;
            m[`${p.k}_${tn}_pre`] = pre ? `${pre.status} ${JSON.stringify(preC)}${pre.headers.get("x-rr06-route") ? ` route=${pre.headers.get("x-rr06-route")}` : ""}` : "no response";
            const act = await fetch(`${base}${p.path}`, {
              method: p.method,
              headers: { Origin: ORIGIN, apikey: anon, ...(p.bearer ? { Authorization: `Bearer ${tokB}` } : {}), ...(p.body ? { "Content-Type": "application/json" } : {}), "x-client-info": "rr07" },
              body: p.body,
              signal: AbortSignal.timeout(15_000),
            }).catch(() => null);
            await act?.text().catch(() => "");
            const actC = act ? corsOf(act.headers) : {};
            seen[`${p.k}_${tn}_act`] = actC;
            m[`${p.k}_${tn}_act`] = act ? `${act.status} ${JSON.stringify(actC)}${act.headers.get("x-rr06-route") ? ` route=${act.headers.get("x-rr06-route")}` : ""}` : "no response";
          }
          const same = (a: string, b: string) => JSON.stringify(seen[a]) === JSON.stringify(seen[b]);
          m[`${p.k}_pre_worker_eq_custom`] = same(`${p.k}_worker_pre`, `${p.k}_custom_pre`) ? "yes" : "no";
          m[`${p.k}_act_worker_eq_custom`] = same(`${p.k}_worker_act`, `${p.k}_custom_act`) ? "yes" : "no";
          m[`${p.k}_act_worker_eq_lb`] = same(`${p.k}_worker_act`, `${p.k}_lb_act`) ? "yes" : "no";
        }
        const diffs = Object.entries(m).filter(([k, v]) => k.includes("_eq_") && v === "no").map(([k]) => k);
        const acao = [...new Set(Object.entries(seen).map(([, v]) => v["access-control-allow-origin"] ?? "-"))];
        push({
          id: "RR07f",
          title: `CORS: preflight and actual requests with Origin ${ORIGIN} for GET /rest/v1, POST /rest/v1/rpc, POST /auth/v1/token, through the Worker, the custom host and the load balancer`,
          status: "info",
          detail: `Access-Control-Allow-Origin values seen ${JSON.stringify(acao)}; header sets that differ: ${diffs.length ? diffs.join(", ") : "none"}; rest_get preflight via Worker ${m.rest_get_worker_pre}; rest_get actual via Worker ${m.rest_get_worker_act}`,
          measurements: m,
        });
      }

      /* ---- RR07g: real cross-origin fetch in headless Chromium ---- */
      {
        const script = resolve(import.meta.dir, "../browser/cors-check.ts");
        const spec = Buffer.from(JSON.stringify({ origin: ORIGIN, anon, email: B.email, password: B.password, bases: { worker: workerBase, custom: customBase } })).toString("base64");
        const p = Bun.spawn(["bun", script], { cwd: resolve(import.meta.dir, "../browser"), stdout: "pipe", stderr: "pipe", env: { ...process.env, PVLAB_CORS_SPEC: spec } });
        const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        await p.exited;
        const line = o.trim().split("\n").pop() ?? "";
        let res: { results?: Record<string, Record<string, string>>; consoleErrors?: string[] } = {};
        try {
          res = JSON.parse(line);
        } catch {}
        if (!res.results) {
          push({ id: "RR07g", title: "cross-origin fetch in headless Chromium", status: "fail", detail: `checker: ${(e || o).trim().slice(-300)}` });
        } else {
          const m: Record<string, string | number> = { console_errors: (res.consoleErrors ?? []).length };
          for (const [b, r] of Object.entries(res.results)) for (const [k, v] of Object.entries(r)) m[`${b}_${k}`] = v;
          const ok = ["worker", "custom"].every((b) => /^200 token/.test(String(m[`${b}_signin`])) && /^200 rows=5/.test(String(m[`${b}_read`])) && /^200 primary/.test(String(m[`${b}_rpc_post`])));
          push({
            id: "RR07g",
            title: `real cross-origin fetches from a page at ${ORIGIN} in headless Chromium: password sign-in, RLS read, POST rpc, through the Worker and the custom host`,
            status: ok ? "pass" : "fail",
            detail: Object.entries(m).map(([k, v]) => `${k} ${v}`).join("; "),
            measurements: m,
            evidence: (res.consoleErrors ?? []).join(" | ").slice(0, 1500),
          });
        }
      }

      /* ---- RR07h-k: OAuth (PKCE) round trips ---- */
      let oauthWorkerClient: SupabaseClient | undefined;
      let oauthUserId = "";
      const entries: { id: string; label: string; base: string; callbackVia?: string }[] = [
        { id: "RR07h", label: "worker", base: workerBase },
        { id: "RR07i", label: "custom", base: customBase },
        { id: "RR07j", label: "project", base: primaryBase },
        { id: "RR07k", label: "worker, callback hop through the Worker", base: workerBase, callbackVia: workerHost },
      ];
      for (const en of entries) {
        const m: Record<string, string | number> = { entry: en.label };
        const c = pkceClient(en.base, anon);
        let err = "";
        const hops: string[] = [];
        let code = "";
        try {
          const si = await c.auth.signInWithOAuth({ provider: "keycloak", options: { redirectTo: SITE_URL, skipBrowserRedirect: true } });
          const authorizeUrl = si.data.url ?? "";
          m.authorize_url = urlLabel(authorizeUrl);
          m.code_challenge_sent = new URL(authorizeUrl).searchParams.get("code_challenge") ? "yes" : "no";
          const step = async (name: string, url: string): Promise<string> => {
            const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
            const loc = r.headers.get("location") ?? "";
            hops.push(`${name} ${urlLabel(url)} ${r.status}${r.headers.get("x-rr06-route") ? ` route=${r.headers.get("x-rr06-route")}` : ""}`);
            if (!loc) err = `${name}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`;
            return loc;
          };
          const l1 = await step("authorize", authorizeUrl);
          if (l1) {
            const ru = new URL(l1).searchParams.get("redirect_uri") ?? "";
            m.redirect_uri = urlLabel(ru);
            const l2 = await step("issuer", l1);
            if (l2) {
              m.issuer_sent_browser_to = urlLabel(l2);
              const cb = new URL(l2);
              if (en.callbackVia) cb.host = en.callbackVia;
              const l3 = await step("callback", cb.toString());
              if (l3) {
                const u = new URL(l3);
                m.landed = urlLabel(l3);
                code = u.searchParams.get("code") ?? "";
                if (!code) err = `landing without code: ${u.searchParams.get("error_description") ?? new URLSearchParams(u.hash.slice(1)).get("error_description") ?? l3.slice(0, 120)}`;
              }
            }
          }
          if (code) {
            const ex = await c.auth.exchangeCodeForSession(code);
            m.exchange = ex.error ? `ERR ${ex.error.status ?? ""} ${ex.error.message}` : "ok";
            const s = ex.data.session;
            if (s) {
              m.token_iss = urlLabel(String(b64json(s.access_token.split(".")[1]!).iss ?? ""));
              m.provider = String(s.user.app_metadata?.provider ?? "-");
              const gu = await c.auth.getUser();
              const cc = gu.data.user?.identities?.[0]?.identity_data?.custom_claims as { hp_token_redirect_uri?: string } | undefined;
              m.token_request_redirect_uri = urlLabel(String(cc?.hp_token_redirect_uri ?? ""));
              m.get_user_via_entry = gu.error ? `ERR ${gu.error.status}` : "ok";
              oauthIds.set(s.user.id, "O");
              if (en.label === "worker") {
                oauthWorkerClient = c;
                oauthUserId = s.user.id;
              }
            } else if (!err) err = `exchange: ${m.exchange}`;
          }
        } catch (e) {
          err = errText(e);
        }
        m.hops = hops.join(" > ");
        push({
          id: en.id,
          title: `OAuth (Keycloak slot, mock issuer) PKCE round trip entered at the ${en.label} host; code exchanged at the entry host`,
          status: m.exchange === "ok" ? "pass" : "fail",
          detail: `${Object.entries(m).map(([k, v]) => `${k} ${v}`).join("; ")}${err ? `; error ${err}` : ""}`,
          measurements: m,
        });
      }

      /* ---- RR07l: the OAuth session through the Worker ---- */
      if (oauthWorkerClient && oauthUserId) {
        const c = oauthWorkerClient;
        const sd = await sql(pctx, `insert into public.rr6_docs(tenant_id, title) select '${oauthUserId}'::uuid, 'oa' || g from generate_series(1,4) g`);
        const reads: ViewRead[] = [];
        for (let i = 0; i < 20; i++) reads.push(await viewRead(c, label));
        const writes: string[] = [];
        for (let i = 0; i < 3; i++) {
          const r = await c.rpc("rr6_touch");
          writes.push(r.error ? `ERR ${r.error.code}` : (r.data as { in_recovery?: boolean })?.in_recovery ? "replica" : "primary");
        }
        const rf = await c.auth.refreshSession();
        const after: ViewRead[] = [];
        for (let i = 0; i < 10; i++) after.push(await viewRead(c, label));
        const all = [...reads, ...after];
        const ok = sd.status < 300 && !rf.error && all.every((r) => r.ok && r.rows === 4 && r.uid === "O" && r.foreign === 0) && writes.every((w) => w === "primary");
        push({
          id: "RR07l",
          title: "the OAuth (PKCE) session on the Worker-host client: 20 reads of rr6_docs_v, 3 POST rpc, refresh, 10 reads",
          status: ok ? "pass" : "fail",
          detail: `reads ${tallyStr(tallyViews(reads))}; POST rpc ${JSON.stringify(count(writes))}; refresh ${rf.error ? `ERR ${rf.error.message}` : "ok"}; reads after ${tallyStr(tallyViews(after))}`,
          measurements: {
            reads: tallyStr(tallyViews(reads)),
            reads_replica: all.filter((r) => r.node === "replica").length,
            reads_primary: all.filter((r) => r.node === "primary").length,
            rpc_post: JSON.stringify(count(writes)),
            refresh: rf.error ? `ERR ${rf.error.message}` : "ok",
            reads_after_refresh: tallyStr(tallyViews(after)),
          },
        });
      } else {
        push({ id: "RR07l", title: "the OAuth session through the Worker", status: "skip", detail: "no session from RR07h" });
      }

      /* ---- RR07m: SAML SSO through the Worker ---- */
      {
        const m: Record<string, string | number> = {};
        const tP = Date.now();
        const en = await mgmt(pctx, "PATCH", `/projects/${ref}/config/auth`, { saml_enabled: true });
        m.saml_enable_patch = en.status;
        let settled: number | string = "never";
        if (en.status < 300) {
          while (Date.now() - tP < 120_000) {
            const s = await fetch(`${primaryBase}/auth/v1/settings`, { headers: { apikey: anon }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
            const j = (await s?.json().catch(() => ({}))) as { saml_enabled?: boolean } | undefined;
            if (j?.saml_enabled === true) {
              settled = Math.round((Date.now() - tP) / 1000);
              break;
            }
            await sleep(3_000);
          }
        }
        m.saml_enabled_in_settings_s = settled;
        const dockerOk = (await run(["docker", "image", "inspect", BUN_IMAGE]).catch(() => ({ code: 1, out: "" }))).code === 0;
        if (en.status >= 300 || settled === "never") {
          push({ id: "RR07m", title: "SAML SSO entitlement", status: "info", detail: `saml_enabled PATCH HTTP ${en.status} ${en.text.slice(0, 200)}; settled ${settled}: not available, SAML not run`, measurements: m });
        } else if (!dockerOk) {
          push({ id: "RR07m", title: "SAML SSO through the Worker", status: "skip", detail: `SAML enabled (PATCH ${en.status}) but docker image ${BUN_IMAGE} absent: round trip not run`, measurements: m });
        } else {
          let err = "";
          try {
            samlDir = await mkdtemp(join(tmpdir(), "rr07-saml-"));
            const g = await run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(samlDir, "idp.key"), "-out", join(samlDir, "idp.crt"), "-subj", "/CN=pvlab-idp", "-days", "2"]);
            if (g.code !== 0) throw new Error(`openssl: ${g.out.slice(-200)}`);
            const keyPem = await Bun.file(join(samlDir, "idp.key")).text();
            const certPem = await Bun.file(join(samlDir, "idp.crt")).text();
            const certB64 = certPem.replace(/-----[A-Z ]+-----|\s/g, "");
            await Bun.write(join(samlDir, "saml-idp.mjs"), await Bun.file(SAML_IDP_SCRIPT).text());
            await writeFile(join(samlDir, "package.json"), JSON.stringify({ name: "w", private: true, type: "module" }));
            const inst = await run(["docker", "run", "--rm", "-v", `${samlDir}:/w`, "-w", "/w", BUN_IMAGE, "bun", "add", "xml-crypto"]);
            if (inst.code !== 0) throw new Error(`bun add xml-crypto: ${inst.out.slice(-200)}`);
            const metadataXml =
              `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${SAML_ENTITY}"><md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
              `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certB64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
              `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
              `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://${SAML_DOMAIN}/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
            const cp = await mgmt(pctx, "POST", `/projects/${ref}/config/auth/sso/providers`, {
              type: "saml",
              metadata_xml: metadataXml,
              domains: [SAML_DOMAIN],
              attribute_mapping: { keys: { email: { name: "email" }, sub: { name: "sub" } } },
            });
            m.provider_create = cp.status;
            if (cp.status >= 300) {
              push({ id: "RR07m", title: "SAML SSO entitlement", status: "info", detail: `saml_enabled PATCH ${en.status}; provider create HTTP ${cp.status} ${cp.text.slice(0, 200)}: not available, SAML not run`, measurements: m });
            } else {
              // SP metadata as seen through each host
              let spEntity = "";
              let acs = "";
              for (const [hn, base] of [["worker", workerBase], ["custom", customBase], ["project", primaryBase]] as const) {
                const r = await fetch(`${base}/auth/v1/sso/saml/metadata`, { headers: { apikey: anon }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
                const x = r ? await r.text() : "";
                const ent = x.match(/entityID="([^"]+)"/)?.[1] ?? "";
                const a = x.match(/AssertionConsumerService[^>]*Location="([^"]+)"/)?.[1] ?? "";
                m[`sp_metadata_via_${hn}`] = `${r?.status ?? 0} entity ${urlLabel(ent)} acs ${urlLabel(a)}`;
                if (hn === "worker") {
                  spEntity = ent;
                  acs = a;
                }
              }
              const attempt = async (postVia: "worker" | "metadata-acs") => {
                const c = pkceClient(workerBase, anon);
                const r = await c.auth.signInWithSSO({ domain: SAML_DOMAIN, options: { redirectTo: SITE_URL } });
                const url = r.data?.url ?? "";
                if (!url) return { ok: false, note: `sso ERR ${r.error?.status ?? ""} ${r.error?.message ?? ""}`, c };
                const u = new URL(url);
                const relay = u.searchParams.get("RelayState") ?? "";
                const reqXml = inflateRawSync(Buffer.from(u.searchParams.get("SAMLRequest") ?? "", "base64")).toString("utf8");
                const inResponseTo = reqXml.match(/\sID="([^"]+)"/)?.[1] ?? "";
                const reqAcs = reqXml.match(/AssertionConsumerServiceURL="([^"]+)"/)?.[1] ?? "";
                const spec = Buffer.from(JSON.stringify({ keyPem, certPem, otherKeyPem: keyPem, issuer: SAML_ENTITY, audience: spEntity, acs, inResponseTo, email: `saml-user@${SAML_DOMAIN}`, sub: "rr07-saml-1", variant: "ok" })).toString("base64");
                const sg = await run(["docker", "run", "--rm", "-e", `SPEC_B64=${spec}`, "-v", `${samlDir}:/w`, "-w", "/w", BUN_IMAGE, "bun", "saml-idp.mjs"]);
                const line = sg.out.split("\n").find((l) => l.startsWith("RESULT:"));
                if (!line) return { ok: false, note: `idp script: ${sg.out.slice(-160)}`, c };
                const target = postVia === "worker" ? `${workerBase}/auth/v1/sso/saml/acs` : acs;
                const post = await fetch(target, {
                  method: "POST",
                  headers: { "content-type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams({ SAMLResponse: line.slice(7), RelayState: relay }).toString(),
                  redirect: "manual",
                  signal: AbortSignal.timeout(30_000),
                });
                const loc = post.headers.get("location") ?? "";
                const route = post.headers.get("x-rr06-route") ?? "";
                let code = "";
                try {
                  code = new URL(loc).searchParams.get("code") ?? "";
                } catch {}
                const ex = code ? await c.auth.exchangeCodeForSession(code) : null;
                const note = `sso url host ${hostLabel(u.host)}; AuthnRequest ACS ${urlLabel(reqAcs)}; ACS POST to ${urlLabel(target)} ${post.status}${route ? ` route=${route}` : ""} -> ${urlLabel(loc)} code ${code ? "yes" : "no"}${code ? "" : ` ${(await post.text()).slice(0, 120)} ${new URLSearchParams(loc.split("#")[1] ?? "").get("error_description")?.slice(0, 80) ?? ""}`}; exchange via Worker ${ex ? (ex.error ? `ERR ${ex.error.message}` : "ok") : "n/a"}`;
                if (ex?.data.session) oauthIds.set(ex.data.session.user.id, "S");
                return { ok: !!ex?.data.session, note, c, userId: ex?.data.session?.user.id ?? "", provider: String(ex?.data.session?.user.app_metadata?.provider ?? "") };
              };
              const viaWorker = await attempt("worker");
              const viaMeta = await attempt("metadata-acs");
              m.acs_post_via_worker = viaWorker.note;
              m.acs_post_to_metadata_acs = viaMeta.note;
              let readsOk = false;
              if (viaWorker.ok && viaWorker.userId) {
                await sql(pctx, `insert into public.rr6_docs(tenant_id, title) select '${viaWorker.userId}'::uuid, 's' || g from generate_series(1,2) g`);
                const reads: ViewRead[] = [];
                for (let i = 0; i < 10; i++) reads.push(await viewRead(viaWorker.c, label));
                m.reads_via_worker = tallyStr(tallyViews(reads));
                m.provider = viaWorker.provider.startsWith("sso:") ? "sso:<uuid>" : viaWorker.provider;
                readsOk = reads.every((r) => r.ok && r.rows === 2 && r.uid === "S" && r.foreign === 0);
              }
              push({
                id: "RR07m",
                title: "SAML SSO (lab-signed Response) started on the Worker-host client (PKCE): SP metadata per host, ACS POST through the Worker and to the metadata ACS, code exchange and 10 reads through the Worker",
                status: viaWorker.ok && readsOk ? "pass" : "fail",
                detail: Object.entries(m).map(([k, v]) => `${k} ${v}`).join("; "),
                measurements: m,
              });
            }
          } catch (e) {
            err = errText(e);
            push({ id: "RR07m", title: "SAML SSO through the Worker", status: "fail", detail: `${Object.entries(m).map(([k, v]) => `${k} ${v}`).join("; ")}; error ${err}`, measurements: m });
          }
        }
      }
    } catch (e) {
      push({ id: "RR07x", title: "module aborted", status: "fail", detail: errText(e) });
    } finally {
      /* ---- RR07p ---- */
      if (samlDir) {
        await run(["docker", "run", "--rm", "-v", `${samlDir}:/w`, BUN_IMAGE, "sh", "-c", "rm -rf /w/* /w/.[!.]*"]).catch(() => undefined);
        await rm(samlDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (ref && !keep) {
        const pctx = forRef(ctx, ref);
        const t: string[] = [];
        if (workerDeployed) {
          t.push(`wrangler delete exit ${(await wrangler(["delete", "--name", WORKER_NAME, "--force"])).code}`);
          // Belt and braces: a Workers Custom Domain or its certificate left on the zone.
          const doms = await cf("GET", `/accounts/${acct}/workers/domains?hostname=${workerHost}`);
          const left = ((doms.json?.result ?? []) as { id: string; hostname: string }[]).filter((d) => d.hostname === workerHost);
          for (const d of left) await cf("DELETE", `/accounts/${acct}/workers/domains/${d.id}`);
          t.push(`Workers Custom Domains left after delete ${left.length}`);
          try {
            const zid = await zoneId(workerHost);
            const packs = await cf("GET", `/zones/${zid}/ssl/certificate_packs?status=all&per_page=100`);
            const mine = ((packs.json?.result ?? []) as { id: string; hosts?: string[] }[]).filter((p) => (p.hosts ?? []).includes(workerHost));
            let gone = 0;
            for (const p of mine) if ((await cf("DELETE", `/zones/${zid}/ssl/certificate_packs/${p.id}`)).status < 300) gone++;
            t.push(`certificate packs for the Worker host ${mine.length}, deleted ${gone}`);
          } catch (e) {
            t.push(`certificate check failed ${errText(e).slice(0, 60)}`);
          }
        }
        const authOff = await mgmt(pctx, "PATCH", `/projects/${ref}/config/auth`, { external_keycloak_enabled: false, saml_enabled: false }).catch(() => null);
        t.push(`auth providers off HTTP ${authOff?.status ?? 0}`);
        if (domainStarted) t.push(`custom-hostname DELETE HTTP ${(await mgmt(pctx, "DELETE", `/projects/${ref}/custom-hostname`).catch(() => null))?.status ?? 0}`);
        t.push(`DNS records removed ${await removeRecords(await zoneId(host), [...dnsNames]).catch(() => -1)}`);
        if (replicaId) {
          t.push(`replica remove HTTP ${(await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/remove`, { database_identifier: replicaId }).catch(() => null))?.status ?? 0}`);
          await sleep(20_000);
        }
        let del = await mgmt(pctx, "DELETE", `/projects/${ref}`).catch(() => null);
        for (let i = 0; i < 6 && (del?.status ?? 0) >= 300; i++) {
          await sleep(30_000);
          del = await mgmt(pctx, "DELETE", `/projects/${ref}`).catch(() => null);
        }
        t.push(`project DELETE HTTP ${del?.status ?? 0}`);
        push({
          id: "RR07p",
          title: "teardown: Worker, Workers Custom Domain, certificate, auth providers, custom hostname, DNS records, replica, project",
          status: (del?.status ?? 0) < 300 ? "pass" : "fail",
          detail: `${t.join("; ")}; run took ${Math.round((Date.now() - t00) / 60000)} min`,
          measurements: { project_delete_http: del?.status ?? 0, run_min: Math.round((Date.now() - t00) / 60000) },
        });
      } else if (ref) {
        ctx.log("project LEFT RUNNING (PVLAB_RR_KEEP=1) - delete it, the Worker, the custom hostname and the DNS records by hand");
      }
    }
    return out;
  },
};
export default mod;
