/**
 * RR02 - does the API load balancer stop sending reads to a lagging or an
 * unhealthy read replica, and what happens to Auth, Storage, Realtime,
 * GraphQL and Edge Function requests sent to the load balancer's host.
 *
 * Same shape as RR01 so the routing is visible from this vantage: a Small
 * primary in ap-northeast-1 (Tokyo), `pitr_7`, one Small replica in
 * ap-southeast-1 (Singapore), probed from Singapore, where RR01f saw the load
 * balancer send 40 of 40 GETs to the replica.
 *
 * Every timed read is `GET /rest/v1/rpc/rr_node` (see lib/rerouting.ts): a
 * data-path read that names the node that ran it and the age of the newest
 * heartbeat row it can see, while a writer on the primary inserts a heartbeat
 * row every 250 ms. Three sources are read in parallel: the load balancer
 * host, the replica's own host and the primary's own host. The harness's
 * `rest_read` probe (harness/src/real-probes.ts, `pvlab_probe` row 1 with the
 * anon key) runs on the load balancer host beside them, so an error rate does
 * not depend on this module's own function.
 *
 *   RR02a  create the primary (Small, ap-northeast-1)
 *   RR02b  `pitr_7`, schema, `pg_graphql`, `pvlab_probe` seed, probe function
 *   RR02c  read replica in ap-southeast-1; replica host and load balancer host
 *   RR02d  `max_standby_streaming_delay` raised through the Management API
 *          (so a replay stop can outlast 30 s) and read back on both nodes
 *   RR02e  baseline: which node the load balancer picks, how stale
 *   RR02f1..f6  REST, GraphQL, Auth, Storage, Realtime, Edge Functions sent to
 *          the primary host, the replica host and the load balancer host
 *   RR02g  lag by write burst: a bulk insert on the primary, reads through the
 *          load balancer during and after. The default 1,500,000 rows filled
 *          a Small project's disk on 2026-10-23 without lagging the replica
 *          past STALE_MS; RR02h is the method that produced lag.
 *   RR02h  lag by a stopped replay: a replica query in a repeatable-read
 *          transaction against a primary UPDATE+VACUUM, which stops replay for
 *          as long as the query holds (up to max_standby_streaming_delay);
 *          reads through the load balancer during the stop
 *   RR02i  `POST /projects/{ref}/restart` while reading: error windows per
 *          source, which nodes restarted (postmaster start time)
 *   RR02j  `read-replicas/remove` while reading: errors, time until the load
 *          balancer serves from the primary
 *   RR02k  edge_logs: the load balancer's redirect identifier per path and
 *          per method, for the RR02f requests and the timed reads
 *   RR02p  teardown
 *
 * DESTRUCTIVE and BILLABLE: Small primary + Small replica + `pitr_7`, 24 and
 * 33 minutes in the 2026-10-23 runs. Env as RR01 (PVLAB_RR_KEEP=1 skips teardown), plus
 * PVLAB_RR_REFS_FILE=<path> appends the created ref to a file outside git.
 */
import { appendFileSync } from "node:fs";
import { Client } from "pg";
import { fetchKeys, logsQuery, sql } from "../../../harness/src/platform";
import { mgmt } from "../../../harness/src/mgmt";
import { graphqlState } from "../../../harness/src/graphql";
import { realtimeJoinProbe, restReadProbe, seedProbeTable } from "../../../harness/src/real-probes";
import { sampleDuring, type PathWindow, type Probe } from "../../../harness/src/sampler";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PREFIX,
  applyAddon,
  connectSession,
  deployProbeFn,
  errText,
  findLoadBalancer,
  forRef,
  poolerConfig,
  resolves,
  round,
  selectedAddons,
  sleep,
  waitProjectHealthy,
  PROBE_FN_SLUG,
  type PoolerEntry,
} from "../lib/rr";
import { buckets, errorModes, label, lagWindow, parseNode, servedDuring, transitions, type Tick } from "../lib/rerouting";

const PRIMARY_REGION = "ap-northeast-1";
const REPLICA_REGION = "ap-southeast-1";
const READ_EVERY_MS = 250;
const HEARTBEAT_MS = 250;
/** A direct replica read older than this counts as lagging. Chosen, not measured: heartbeat period x 8. */
const STALE_MS = 2000;
const STANDBY_DELAY = process.env.PVLAB_RR_STANDBY_DELAY ?? "600s";
const STALL_S = Number(process.env.PVLAB_RR_STALL_S ?? 180);
const BURST_ROWS = Number(process.env.PVLAB_RR_BURST_ROWS ?? 1_500_000);
/** How long RR02j keeps reading after the remove call. */
const REMOVE_WATCH_S = Number(process.env.PVLAB_RR_REMOVE_WATCH_S ?? 360);
const phases = new Set((process.env.PVLAB_RR_PHASES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const want = (p: string) => phases.size === 0 || phases.has(p);

const SCHEMA = `
create table if not exists public.rr_marker (
  id bigserial primary key,
  tag text not null,
  written_at timestamptz not null default clock_timestamp()
);
insert into public.rr_marker(tag) values ('seed');
create table if not exists public.rr_conflict (id int primary key, v int not null, pad text not null);
insert into public.rr_conflict select g, 0, repeat('x', 200) from generate_series(1, 50000) g on conflict do nothing;
grant select on public.rr_marker, public.rr_conflict to anon, authenticated;
grant all on public.rr_marker, public.rr_conflict to service_role;
grant usage, select on sequence public.rr_marker_id_seq to service_role;
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
grant execute on function public.rr_whoami(), public.rr_node() to anon, authenticated, service_role;
notify pgrst, 'reload schema';
`;

/* ---------- small helpers ---------- */

interface Call {
  status: number;
  text: string;
  ms: number;
  headers: Headers | null;
  err?: string;
}
async function call(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Call> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
    const text = await res.text();
    return { status: res.status, text, ms: performance.now() - t0, headers: res.headers };
  } catch (e) {
    return { status: 0, text: "", ms: performance.now() - t0, headers: null, err: errText(e).slice(0, 80) };
  }
}
const short = (c: Call) => (c.status ? String(c.status) : `ERR ${c.err ?? ""}`.trim());

/** A pooler client with a query timeout, for loops that must survive a restart. */
function pgClient(e: PoolerEntry, password: string, queryTimeoutMs?: number): Client {
  // pg falls back to the client's query_timeout when a query passes 0, so a
  // client that runs long statements is created without one.
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

/** Inserts a heartbeat row on the primary every HEARTBEAT_MS until stopped; reconnects on error. */
function startHeartbeat(e: PoolerEntry, password: string) {
  let stop = false;
  let rows = 0;
  let errors = 0;
  let lastErr = "";
  const loop = (async () => {
    let c: Client | undefined;
    while (!stop) {
      try {
        if (!c) {
          c = pgClient(e, password, 10_000);
          await c.connect();
        }
        await c.query("insert into public.rr_marker(tag) values ('hb')");
        rows++;
      } catch (err) {
        errors++;
        lastErr = errText(err).slice(0, 80);
        await c?.end().catch(() => {});
        c = undefined;
        await sleep(1000);
      }
      await sleep(HEARTBEAT_MS);
    }
    await c?.end().catch(() => {});
  })();
  return {
    async stop() {
      stop = true;
      await loop;
      return { rows, errors, lastErr };
    },
  };
}

/** A sampler probe that reads rr_node from `base` and records every read as a tick. */
function nodeProbe(name: string, base: string, anon: string, t0: () => number, ticks: Tick[]): Probe {
  return {
    name,
    async run() {
      const c = await call(`${base}/rest/v1/rpc/rr_node`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` }, timeoutMs: 5000 });
      const p = c.status ? parseNode(c.status, c.text) : { err: c.err?.includes("timed out") || c.err?.includes("TimeoutError") ? "timeout" : (c.err ?? "fetch failed") };
      const tick: Tick = { t: Date.now() - t0(), src: name, status: c.status, ...p };
      ticks.push(tick);
      return tick.node ? { ok: true } : { ok: false, error: label(tick) };
    },
  };
}

const windowMeas = (w: PathWindow | undefined, pfx: string): Record<string, number | string> =>
  w
    ? {
        [`${pfx}_samples`]: w.samples,
        [`${pfx}_failures`]: w.failures,
        [`${pfx}_first_fail_s`]: w.firstFailMs === null ? "never" : round(w.firstFailMs / 1000, 1),
        [`${pfx}_recovered_s`]: w.recoveredMs === null ? (w.firstFailMs === null ? "n/a" : "not recovered") : round(w.recoveredMs / 1000, 1),
        [`${pfx}_window_s`]: w.windowMs === null ? "n/a" : round(w.windowMs / 1000, 1),
      }
    : {};

const pmOf = (ticks: Tick[], src: string, node: "primary" | "replica", which: "first" | "last") => {
  const ks = ticks.filter((k) => k.src === src && k.node === node && k.pm !== undefined);
  return (which === "first" ? ks[0]?.pm : ks[ks.length - 1]?.pm) ?? 0;
};

const mod: TestModule = {
  id: "RR02",
  title: "Read replica re-routing: lagging and unhealthy replica, and non-REST traffic through the load balancer",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const push = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id} ${r.status}${r.detail ? `: ${r.detail.slice(0, 220)}` : ""}`);
    };
    const org = ctx.orgs.pro;
    if (!org) return [{ id: "RR02", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const keep = process.env.PVLAB_RR_KEEP === "1";
    const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
    let ref = "";
    let replicaId = "";
    let replicaRemoved = false;
    const t00 = Date.now();

    try {
      /* ---- RR02a ---- */
      const name = `${PREFIX}${Date.now()}`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name,
        db_pass: dbPass,
        region_selection: { type: "specific", code: PRIMARY_REGION },
        desired_instance_size: "small",
      });
      ref = String((create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "");
      if (ref && process.env.PVLAB_RR_REFS_FILE) appendFileSync(process.env.PVLAB_RR_REFS_FILE, `${ref} ${name} ${new Date().toISOString()} RR02\n`);
      if (create.status !== 201 || !ref) {
        push({ id: "RR02a", title: "create primary (Small, ap-northeast-1)", status: "fail", detail: `HTTP ${create.status}: ${create.text.slice(0, 300)}` });
        return out;
      }
      ctx.log(`primary created (${name}); waiting healthy`);
      const h = await waitProjectHealthy(ctx, ref);
      push({
        id: "RR02a",
        title: "create primary (Small, ap-northeast-1)",
        status: h.status === "ACTIVE_HEALTHY" ? "pass" : "fail",
        detail: `create HTTP ${create.status}; ${h.status} after ${h.waitedS}s`,
        measurements: { create_http: create.status, healthy_after_s: h.waitedS, size_requested: "small", region: PRIMARY_REGION },
      });
      if (h.status !== "ACTIVE_HEALTHY") return out;
      const pctx = forRef(ctx, ref);
      const primaryHost = `${ref}.supabase.co`;
      const primaryBase = `https://${primaryHost}`;

      /* ---- RR02b ---- */
      const have = await selectedAddons(pctx, ref);
      const pitr = have.includes("pitr_7") ? { status: 0, text: "already" } : await applyAddon(pctx, ref, "pitr", "pitr_7");
      const ddl = await sql(pctx, SCHEMA);
      const gql = await sql(pctx, "create extension if not exists pg_graphql; notify pgrst, 'reload schema';");
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
      if (!keys) {
        push({ id: "RR02b", title: "api keys", status: "fail", detail: keysErr });
        return out;
      }
      const anon = keys.anon;
      const svc = keys.service;
      let seedS: number | string = "failed";
      try {
        seedS = await seedProbeTable(pctx, primaryHost, anon);
      } catch (e) {
        seedS = `failed: ${errText(e)}`;
      }
      const dep = await deployProbeFn(pctx, ref);
      push({
        id: "RR02b",
        title: "pitr_7, schema (rr_marker, rr_node), pg_graphql, pvlab_probe seed, probe Edge Function",
        status: pitr.status < 300 && ddl.status < 300 && typeof seedS === "number" ? "pass" : "fail",
        detail: `pitr_7 ${pitr.status || "already"}; schema HTTP ${ddl.status}${ddl.error ? ` ${ddl.error}` : ""}; pg_graphql HTTP ${gql.status}${gql.error ? ` ${gql.error}` : ""}; pvlab_probe serving after ${seedS}; function deploy HTTP ${dep.status}`,
        measurements: { pitr_http: pitr.status || "already", schema_http: ddl.status, pg_graphql_http: gql.status, probe_seed_s: seedS, fn_deploy_http: dep.status },
      });
      if (ddl.status >= 300) return out;

      /* ---- RR02c: replica ---- */
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
        push({ id: "RR02c", title: "read replica", status: "fail", detail: `setup ${attempts[attempts.length - 1]}; served ${servedS}; ${lastErr}`, evidence: attempts.join("\n") });
        return out;
      }
      replicaId = replica.identifier;
      const primaryEntry = (await poolerConfig(pctx, ref)).find((e) => e.database_type === "PRIMARY")!;
      const replicaHost = `${replicaId}.supabase.co`;
      const replicaBase = `https://${replicaHost}`;
      let replicaUp = await call(`${replicaBase}/rest/v1/rpc/rr_node`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
      for (let i = 0; i < 18 && parseNode(replicaUp.status, replicaUp.text).node !== "replica"; i++) {
        await sleep(10_000);
        replicaUp = await call(`${replicaBase}/rest/v1/rpc/rr_node`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
      }
      const lb = await findLoadBalancer(pctx, ref, anon);
      push({
        id: "RR02c",
        title: `read-replicas/setup ${REPLICA_REGION}; replica host; load balancer host`,
        status: lb.url ? "pass" : "fail",
        detail: `setup ${attempts[attempts.length - 1]}; first session connection after ${servedS}s; replica host rr_node HTTP ${replicaUp.status}; load balancer ${lb.url ? lb.url.replace(ref, "<ref>").replace(/^https:\/\//, "") : "NOT found"} (candidates ${lb.tried.join(",")})`,
        measurements: { setup_http: setup.status, setup_attempts: attempts.length, served_after_s: servedS, replica_rest_http: replicaUp.status },
        evidence: attempts.join("\n"),
      });
      if (!lb.url) return out;

      /* ---- RR02d: max_standby_streaming_delay ---- */
      const before = await mgmt(pctx, "GET", `/projects/${ref}/config/database/postgres`);
      const put = await mgmt(pctx, "PUT", `/projects/${ref}/config/database/postgres`, { max_standby_streaming_delay: STANDBY_DELAY });
      await sleep(20_000);
      const hc = await waitProjectHealthy(ctx, ref, 10 * 60_000);
      const after = await mgmt(pctx, "GET", `/projects/${ref}/config/database/postgres`);
      const cfgVal = (r: typeof before) => String((r.json as Record<string, unknown> | undefined)?.max_standby_streaming_delay ?? "(unset)");
      // The config change may restart the nodes: wait until the replica host serves rr_node again.
      let replicaBack = "never";
      const tb = Date.now();
      while (Date.now() - tb < 5 * 60_000) {
        const c = await call(`${replicaBase}/rest/v1/rpc/rr_node`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
        if (parseNode(c.status, c.text).node === "replica") {
          replicaBack = `${Math.round((Date.now() - tb) / 1000)}s after the health wait`;
          break;
        }
        await sleep(5000);
      }
      // Standby settings as the replica itself reports them.
      const settings: Record<string, string> = { replica_rest_back: replicaBack };
      for (const [lbl, e] of [["primary", primaryEntry], ["replica", replica]] as const) {
        try {
          const c = await connectSession(e, dbPass, 6, 10_000);
          const r = await c.query<{ name: string; setting: string; unit: string | null; source: string }>(
            "select name, setting, unit, source from pg_settings where name in ('max_standby_streaming_delay','hot_standby_feedback','statement_timeout')",
          );
          for (const x of r.rows) settings[`${lbl}_${x.name}`] = `${x.setting}${x.unit ?? ""} (${x.source})`;
          await c.end();
        } catch (e) {
          settings[`${lbl}_error`] = errText(e).slice(0, 120);
        }
      }
      push({
        id: "RR02d",
        title: `PUT config/database/postgres max_standby_streaming_delay=${STANDBY_DELAY}, read back on both nodes`,
        status: put.status < 300 ? "info" : "fail",
        detail: `config before ${cfgVal(before)}; PUT HTTP ${put.status} ${put.status < 300 ? "" : put.text.slice(0, 160)}; config after ${cfgVal(after)}; project ${hc.status}; replica pg_settings max_standby_streaming_delay ${settings.replica_max_standby_streaming_delay ?? "?"}`,
        measurements: { put_http: put.status, config_before: cfgVal(before), config_after: cfgVal(after), ...settings },
      });

      const lbBase = lb.url;
      const lbHost = new URL(lbBase).hostname;
      const hosts = { primary: primaryBase, replica: replicaBase, lb: lbBase } as const;

      /* ---- RR02e: baseline ---- */
      const hb0 = startHeartbeat(primaryEntry, dbPass);
      await sleep(3000);
      {
        const ticks: Tick[] = [];
        const t0 = Date.now();
        const probes = (["lb", "replica", "primary"] as const).map((s) => nodeProbe(s, hosts[s], anon, () => t0, ticks));
        for (let i = 0; i < 30; i++) {
          for (const p of probes) await p.run();
          await sleep(READ_EVERY_MS);
        }
        const lbS = servedDuring(ticks, "lb", 0, Infinity);
        const repS = servedDuring(ticks, "replica", 0, Infinity);
        const priStale = ticks.filter((k) => k.src === "primary" && k.staleMs !== undefined).map((k) => k.staleMs!);
        push({
          id: "RR02e",
          title: "baseline: rr_node through the load balancer, the replica host and the primary host (30 rounds, heartbeat every 250 ms)",
          status: "info",
          detail: `lb served replica ${lbS.replica}, primary ${lbS.primary}, errors ${lbS.errors}; max stale ms: lb-replica ${lbS.maxStaleReplicaMs}, replica host ${repS.maxStaleReplicaMs}, primary host ${Math.max(...priStale)}`,
          measurements: {
            n_per_source: 30,
            lb_replica: lbS.replica,
            lb_primary: lbS.primary,
            lb_errors: lbS.errors,
            lb_max_stale_ms: lbS.maxStaleReplicaMs,
            replica_max_stale_ms: repS.maxStaleReplicaMs,
            primary_max_stale_ms: Math.max(...priStale),
          },
        });
      }
      const hb0r = await hb0.stop();
      ctx.log(`baseline heartbeat rows ${hb0r.rows} errors ${hb0r.errors}`);

      /* ---- RR02f: non-REST traffic on each host ---- */
      if (want("services")) {
        const tag = Date.now();
        type Row = Record<string, string>;
        const rows: Record<string, Row> = { rest: {}, graphql: {}, auth: {}, storage: {}, realtime: {}, functions: {} };
        const nodeIn = (c: Call) => {
          const n = parseNode(c.status, c.text);
          return n.node ? `${c.status} ${n.node}` : short(c);
        };
        for (const [h, base] of Object.entries(hosts)) {
          const A = { apikey: anon, Authorization: `Bearer ${anon}` };
          const S = { apikey: svc, Authorization: `Bearer ${svc}` };
          // REST reference: GET and POST of the same function.
          rows.rest![`${h}_get_rr_node`] = nodeIn(await call(`${base}/rest/v1/rpc/rr_node`, { headers: A }));
          rows.rest![`${h}_post_rr_node`] = nodeIn(await call(`${base}/rest/v1/rpc/rr_node`, { method: "POST", headers: { ...A, "Content-Type": "application/json" }, body: "{}" }));
          // GraphQL
          const gT = await call(`${base}/graphql/v1`, { method: "POST", headers: { ...A, "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ __typename }" }) });
          rows.graphql![`${h}_post_typename`] = graphqlState(gT.status, gT.text);
          const gN = await call(`${base}/graphql/v1`, { method: "POST", headers: { ...A, "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ rr_node }" }) });
          rows.graphql![`${h}_post_rr_node`] = gqlNode(gN);
          const gG = await call(`${base}/graphql/v1?query=${encodeURIComponent("{ rr_node }")}`, { headers: A });
          rows.graphql![`${h}_get_rr_node`] = gqlNode(gG);
          // Auth
          rows.auth![`${h}_get_health`] = short(await call(`${base}/auth/v1/health`, { headers: { apikey: anon } }));
          rows.auth![`${h}_get_settings`] = short(await call(`${base}/auth/v1/settings`, { headers: { apikey: anon } }));
          const email = `rr02-${h}-${tag}` + "@" + "example.com";
          const password = `${crypto.randomUUID()}Aa1!`;
          const mk = await call(`${base}/auth/v1/admin/users`, { method: "POST", headers: { ...S, "Content-Type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
          rows.auth![`${h}_post_admin_users`] = short(mk);
          const tok = await call(`${base}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
          rows.auth![`${h}_post_token_password`] = short(tok);
          let access = "";
          try {
            access = String((JSON.parse(tok.text) as { access_token?: string }).access_token ?? "");
          } catch {}
          const me = access ? await call(`${base}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${access}` } }) : undefined;
          rows.auth![`${h}_get_user`] = me ? short(me) : "no token";
          // Storage
          const bucket = `rr02-${h}`;
          rows.storage![`${h}_get_bucket_list`] = short(await call(`${base}/storage/v1/bucket`, { headers: S }));
          rows.storage![`${h}_post_bucket`] = short(await call(`${base}/storage/v1/bucket`, { method: "POST", headers: { ...S, "Content-Type": "application/json" }, body: JSON.stringify({ name: bucket, public: false }) }));
          rows.storage![`${h}_post_object`] = short(await call(`${base}/storage/v1/object/${bucket}/probe.txt`, { method: "POST", headers: { ...S, "Content-Type": "text/plain" }, body: `rr02 ${h}` }));
          const dl = await call(`${base}/storage/v1/object/authenticated/${bucket}/probe.txt`, { headers: S });
          rows.storage![`${h}_get_object`] = `${short(dl)}${dl.status === 200 ? (dl.text === `rr02 ${h}` ? " body-ok" : " body-differs") : ""}`;
          // Realtime: join + Postgres Changes subscription + broadcast self-echo (harness probe), 3 tries.
          const rt: string[] = [];
          for (let i = 0; i < 3; i++) {
            const o = await realtimeJoinProbe(new URL(base).hostname, anon).run();
            rt.push(o.ok ? "ok" : (o.error ?? "fail"));
          }
          rows.realtime![`${h}_join_x3`] = rt.join(", ");
          // Edge Functions
          const fn = await call(`${base}/functions/v1/${PROBE_FN_SLUG}`, { method: "POST", headers: { ...A, "Content-Type": "application/json" }, body: JSON.stringify({ targets: [], n: 0, anon: "" }) });
          rows.functions![`${h}_post_invoke`] = `${short(fn)}${fn.headers?.get("x-sb-edge-region") ? ` region ${fn.headers.get("x-sb-edge-region")}` : ""}`;
        }
        const titles: Record<string, string> = {
          rest: "REST reference: GET and POST rpc/rr_node on each host",
          graphql: "GraphQL (/graphql/v1): POST { __typename }, POST and GET { rr_node } on each host",
          auth: "Auth: health, settings, admin create user, password grant, GET /user on each host",
          storage: "Storage: list buckets, create bucket, upload, authenticated download on each host",
          realtime: "Realtime: join with Postgres Changes and broadcast self-echo (harness probe), 3 tries per host",
          functions: "Edge Functions: POST /functions/v1/<probe> on each host",
        };
        for (const [i, k] of ["rest", "graphql", "auth", "storage", "realtime", "functions"].entries()) {
          const r = rows[k]!;
          push({
            id: `RR02f${i + 1}`,
            title: titles[k]!,
            status: "info",
            detail: Object.entries(r)
              .filter(([key]) => key.startsWith("lb_"))
              .map(([key, v]) => `${key} ${v}`)
              .join("; "),
            measurements: r,
          });
        }
      }

      /* ---- timed phases share this runner ---- */
      const timed = async (opts: { maxWaitMs: number; settleMs: number }, op: (t0: () => number, mark: (s: string) => void) => Promise<void>) => {
        const ticks: Tick[] = [];
        const marks: string[] = [];
        let t0 = Date.now();
        const now = () => Date.now() - t0;
        const probes = [
          nodeProbe("lb", lbBase, anon, () => t0, ticks),
          nodeProbe("replica", replicaBase, anon, () => t0, ticks),
          nodeProbe("primary", primaryBase, anon, () => t0, ticks),
          restReadProbe(lbHost, anon, "lb_rest_read"),
        ];
        const hb = startHeartbeat(primaryEntry, dbPass);
        await sleep(2000);
        t0 = Date.now();
        const windows = await sampleDuring(probes, { intervalMs: READ_EVERY_MS, maxWaitMs: opts.maxWaitMs, settleMs: opts.settleMs, sampleDeadlineMs: 10_000 }, () =>
          op(now, (s) => marks.push(`+${round(now() / 1000, 1)}s ${s}`)),
        );
        const hbr = await hb.stop();
        return { ticks, marks, windows, hb: hbr };
      };

      /* ---- RR02g: lag by write burst ---- */
      if (want("burst")) {
        let opStart = 0;
        let burstS: number | string = "?";
        let walBytes = "?";
        let burstErr = "";
        const lagSamples: string[] = [];
        const r = await timed({ maxWaitMs: 300_000, settleMs: 20_000 }, async (now, mark) => {
          await sleep(15_000);
          const pc = pgClient(primaryEntry, dbPass);
          const mc = pgClient(replica!, dbPass, 10_000);
          const mon = { stop: false };
          try {
            await pc.connect();
            await mc.connect();
            await pc.query("set statement_timeout = 0");
            await pc.query("create table if not exists public.rr_bulk (id bigint, pad text)");
            const lsn0 = (await pc.query<{ l: string }>("select pg_current_wal_lsn()::text as l")).rows[0]!.l;
            const monitor = (async () => {
              const pm = pgClient(primaryEntry, dbPass, 10_000);
              await pm.connect().catch(() => {});
              while (!mon.stop) {
                const rl = await mc.query<{ l: string }>("select pg_last_wal_replay_lsn()::text as l").catch(() => undefined);
                const d = await pm.query<{ d: string }>("select pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::text as d", [rl?.rows[0]?.l ?? "0/0"]).catch(() => undefined);
                lagSamples.push(`${Math.round(now() / 1000)}s:${d?.rows[0]?.d ?? "?"}B`);
                await sleep(5000);
              }
              await pm.end().catch(() => {});
            })();
            opStart = now();
            mark(`bulk insert of ${BURST_ROWS} rows starts`);
            await pc.query(`insert into public.rr_bulk select g, repeat(md5(g::text), 16) from generate_series(1, ${BURST_ROWS}) g`);
            burstS = round((now() - opStart) / 1000, 1);
            mark(`bulk insert committed after ${burstS}s`);
            walBytes = (await pc.query<{ d: string }>("select pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::text as d", [lsn0])).rows[0]!.d;
            await sleep(90_000);
            mon.stop = true;
            await monitor;
            await pc.query("drop table public.rr_bulk");
          } catch (e) {
            burstErr = errText(e);
            mark(`burst error ${burstErr}`);
          } finally {
            mon.stop = true;
            await pc.end().catch(() => {});
            await mc.end().catch(() => {});
          }
        });
        push(lagResult("RR02g", `lag by write burst: ${BURST_ROWS}-row bulk insert (about 530 bytes a row) on the primary while reading`, r, { burst_s: burstS, burst_wal_bytes: walBytes, burst_error: burstErr || "none", op_start_s: round(opStart / 1000, 1) }, lagSamples));
      }

      /* ---- RR02h: lag by a stopped replay ---- */
      if (want("stall")) {
        let conflictAt = 0;
        let cancelled = "";
        let releasedAt = 0;
        const r = await timed({ maxWaitMs: (STALL_S + 120) * 1000, settleMs: 20_000 }, async (now, mark) => {
          await sleep(15_000);
          const pc = pgClient(primaryEntry, dbPass);
          const rc = pgClient(replica!, dbPass);
          try {
            await pc.connect();
            await rc.connect();
            await rc.query("set statement_timeout = 0");
            await rc.query("begin isolation level repeatable read");
            await rc.query("select count(*) from public.rr_conflict");
            const longQ = rc
              .query(`select pg_sleep(${STALL_S})`)
              .then(() => {
                releasedAt = now();
                mark("replica query finished on its own");
              })
              .catch((e: unknown) => {
                releasedAt = now();
                cancelled = `${String((e as { code?: string }).code ?? "")} ${errText(e)}`.slice(0, 160);
                mark(`replica query cancelled: ${cancelled}`);
              });
            await sleep(3000);
            conflictAt = now();
            mark("primary update+vacuum starts");
            await pc.query("update public.rr_conflict set v = v + 1");
            await pc.query("vacuum public.rr_conflict");
            mark("primary update+vacuum done");
            await longQ;
            await rc.query("rollback").catch(() => {});
            mark("replica transaction closed");
            await sleep(90_000);
          } catch (e) {
            mark(`stall error ${errText(e)}`);
          } finally {
            await pc.end().catch(() => {});
            await rc.end().catch(() => {});
          }
        });
        push(
          lagResult("RR02h", `lag by stopped replay: replica repeatable-read query (pg_sleep ${STALL_S}) against primary UPDATE+VACUUM, max_standby_streaming_delay ${STANDBY_DELAY} requested`, r, {
            conflict_at_s: round(conflictAt / 1000, 1),
            replica_query_released_s: round(releasedAt / 1000, 1),
            replica_query_cancelled: cancelled || "no",
          }),
        );
      }

      /* ---- RR02i: project restart ---- */
      if (want("restart")) {
        let restartHttp = 0;
        let healthyS: number | string = "?";
        const r = await timed({ maxWaitMs: 8 * 60_000, settleMs: 30_000 }, async (now, mark) => {
          await sleep(15_000);
          mark("POST /restart");
          const rs = await mgmt(pctx, "POST", `/projects/${ref}/restart`);
          restartHttp = rs.status;
          mark(`restart HTTP ${rs.status} ${rs.status < 300 ? "" : rs.text.slice(0, 120)}`);
          const hh = await waitProjectHealthy(ctx, ref, 7 * 60_000);
          healthyS = round(now() / 1000, 0);
          mark(`project ${hh.status}`);
        });
        push(eventResult("RR02i", "POST /projects/{ref}/restart while reading through the load balancer", r, { restart_http: restartHttp, healthy_at_s: healthyS }));
      }

      /* ---- RR02j: replica removed ---- */
      if (want("remove")) {
        let rmHttp = 0;
        let goneAt: number | string = "?";
        const r = await timed({ maxWaitMs: REMOVE_WATCH_S * 1000, settleMs: 30_000 }, async (now, mark) => {
          await sleep(15_000);
          mark("POST read-replicas/remove");
          const rm = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/remove`, { database_identifier: replicaId });
          rmHttp = rm.status;
          mark(`remove HTTP ${rm.status} ${rm.status < 300 ? "" : rm.text.slice(0, 120)}`);
          const t = Date.now();
          while (Date.now() - t < 5 * 60_000) {
            const cfg = await poolerConfig(pctx, ref).catch(() => null);
            if (cfg && !cfg.some((e) => e.database_type === "READ_REPLICA")) {
              goneAt = round(now() / 1000, 1);
              mark("READ_REPLICA gone from pooler config");
              break;
            }
            await sleep(5000);
          }
          // Does the load balancer's name still resolve? Checked once a minute while the readers run.
          while (now() < (REMOVE_WATCH_S - 30) * 1000) {
            await sleep(60_000);
            mark(`lb host ${(await resolves(lbHost)).length ? "resolves" : "does not resolve"}`);
          }
        });
        replicaRemoved = rmHttp > 0 && rmHttp < 300;
        push(eventResult("RR02j", "read-replicas/remove while reading through the load balancer", r, { remove_http: rmHttp, pooler_entry_gone_s: goneAt }));
      }

      /* ---- RR02k: edge_logs ---- */
      if (want("logs")) {
        const Q =
          "select log_attributes['request.method'] as method, log_attributes['request.path'] as path, " +
          "log_attributes['response.status_code'] as status, " +
          "log_attributes['load_balancer_redirect_identifier'] as redirect, count(*) as n " +
          `from logs where source = 'edge_logs' and log_attributes['request.host'] = '${lbHost}' ` +
          "group by method, path, status, redirect order by n desc limit 200";
        let rows: Record<string, unknown>[] = [];
        let lastErr2 = "";
        const t0 = Date.now();
        while (Date.now() - t0 < 6 * 60_000) {
          await sleep(45_000);
          const q = await logsQuery(pctx, Q, 2);
          if (q.error) lastErr2 = q.error;
          if (q.rows.length) {
            rows = q.rows as Record<string, unknown>[];
            if (!want("services") || (rows.some((x) => String(x.path ?? "").startsWith("/auth/")) && rows.some((x) => String(x.path ?? "").startsWith("/storage/")))) break;
          }
        }
        const shape = (v: unknown) => String(v ?? "").replace(/[a-z]{20}/g, "<ref>");
        const target = (v: unknown) => {
          const s = shape(v);
          return !s ? "none" : s === "<ref>.supabase.co" ? "primary" : s.includes("-rr-") ? "replica" : s;
        };
        const family = (p: string) => (p.startsWith("/rest/v1/rpc/rr_node") ? "rest rr_node" : p.startsWith("/rest/") ? "rest other" : (p.split("/")[1] ?? "?"));
        const agg: Record<string, number> = {};
        for (const x of rows) {
          const key = `${family(String(x.path ?? ""))} ${x.method} ${x.status} -> ${target(x.redirect)}`;
          agg[key] = (agg[key] ?? 0) + Number(x.n ?? 0);
        }
        const lines = Object.entries(agg).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} n=${n}`);
        const m: Record<string, number | string> = { groups: rows.length, rows: rows.reduce((a, x) => a + Number(x.n ?? 0), 0) };
        for (const fam of ["auth", "storage", "realtime", "graphql", "functions", "rest rr_node"]) {
          const ks = Object.entries(agg).filter(([k]) => k.startsWith(`${fam} `));
          for (const t of ["primary", "replica", "none"]) {
            const n = ks.filter(([k]) => k.endsWith(`-> ${t}`)).reduce((a, [, v]) => a + v, 0);
            if (n) m[`${fam.replace(" ", "_")}_to_${t}`] = n;
          }
        }
        push({
          id: "RR02k",
          title: "edge_logs on the load balancer host: redirect identifier per path family, method and status",
          status: "info",
          detail: `${m.rows} rows in ${rows.length} groups after ${Math.round((Date.now() - t0) / 1000)} s${lastErr2 ? `; last endpoint error ${lastErr2.slice(0, 80)}` : ""}`,
          measurements: m,
          evidence: lines.join("\n"),
        });
      }
    } catch (e) {
      push({ id: "RR02x", title: "module aborted", status: "fail", detail: errText(e) });
    } finally {
      /* ---- RR02p ---- */
      if (ref && !keep) {
        const pctx = forRef(ctx, ref);
        let rm = 0;
        if (replicaId && !replicaRemoved) {
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
          id: "RR02p",
          title: "teardown: replica removed, project deleted",
          status: (del?.status ?? 0) < 300 ? "pass" : "fail",
          detail: `replica remove at teardown HTTP ${rm || "n/a (removed in RR02j)"}; project DELETE HTTP ${del?.status ?? 0}; run took ${Math.round((Date.now() - t00) / 60000)} min`,
          measurements: { project_delete_http: del?.status ?? 0, run_min: Math.round((Date.now() - t00) / 60000) },
        });
      } else if (ref) {
        ctx.log("project LEFT RUNNING (PVLAB_RR_KEEP=1) - delete it by hand");
      }
    }
    return out;
  },
};
export default mod;

function gqlNode(c: Call): string {
  if (!c.status) return short(c);
  try {
    const j = JSON.parse(c.text) as { data?: { rr_node?: unknown } | null; errors?: { message?: string }[]; code?: string; message?: string };
    let v = j.data?.rr_node;
    if (typeof v === "string") v = JSON.parse(v);
    if (v && typeof (v as { in_recovery?: unknown }).in_recovery === "boolean") return `${c.status} ${(v as { in_recovery: boolean }).in_recovery ? "replica" : "primary"}`;
    const msg = j.errors?.[0]?.message ?? j.code ?? j.message ?? "";
    return `${c.status} ${String(msg).slice(0, 70)}`.trim();
  } catch {
    return `${c.status} ${c.text.slice(0, 40)}`;
  }
}

interface Timed {
  ticks: Tick[];
  marks: string[];
  windows: PathWindow[];
  hb: { rows: number; errors: number; lastErr: string };
}

/** A lag phase: how long the replica host lagged, and what the load balancer served meanwhile. */
function lagResult(id: string, title: string, r: Timed, extra: Record<string, number | string>, lagSamples: string[] = []): TestResult {
  const w = lagWindow(r.ticks, "replica", STALE_MS);
  const lbIn = w ? servedDuring(r.ticks, "lb", w.startT, w.endT, STALE_MS) : undefined;
  const lbAll = servedDuring(r.ticks, "lb", 0, Infinity, STALE_MS);
  const rest = r.windows.find((x) => x.name === "lb_rest_read");
  const measurements: Record<string, number | string> = {
    ...extra,
    stale_threshold_ms: STALE_MS,
    replica_lag_window_s: w ? round((w.endT - w.startT) / 1000, 1) : "none",
    replica_lag_start_s: w ? round(w.startT / 1000, 1) : "none",
    replica_max_stale_ms: w ? w.maxStaleMs : servedDuring(r.ticks, "replica", 0, Infinity).maxStaleReplicaMs,
    lb_reads_total: lbAll.n,
    lb_reads_in_window: lbIn?.n ?? 0,
    lb_replica_in_window: lbIn?.replica ?? 0,
    lb_primary_in_window: lbIn?.primary ?? 0,
    lb_errors_in_window: lbIn?.errors ?? 0,
    lb_replica_stale_in_window: lbIn?.replicaStale ?? 0,
    lb_max_stale_served_ms: lbAll.maxStaleReplicaMs,
    lb_first_primary_in_window_s: lbIn?.firstPrimaryT != null && w ? round((lbIn.firstPrimaryT - w.startT) / 1000, 1) : "never",
    lb_primary_total: lbAll.primary,
    lb_errors_total: lbAll.errors,
    lb_rest_read_failures: rest?.failures ?? "?",
    lb_rest_read_samples: rest?.samples ?? "?",
    heartbeat_rows: r.hb.rows,
    heartbeat_errors: r.hb.errors,
  };
  return {
    id,
    title,
    status: "info",
    detail: w
      ? `replica host stale > ${STALE_MS} ms for ${measurements.replica_lag_window_s} s (max ${w.maxStaleMs} ms); load balancer in that window: replica ${lbIn!.replica} (stale ${lbIn!.replicaStale}), primary ${lbIn!.primary}, errors ${lbIn!.errors}; max stale served by the load balancer ${lbAll.maxStaleReplicaMs} ms`
      : `replica host never stale beyond ${STALE_MS} ms (max ${measurements.replica_max_stale_ms} ms); load balancer replica ${lbAll.replica}, primary ${lbAll.primary}, errors ${lbAll.errors}`,
    measurements,
    evidence: [
      `marks: ${r.marks.join(" | ")}`,
      `lb transitions: ${transitions(r.ticks, "lb").map((x) => `+${round(x.t / 1000, 1)}s ${x.from}->${x.to}`).join(", ")}`,
      lagSamples.length ? `replay lag bytes (primary current LSN minus replica replay LSN) by seconds: ${lagSamples.join(" ")}` : "",
      `heartbeat last error: ${r.hb.lastErr || "none"}`,
      "5 s buckets (R replica-served, P primary-served, E failed, max = largest stale_ms):",
      ...buckets(r.ticks, ["lb", "replica", "primary"], 5000),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** An unhealthy-replica phase: error windows per source, and when the load balancer changed node. */
function eventResult(id: string, title: string, r: Timed, extra: Record<string, number | string>): TestResult {
  const m: Record<string, number | string> = { ...extra };
  for (const w of r.windows) Object.assign(m, windowMeas(w, w.name));
  const lbAll = servedDuring(r.ticks, "lb", 0, Infinity);
  const trans = transitions(r.ticks, "lb");
  m.lb_replica_total = lbAll.replica;
  m.lb_primary_total = lbAll.primary;
  m.lb_errors_total = lbAll.errors;
  m.lb_first_error_s = lbAll.firstErrorT === null ? "never" : round(lbAll.firstErrorT / 1000, 1);
  m.lb_last_error_s = lbAll.lastErrorT === null ? "never" : round(lbAll.lastErrorT / 1000, 1);
  m.lb_last_replica_s = lbAll.lastReplicaT === null ? "never" : round(lbAll.lastReplicaT / 1000, 1);
  const firstPri = r.ticks.find((k) => k.src === "lb" && k.node === "primary");
  m.lb_first_primary_s = firstPri ? round(firstPri.t / 1000, 1) : "never";
  m.lb_transitions = trans.length;
  m.primary_pm_changed = String(pmOf(r.ticks, "primary", "primary", "first") !== pmOf(r.ticks, "primary", "primary", "last"));
  m.replica_pm_changed = String(pmOf(r.ticks, "replica", "replica", "first") !== pmOf(r.ticks, "replica", "replica", "last"));
  m.heartbeat_rows = r.hb.rows;
  m.heartbeat_errors = r.hb.errors;
  const lbModes = errorModes(r.ticks, "lb");
  return {
    id,
    title,
    status: "info",
    detail: `load balancer: replica ${lbAll.replica}, primary ${lbAll.primary}, errors ${lbAll.errors} (${lbModes.join("; ") || "none"}); transitions ${trans.map((x) => `+${round(x.t / 1000, 1)}s ${x.from}->${x.to}`).join(", ")}`,
    measurements: m,
    evidence: [
      `marks: ${r.marks.join(" | ")}`,
      `lb transitions: ${trans.map((x) => `+${round(x.t / 1000, 1)}s ${x.from}->${x.to}`).join(", ")}`,
      ...r.windows.map((w) => `${w.name}: healthyAtStart ${w.healthyAtStart}, modes ${w.modes.join("; ") || "none"}`),
      `replica host errors: ${errorModes(r.ticks, "replica").join("; ") || "none"}; primary host errors: ${errorModes(r.ticks, "primary").join("; ") || "none"}`,
      `heartbeat last error: ${r.hb.lastErr || "none"}`,
      "5 s buckets (R replica-served, P primary-served, E failed, max = largest stale_ms):",
      ...buckets(r.ticks, ["lb", "replica", "primary"], 5000),
    ].join("\n"),
  };
}
