/**
 * RR09 - gaps RR01-RR08 left open, on a Team-plan org.
 *
 * RR01-RR08 ran on a Pro org with tables that fit in memory, so four things
 * were never measured: which node pays the disk reads when reads miss the
 * cache; whether the load balancer keeps sending reads to a node whose disk is
 * saturated (RR04i loaded CPU, which barely slowed REST); whether a project's
 * own `edge_logs` can tell which hostname each request came through (the
 * check an operator would run to learn whether an app uses the load balancer,
 * a replica host, the project host or a custom domain); and how long `-all`
 * keeps failing after its only replica is removed (RR02j stopped watching at
 * 1,200 s).
 *
 *   RR09a  primary (Small) in the org of role PVLAB_RR9_ORG_ROLE (team), pitr_7,
 *          disk grown, schema, org plan recorded
 *   RR09b  same-region read replica on the still-empty primary; replica host;
 *          load balancer host. RR09a2 then loads a table several times the
 *          node's RAM, which streams to the replica (run 1 on 2026-11-09 built
 *          the replica after a 3.9 GB load: setup 204, never served in 45 min)
 *   RR09c  custom domain (optional): add-on, DNS, verify, activate, serving
 *   RR09d  edge_logs: tagged GETs sent to each hostname, then the rows the
 *          project's logs hold for them (host, query string, redirect identifier)
 *   RR09e  cold reads: random point reads through the custom host and through
 *          the load balancer, disjoint key ranges; per node: who served,
 *          latency, pg_stat_database blks_read/blks_hit, node_disk read bytes
 *   RR09f  the same through the load balancer (and the custom host) while
 *          sequential scans saturate the PRIMARY's disk; a cache-hot probe too
 *   RR09g  read-replicas/remove, then the load balancer, the project host and
 *          the custom host every 10 s for up to PVLAB_RR9_REMOVE_WATCH_S
 *   RR09p  teardown: custom hostname, DNS records, replica (if still there), project
 *
 * The node is read from `pg_is_in_recovery()` in each response, never latency.
 * `blks_read` counts shared-buffer misses (the OS page cache can answer some);
 * the table is sized at about twice the Small node's 2 GB RAM so most misses
 * reach the disk, and node_disk counters from the metrics endpoint are kept as
 * a second reading where the endpoint answers.
 *
 * DESTRUCTIVE and BILLABLE: Small primary, Small replica, pitr_7, disk above the
 * default, custom_domain (when PVLAB_ENDPOINT_CUSTOM_DOMAIN is set).
 * Env: PVLAB_ORG_TEAM (or the role in PVLAB_RR9_ORG_ROLE); see the Makefile for knobs.
 */
import { appendFileSync } from "node:fs";
import { Resolver, resolve4 } from "node:dns/promises";
import { fetchKeys, logsQuery, sql } from "../../../harness/src/platform";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { parseNodeMetrics } from "../../compute-disk/lib/disk-change";
import { addRecord, cfAvailable, removeRecords, zoneId } from "../../hostname-path/lib/cfdns";
import { activateWithRetry } from "../../static-hosting/lib/activate";
import { PREFIX, applyAddon, connectSession, errText, findLoadBalancer, forRef, poolerConfig, round, selectedAddons, sleep, waitProjectHealthy, whoami, type PoolerEntry } from "../lib/rr";
import { statsOf, tallyBy } from "../lib/rr08";
import { blkDelta, removalSummary, replicaShare, tagOf, type Blks, type RemovalTick } from "../lib/rr09";
import { anonNode, wantedTxt, type HostnameCfg } from "./rr06-custom-domain";

const REGION = process.env.PVLAB_RR9_REGION ?? "ap-southeast-1";
const ORG_ROLE = process.env.PVLAB_RR9_ORG_ROLE ?? "team";
const ROWS = Number(process.env.PVLAB_RR9_ROWS ?? 4_000_000);
const DISK_GB = Number(process.env.PVLAB_RR9_DISK_GB ?? 24);
const ARM_S = Number(process.env.PVLAB_RR9_ARM_S ?? 90);
const CONC = Number(process.env.PVLAB_RR9_CONC ?? 8);
const BATCH = Number(process.env.PVLAB_RR9_BATCH ?? 50);
const HOG = Number(process.env.PVLAB_RR9_HOG ?? 4);
const REMOVE_WATCH_S = Number(process.env.PVLAB_RR9_REMOVE_WATCH_S ?? 2400);
const LOG_N = 20;
const LOAD_CHUNK = 250_000;
const PHASES = (process.env.PVLAB_RR9_PHASES ?? "logs,cold,hog,remove").split(",").map((s) => s.trim());
const want = (p: string) => PHASES.includes(p);

/** ~1 KB rows: 30 x md5 = 960 characters, under the TOAST threshold so stored inline, uncompressed. */
const schema = (rows: number) => `
create table if not exists public.rr_marker (id bigserial primary key, tag text not null, written_at timestamptz not null default clock_timestamp());
insert into public.rr_marker(tag) values ('seed');
grant select on public.rr_marker to anon, authenticated;
create or replace function public.rr_whoami() returns json language sql stable as $$
  select json_build_object('in_recovery', pg_is_in_recovery(), 'pm', extract(epoch from pg_postmaster_start_time())::bigint)
$$;
create table if not exists public.rr9_cold (id bigint primary key, pad text not null);
grant select on public.rr9_cold to anon, authenticated;
create or replace function public.rr9_cold_read(n int default 50, lo bigint default 1, hi bigint default ${rows}) returns json language plpgsql volatile as $$
declare k bigint; l int; got int := 0; bytes bigint := 0;
begin
  for i in 1..least(n, 500) loop
    k := lo + floor(random() * (hi - lo + 1))::bigint;
    select length(pad) into l from public.rr9_cold where id = k;
    if found then got := got + 1; bytes := bytes + l; end if;
  end loop;
  return json_build_object('in_recovery', pg_is_in_recovery(), 'rows', got, 'bytes', bytes);
end $$;
grant execute on function public.rr_whoami(), public.rr9_cold_read(int, bigint, bigint) to anon, authenticated;
notify pgrst, 'reload schema';
`;

/* ---------- helpers ---------- */

/** pg_stat_database counters for this database, over a fresh session connection to the node. */
async function nodeBlks(e: PoolerEntry, pw: string): Promise<Blks | null> {
  try {
    const c = await connectSession(e, pw, 3, 5_000);
    try {
      const r = await c.query("select blks_read::bigint as r, blks_hit::bigint as h from pg_stat_database where datname = current_database()");
      return { read: Number(r.rows[0]?.r ?? -1), hit: Number(r.rows[0]?.h ?? -1) };
    } finally {
      await c.end().catch(() => {});
    }
  } catch {
    return null;
  }
}

/** node_disk read bytes summed over devices, from the project's Prometheus endpoint on `host`. */
async function diskReadBytes(host: string, svc: string): Promise<{ status: number; bytes: number; timeS: number }> {
  try {
    const res = await fetch(`https://${host}/customer/v1/privileged/metrics`, {
      headers: { Authorization: `Basic ${Buffer.from(`service_role:${svc}`).toString("base64")}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { status: res.status, bytes: -1, timeS: Number.NaN };
    const snap = parseNodeMetrics(await res.text());
    const bytes = Object.values(snap.disks).reduce((a, d) => a + d.readBytes, 0);
    return { status: res.status, bytes, timeS: snap.timeS };
  } catch {
    return { status: 0, bytes: -1, timeS: Number.NaN };
  }
}

interface ArmOut {
  served: Record<string, number>;
  ms: { primary: number[]; replica: number[] };
  errors: string[];
  rows: number;
  requests: number;
}

/** CONC workers calling rr9_cold_read through `base` until the deadline. */
async function coldArm(base: string, anon: string, lo: number, hi: number, seconds: number): Promise<ArmOut> {
  const out: ArmOut = { served: {}, ms: { primary: [], replica: [] }, errors: [], rows: 0, requests: 0 };
  const deadline = Date.now() + seconds * 1000;
  const worker = async () => {
    while (Date.now() < deadline) {
      const t0 = performance.now();
      out.requests++;
      try {
        const r = await fetch(`${base}/rest/v1/rpc/rr9_cold_read?n=${BATCH}&lo=${lo}&hi=${hi}`, {
          headers: { apikey: anon, Authorization: `Bearer ${anon}` },
          signal: AbortSignal.timeout(60_000),
        });
        const text = await r.text();
        const ms = performance.now() - t0;
        let j: { in_recovery?: boolean; rows?: number } = {};
        try {
          j = JSON.parse(text);
        } catch {}
        if (r.status === 200 && typeof j.in_recovery === "boolean") {
          const node = j.in_recovery ? "replica" : "primary";
          out.served[node] = (out.served[node] ?? 0) + 1;
          out.ms[node].push(ms);
          out.rows += Number(j.rows ?? 0);
        } else out.errors.push(`HTTP ${r.status} ${text.replace(/\s+/g, " ").slice(0, 60)}`);
      } catch (e) {
        out.errors.push(errText(e).slice(0, 60));
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  return out;
}

async function waitServing(host: string, anon: string, budgetMs: number): Promise<{ s: number | "never"; last: string }> {
  const t0 = Date.now();
  let last = "";
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

const mod: TestModule = {
  id: "RR09",
  title: "Read replica gaps on a Team org: cold reads per node, a disk-saturated primary, edge_logs per hostname, the load balancer after its replica is removed",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const host = ctx.endpoints.custom_domain ?? "";
    let ref = "";
    let replicaId = "";
    const redact = (s: string) => {
      let r = s;
      if (ref) r = r.split(ref).join("<ref>");
      if (replicaId) r = r.split(replicaId).join("<replica-id>");
      if (host) r = r.split(host).join("<custom-host>");
      return r;
    };
    const push = (r: TestResult) => {
      r.detail = r.detail ? redact(r.detail) : r.detail;
      r.evidence = r.evidence ? redact(r.evidence) : r.evidence;
      out.push(r);
      ctx.log(`${r.id} ${r.status}${r.detail ? `: ${r.detail.slice(0, 300)}` : ""}`);
    };
    const org = ctx.orgs[ORG_ROLE];
    if (!org) return [{ id: "RR09", title: this.title, status: "skip", detail: `PVLAB_ORG_${ORG_ROLE.toUpperCase()} not set` }];
    if (host && !cfAvailable()) return [{ id: "RR09", title: this.title, status: "skip", detail: "custom domain set but no CLOUDFLARE_API_KEY/CLOUDFLARE_EMAIL" }];
    const keep = process.env.PVLAB_RR_KEEP === "1";
    const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
    let domainStarted = false;
    let replicaRemoved = false;
    const dnsNames = new Set<string>(host ? [host, `_acme-challenge.${host}`, `_cf-custom-hostname.${host}`] : []);
    const t00 = Date.now();

    try {
      /* ---- RR09a: primary, disk, data ---- */
      const orgRow = await mgmt(ctx, "GET", `/organizations/${org}`);
      const orgPlan = String((orgRow.json as { plan?: string } | undefined)?.plan ?? `HTTP ${orgRow.status}`);
      const name = `${PREFIX}${Date.now()}`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name,
        db_pass: dbPass,
        region_selection: { type: "specific", code: REGION },
        desired_instance_size: "small",
      });
      ref = String((create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "");
      if (ref && process.env.PVLAB_RR_REFS_FILE) appendFileSync(process.env.PVLAB_RR_REFS_FILE, `${ref} ${name} ${new Date().toISOString()} RR09\n`);
      if (create.status !== 201 || !ref) {
        push({ id: "RR09a", title: `create primary (Small, ${REGION}, ${ORG_ROLE} org)`, status: "fail", detail: `org plan ${orgPlan}; HTTP ${create.status}: ${create.text.slice(0, 300)}` });
        return out;
      }
      ctx.log(`primary created (${name}, org plan ${orgPlan}); waiting healthy`);
      const h = await waitProjectHealthy(ctx, ref);
      if (h.status !== "ACTIVE_HEALTHY") {
        push({ id: "RR09a", title: `create primary (Small, ${REGION})`, status: "fail", detail: `${h.status} after ${h.waitedS}s` });
        return out;
      }
      const pctx = forRef(ctx, ref);
      const primaryHost = `${ref}.supabase.co`;
      const primaryBase = `https://${primaryHost}`;
      const have = await selectedAddons(pctx, ref);
      const pitr = have.includes("pitr_7") ? { status: 0, text: "already" } : await applyAddon(pctx, ref, "pitr", "pitr_7");
      // Grow the disk before loading: the default volume is too small for the table plus WAL.
      const curDisk = await mgmt(pctx, "GET", `/projects/${ref}/config/disk`);
      const attrs = ((curDisk.json ?? {}) as { attributes?: Record<string, unknown> }).attributes ?? {};
      const grow = await mgmt(pctx, "POST", `/projects/${ref}/config/disk`, { attributes: { ...attrs, size_gb: DISK_GB } });
      let grownS: number | string = "never";
      const tg = Date.now();
      while (grow.status < 300 && Date.now() - tg < 15 * 60_000) {
        const u = await mgmt(pctx, "GET", `/projects/${ref}/config/disk/util`).catch(() => null);
        const fs = ((u?.json ?? {}) as { metrics?: { fs_size_bytes?: number } }).metrics?.fs_size_bytes ?? 0;
        if (fs > (DISK_GB - 3) * 1024 ** 3) {
          grownS = Math.round((Date.now() - tg) / 1000);
          break;
        }
        await sleep(15_000);
      }
      const ddl = await sql(pctx, schema(ROWS));
      let keys: Awaited<ReturnType<typeof fetchKeys>> | undefined;
      for (let i = 0; i < 18 && !keys; i++) {
        try {
          keys = await fetchKeys(pctx);
        } catch {
          await sleep(10_000);
        }
      }
      const primaryEntry = (await poolerConfig(pctx, ref).catch(() => [])).find((e) => e.database_type === "PRIMARY");
      if (!keys || ddl.status >= 300 || !primaryEntry || grownS === "never") {
        push({ id: "RR09a", title: "disk, schema, keys, pooler", status: "fail", detail: `disk POST ${grow.status} grown ${grownS}; schema HTTP ${ddl.status} ${ddl.error}; keys ${keys ? "ok" : "absent"}; pooler ${primaryEntry ? "ok" : "absent"}` });
        return out;
      }
      const anon = keys.anon;
      const svc = keys.service;
      push({
        id: "RR09a",
        title: `primary (Small, ${REGION}) in the ${ORG_ROLE} org, pitr_7, disk ${DISK_GB} GB, schema`,
        status: "pass",
        detail: `org plan ${orgPlan}; healthy after ${h.waitedS}s; pitr_7 ${pitr.status || "already"}; disk grown after ${grownS}s`,
        measurements: { org_plan: orgPlan, healthy_after_s: h.waitedS, disk_grown_s: grownS, region: REGION },
      });

      /* ---- RR09b: replica ---- */
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
        while (Date.now() - t2 < 45 * 60_000) {
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
        push({ id: "RR09b", title: "read replica", status: "fail", detail: `setup HTTP ${setup.status} ${setup.text.slice(0, 200)}; served ${servedS}` });
        return out;
      }
      replicaId = replica.identifier;
      const replicaHost = `${replicaId}.supabase.co`;
      const replicaBase = `https://${replicaHost}`;
      let rn = await anonNode(replicaBase, anon);
      for (let i = 0; i < 18 && rn !== "replica"; i++) {
        await sleep(10_000);
        rn = await anonNode(replicaBase, anon);
      }
      const tl = Date.now();
      const loader = await connectSession(primaryEntry, dbPass);
      let loaded = 0;
      try {
        await loader.query("set statement_timeout = 0");
        for (let lo = 1; lo <= ROWS; lo += LOAD_CHUNK) {
          const hi = Math.min(ROWS, lo + LOAD_CHUNK - 1);
          await loader.query(`insert into public.rr9_cold select g, repeat(md5(g::text), 30) from generate_series(${lo}, ${hi}) g`);
          loaded = hi;
        }
        await loader.query("vacuum (analyze) public.rr9_cold");
      } finally {
        await loader.end().catch(() => {});
      }
      const loadS = Math.round((Date.now() - tl) / 1000);
      const size = await sql(pctx, "select pg_relation_size('public.rr9_cold')::bigint as heap, pg_total_relation_size('public.rr9_cold')::bigint as total, current_setting('shared_buffers') as sb, version() as v");
      const heapGb = round(Number(size.rows[0]?.heap ?? 0) / 1024 ** 3, 2);
      push({
        id: "RR09a2",
        title: `rr9_cold ${ROWS} rows of ~1 KB loaded AFTER the replica serves (streams to it), then VACUUM ANALYZE`,
        status: loaded === ROWS ? "pass" : "fail",
        detail: `loaded ${loaded} rows in ${loadS}s; heap ${heapGb} GB, total ${round(Number(size.rows[0]?.total ?? 0) / 1024 ** 3, 2)} GB; shared_buffers ${size.rows[0]?.sb}; ${String(size.rows[0]?.v ?? "").slice(0, 40)}`,
        measurements: { load_s: loadS, heap_gb: heapGb },
      });

      // Retry: run 2 (2026-11-09) probed once, after the load, and missed; the
      // candidates tried are kept so a miss says which host answered what.
      let lb = await findLoadBalancer(pctx, ref, anon);
      const tLb = Date.now();
      while (!lb.url && Date.now() - tLb < 10 * 60_000) {
        await sleep(20_000);
        lb = await findLoadBalancer(pctx, ref, anon);
      }
      const lbAfterS = Math.round((Date.now() - tLb) / 1000);
      push({
        id: "RR09b",
        title: `read replica in ${REGION} (added to the empty primary; RR09a2 loads after it); replica host; load balancer host`,
        status: lb.url && rn === "replica" ? "pass" : "fail",
        detail: `setup HTTP ${setup.status}; first session connection after ${servedS}s; replica host answers ${rn}; load balancer ${lb.url ? lb.url.replace(/^https:\/\//, "") : "NOT found"} after ${lbAfterS}s of retries (tried ${lb.tried.join(" ")}; platform route HTTP ${lb.platformStatus})`,
        measurements: { replica_served_after_s: servedS },
      });
      if (!lb.url) return out;
      const lbBase = lb.url;
      const lbHost = lbBase.replace(/^https:\/\//, "");

      /* ---- RR09c: custom domain (optional) ---- */
      let customBase = "";
      if (!host) {
        push({ id: "RR09c", title: "custom domain", status: "skip", detail: "PVLAB_ENDPOINT_CUSTOM_DOMAIN not set; custom-host arms skipped" });
      } else {
        domainStarted = true;
        const addon = await applyAddon(pctx, ref, "custom_domain", "cd_default");
        const init = await mgmt(pctx, "POST", `/projects/${ref}/custom-hostname/initialize`, { custom_hostname: host });
        const notes: string[] = [`add-on HTTP ${addon.status}`, `initialize HTTP ${init.status}`];
        let serving: { s: number | "never"; last: string } = { s: "never", last: "not started" };
        if (init.status < 300) {
          const zone = await zoneId(host);
          const cname = await addRecord(zone, "CNAME", host, `${ref}.supabase.co`);
          notes.push(`CNAME ${cname.status}${cname.error ? ` ${cname.error}` : ""}`);
          const written = new Set<string>();
          const writeWanted = async (cfg: HostnameCfg) => {
            for (const w of wantedTxt(cfg)) {
              const k = `${w.name}=${w.value}`;
              if (written.has(k)) continue;
              const r = await addRecord(zone, "TXT", w.name, w.value);
              written.add(k);
              dnsNames.add(w.name);
              notes.push(`TXT ${w.name.split(".")[0]} ${r.status}`);
            }
          };
          await writeWanted((init.json ?? {}) as HostnameCfg);
          const tD = Date.now();
          let cfg: HostnameCfg = {};
          let verified = false;
          while (Date.now() - tD < 20 * 60_000) {
            const rv = await mgmt(pctx, "POST", `/projects/${ref}/custom-hostname/reverify`);
            cfg = (rv.json ?? {}) as HostnameCfg;
            await writeWanted(cfg);
            if ((cfg.status ?? "") >= "3_challenge_verified") {
              verified = true;
              notes.push(`verified ${Math.round((Date.now() - tD) / 1000)}s`);
              break;
            }
            await sleep(20_000);
          }
          if (verified) {
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
            notes.push(`activate first ${act.first}, ${act.attempts} attempt(s)`);
            while (Date.now() - tA < 15 * 60_000) {
              const g = (await mgmt(pctx, "GET", `/projects/${ref}/custom-hostname`)).json as HostnameCfg | undefined;
              if ((g?.status ?? "") >= "5_services_reconfigured") break;
              await sleep(10_000);
            }
            serving = await waitServing(host, anon, 10 * 60_000);
          }
        }
        if (serving.s !== "never") customBase = `https://${host}`;
        push({
          id: "RR09c",
          title: "custom domain up: add-on, initialize, DNS, verify, activate; host serves rr_whoami",
          status: serving.s !== "never" ? "pass" : "fail",
          detail: `${notes.join(", ")}; custom host answered ${serving.last} after ${serving.s}s`,
          measurements: { serving_s: serving.s },
        });
      }
      const hosts: [string, string][] = [
        ...(customBase ? ([["custom", customBase]] as [string, string][]) : []),
        ["lb", lbBase],
        ["replica", replicaBase],
        ["primary", primaryBase],
      ];
      const hostLabel = (h: string) => (h === host ? "custom" : h === lbHost ? "lb" : h === replicaHost ? "replica" : h === primaryHost ? "primary" : h ? `other:${redact(h)}` : "none");

      /* ---- RR09d (send half): tagged GETs per hostname; the logs are read after RR09f ---- */
      const sentTags: Record<string, Record<string, number>> = {};
      const tLogs = Date.now();
      if (want("logs")) {
        for (const [label, base] of hosts) {
          const st: Record<string, number> = {};
          for (let i = 0; i < LOG_N; i++) {
            const r = await fetch(`${base}/rest/v1/rr_marker?select=id&tag=eq.rr9-${label}&limit=1`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
            const k = String(r?.status ?? 0);
            st[k] = (st[k] ?? 0) + 1;
          }
          sentTags[label] = st;
        }
      }

      /* ---- RR09e: cold reads, no load ---- */
      const q = Math.floor(ROWS / 4);
      const ranges = { e_custom: [1, q], e_lb: [q + 1, 2 * q], f_lb: [2 * q + 1, 3 * q], f_custom: [3 * q + 1, ROWS] } as const;
      const measureArm = async (key: string, base: string, lo: number, hi: number) => {
        const b0 = { p: await nodeBlks(primaryEntry, dbPass), r: await nodeBlks(replica!, dbPass), dp: await diskReadBytes(primaryHost, svc), dr: await diskReadBytes(replicaHost, svc) };
        const a = await coldArm(base, anon, lo, hi, ARM_S);
        await sleep(12_000); // backends flush pending stats within about 10 s of going idle
        const b1 = { p: await nodeBlks(primaryEntry, dbPass), r: await nodeBlks(replica!, dbPass), dp: await diskReadBytes(primaryHost, svc), dr: await diskReadBytes(replicaHost, svc) };
        const dP = b0.p && b1.p ? blkDelta(b0.p, b1.p) : { read: -1, hit: -1, missPct: -1 };
        const dR = b0.r && b1.r ? blkDelta(b0.r, b1.r) : { read: -1, hit: -1, missPct: -1 };
        const mb = (x: { bytes: number }, y: { bytes: number }) => (x.bytes >= 0 && y.bytes >= 0 ? round((y.bytes - x.bytes) / 1024 ** 2, 1) : -1);
        const sp = statsOf(a.ms.primary);
        const sr = statsOf(a.ms.replica);
        const m: Record<string, number | string> = {
          [`${key}_requests`]: a.requests,
          [`${key}_served_primary`]: a.served.primary ?? 0,
          [`${key}_served_replica`]: a.served.replica ?? 0,
          [`${key}_errors`]: a.errors.length,
          [`${key}_p50_primary_ms`]: sp.p50,
          [`${key}_p95_primary_ms`]: sp.p95,
          [`${key}_p50_replica_ms`]: sr.p50,
          [`${key}_p95_replica_ms`]: sr.p95,
          [`${key}_blks_read_primary`]: dP.read,
          [`${key}_blks_read_replica`]: dR.read,
          [`${key}_miss_pct_primary`]: dP.missPct,
          [`${key}_miss_pct_replica`]: dR.missPct,
          [`${key}_replica_share_blks_pct`]: replicaShare(dP.read, dR.read),
          [`${key}_disk_read_mb_primary`]: mb(b0.dp, b1.dp),
          [`${key}_disk_read_mb_replica`]: mb(b0.dr, b1.dr),
        };
        const line = `${key}: ${a.requests} req (${BATCH} random rows each, keys ${lo}-${hi}), served primary ${a.served.primary ?? 0} / replica ${a.served.replica ?? 0}, errors ${a.errors.length}${a.errors.length ? ` (${tallyBy(a.errors).slice(0, 120)})` : ""}; ms p50/p95 primary ${sp.p50}/${sp.p95}, replica ${sr.p50}/${sr.p95}; blks_read primary ${dP.read} (miss ${dP.missPct}%), replica ${dR.read} (miss ${dR.missPct}%), replica share ${replicaShare(dP.read, dR.read)}%; node_disk read MB primary ${mb(b0.dp, b1.dp)} (metrics HTTP ${b1.dp.status}), replica ${mb(b0.dr, b1.dr)} (metrics HTTP ${b1.dr.status})`;
        return { m, line };
      };
      const hotProbe = async (base: string, n: number) => {
        const s: { node: string; ms: number }[] = [];
        for (let i = 0; i < n; i++) {
          const x = await whoami(base, anon);
          s.push({ node: x.node ? (x.node.in_recovery ? "replica" : "primary") : x.err?.slice(0, 40) ?? `HTTP ${x.status}`, ms: x.ms });
        }
        const by = (k: string) => statsOf(s.filter((x) => x.node === k).map((x) => x.ms));
        return { tally: tallyBy(s.map((x) => x.node)), p: by("primary"), r: by("replica") };
      };
      if (want("cold")) {
        const m: Record<string, number | string> = {};
        const lines: string[] = [];
        if (customBase) {
          const x = await measureArm("e_custom", customBase, ranges.e_custom[0], ranges.e_custom[1]);
          Object.assign(m, x.m);
          lines.push(x.line);
        }
        const y = await measureArm("e_lb", lbBase, ranges.e_lb[0], ranges.e_lb[1]);
        Object.assign(m, y.m);
        lines.push(y.line);
        const hp = await hotProbe(lbBase, 100);
        m.e_hot_lb = hp.tally;
        lines.push(`hot probe (100 x rpc/rr_whoami via lb, sequential): ${hp.tally}; ms p50 primary ${hp.p.p50}, replica ${hp.r.p50}`);
        push({
          id: "RR09e",
          title: `cold reads, no load: ${ARM_S} s per arm, ${CONC} concurrent clients, ${BATCH} random point reads per GET, disjoint key ranges; per node served, latency, blks_read, node_disk reads`,
          status: "info",
          detail: lines.join(" | "),
          measurements: m,
          evidence: lines.join("\n"),
        });
      }

      /* ---- RR09f: the same with the primary's disk saturated by sequential scans ---- */
      if (want("hog")) {
        const m: Record<string, number | string> = { hog_sessions: HOG };
        const lines: string[] = [];
        let stop = false;
        const hogClients = await Promise.all(Array.from({ length: HOG }, () => connectSession(primaryEntry, dbPass, 3, 5_000).catch(() => null)));
        const live = hogClients.filter((c): c is NonNullable<typeof c> => !!c);
        let scans = 0;
        const loops = live.map(async (c) => {
          try {
            await c.query("set statement_timeout = 0; set synchronize_seqscans = off; set application_name = 'rr9_hog'");
            while (!stop) {
              await c.query("select count(*) from public.rr9_cold where length(pad) > 0");
              scans++;
            }
          } catch {
            /* cancelled at the end */
          }
        });
        await sleep(30_000);
        const hb0 = { p: await nodeBlks(primaryEntry, dbPass), dp: await diskReadBytes(primaryHost, svc), t: Date.now() };
        const fl = await measureArm("f_lb", lbBase, ranges.f_lb[0], ranges.f_lb[1]);
        Object.assign(m, fl.m);
        lines.push(fl.line);
        if (customBase) {
          const fc = await measureArm("f_custom", customBase, ranges.f_custom[0], ranges.f_custom[1]);
          Object.assign(m, fc.m);
          lines.push(fc.line);
        }
        const hp = await hotProbe(lbBase, 100);
        m.f_hot_lb = hp.tally;
        m.f_hot_p50_primary_ms = hp.p.p50;
        m.f_hot_p50_replica_ms = hp.r.p50;
        lines.push(`hot probe under the hog (100 x rpc/rr_whoami via lb): ${hp.tally}; ms p50 primary ${hp.p.p50}, replica ${hp.r.p50}`);
        const hb1 = { p: await nodeBlks(primaryEntry, dbPass), dp: await diskReadBytes(primaryHost, svc), t: Date.now() };
        stop = true;
        const cancel = await sql(pctx, "select count(pg_cancel_backend(pid))::int as n from pg_stat_activity where application_name = 'rr9_hog'");
        await Promise.race([Promise.all(loops), sleep(30_000)]);
        await Promise.all(live.map((c) => c.end().catch(() => {})));
        const secs = (hb1.t - hb0.t) / 1000;
        const hogBlks = hb0.p && hb1.p ? hb1.p.read - hb0.p.read : -1;
        m.hog_connected = live.length;
        m.hog_scans_completed = scans;
        m.hog_primary_blks_read_per_s = hogBlks >= 0 ? Math.round(hogBlks / secs) : -1;
        m.hog_primary_disk_read_mbps = hb0.dp.bytes >= 0 && hb1.dp.bytes >= 0 ? round((hb1.dp.bytes - hb0.dp.bytes) / 1024 ** 2 / secs, 1) : -1;
        lines.push(`hog: ${live.length}/${HOG} sessions, ${scans} full scans completed, primary blks_read ${m.hog_primary_blks_read_per_s}/s and node_disk ${m.hog_primary_disk_read_mbps} MB/s over ${Math.round(secs)} s; cancelled ${cancel.rows[0]?.n ?? "?"}`);
        push({
          id: "RR09f",
          title: `cold reads with ${HOG} sequential-scan sessions saturating the PRIMARY's disk: split, per-node latency, blks_read; a cache-hot probe`,
          status: "info",
          detail: lines.join(" | "),
          measurements: m,
          evidence: lines.join("\n"),
        });
      }

      /* ---- RR09d (read half): what the project's edge_logs hold for the tagged GETs ---- */
      if (want("logs")) {
        const Q =
          "select log_attributes['request.host'] as host, log_attributes['request.search'] as search, log_attributes['request.method'] as method, " +
          "log_attributes['response.status_code'] as status, log_attributes['load_balancer_redirect_identifier'] as redirect, count(*) as n " +
          "from logs where source = 'edge_logs' and log_attributes['request.path'] = '/rest/v1/rr_marker' " +
          "group by host, search, method, status, redirect order by n desc limit 200";
        let rows: Record<string, unknown>[] = [];
        let qErr = "";
        let prev = -1;
        const tq = Date.now();
        while (Date.now() - tq < 8 * 60_000) {
          const r = await logsQuery(pctx, Q, 3);
          if (r.error) qErr = r.error;
          if (r.rows.length) {
            rows = r.rows as Record<string, unknown>[];
            const total = rows.reduce((a, x) => a + Number(x.n ?? 0), 0);
            if (total === prev && total >= LOG_N * hosts.length) break;
            prev = total;
          }
          await sleep(45_000);
        }
        const target = (v: unknown) => {
          const s = String(v ?? "");
          return !s ? "none" : s === primaryHost ? "primary" : s === replicaHost ? "replica" : redact(s);
        };
        // sent-to label -> logged host label -> redirect target -> rows
        const matrix: Record<string, number> = {};
        for (const x of rows) {
          const k = `sent ${tagOf(String(x.search ?? ""))} -> logged host ${hostLabel(String(x.host ?? ""))}, redirect ${target(x.redirect)}, ${x.method} ${x.status}`;
          matrix[k] = (matrix[k] ?? 0) + Number(x.n ?? 0);
        }
        const m: Record<string, number | string> = { log_rows: rows.reduce((a, x) => a + Number(x.n ?? 0), 0), log_groups: rows.length };
        for (const [label, st] of Object.entries(sentTags)) m[`sent_${label}`] = Object.entries(st).map(([s, n]) => `${s}x${n}`).join(" ");
        for (const [k, v] of Object.entries(matrix)) m[k.replace(/[^a-z0-9]+/gi, "_").slice(0, 90)] = v;
        const QA = `select log_attributes from logs where source = 'edge_logs' and log_attributes['request.path'] = '/rest/v1/rr_marker' limit 4`;
        const qa = await logsQuery(pctx, QA, 3);
        const names = [...new Set((qa.rows as Record<string, unknown>[]).flatMap((x) => Object.keys((x.log_attributes ?? {}) as Record<string, unknown>)))].sort();
        push({
          id: "RR09d",
          title: `edge_logs per hostname: ${LOG_N} GETs of rr_marker tagged rr9-<host> to each host, then the rows the project's logs hold for them`,
          status: "info",
          detail: `sent ${JSON.stringify(sentTags)}; ${m.log_rows} rows in ${rows.length} groups after ${Math.round((Date.now() - tLogs) / 1000)} s${qErr ? `; last endpoint error ${redact(qErr.slice(0, 100))}` : ""}; ${Object.entries(matrix).map(([k, v]) => `${k}: ${v}`).join("; ")}`,
          measurements: m,
          evidence: [...Object.entries(matrix).map(([k, v]) => `${k}: ${v}`), `attribute names (${names.length}): ${names.join(",")}`].join("\n"),
        });
      }

      /* ---- RR09g: remove the only replica, watch the load balancer ---- */
      if (want("remove")) {
        const tR = Date.now();
        const rm = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/remove`, { database_identifier: replicaId });
        replicaRemoved = rm.status < 300;
        const ticks: Record<string, RemovalTick[]> = { lb: [], primary: [], ...(customBase ? { custom: [] } : {}) };
        let poolerGoneS: number | string = "never";
        let dnsGoneS: number | string = "never";
        let stableOk = 0;
        let lastMinute = -1;
        while (Date.now() - tR < REMOVE_WATCH_S * 1000) {
          const t = Math.round((Date.now() - tR) / 1000);
          const [l, p, c] = await Promise.all([anonNode(lbBase, anon), anonNode(primaryBase, anon), customBase ? anonNode(customBase, anon) : Promise.resolve("")]);
          ticks.lb!.push({ t, label: l });
          ticks.primary!.push({ t, label: p });
          if (customBase) ticks.custom!.push({ t, label: c });
          const minute = Math.floor(t / 60);
          if (minute !== lastMinute) {
            lastMinute = minute;
            if (poolerGoneS === "never" && !(await poolerConfig(pctx, ref).catch(() => [])).some((e) => e.database_type === "READ_REPLICA")) poolerGoneS = t;
            if (dnsGoneS === "never" && !(await resolve4(lbHost).catch(() => [] as string[])).length) dnsGoneS = t;
          }
          // After a recovery, stop once the load balancer has served for 5 minutes straight.
          const sumNow = removalSummary(ticks.lb!);
          stableOk = typeof sumNow.recoveredS === "number" && (l === "primary" || l === "replica") ? stableOk + 1 : 0;
          if (stableOk >= 30) break;
          await sleep(10_000);
        }
        const m: Record<string, number | string> = { remove_http: rm.status, watch_s: Math.round((Date.now() - tR) / 1000), pooler_entry_gone_s: poolerGoneS, lb_dns_gone_s: dnsGoneS };
        const lines: string[] = [`remove HTTP ${rm.status}; watched ${m.watch_s} s at 10 s; READ_REPLICA pooler entry gone ${poolerGoneS} s; -all DNS gone ${dnsGoneS} s`];
        for (const [k, ts] of Object.entries(ticks)) {
          const s = removalSummary(ts);
          for (const [f, v] of Object.entries(s)) m[`${k}_${f}`] = v;
          lines.push(`${k}: first error ${s.firstErrorS} s, last error ${s.lastErrorS} s, recovered ${s.recoveredS} s; errors ${s.errors} (${s.errorLabels}); after recovery ${s.afterRecovery}; last ${s.endLabel}`);
        }
        push({
          id: "RR09g",
          title: `read-replicas/remove of the only replica, then the load balancer, project host${customBase ? " and custom host" : ""} every 10 s for up to ${REMOVE_WATCH_S} s`,
          status: "info",
          detail: lines.join(" | "),
          measurements: m,
          evidence: Object.entries(ticks)
            .map(([k, ts]) => `${k}: ${ts.map((x) => `${x.t}:${x.label}`).join(" ").slice(0, 6000)}`)
            .join("\n"),
        });
      }
    } catch (e) {
      push({ id: "RR09x", title: "module aborted", status: "fail", detail: errText(e) });
    } finally {
      /* ---- RR09p ---- */
      if (ref && !keep) {
        const pctx = forRef(ctx, ref);
        let hdel: number | string = "n/a";
        let dns: number | string = "n/a";
        if (domainStarted) {
          hdel = (await mgmt(pctx, "DELETE", `/projects/${ref}/custom-hostname`).catch(() => null))?.status ?? 0;
          dns = await removeRecords(await zoneId(host), [...dnsNames]).catch(() => -1);
        }
        let rm: number | string = "n/a";
        if (replicaId && !replicaRemoved) {
          rm = (await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/remove`, { database_identifier: replicaId }).catch(() => null))?.status ?? 0;
          await sleep(20_000);
        }
        let del = await mgmt(pctx, "DELETE", `/projects/${ref}`).catch(() => null);
        for (let i = 0; i < 6 && (del?.status ?? 0) >= 300; i++) {
          await sleep(30_000);
          del = await mgmt(pctx, "DELETE", `/projects/${ref}`).catch(() => null);
        }
        push({
          id: "RR09p",
          title: "teardown: custom hostname, DNS records, replica, project",
          status: (del?.status ?? 0) < 300 ? "pass" : "fail",
          detail: `custom-hostname DELETE HTTP ${hdel}; DNS records removed ${dns}; replica remove HTTP ${rm}; project DELETE HTTP ${del?.status ?? 0}; run took ${Math.round((Date.now() - t00) / 60000)} min`,
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
