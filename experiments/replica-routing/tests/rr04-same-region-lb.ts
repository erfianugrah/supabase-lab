/**
 * RR04 - the API load balancer with the primary and one replica in the SAME
 * region: read-your-writes through `-all`, the split under concurrent load
 * and under CPU load on one node, a stale replica, a project restart, and
 * which component answers 400 to a HEAD on the replica's own host.
 *
 * RR03h saw the load balancer spread GETs about half and half over the two
 * nodes in this shape, so a GET right after a POST through `-all` can land on
 * the replica. RR02h-j (cross-region) saw it keep sending reads to a stale or
 * unreachable replica; this module repeats those methods with a same-region
 * primary as the alternative.
 *
 * Every read names the node that ran it (`pg_is_in_recovery()`), never
 * latency.
 *
 *   RR04a  create the primary (Small, ap-southeast-1)
 *   RR04b  `pitr_7`, schema (heartbeat, conflict table, rr4_ryw, rr4_seen,
 *          rr4_where, rr4_spin)
 *   RR04c  read replica in the same region; replica host; load balancer host
 *   RR04d  HEAD anatomy: raw HTTP/1.1 over TLS (Connection: close) for HEAD,
 *          GET, POST, OPTIONS and an Auth GET on the replica host, the load
 *          balancer host and the primary host; status line, every response
 *          header, body bytes
 *   RR04e  read-your-writes through the load balancer, raw fetch: POST a row,
 *          then at once GET rpc/rr4_seen for it; N times; stale = the replica
 *          served and did not see the row; pg_stat_replication lag around it
 *   RR04f  the same with supabase-js (insert().select(), then rpc get: true)
 *   RR04g  the same while the primary takes 50 single-row inserts a second
 *   RR04h  split under concurrent read load (sequential baseline, then 8 and
 *          32 concurrent clients)
 *   RR04i  split while one node's CPU is held by busy loops (replica, then
 *          primary)
 *   RR04j  split while the replica's replay is stopped (pg_wal_replay_pause
 *          if allowed, else RR02h's replica query vs primary UPDATE+VACUUM)
 *   RR04k  `POST /restart` while reading (both nodes go down in turn)
 *   RR04l  edge_logs: host, method, path family, status and redirect
 *          identifier for every request to the three hosts in the last 2 h
 *          (RR04d-k); attribute names of HEAD rows
 *   RR04p  teardown
 *
 * DESTRUCTIVE and BILLABLE: Small primary + Small replica + `pitr_7`, 14 and
 * 16 minutes in the 2026-10-26 runs. pg_wal_replay_pause is refused (42501)
 * for postgres, so RR04j falls back to the conflict method.
 * Env: PVLAB_ORG_PRO; PVLAB_RR_KEEP=1 skips teardown; PVLAB_RR_REFS_FILE
 * appends the created ref; PVLAB_RR4_REGION (ap-southeast-1);
 * PVLAB_RR4_PHASES=head,ryw,load,cpu,stall,restart,logs; PVLAB_RR4_RYW_N
 * (200); PVLAB_RR4_STALL_S (120); PVLAB_RR4_CYCLES (3); PVLAB_RR4_LOAD_S (60).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { connect } from "node:tls";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { fetchKeys, logsQuery, sql } from "../../../harness/src/platform";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PREFIX,
  applyAddon,
  connectSession,
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
import { buckets, label, lagWindow, parseNode, servedDuring, transitions, type Tick } from "../lib/rerouting";
import { errorSpan, headerNames, parseRawHttp, rywSummary, seqStats, type RawHttp, type RywTry } from "../lib/rr04";

const REGION = process.env.PVLAB_RR4_REGION ?? "ap-southeast-1";
const RYW_N = Number(process.env.PVLAB_RR4_RYW_N ?? 200);
const RYW_JS_N = 50;
const STALL_S = Number(process.env.PVLAB_RR4_STALL_S ?? 120);
const CYCLES = Number(process.env.PVLAB_RR4_CYCLES ?? 3);
const LOAD_S = Number(process.env.PVLAB_RR4_LOAD_S ?? 60);
const SPIN_CLIENTS = 4;
const WRITE_RATE = 50;
const READ_EVERY_MS = 250;
const HEARTBEAT_MS = 250;
/** A replica-served read (direct or through the load balancer) whose stale_ms exceeds this counts as stale. Chosen, not measured (RR02's value). */
const STALE_MS = 2000;
const phases = new Set((process.env.PVLAB_RR4_PHASES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
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
-- findLoadBalancer (lib/rr.ts) probes candidate hosts with rpc/rr_whoami.
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

create table if not exists public.rr4_ryw (id bigserial primary key, tag text not null, written_at timestamptz not null default clock_timestamp());
grant select, insert on public.rr4_ryw to anon, authenticated;
grant usage on sequence public.rr4_ryw_id_seq to anon, authenticated;
-- Did this node see row p_id; on a replica, how old the last replayed commit is
-- and how many WAL bytes it has received but not replayed.
create or replace function public.rr4_seen(p_id bigint) returns json language plpgsql stable as $$
declare
  age numeric;
  gap numeric;
  why text;
begin
  if pg_is_in_recovery() then
    begin
      age := round(extract(epoch from clock_timestamp() - pg_last_xact_replay_timestamp()) * 1000);
      gap := pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn());
    exception when others then
      why := SQLSTATE || ' ' || left(SQLERRM, 60);
    end;
  end if;
  return json_build_object('in_recovery', pg_is_in_recovery(),
    'seen', exists(select 1 from public.rr4_ryw where id = p_id),
    'replay_age_ms', age, 'unreplayed_bytes', gap, 'why', why);
end;
$$;
create or replace view public.rr4_where as select pg_is_in_recovery() as in_recovery;
grant select on public.rr4_where to anon, authenticated;
-- Busy loop for s seconds; returns iterations (a CPU-share figure). Not exposed to API roles.
create or replace function public.rr4_spin(s int) returns bigint language plpgsql volatile as $$
declare i bigint := 0; t0 timestamptz := clock_timestamp();
begin
  while clock_timestamp() < t0 + make_interval(secs => s) loop i := i + 1; end loop;
  return i;
end;
$$;
revoke execute on function public.rr4_spin(int) from public, anon, authenticated;
grant execute on function public.rr_whoami(), public.rr_node(), public.rr4_seen(bigint) to anon, authenticated, service_role;
notify pgrst, 'reload schema';
`;

/* ---------- helpers ---------- */

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

/** One HTTP/1.1 request over TLS with Connection: close; everything the server sent. */
function rawRequest(host: string, method: string, path: string, headers: Record<string, string>, body = "", timeoutMs = 10_000): Promise<{ raw: Buffer; ms: number; err?: string }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const chunks: Buffer[] = [];
    let done = false;
    const sock = connect({ host, port: 443, servername: host, ALPNProtocols: ["http/1.1"] }, () => {
      const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, "Connection: close", "User-Agent: pvlab-rr04", "Accept: */*", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      sock.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
    });
    const finish = (err?: string) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ raw: Buffer.concat(chunks), ms: performance.now() - t0, err });
    };
    sock.on("data", (d: Buffer) => chunks.push(d));
    sock.on("end", () => finish());
    sock.on("close", () => finish());
    sock.on("error", (e) => finish(errText(e)));
    sock.setTimeout(timeoutMs, () => finish("timeout"));
  });
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

/** Inserts a heartbeat row on the primary every HEARTBEAT_MS until stopped; reconnects on error. */
function startHeartbeat(e: PoolerEntry, password: string, everyMs = HEARTBEAT_MS) {
  let stop = false;
  let rows = 0;
  let errors = 0;
  let lastErr = "";
  const t0 = performance.now();
  const loop = (async () => {
    let c: Client | undefined;
    let i = 0;
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
      i++;
      const wait = t0 + i * everyMs - performance.now();
      if (wait > 0) await sleep(wait);
    }
    await c?.end().catch(() => {});
  })();
  return {
    async stop() {
      stop = true;
      await loop;
      return { rows, errors, lastErr, seconds: round((performance.now() - t0) / 1000, 1) };
    },
  };
}

/** pg_stat_replication on the primary every `everyMs`: replay_lag and write_lag in ms. */
function startLagMon(e: PoolerEntry, password: string, everyMs = 1000) {
  let stop = false;
  const replay: number[] = [];
  const write: number[] = [];
  const errs: string[] = [];
  const loop = (async () => {
    const c = pgClient(e, password, 10_000);
    try {
      await c.connect();
      while (!stop) {
        try {
          const r = await c.query<{ r: string | null; w: string | null }>(
            "select (extract(epoch from replay_lag) * 1000)::text as r, (extract(epoch from write_lag) * 1000)::text as w from pg_stat_replication limit 1",
          );
          const x = r.rows[0];
          if (x?.r != null) replay.push(Number(x.r));
          if (x?.w != null) write.push(Number(x.w));
          if (!x) errs.push("no row");
        } catch (err) {
          errs.push(errText(err).slice(0, 60));
        }
        await sleep(everyMs);
      }
    } catch (err) {
      errs.push(`connect ${errText(err).slice(0, 60)}`);
    } finally {
      await c.end().catch(() => {});
    }
  })();
  return {
    async stop() {
      stop = true;
      await loop;
      const f = (xs: number[], q: number) => (xs.length ? round(pct(xs, q), 1) : "none");
      return {
        replay_lag_n: replay.length,
        replay_lag_p50_ms: f(replay, 50),
        replay_lag_max_ms: replay.length ? round(Math.max(...replay), 1) : "none",
        write_lag_p50_ms: f(write, 50),
        lag_monitor_errors: [...new Set(errs)].join("; ") || "none",
      };
    },
  };
}

/** Readers that record every rr_node read from `srcs` as ticks until stopped. `gapMs` 0 = back to back. */
function startReaders(srcs: [string, string, number][], anon: string, t0: () => number, ticks: Tick[]) {
  let stop = false;
  const loops = srcs.map(([name, base, gapMs]) =>
    (async () => {
      while (!stop) {
        const c = await call(`${base}/rest/v1/rpc/rr_node`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` }, timeoutMs: 5000 });
        const p = c.status ? parseNode(c.status, c.text) : { err: c.err?.includes("timed out") || c.err?.includes("TimeoutError") ? "timeout" : (c.err ?? "fetch failed") };
        ticks.push({ t: Date.now() - t0(), src: name, status: c.status, ...p, ...({ ms: c.ms } as object) });
        if (gapMs) await sleep(gapMs);
      }
    })(),
  );
  return {
    async stop() {
      stop = true;
      await Promise.all(loops);
    },
  };
}

/** `timeout x3, HTTP 503 x1`: what the failing reads of `src` returned, by count. */
const errorCounts = (ticks: Tick[], src: string): string => {
  const t: Record<string, number> = {};
  for (const k of ticks) if (k.src === src && !k.node) t[label(k)] = (t[label(k)] ?? 0) + 1;
  return Object.entries(t).map(([k, n]) => `${k} x${n}`).join(", ") || "none";
};
const share = (ticks: Tick[], src: string, from: number, to: number) => {
  const s = servedDuring(ticks, src, from, to, STALE_MS);
  return `${s.replica}/${s.primary}/${s.errors}`;
};
const msOf = (k: Tick) => (k as Tick & { ms?: number }).ms ?? NaN;

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
  id: "RR04",
  title: "Same-region load balancer: read-your-writes, split under load, a stale replica, a restart, and HEAD on the replica host",
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
    if (!org) return [{ id: "RR04", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const keep = process.env.PVLAB_RR_KEEP === "1";
    const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
    let ref = "";
    let replicaId = "";
    const t00 = Date.now();
    const jsVer = supabaseJsVersion();
    const san = (s: string) => {
      const a = replicaId ? s.split(replicaId).join("<replica-id>") : s;
      return ref ? a.split(ref).join("<ref>") : a;
    };

    try {
      /* ---- RR04a ---- */
      const name = `${PREFIX}${Date.now()}`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name,
        db_pass: dbPass,
        region_selection: { type: "specific", code: REGION },
        desired_instance_size: "small",
      });
      ref = String((create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "");
      if (ref && process.env.PVLAB_RR_REFS_FILE) appendFileSync(process.env.PVLAB_RR_REFS_FILE, `${ref} ${name} ${new Date().toISOString()} RR04\n`);
      if (create.status !== 201 || !ref) {
        push({ id: "RR04a", title: `create primary (Small, ${REGION})`, status: "fail", detail: `HTTP ${create.status}: ${create.text.slice(0, 300)}` });
        return out;
      }
      ctx.log(`primary created (${name}); waiting healthy`);
      const h = await waitProjectHealthy(ctx, ref);
      push({
        id: "RR04a",
        title: `create primary (Small, ${REGION})`,
        status: h.status === "ACTIVE_HEALTHY" ? "pass" : "fail",
        detail: `create HTTP ${create.status}; ${h.status} after ${h.waitedS}s; supabase-js ${jsVer}`,
        measurements: { create_http: create.status, healthy_after_s: h.waitedS, region: REGION, supabase_js: jsVer },
      });
      if (h.status !== "ACTIVE_HEALTHY") return out;
      const pctx = forRef(ctx, ref);
      const primaryHost = `${ref}.supabase.co`;
      const primaryBase = `https://${primaryHost}`;

      /* ---- RR04b ---- */
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
      push({
        id: "RR04b",
        title: "pitr_7 and schema (rr_marker, rr_conflict 50,000 rows, rr4_ryw, rr4_seen, rr4_where, rr4_spin)",
        status: pitr.status < 300 && ddl.status < 300 && keys ? "pass" : "fail",
        detail: `pitr_7 ${pitr.status || "already"}; schema HTTP ${ddl.status}${ddl.error ? ` ${ddl.error}` : ""}; keys ${keys ? "ok" : keysErr}`,
        measurements: { pitr_http: pitr.status || "already", schema_http: ddl.status },
      });
      if (!keys || ddl.status >= 300) return out;
      const anon = keys.anon;
      const A = { apikey: anon, Authorization: `Bearer ${anon}` };

      /* ---- RR04c: replica ---- */
      const t1 = Date.now();
      let setup = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/setup`, { read_replica_region: REGION });
      const attempts = [`0s HTTP ${setup.status} ${setup.text.slice(0, 160)}`];
      while (setup.status >= 300 && setup.status !== 402 && Date.now() - t1 < 12 * 60_000) {
        await sleep(30_000);
        setup = await mgmt(pctx, "POST", `/projects/${ref}/read-replicas/setup`, { read_replica_region: REGION });
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
        push({ id: "RR04c", title: "read replica", status: "fail", detail: `setup ${attempts[attempts.length - 1]}; served ${servedS}; ${lastErr}`, evidence: attempts.join("\n") });
        return out;
      }
      replicaId = replica.identifier;
      const primaryEntry = (await poolerConfig(pctx, ref)).find((e) => e.database_type === "PRIMARY")!;
      const replicaHost = `${replicaId}.supabase.co`;
      const replicaBase = `https://${replicaHost}`;
      let replicaUp = await call(`${replicaBase}/rest/v1/rpc/rr_node`, { headers: A });
      for (let i = 0; i < 18 && parseNode(replicaUp.status, replicaUp.text).node !== "replica"; i++) {
        await sleep(10_000);
        replicaUp = await call(`${replicaBase}/rest/v1/rpc/rr_node`, { headers: A });
      }
      let lb = await findLoadBalancer(pctx, ref, anon);
      for (let i = 0; i < 8 && !lb.url; i++) {
        await sleep(15_000);
        lb = await findLoadBalancer(pctx, ref, anon);
      }
      push({
        id: "RR04c",
        title: `read-replicas/setup ${REGION} (primary ${REGION}); replica host; load balancer host`,
        status: lb.url ? "pass" : "fail",
        detail: `setup ${san(attempts[attempts.length - 1]!).replace(/\s+$/, "")}; first session connection after ${servedS}s; replica host rr_node HTTP ${replicaUp.status}; load balancer ${lb.url ? san(lb.url).replace(/^https:\/\//, "") : "NOT found"} (candidates ${lb.tried.join(",")})`,
        measurements: { setup_http: setup.status, setup_attempts: attempts.length, served_after_s: servedS, replica_rest_http: replicaUp.status },
        evidence: san(attempts.join("\n")),
      });
      if (!lb.url) return out;
      const lbBase = lb.url;
      const lbHost = new URL(lbBase).hostname;
      const hostOf: Record<string, string> = { lb: lbHost, replica: replicaHost, primary: primaryHost };
      const hostLabel = (host: string) => (host === lbHost ? "lb" : host === replicaHost ? "replica" : host === primaryHost ? "primary" : san(host));

      /* ---- RR04d: HEAD anatomy ---- */
      const directCounts: Record<string, number> = {};
      if (want("head")) {
        const m: Record<string, string | number> = {};
        const ev: string[] = [];
        const P = "/rest/v1/rr4_where?select=*&in_recovery=eq.true";
        const reqs: [string, string, string, Record<string, string>, string][] = [
          ["head_count", "HEAD", P, { ...A, Prefer: "count=exact" }, ""],
          ["head_plain", "HEAD", P, A, ""],
          ["get_count", "GET", P, { ...A, Prefer: "count=exact" }, ""],
          ["post", "POST", "/rest/v1/rr4_where", { ...A, "Content-Type": "application/json" }, "{}"],
          ["head_root", "HEAD", "/rest/v1/", A, ""],
          ["options_preflight", "OPTIONS", P, { Origin: "https://example.com", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "apikey,authorization,prefer" }, ""],
          ["get_auth_health", "GET", "/auth/v1/health", { apikey: anon }, ""],
        ];
        const showHeaders = (r: RawHttp) => r.headers.map(([k, v]) => `${k}: ${k === "set-cookie" ? v.replace(/=[^;]*/, "=<redacted>") : san(v)}`);
        const byKey: Record<string, RawHttp> = {};
        for (const [hn, host] of Object.entries(hostOf)) {
          for (const [k, meth, path, hdr, body] of reqs) {
            const x = await rawRequest(host, meth, path, hdr, body);
            const r = parseRawHttp(x.raw);
            byKey[`${hn}_${k}`] = r;
            directCounts[`${hn} ${meth}`] = (directCounts[`${hn} ${meth}`] ?? 0) + 1;
            const get = (n: string) => r.headers.find(([h]) => h === n)?.[1];
            m[`${hn}_${k}`] =
              `${r.status || `ERR ${x.err ?? r.statusLine}`} ct=${get("content-type") ?? "none"} cl=${get("content-length") ?? "none"} body_bytes=${r.body.length}` +
              `${get("content-range") ? ` content-range=${get("content-range")}` : ""}${get("server") ? ` server=${get("server")}` : ""}` +
              `${r.body.length ? ` body=${JSON.stringify(san(r.body.toString().replace(/\s+/g, " ").slice(0, 90)))}` : ""}`;
            ev.push(`== ${hn} ${meth} ${path} (${round(x.ms, 0)} ms)`, r.statusLine, ...showHeaders(r), `-- body ${r.body.length} bytes: ${san(r.body.toString().slice(0, 300))}`);
          }
        }
        // Does the HEAD 400 share the POST 400's shape? Same header names, and a
        // Content-Length equal to the POST body's length (HEAD and POST are both
        // four bytes, so this fits a method-substituted template; it cannot test one).
        const rh = byKey.replica_head_count;
        const rp = byKey.replica_post;
        const rg = byKey.replica_get_count;
        if (rh && rp && rg) {
          const n = (r: RawHttp) => headerNames(r.headers).filter((x) => !["date", "cf-ray", "sb-request-id", "set-cookie", "content-length", "alt-svc", "nel", "report-to"].includes(x));
          const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x)).join(",") || "none";
          m.replica_head400_names_not_in_post400 = diff(n(rh), n(rp));
          m.replica_post400_names_not_in_head400 = diff(n(rp), n(rh));
          m.replica_head400_names_not_in_get200 = diff(n(rh), n(rg));
          m.replica_get200_names_not_in_head400 = diff(n(rg), n(rh));
          const postText = rp.body.toString();
          const cl = Number(rh.headers.find(([k]) => k === "content-length")?.[1] ?? NaN);
          const predicted = Buffer.byteLength(postText.replace(/\bPOST\b/, "HEAD"));
          m.replica_post400_body_bytes = Buffer.byteLength(postText);
          m.replica_head400_content_length = Number.isFinite(cl) ? cl : "none";
          m.replica_head400_len_if_post_template = predicted;
        }
        // HEAD through the load balancer: 10 tries, node from count=exact on rr4_where (in_recovery=eq.true counts 1 on the replica).
        const lbHead: Record<string, number> = {};
        const lbHeadNames: Record<string, Set<string>> = { replica: new Set(), primary: new Set() };
        for (let i = 0; i < 10; i++) {
          const x = await rawRequest(lbHost, "HEAD", P, { ...A, Prefer: "count=exact" });
          const r = parseRawHttp(x.raw);
          const cr = r.headers.find(([k]) => k === "content-range")?.[1] ?? "";
          const node = cr.endsWith("/1") ? "replica" : cr.endsWith("/0") ? "primary" : `status ${r.status}`;
          lbHead[`${r.status} ${node}`] = (lbHead[`${r.status} ${node}`] ?? 0) + 1;
          if (node === "replica" || node === "primary") for (const h of headerNames(r.headers)) lbHeadNames[node]!.add(h);
          directCounts["lb HEAD"] = (directCounts["lb HEAD"] ?? 0) + 1;
        }
        m.lb_head_x10 = Object.entries(lbHead).map(([k, v]) => `${k} x${v}`).join(" | ");
        m.lb_head_names_replica_only = [...lbHeadNames.replica!].filter((x) => !lbHeadNames.primary!.has(x)).join(",") || "none";
        m.lb_head_names_primary_only = [...lbHeadNames.primary!].filter((x) => !lbHeadNames.replica!.has(x)).join(",") || "none";
        push({
          id: "RR04d",
          title: "HEAD anatomy: raw HTTP/1.1 HEAD, GET, POST, OPTIONS and Auth GET on the replica, load balancer and primary hosts; 10 HEADs through the load balancer",
          status: "info",
          detail: ["replica_head_count", "replica_post", "replica_get_count", "replica_options_preflight", "lb_head_x10", "replica_head400_names_not_in_post400", "replica_head400_content_length", "replica_head400_len_if_post_template"]
            .map((k) => `${k} ${m[k]}`)
            .join("; "),
          measurements: m,
          evidence: ev.join("\n"),
        });
      }

      /* ---- RR04e-g: read-your-writes ---- */
      const rywRaw = async (): Promise<RywTry> => {
        const p = await call(`${lbBase}/rest/v1/rr4_ryw?select=id`, {
          method: "POST",
          headers: { ...A, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify({ tag: "ryw" }),
        });
        let id = 0;
        try {
          id = Number((JSON.parse(p.text) as { id: number }[])[0]?.id ?? 0);
        } catch {}
        if (!id) return { err: `POST ${p.status || p.err}`, postMs: p.ms, getMs: 0 };
        const g = await call(`${lbBase}/rest/v1/rpc/rr4_seen?p_id=${id}`, { headers: A });
        const t: RywTry = { postMs: p.ms, getMs: g.ms };
        try {
          const j = JSON.parse(g.text) as { in_recovery?: boolean; seen?: boolean; replay_age_ms?: number | null; why?: string | null };
          if (g.status !== 200 || typeof j.in_recovery !== "boolean") return { ...t, err: `GET ${g.status}` };
          t.node = j.in_recovery ? "replica" : "primary";
          t.seen = !!j.seen;
          if (j.replay_age_ms != null) t.replayAgeMs = j.replay_age_ms;
        } catch {
          return { ...t, err: `GET ${g.status || g.err}` };
        }
        if (t.node === "replica" && !t.seen) {
          const ts = performance.now();
          let n = 0;
          while (performance.now() - ts < 3000) {
            n++;
            const r = await call(`${lbBase}/rest/v1/rpc/rr4_seen?p_id=${id}`, { headers: A });
            try {
              if ((JSON.parse(r.text) as { seen?: boolean }).seen) {
                t.untilSeenMs = round(performance.now() - ts, 1);
                break;
              }
            } catch {}
          }
          t.retries = n;
        }
        return t;
      };
      const rywResult = (id: string, title: string, tries: RywTry[], lag: Record<string, number | string>, extra: Record<string, number | string> = {}): TestResult => {
        const s = rywSummary(tries);
        const ages = tries.filter((t) => t.replayAgeMs !== undefined).map((t) => t.replayAgeMs!);
        return {
          id,
          title,
          status: "info",
          detail: `replica ${s.replica}, primary ${s.primary}, errors ${s.errors}; stale ${s.stale_of_replica_reads} replica-served reads (row not yet visible); primary unseen ${s.primary_unseen}; until seen max ${s.until_seen_max_ms} ms; POST p50 ${round(Number(s.post_p50_ms), 1)} ms, GET p50 ${round(Number(s.get_p50_ms), 1)} ms; replay_lag p50 ${lag.replay_lag_p50_ms} ms, max ${lag.replay_lag_max_ms} ms`,
          measurements: {
            ...s,
            post_p50_ms: round(Number(s.post_p50_ms), 1),
            get_p50_ms: round(Number(s.get_p50_ms), 1),
            replica_replay_age_p50_ms: ages.length ? pct(ages, 50) : "none",
            ...lag,
            ...extra,
          },
          evidence: tries.map((t, i) => `${i} ${t.node ?? t.err} seen=${t.seen ?? "-"}${t.untilSeenMs !== undefined ? ` until_seen=${t.untilSeenMs}ms retries=${t.retries}` : ""} post=${round(t.postMs, 0)} get=${round(t.getMs, 0)}`).join("\n"),
        };
      };
      if (want("ryw")) {
        {
          const mon = startLagMon(primaryEntry, dbPass);
          await sleep(1500);
          const tries: RywTry[] = [];
          for (let i = 0; i < RYW_N; i++) tries.push(await rywRaw());
          directCounts["lb POST"] = (directCounts["lb POST"] ?? 0) + RYW_N;
          push(rywResult("RR04e", `read-your-writes through the load balancer, raw fetch keep-alive: POST rr4_ryw (return=representation), then at once GET rpc/rr4_seen, ${RYW_N} times, no other writes`, tries, await mon.stop()));
        }
        {
          const mon = startLagMon(primaryEntry, dbPass);
          await sleep(1500);
          const c = createClient(lbBase, anon, { auth: { persistSession: false, autoRefreshToken: false } });
          const tries: RywTry[] = [];
          for (let i = 0; i < RYW_JS_N; i++) {
            const t0 = performance.now();
            const ins = await c.from("rr4_ryw").insert({ tag: "ryw-js" }).select("id").single();
            const postMs = performance.now() - t0;
            const id = (ins.data as { id?: number } | null)?.id;
            if (!id) {
              tries.push({ err: `insert ${ins.status} ${ins.error?.code ?? ""}`, postMs, getMs: 0 });
              continue;
            }
            const t1b = performance.now();
            const g = await c.rpc("rr4_seen", { p_id: id }, { get: true });
            const getMs = performance.now() - t1b;
            const j = g.data as { in_recovery?: boolean; seen?: boolean; replay_age_ms?: number | null } | null;
            if (g.error || typeof j?.in_recovery !== "boolean") tries.push({ err: `rpc ${g.status} ${g.error?.code ?? ""}`, postMs, getMs });
            else tries.push({ node: j.in_recovery ? "replica" : "primary", seen: !!j.seen, postMs, getMs, ...(j.replay_age_ms != null ? { replayAgeMs: j.replay_age_ms } : {}) });
          }
          push(rywResult("RR04f", `read-your-writes through the load balancer, supabase-js ${jsVer}: insert().select().single(), then rpc('rr4_seen', ..., { get: true }), ${RYW_JS_N} times`, tries, await mon.stop()));
        }
        {
          // RR03i's writer: one session connection inserting into rr_marker at WRITE_RATE rows/s.
          const stop = { v: false };
          let rows = 0;
          const writer = (async () => {
            const c = pgClient(primaryEntry, dbPass, 10_000);
            await c.connect();
            const t0 = performance.now();
            let i = 0;
            while (!stop.v) {
              const wait = t0 + i * (1000 / WRITE_RATE) - performance.now();
              if (wait > 0) await sleep(wait);
              i++;
              await c.query("insert into public.rr_marker(tag) values ('w')").then(() => rows++, () => {});
            }
            await c.end().catch(() => {});
            return (performance.now() - t0) / 1000;
          })();
          const mon = startLagMon(primaryEntry, dbPass);
          await sleep(3000);
          const tries: RywTry[] = [];
          for (let i = 0; i < RYW_N; i++) tries.push(await rywRaw());
          directCounts["lb POST"] = (directCounts["lb POST"] ?? 0) + RYW_N;
          const lag = await mon.stop();
          stop.v = true;
          const wallS = await writer;
          push(rywResult("RR04g", `read-your-writes as RR04e while the primary takes ${WRITE_RATE} single-row inserts/s on another connection, ${RYW_N} times`, tries, lag, { background_rows: rows, background_rows_per_s: round(rows / wallS, 1) }));
        }
      }

      /* ---- RR04h: split under concurrent read load ---- */
      if (want("load")) {
        const runLoad = async (conc: number, seconds: number) => {
          const seqs: string[] = Array.from({ length: conc }, () => "");
          const ms: Record<string, number[]> = { R: [], P: [] };
          const end = Date.now() + seconds * 1000;
          const t0 = Date.now();
          await Promise.all(
            seqs.map(async (_, w) => {
              while (Date.now() < end) {
                const c = await call(`${lbBase}/rest/v1/rpc/rr_node`, { headers: A, timeoutMs: 10_000 });
                const n = parseNode(c.status, c.text);
                const k = n.node === "replica" ? "R" : n.node === "primary" ? "P" : "E";
                seqs[w] += k;
                if (k !== "E") ms[k]!.push(c.ms);
              }
            }),
          );
          const all = seqs.join("");
          const cnt = (x: string) => all.split("").filter((y) => y === x).length;
          const st = seqStats(seqs[0]!);
          return {
            m: {
              concurrency: conc,
              seconds,
              requests: all.length,
              rps: round(all.length / ((Date.now() - t0) / 1000), 1),
              replica: cnt("R"),
              primary: cnt("P"),
              errors: cnt("E"),
              replica_share_pct: round((100 * cnt("R")) / Math.max(1, cnt("R") + cnt("P")), 1),
              p50_replica_ms: ms.R!.length ? round(pct(ms.R!, 50)) : "none",
              p50_primary_ms: ms.P!.length ? round(pct(ms.P!, 50)) : "none",
              p95_replica_ms: ms.R!.length ? round(pct(ms.R!, 95)) : "none",
              p95_primary_ms: ms.P!.length ? round(pct(ms.P!, 95)) : "none",
              worker0_switches: `${st.switches} of ${Math.max(0, seqs[0]!.length - 1)}`,
            } as Record<string, number | string>,
            seq0: seqs[0]!,
          };
        };
        for (const [i, conc, secs] of [[0, 1, 20], [1, 8, 20], [2, 32, 20]] as const) {
          const r = await runLoad(conc, secs);
          directCounts["lb GET"] = (directCounts["lb GET"] ?? 0) + Number(r.m.requests);
          push({
            id: `RR04h${i}`,
            title: `split under read load: ${conc} concurrent client${conc > 1 ? "s" : ""} back to back on GET rpc/rr_node through the load balancer for ${secs} s`,
            status: "info",
            detail: `${r.m.requests} requests (${r.m.rps}/s): replica ${r.m.replica}, primary ${r.m.primary}, errors ${r.m.errors} (replica ${r.m.replica_share_pct} %); p50 replica ${r.m.p50_replica_ms} ms, primary ${r.m.p50_primary_ms} ms`,
            measurements: r.m,
            evidence: `worker 0 sequence: ${r.seq0.slice(0, 600)}`,
          });
        }
      }

      /* ---- RR04i: split while one node's CPU is held ---- */
      if (want("cpu")) {
        for (const [i, target] of [[1, "replica"], [2, "primary"]] as const) {
          const entry = target === "replica" ? replica : primaryEntry;
          const ticks: Tick[] = [];
          let t0 = Date.now();
          const rd = startReaders(
            [
              ["lb", lbBase, 0],
              ["replica", replicaBase, 500],
              ["primary", primaryBase, 500],
            ],
            anon,
            () => t0,
            ticks,
          );
          t0 = Date.now();
          await sleep(20_000);
          const loadFrom = Date.now() - t0;
          const iters: string[] = [];
          await Promise.all(
            Array.from({ length: SPIN_CLIENTS }, async () => {
              const c = pgClient(entry, dbPass);
              try {
                await c.connect();
                await c.query("set statement_timeout = 0");
                const r = await c.query<{ n: string }>(`select public.rr4_spin(${LOAD_S})::text as n`);
                iters.push(r.rows[0]?.n ?? "?");
              } catch (e) {
                iters.push(`ERR ${errText(e).slice(0, 60)}`);
              } finally {
                await c.end().catch(() => {});
              }
            }),
          );
          const loadTo = Date.now() - t0;
          await sleep(10_000);
          await rd.stop();
          const before = servedDuring(ticks, "lb", 0, loadFrom);
          const during = servedDuring(ticks, "lb", loadFrom, loadTo);
          const lat = (src: string, from: number, to: number) => {
            const xs = ticks.filter((k) => k.src === src && k.node && k.t >= from && k.t <= to).map(msOf).filter(Number.isFinite);
            return xs.length ? round(pct(xs, 50)) : "none";
          };
          directCounts["lb GET"] = (directCounts["lb GET"] ?? 0) + ticks.filter((k) => k.src === "lb").length;
          const m: Record<string, number | string> = {
            loaded_node: target,
            spin_clients: SPIN_CLIENTS,
            load_s: LOAD_S,
            spin_iterations: iters.join(","),
            lb_before_replica: before.replica,
            lb_before_primary: before.primary,
            lb_before_errors: before.errors,
            lb_during_replica: during.replica,
            lb_during_primary: during.primary,
            lb_during_errors: during.errors,
            lb_during_replica_share_pct: round((100 * during.replica) / Math.max(1, during.replica + during.primary), 1),
            lb_before_replica_share_pct: round((100 * before.replica) / Math.max(1, before.replica + before.primary), 1),
            replica_host_p50_ms_before: lat("replica", 0, loadFrom),
            replica_host_p50_ms_during: lat("replica", loadFrom, loadTo),
            primary_host_p50_ms_before: lat("primary", 0, loadFrom),
            primary_host_p50_ms_during: lat("primary", loadFrom, loadTo),
            lb_p50_ms_before: lat("lb", 0, loadFrom),
            lb_p50_ms_during: lat("lb", loadFrom, loadTo),
          };
          push({
            id: `RR04i${i}`,
            title: `split while the ${target}'s CPU is held: ${SPIN_CLIENTS} session connections run a ${LOAD_S} s plpgsql busy loop on the ${target}; GET rpc/rr_node back to back through the load balancer, 20 s before and during`,
            status: "info",
            detail: `load balancer replica/primary/errors before ${before.replica}/${before.primary}/${before.errors}, during ${during.replica}/${during.primary}/${during.errors}; ${target} host p50 ${target === "replica" ? m.replica_host_p50_ms_before : m.primary_host_p50_ms_before} -> ${target === "replica" ? m.replica_host_p50_ms_during : m.primary_host_p50_ms_during} ms; spin iterations ${m.spin_iterations}`,
            measurements: m,
            evidence: ["5 s buckets (R replica-served, P primary-served, E failed):", ...buckets(ticks, ["lb", "replica", "primary"], 5000)].join("\n"),
          });
        }
      }

      /* ---- RR04j: stale replica ---- */
      if (want("stall")) {
        const ticks: Tick[] = [];
        const marks: string[] = [];
        let t0 = Date.now();
        const now = () => Date.now() - t0;
        const mark = (s: string) => marks.push(`+${round(now() / 1000, 1)}s ${s}`);
        const hb = startHeartbeat(primaryEntry, dbPass);
        await sleep(2000);
        t0 = Date.now();
        const rd = startReaders(
          [
            ["lb", lbBase, READ_EVERY_MS],
            ["replica", replicaBase, READ_EVERY_MS],
            ["primary", primaryBase, READ_EVERY_MS],
          ],
          anon,
          () => t0,
          ticks,
        );
        await sleep(15_000);
        let method = "";
        let pauseErr = "";
        const rc = pgClient(replica, dbPass);
        try {
          await rc.connect();
          try {
            await rc.query("select pg_wal_replay_pause()");
            method = "pg_wal_replay_pause";
            mark("pg_wal_replay_pause() ok");
            await sleep(STALL_S * 1000);
            await rc.query("select pg_wal_replay_resume()");
            mark("pg_wal_replay_resume() ok");
          } catch (e) {
            pauseErr = `${String((e as { code?: string }).code ?? "")} ${errText(e)}`.slice(0, 120);
            mark(`pg_wal_replay_pause refused: ${pauseErr}`);
          }
          if (!method) {
            method = `conflict x${CYCLES}`;
            const pc = pgClient(primaryEntry, dbPass);
            await pc.connect();
            for (let c = 0; c < CYCLES; c++) {
              await rc.query("set statement_timeout = 0");
              await rc.query("begin isolation level repeatable read");
              await rc.query("select count(*) from public.rr_conflict");
              const longQ = rc.query(`select pg_sleep(${STALL_S})`).then(
                () => mark(`cycle ${c + 1}: replica query finished on its own`),
                (e: unknown) => mark(`cycle ${c + 1}: replica query cancelled ${String((e as { code?: string }).code ?? "")}`),
              );
              await sleep(2000);
              mark(`cycle ${c + 1}: primary update+vacuum`);
              await pc.query("update public.rr_conflict set v = v + 1");
              await pc.query("vacuum public.rr_conflict");
              await longQ;
              await rc.query("rollback").catch(() => {});
              // Let replay catch up before the next snapshot: on 2026-10-26 (first
              // published run) cycle 2 started 0.1 s after cycle 1's cancel and was
              // cancelled at once, so only one stop happened.
              const tc = Date.now();
              while (Date.now() - tc < 30_000) {
                const r = await call(`${replicaBase}/rest/v1/rpc/rr_node`, { headers: A, timeoutMs: 5000 });
                const n = parseNode(r.status, r.text);
                if (n.node === "replica" && (n.staleMs ?? Infinity) < 1000) break;
                await sleep(500);
              }
              mark(`cycle ${c + 1}: replica caught up`);
            }
            await pc.end().catch(() => {});
          }
        } catch (e) {
          mark(`stall error ${errText(e)}`);
        } finally {
          await rc.end().catch(() => {});
        }
        await sleep(40_000);
        await rd.stop();
        const hbr = await hb.stop();
        const w = lagWindow(ticks, "replica", STALE_MS);
        const lbIn = w ? servedDuring(ticks, "lb", w.startT, w.endT, STALE_MS) : undefined;
        const half = w ? (w.startT + w.endT) / 2 : 0;
        const pre = servedDuring(ticks, "lb", 0, 15_000);
        const lbAll = servedDuring(ticks, "lb", 0, Infinity, STALE_MS);
        const m: Record<string, number | string> = {
          method,
          pause_error: pauseErr || "none",
          stale_threshold_ms: STALE_MS,
          replica_stale_window_s: w ? round((w.endT - w.startT) / 1000, 1) : "none",
          replica_max_stale_ms: w ? w.maxStaleMs : servedDuring(ticks, "replica", 0, Infinity).maxStaleReplicaMs,
          lb_pre_replica_primary_errors: `${pre.replica}/${pre.primary}/${pre.errors}`,
          lb_in_window_replica: lbIn?.replica ?? 0,
          lb_in_window_primary: lbIn?.primary ?? 0,
          lb_in_window_errors: lbIn?.errors ?? 0,
          lb_in_window_replica_stale: lbIn?.replicaStale ?? 0,
          lb_first_half_replica_primary_errors: w ? share(ticks, "lb", w.startT, half) : "none",
          lb_second_half_replica_primary_errors: w ? share(ticks, "lb", half, w.endT) : "none",
          lb_max_stale_served_ms: lbAll.maxStaleReplicaMs,
          lb_reads_total: lbAll.n,
          lb_error_modes: errorCounts(ticks, "lb"),
          heartbeat_rows: hbr.rows,
          heartbeat_errors: hbr.errors,
        };
        push({
          id: "RR04j",
          title: `split while the replica's replay is stopped (${method}); rr_node every ${READ_EVERY_MS} ms on the load balancer, replica and primary hosts; heartbeat every ${HEARTBEAT_MS} ms`,
          status: "info",
          detail: w
            ? `replica host stale > ${STALE_MS} ms for ${m.replica_stale_window_s} s (max ${w.maxStaleMs} ms); load balancer in that window: replica ${lbIn!.replica} (stale ${lbIn!.replicaStale}), primary ${lbIn!.primary}, errors ${lbIn!.errors}; first half ${m.lb_first_half_replica_primary_errors}, second half ${m.lb_second_half_replica_primary_errors} (replica/primary/errors); before ${m.lb_pre_replica_primary_errors}`
            : `replica host never stale beyond ${STALE_MS} ms (max ${m.replica_max_stale_ms} ms); ${pauseErr ? `pause refused: ${pauseErr}` : ""}`,
          measurements: m,
          evidence: [
            `marks: ${marks.join(" | ")}`,
            `heartbeat last error: ${hbr.lastErr || "none"}`,
            "5 s buckets (R replica-served, P primary-served, E failed, max = largest stale_ms):",
            ...buckets(ticks, ["lb", "replica", "primary"], 5000),
          ].join("\n"),
        });
      }

      /* ---- RR04k: restart ---- */
      if (want("restart")) {
        const ticks: Tick[] = [];
        const marks: string[] = [];
        let t0 = Date.now();
        const now = () => Date.now() - t0;
        const mark = (s: string) => marks.push(`+${round(now() / 1000, 1)}s ${s}`);
        const hb = startHeartbeat(primaryEntry, dbPass);
        await sleep(2000);
        t0 = Date.now();
        const rd = startReaders(
          [
            ["lb", lbBase, READ_EVERY_MS],
            ["replica", replicaBase, READ_EVERY_MS],
            ["primary", primaryBase, READ_EVERY_MS],
          ],
          anon,
          () => t0,
          ticks,
        );
        await sleep(15_000);
        mark("POST /restart");
        const rs = await mgmt(pctx, "POST", `/projects/${ref}/restart`);
        mark(`restart HTTP ${rs.status}`);
        const hh = await waitProjectHealthy(ctx, ref, 7 * 60_000);
        mark(`project ${hh.status}`);
        // Keep reading until both hosts have answered for 30 s in a row, max 3 more minutes.
        const tw = Date.now();
        while (Date.now() - tw < 3 * 60_000) {
          await sleep(5000);
          const recent = ticks.filter((k) => k.t > now() - 30_000 && (k.src === "replica" || k.src === "primary"));
          if (recent.length > 20 && recent.every((k) => k.node)) break;
        }
        await rd.stop();
        const hbr = await hb.stop();
        const ps = errorSpan(ticks, "primary");
        const rsn = errorSpan(ticks, "replica");
        const lbAll = servedDuring(ticks, "lb", 0, Infinity);
        const inSpan = (s: { from: number; to: number } | null) => (s ? share(ticks, "lb", s.from, s.to) : "no errors");
        // Load balancer reads while exactly one host was failing.
        const onlyPrimaryDown = ticks.filter((k) => k.src === "lb" && ps && k.t >= ps.from && k.t <= ps.to && !(rsn && k.t >= rsn.from && k.t <= rsn.to));
        const onlyReplicaDown = ticks.filter((k) => k.src === "lb" && rsn && k.t >= rsn.from && k.t <= rsn.to && !(ps && k.t >= ps.from && k.t <= ps.to));
        const tri = (ks: Tick[]) => `${ks.filter((k) => k.node === "replica").length}/${ks.filter((k) => k.node === "primary").length}/${ks.filter((k) => !k.node).length}`;
        const m: Record<string, number | string> = {
          restart_http: rs.status,
          project_status: hh.status,
          primary_host_error_span_s: ps ? `${round(ps.from / 1000, 1)}-${round(ps.to / 1000, 1)}` : "none",
          primary_host_errors: ps?.errors ?? 0,
          replica_host_error_span_s: rsn ? `${round(rsn.from / 1000, 1)}-${round(rsn.to / 1000, 1)}` : "none",
          replica_host_errors: rsn?.errors ?? 0,
          lb_in_primary_span_replica_primary_errors: inSpan(ps),
          lb_in_replica_span_replica_primary_errors: inSpan(rsn),
          lb_only_primary_down_replica_primary_errors: tri(onlyPrimaryDown),
          lb_only_replica_down_replica_primary_errors: tri(onlyReplicaDown),
          lb_total_replica: lbAll.replica,
          lb_total_primary: lbAll.primary,
          lb_total_errors: lbAll.errors,
          lb_error_modes: errorCounts(ticks, "lb"),
          primary_host_error_modes: errorCounts(ticks, "primary"),
          replica_host_error_modes: errorCounts(ticks, "replica"),
          heartbeat_errors: hbr.errors,
        };
        push({
          id: "RR04k",
          title: `POST /restart while reading rr_node every ${READ_EVERY_MS} ms on the load balancer, replica and primary hosts`,
          status: "info",
          detail: `primary host failing ${m.primary_host_error_span_s} s, replica host ${m.replica_host_error_span_s} s; load balancer (replica/primary/errors) while only the primary failed ${m.lb_only_primary_down_replica_primary_errors}, while only the replica failed ${m.lb_only_replica_down_replica_primary_errors}; total ${lbAll.replica}/${lbAll.primary}/${lbAll.errors}`,
          measurements: m,
          evidence: [
            `marks: ${marks.join(" | ")}`,
            `lb transitions: ${transitions(ticks, "lb").map((x) => `+${round(x.t / 1000, 1)}s ${x.from}->${x.to}`).join(", ").slice(0, 3000)}`,
            "5 s buckets (R replica-served, P primary-served, E failed):",
            ...buckets(ticks, ["lb", "replica", "primary"], 5000),
          ].join("\n"),
        });
      }

      /* ---- RR04l: edge_logs ---- */
      if (want("logs")) {
        const hostsIn = Object.values(hostOf)
          .map((x) => `'${x}'`)
          .join(",");
        const Q =
          "select log_attributes['request.host'] as host, log_attributes['request.method'] as method, " +
          "log_attributes['request.path'] as path, log_attributes['response.status_code'] as status, " +
          "log_attributes['load_balancer_redirect_identifier'] as redirect, count(*) as n " +
          `from logs where source = 'edge_logs' and log_attributes['request.host'] in (${hostsIn}) ` +
          "group by host, method, path, status, redirect order by n desc limit 300";
        let rows: Record<string, unknown>[] = [];
        let qErr = "";
        const tq = Date.now();
        let prevTotal = -1;
        while (Date.now() - tq < 6 * 60_000) {
          await sleep(45_000);
          const q = await logsQuery(pctx, Q, 2);
          if (q.error) qErr = q.error;
          if (q.rows.length) {
            rows = q.rows as Record<string, unknown>[];
            const total = rows.reduce((a, x) => a + Number(x.n ?? 0), 0);
            if (total === prevTotal) break;
            prevTotal = total;
          }
        }
        const target = (v: unknown) => {
          const s = String(v ?? "");
          return !s ? "none" : s === primaryHost ? "primary" : s === replicaHost ? "replica" : san(s);
        };
        const fam = (p: string) =>
          p.startsWith("/rest/v1/rr4_where") ? "rr4_where" : p.startsWith("/rest/v1/rpc/rr4_seen") ? "rr4_seen" : p.startsWith("/rest/v1/rpc/rr_node") ? "rr_node" : p.startsWith("/rest/v1/rr4_ryw") ? "rr4_ryw" : p === "/rest/v1/" ? "rest root" : p.startsWith("/auth/") ? "auth" : "other";
        const agg: Record<string, number> = {};
        for (const x of rows) {
          const key = `${hostLabel(String(x.host ?? ""))} ${x.method} ${fam(String(x.path ?? ""))} ${x.status} -> ${target(x.redirect)}`;
          agg[key] = (agg[key] ?? 0) + Number(x.n ?? 0);
        }
        const m: Record<string, number | string> = { groups: rows.length, rows: rows.reduce((a, x) => a + Number(x.n ?? 0), 0) };
        for (const [k, v] of Object.entries(agg)) if (/ (HEAD|OPTIONS) /.test(k) || / rr4_where /.test(k)) m[k.replace(/\s+/g, "_")] = v;
        for (const [k, v] of Object.entries(directCounts)) m[`sent_direct ${k}`.replace(/\s+/g, "_")] = v;
        // Attribute NAMES of HEAD rows on the replica host and the load balancer host (values left out: request
        // headers include client addresses), plus the response-side values.
        const QA = `select log_attributes from logs where source = 'edge_logs' and log_attributes['request.method'] = 'HEAD' and log_attributes['request.host'] in ('${replicaHost}','${lbHost}') limit 6`;
        const qa = await logsQuery(pctx, QA, 2);
        const attrEv: string[] = [];
        if (qa.error) attrEv.push(`attribute query error: ${san(qa.error.slice(0, 160))}`);
        for (const x of qa.rows as Record<string, unknown>[]) {
          const la = (x.log_attributes ?? {}) as Record<string, unknown>;
          const keysA = Object.keys(la).sort();
          const host = hostLabel(String(la["request.host"] ?? ""));
          const keep = keysA.filter((k) => /^(response\.|load_balancer|request\.(method|path)$)/.test(k) && !/ip|forwarded|connecting|real|cookie|client/i.test(k));
          attrEv.push(`${host}: ${keep.map((k) => `${k}=${san(String(la[k]).slice(0, 80))}`).join(" ")}`, `${host} attribute names (${keysA.length}): ${keysA.join(",")}`);
        }
        push({
          id: "RR04l",
          title: "edge_logs on the three hosts: host, method, path family, status, redirect identifier; attribute names of HEAD rows",
          status: "info",
          detail: `${m.rows} rows in ${rows.length} groups after ${Math.round((Date.now() - tq) / 1000)} s${qErr ? `; last endpoint error ${san(qErr.slice(0, 80))}` : ""}; HEAD rows: ${Object.entries(agg)
            .filter(([k]) => / HEAD /.test(k))
            .map(([k, v]) => `${k} n=${v}`)
            .join("; ")}`,
          measurements: m,
          evidence: [
            ...Object.entries(agg)
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => `${k} n=${n}`),
            ...attrEv,
          ].join("\n"),
        });
      }
    } catch (e) {
      push({ id: "RR04x", title: "module aborted", status: "fail", detail: san(errText(e)) });
    } finally {
      /* ---- RR04p ---- */
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
          id: "RR04p",
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
