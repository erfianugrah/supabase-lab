/**
 * RR08 - hot-standby conflicts against Data API reads on a same-region read
 * replica, and what the two hosted knobs (`hot_standby_feedback`,
 * `max_standby_streaming_delay`) change.
 *
 * Question: an app reads lists that take 1 to 8 s through the Data API (8 s
 * statement_timeout for `authenticated`) on a same-region replica while the
 * primary takes continuous updates and VACUUM. What can be tuned on hosted
 * against recovery conflicts, and what does each setting cost?
 *
 * RR01m-n cancelled a single 100 s replica query after about 30 s (SQLSTATE
 * 40001); this module uses many overlapping short reads instead, which is
 * what an app sends, and sets the knobs with the Management API endpoint the
 * CLI uses (`PUT /v1/projects/{ref}/config/database/postgres`, merged with
 * the current overrides as `supabase postgres-config update` does), reading
 * the value back ON each node (RR02d once saw the replica keep the default).
 *
 *   RR08a  create the primary (Small, ap-southeast-1)
 *   RR08b  `pitr_7`; schema; `rr8_items` (ROWS rows); one auth user
 *   RR08c  read replica in the same region; replica host; load balancer host
 *   RR08d  steady lag: heartbeat only (4 inserts/s), stale_ms on both hosts,
 *          replay_lag (#276)
 *   RR08e  arm A, defaults: readers + updater + VACUUM VERBOSE every 30 s
 *   RR08f  arm A, lock: readers + a brief ACCESS EXCLUSIVE lock on the primary
 *   RR08g  set max_standby_streaming_delay 5s;   RR08h arm D (as RR08e)
 *   RR08i  set max_standby_streaming_delay 120s; RR08j arm C (as RR08e)
 *   RR08k  set 30s + hot_standby_feedback on;    RR08l arm B (as RR08e)
 *   RR08m  arm B plus one 120 s replica transaction (feedback's bloat cost
 *          for a long query)
 *   RR08n  arm B, lock (does feedback prevent lock conflicts?)
 *   RR08p  teardown
 *
 * Readers: READERS loops on the replica's own host and READERS on `<ref>-all`,
 * each back to back, `GET rpc/rr8_list?p_ms=<1000..7000>` with a user JWT
 * (role `authenticated`, statement_timeout 8 s). The function scans 100,000-row
 * ranges of `rr8_items` with 0.25 s sleeps between scans for p_ms; as a STABLE
 * function it runs under one snapshot for the whole call.
 *
 * DESTRUCTIVE and BILLABLE: Small primary + Small replica + `pitr_7`, about
 * 45 minutes. Env: PVLAB_ORG_PRO; PVLAB_RR_KEEP=1 skips teardown;
 * PVLAB_RR_REFS_FILE appends the created ref; PVLAB_RR8_REGION
 * (ap-southeast-1); PVLAB_RR8_ARMS=steady,A,Alock,D,C,B,Blong,Block;
 * PVLAB_RR8_ARM_S (240); PVLAB_RR8_C_S (300); PVLAB_RR8_LOCK_S (150);
 * PVLAB_RR8_READERS (4 per host); PVLAB_RR8_ROWS (1500000).
 */
import { appendFileSync } from "node:fs";
import { Client } from "pg";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PREFIX,
  applyAddon,
  connectSession,
  errText,
  findLoadBalancer,
  forRef,
  poolerConfig,
  round,
  selectedAddons,
  sleep,
  waitProjectHealthy,
  type PoolerEntry,
} from "../lib/rr";
import { parseNode } from "../lib/rerouting";
import { classifyRead, parseVacuumVerbose, staleEpisodes, statsOf, tallyBy, type ReadClass, type VacuumTuples } from "../lib/rr08";

const REGION = process.env.PVLAB_RR8_REGION ?? "ap-southeast-1";
const ROWS = Number(process.env.PVLAB_RR8_ROWS ?? 1_500_000);
const READERS = Number(process.env.PVLAB_RR8_READERS ?? 4);
const ARM_S = Number(process.env.PVLAB_RR8_ARM_S ?? 240);
const C_S = Number(process.env.PVLAB_RR8_C_S ?? 300);
const LOCK_S = Number(process.env.PVLAB_RR8_LOCK_S ?? 150);
const STEADY_S = 120;
const LONG_Q_S = 120;
const LOCKS = 3;
const READ_MIN_MS = 1000;
const READ_MAX_MS = 7000;
const UPDATE_EVERY_MS = 250;
const UPDATE_BATCH = 500;
const VACUUM_EVERY_S = 30;
const HEARTBEAT_MS = 250;
const POLL_MS = 500;
/** A replica-host heartbeat read older than this counts as stale. Chosen (RR02's value), not measured. */
const STALE_MS = 2000;
const arms = new Set((process.env.PVLAB_RR8_ARMS ?? "steady,A,Alock,D,C,B,Blong,Block").split(",").map((s) => s.trim()).filter(Boolean));

const SCHEMA = `
create table if not exists public.rr_marker (id bigserial primary key, tag text not null, written_at timestamptz not null default clock_timestamp());
insert into public.rr_marker(tag) values ('seed');
grant select on public.rr_marker to anon, authenticated;
create or replace function public.rr_whoami() returns json language sql stable as $$
  select json_build_object('in_recovery', pg_is_in_recovery(), 'addr', inet_server_addr()::text,
    'pm', extract(epoch from pg_postmaster_start_time())::bigint,
    'max_id', (select coalesce(max(id), 0) from public.rr_marker), 'now', clock_timestamp())
$$;
create or replace function public.rr_node() returns json language sql stable as $$
  select json_build_object('in_recovery', pg_is_in_recovery(),
    'pm', extract(epoch from pg_postmaster_start_time())::bigint, 'max_id', m.id,
    'stale_ms', round(extract(epoch from (clock_timestamp() - m.written_at)) * 1000)::bigint)
  from (select id, written_at from public.rr_marker order by id desc limit 1) m
$$;
create table if not exists public.rr8_items (id int primary key, grp int not null, v int not null default 0, pad text not null);
grant select on public.rr8_items to authenticated;
-- The list read: scan 100,000-row ranges with 0.25 s pauses until p_ms has
-- passed. STABLE, so the whole call runs under the calling statement's snapshot.
create or replace function public.rr8_list(p_ms int) returns json language plpgsql stable as $$
declare
  t0 timestamptz := clock_timestamp();
  hb timestamptz;
  n bigint := 0; s bigint := 0; c bigint; sm bigint; it int := 0; lo int;
  total int := (select coalesce(max(id), 0) from public.rr8_items);
begin
  select written_at into hb from public.rr_marker order by id desc limit 1;
  loop
    lo := ((it * 100000) + (extract(epoch from t0)::bigint % 15) * 100000) % greatest(total, 1);
    select count(*), coalesce(sum(v), 0) into c, sm from public.rr8_items where id > lo and id <= lo + 100000;
    n := n + c; s := s + sm; it := it + 1;
    exit when clock_timestamp() >= t0 + make_interval(secs => p_ms / 1000.0);
    perform pg_sleep(least(0.25, greatest(0, extract(epoch from (t0 + make_interval(secs => p_ms / 1000.0) - clock_timestamp())))));
  end loop;
  return json_build_object('in_recovery', pg_is_in_recovery(),
    'pm', extract(epoch from pg_postmaster_start_time())::bigint,
    'rows', n, 'sum', s, 'iters', it,
    'ms', round(extract(epoch from clock_timestamp() - t0) * 1000)::bigint,
    'stale_ms', round(extract(epoch from (t0 - hb)) * 1000)::bigint);
end;
$$;
revoke execute on function public.rr8_list(int) from public, anon;
grant execute on function public.rr8_list(int) to authenticated, service_role;
grant execute on function public.rr_whoami(), public.rr_node() to anon, authenticated, service_role;
notify pgrst, 'reload schema';
`;

/* ---------- connections ---------- */

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

/** Runs `step(client)` every `everyMs` until stopped; reconnects on error; counts. */
function loopOn(e: PoolerEntry, password: string, everyMs: number, step: (c: Client) => Promise<void>, queryTimeoutMs = 30_000) {
  let stop = false;
  let ok = 0;
  let errors = 0;
  const errs: string[] = [];
  const t0 = performance.now();
  const loop = (async () => {
    let c: Client | undefined;
    let i = 0;
    while (!stop) {
      try {
        if (!c) {
          c = pgClient(e, password, queryTimeoutMs);
          await c.connect();
        }
        await step(c);
        ok++;
      } catch (err) {
        errors++;
        errs.push(errText(err).slice(0, 80));
        await c?.end().catch(() => {});
        c = undefined;
        await sleep(1000);
      }
      i++;
      const wait = t0 + i * everyMs - performance.now();
      if (wait > 0) await sleep(Math.min(wait, everyMs));
    }
    await c?.end().catch(() => {});
  })();
  return {
    async stop() {
      stop = true;
      await loop;
      return { ok, errors, errs: tallyBy(errs), seconds: round((performance.now() - t0) / 1000, 1) };
    },
  };
}

interface ReadRec extends ReadClass {
  t: number;
  src: string;
  planned: number;
  ms: number;
  status: number;
}

/* ---------- module ---------- */

const mod: TestModule = {
  id: "RR08",
  title: "Hot-standby conflicts against 1 to 8 s Data API reads on a same-region replica: defaults, hot_standby_feedback, max_standby_streaming_delay",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const push = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id} ${r.status}${r.detail ? `: ${r.detail.slice(0, 300)}` : ""}`);
    };
    const org = ctx.orgs.pro;
    if (!org) return [{ id: "RR08", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const keep = process.env.PVLAB_RR_KEEP === "1";
    const dbPass = `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;
    let ref = "";
    let replicaId = "";
    const t00 = Date.now();
    const san = (s: string) => {
      const a = replicaId ? s.split(replicaId).join("<replica-id>") : s;
      return ref ? a.split(ref).join("<ref>") : a;
    };

    try {
      /* ---- RR08a ---- */
      const name = `${PREFIX}${Date.now()}`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name,
        db_pass: dbPass,
        region_selection: { type: "specific", code: REGION },
        desired_instance_size: "small",
      });
      ref = String((create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "");
      if (ref && process.env.PVLAB_RR_REFS_FILE) appendFileSync(process.env.PVLAB_RR_REFS_FILE, `${ref} ${name} ${new Date().toISOString()} RR08\n`);
      if (create.status !== 201 || !ref) {
        push({ id: "RR08a", title: `create primary (Small, ${REGION})`, status: "fail", detail: `HTTP ${create.status}: ${create.text.slice(0, 300)}` });
        return out;
      }
      ctx.log(`primary created (${name}); waiting healthy`);
      const h = await waitProjectHealthy(ctx, ref);
      push({
        id: "RR08a",
        title: `create primary (Small, ${REGION})`,
        status: h.status === "ACTIVE_HEALTHY" ? "pass" : "fail",
        detail: `create HTTP ${create.status}; ${h.status} after ${h.waitedS}s`,
        measurements: { create_http: create.status, healthy_after_s: h.waitedS, region: REGION },
      });
      if (h.status !== "ACTIVE_HEALTHY") return out;
      const pctx = forRef(ctx, ref);
      const primaryBase = `https://${ref}.supabase.co`;

      /* ---- RR08b ---- */
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
      const primaryEntry = (await poolerConfig(pctx, ref)).find((e) => e.database_type === "PRIMARY");
      let seedMsg = "not run";
      let relMb = 0;
      if (primaryEntry && ddl.status < 300) {
        try {
          const c = await connectSession(primaryEntry, dbPass, 12, 10_000);
          const ts = performance.now();
          await c.query("set statement_timeout = 0");
          await c.query(`insert into public.rr8_items(id, grp, v, pad) select g, g % 1000, 0, repeat('x', 24) from generate_series(1, ${ROWS}) g on conflict do nothing`);
          await c.query("vacuum analyze public.rr8_items");
          const r = await c.query<{ mb: string; n: string }>("select (pg_relation_size('public.rr8_items') / 1048576.0)::text as mb, (select count(*) from public.rr8_items)::text as n");
          relMb = round(Number(r.rows[0]!.mb), 1);
          seedMsg = `${r.rows[0]!.n} rows, ${relMb} MB heap, ${round((performance.now() - ts) / 1000, 1)} s`;
          await c.end();
        } catch (e) {
          seedMsg = `error ${errText(e)}`;
        }
      }
      // One user; its JWT makes every read run as `authenticated` (statement_timeout 8 s on hosted).
      const email = `rr08-${Date.now()}` + "@" + "example.com";
      const password = `${crypto.randomUUID()}Aa1!`;
      let userId = "";
      for (let i = 0; i < 12 && !userId && keys; i++) {
        const r = await fetch(`${primaryBase}/auth/v1/admin/users`, {
          method: "POST",
          headers: { apikey: keys.service, Authorization: `Bearer ${keys.service}`, "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, email_confirm: true }),
        }).catch(() => null);
        userId = r ? String(((await r.json().catch(() => ({}))) as { id?: string }).id ?? "") : "";
        if (!userId) await sleep(10_000);
      }
      const ok = pitr.status < 300 && ddl.status < 300 && !!keys && !!primaryEntry && seedMsg.includes("rows") && !!userId;
      push({
        id: "RR08b",
        title: `pitr_7, schema (rr_marker, rr_node, rr8_items, rr8_list), seed ${ROWS} rows, one auth user`,
        status: ok ? "pass" : "fail",
        detail: `pitr_7 ${pitr.status || "already"}; schema HTTP ${ddl.status}${ddl.error ? ` ${ddl.error}` : ""}; keys ${keys ? "ok" : keysErr}; seed ${seedMsg}; user ${userId ? "ok" : "absent"}`,
        measurements: { pitr_http: pitr.status || "already", schema_http: ddl.status, rows: ROWS, heap_mb: relMb },
      });
      if (!ok || !keys || !primaryEntry) return out;
      const anon = keys.anon;
      const A = { apikey: anon, Authorization: `Bearer ${anon}` };
      const signIn = async (): Promise<string> => {
        for (let i = 0; i < 6; i++) {
          const r = await fetch(`${primaryBase}/auth/v1/token?grant_type=password`, {
            method: "POST",
            headers: { apikey: anon, "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
          }).catch(() => null);
          const tok = r ? String(((await r.json().catch(() => ({}))) as { access_token?: string }).access_token ?? "") : "";
          if (tok) return tok;
          await sleep(5000);
        }
        throw new Error("sign-in failed");
      };

      /* ---- RR08c: replica ---- */
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
        push({ id: "RR08c", title: "read replica", status: "fail", detail: san(`setup ${attempts[attempts.length - 1]}; served ${servedS}; ${lastErr}`), evidence: san(attempts.join("\n")) });
        return out;
      }
      const replicaEntry = replica;
      replicaId = replicaEntry.identifier;
      const replicaBase = `https://${replicaId}.supabase.co`;
      let replicaUp = await fetch(`${replicaBase}/rest/v1/rpc/rr_node`, { headers: A }).then(async (r) => parseNode(r.status, await r.text())).catch(() => ({ node: undefined }));
      for (let i = 0; i < 18 && replicaUp.node !== "replica"; i++) {
        await sleep(10_000);
        replicaUp = await fetch(`${replicaBase}/rest/v1/rpc/rr_node`, { headers: A }).then(async (r) => parseNode(r.status, await r.text())).catch(() => ({ node: undefined }));
      }
      let lb = await findLoadBalancer(pctx, ref, anon);
      for (let i = 0; i < 8 && !lb.url; i++) {
        await sleep(15_000);
        lb = await findLoadBalancer(pctx, ref, anon);
      }
      push({
        id: "RR08c",
        title: `read-replicas/setup ${REGION} (primary ${REGION}); replica host; load balancer host`,
        status: lb.url && replicaUp.node === "replica" ? "pass" : "fail",
        detail: san(`setup ${attempts[attempts.length - 1]!.replace(/\s+$/, "")}; first session connection after ${servedS}s; replica host rr_node ${replicaUp.node ?? "not serving"}; load balancer ${lb.url ? lb.url.replace(/^https:\/\//, "") : "NOT found"}`),
        measurements: { setup_http: setup.status, served_after_s: servedS },
        evidence: san(attempts.join("\n")),
      });
      if (!lb.url || replicaUp.node !== "replica") return out;
      const lbBase = lb.url;

      /* ---- shared measurement pieces ---- */

      /** pg_settings and postmaster start on one node, over a fresh session connection. */
      const nodeSettings = async (e: PoolerEntry) => {
        const c = pgClient(e, dbPass, 15_000);
        try {
          await c.connect();
          const r = await c.query<{ name: string; setting: string; unit: string | null; source: string }>(
            "select name, setting, unit, source from pg_settings where name in ('max_standby_streaming_delay','hot_standby_feedback','statement_timeout','autovacuum')",
          );
          const pm = await c.query<{ pm: string }>("select extract(epoch from pg_postmaster_start_time())::bigint::text as pm");
          const s: Record<string, string> = {};
          for (const x of r.rows) s[x.name] = `${x.setting}${x.unit ?? ""} (${x.source})`;
          return { s, pm: Number(pm.rows[0]!.pm) };
        } finally {
          await c.end().catch(() => {});
        }
      };
      /** Role-level statement_timeout of the API roles (pg_db_role_setting), read on one node. */
      const roleTimeouts = async (e: PoolerEntry) => {
        const c = pgClient(e, dbPass, 15_000);
        try {
          await c.connect();
          const r = await c.query<{ rolname: string; cfg: string }>(
            "select r.rolname, array_to_string(s.setconfig, ',') as cfg from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname in ('anon','authenticated','authenticator','service_role')",
          );
          return r.rows.map((x) => `${x.rolname}: ${x.cfg}`).join("; ") || "none";
        } catch (e) {
          return `error ${errText(e).slice(0, 80)}`;
        } finally {
          await c.end().catch(() => {});
        }
      };

      /** PUT config/database/postgres merged over the current overrides (as the CLI does), then read back on both nodes until they match. */
      const applyConfig = async (id: string, changes: Record<string, string | boolean>, expect: { delayMs: number; feedback: "on" | "off" }) => {
        const before = await mgmt(pctx, "GET", `/projects/${ref}/config/database/postgres`);
        const cur = (before.json ?? {}) as Record<string, unknown>;
        const pmBefore = { primary: await nodeSettings(primaryEntry).then((x) => x.pm).catch(() => 0), replica: await nodeSettings(replicaEntry).then((x) => x.pm).catch(() => 0) };
        const tPut = Date.now();
        const put = await mgmt(pctx, "PUT", `/projects/${ref}/config/database/postgres`, { ...cur, ...changes });
        const after = await mgmt(pctx, "GET", `/projects/${ref}/config/database/postgres`);
        const want = (s: Record<string, string>) => s.max_standby_streaming_delay?.startsWith(`${expect.delayMs}ms`) && s.hot_standby_feedback?.startsWith(expect.feedback);
        const seen: Record<string, string> = {};
        const matchedAt: Record<string, number | string> = { primary: "never", replica: "never" };
        const pmAfter: Record<string, number> = { primary: 0, replica: 0 };
        const trail: string[] = [];
        while (Date.now() - tPut < 6 * 60_000 && (matchedAt.primary === "never" || matchedAt.replica === "never")) {
          await sleep(10_000);
          for (const [lbl, e] of [["primary", primaryEntry], ["replica", replicaEntry]] as const) {
            if (matchedAt[lbl] !== "never") continue;
            try {
              const x = await nodeSettings(e);
              pmAfter[lbl] = x.pm;
              seen[lbl] = `delay ${x.s.max_standby_streaming_delay}, feedback ${x.s.hot_standby_feedback}`;
              if (want(x.s)) matchedAt[lbl] = Math.round((Date.now() - tPut) / 1000);
            } catch (err) {
              seen[lbl] = `error ${errText(err).slice(0, 60)}`;
            }
          }
          trail.push(`+${Math.round((Date.now() - tPut) / 1000)}s primary: ${seen.primary} | replica: ${seen.replica}`);
        }
        const proj = await mgmt(pctx, "GET", `/projects/${ref}`);
        const status = String((proj.json as { status?: string } | undefined)?.status ?? proj.status);
        const restarted = (l: "primary" | "replica") => (pmAfter[l] && pmBefore[l] ? (pmAfter[l] !== pmBefore[l] ? "yes" : "no") : "unknown");
        const cfg = (r: typeof before, k: string) => String((r.json as Record<string, unknown> | undefined)?.[k] ?? "(unset)");
        const m: Record<string, string | number> = {
          put_http: put.status,
          put_body: Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(" "),
          config_before: `delay ${cfg(before, "max_standby_streaming_delay")}, feedback ${cfg(before, "hot_standby_feedback")}`,
          config_after: `delay ${cfg(after, "max_standby_streaming_delay")}, feedback ${cfg(after, "hot_standby_feedback")}`,
          primary_read_back: seen.primary ?? "none",
          replica_read_back: seen.replica ?? "none",
          primary_matched_after_s: matchedAt.primary!,
          replica_matched_after_s: matchedAt.replica!,
          primary_restarted: restarted("primary"),
          replica_restarted: restarted("replica"),
          project_status: status,
        };
        push({
          id,
          title: `PUT config/database/postgres ${m.put_body} (merged over current overrides); read back with pg_settings on both nodes`,
          status: put.status < 300 && matchedAt.replica !== "never" && matchedAt.primary !== "never" ? "pass" : "fail",
          detail: `PUT HTTP ${put.status}${put.status < 300 ? "" : ` ${san(put.text.slice(0, 160))}`}; primary ${m.primary_read_back} (matched after ${m.primary_matched_after_s} s, restarted ${m.primary_restarted}); replica ${m.replica_read_back} (matched after ${m.replica_matched_after_s} s, restarted ${m.replica_restarted}); project ${status}`,
          measurements: m,
          evidence: trail.join("\n"),
        });
        // Wait until the replica host serves again (a restart would interrupt it).
        const tb = Date.now();
        while (Date.now() - tb < 5 * 60_000) {
          const n = await fetch(`${replicaBase}/rest/v1/rpc/rr_node`, { headers: A, signal: AbortSignal.timeout(5000) })
            .then(async (r) => parseNode(r.status, await r.text()))
            .catch(() => ({ node: undefined, staleMs: undefined }));
          // No heartbeat runs between arms, so stale_ms only grows here: wait for the
          // replica to serve, not to be fresh (the 2026-10-28 runs waited the full 5 min).
          if (n.node === "replica") break;
          await sleep(3000);
        }
        return matchedAt.replica !== "never";
      };

      /** Table stats on the primary. */
      const tableStats = async (c: Client) => {
        const r = await c.query<Record<string, string>>(
          `select n_dead_tup::text as dead, n_live_tup::text as live, (pg_relation_size('public.rr8_items') / 1048576.0)::text as heap_mb,
                  (pg_total_relation_size('public.rr8_items') / 1048576.0)::text as total_mb, vacuum_count::text as vac, autovacuum_count::text as autovac
           from pg_stat_user_tables where relid = 'public.rr8_items'::regclass`,
        );
        const x = r.rows[0] ?? {};
        return { dead: Number(x.dead), live: Number(x.live), heapMb: round(Number(x.heap_mb), 1), totalMb: round(Number(x.total_mb), 1), vac: Number(x.vac), autovac: Number(x.autovac) };
      };
      const conflictStats = async () => {
        const c = pgClient(replicaEntry, dbPass, 15_000);
        try {
          await c.connect();
          const r = await c.query<Record<string, string>>(
            "select confl_snapshot::text as snapshot, confl_lock::text as lock, confl_bufferpin::text as bufferpin, confl_deadlock::text as deadlock, confl_tablespace::text as tablespace from pg_stat_database_conflicts where datname = current_database()",
          );
          const x = r.rows[0] ?? {};
          return { snapshot: Number(x.snapshot), lock: Number(x.lock), bufferpin: Number(x.bufferpin), deadlock: Number(x.deadlock) };
        } catch {
          return null;
        } finally {
          await c.end().catch(() => {});
        }
      };

      interface ArmSpec {
        id: string;
        label: string;
        durS: number;
        readers: boolean;
        writer: boolean;
        vacuum: boolean;
        locks: number;
        longQueryS?: number;
      }

      const runArm = async (spec: ArmSpec) => {
        // Reset between arms: plain VACUUM on the primary with no readers, then let the replica catch up.
        const admin = pgClient(primaryEntry, dbPass, 120_000);
        await admin.connect();
        await admin.query("set statement_timeout = 0");
        if (spec.writer) await admin.query("vacuum public.rr8_items").catch(() => {});
        await sleep(5000);
        const cfgNow = { primary: await nodeSettings(primaryEntry).catch(() => null), replica: await nodeSettings(replicaEntry).catch(() => null) };
        const pre = await tableStats(admin);
        const conflPre = await conflictStats();
        const jwt = spec.readers ? await signIn() : "";
        const U = { apikey: anon, Authorization: `Bearer ${jwt}` };

        const t0 = Date.now();
        const now = () => Date.now() - t0;
        const marks: string[] = [];
        const mark = (s: string) => marks.push(`+${round(now() / 1000, 1)}s ${s}`);
        let stopAll = false;

        // Heartbeat (4 inserts/s) on the primary.
        const hb = loopOn(primaryEntry, dbPass, HEARTBEAT_MS, async (c) => {
          await c.query("insert into public.rr_marker(tag) values ('hb')");
        }, 10_000);
        // Staleness poller: rr_node (anon, reads rr_marker only) on the replica and primary hosts.
        const stalePts: { replica: { t: number; staleMs: number }[]; primary: { t: number; staleMs: number }[] } = { replica: [], primary: [] };
        let pollFails = 0;
        const pollers = (["replica", "primary"] as const).map((which) =>
          (async () => {
            const base = which === "replica" ? replicaBase : primaryBase;
            // Before the first heartbeat lands, rr_node reads the previous arm's last
            // row: the 2026-10-28 runs (polls from t = 0) carry that as one 0.5 s
            // "episode" of 5 to 319 s at the start of an arm.
            await sleep(1500);
            while (!stopAll) {
              const ts = performance.now();
              const n = await fetch(`${base}/rest/v1/rpc/rr_node`, { headers: A, signal: AbortSignal.timeout(5000) })
                .then(async (r) => parseNode(r.status, await r.text()))
                .catch(() => ({ node: undefined, staleMs: undefined }));
              if (n.staleMs !== undefined && n.node) stalePts[which].push({ t: now(), staleMs: n.staleMs });
              else pollFails++;
              const wait = POLL_MS - (performance.now() - ts);
              if (wait > 0) await sleep(wait);
            }
          })(),
        );
        // Lag and xmin monitor on the primary every second.
        const lag: { replayMs: number[]; replayBytes: number[]; bxAge: number[]; slotAge: number[]; localAge: number[]; dead: number[] } = {
          replayMs: [],
          replayBytes: [],
          bxAge: [],
          slotAge: [],
          localAge: [],
          dead: [],
        };
        const lagMon = loopOn(primaryEntry, dbPass, 1000, async (c) => {
          const r = await c.query<Record<string, string | null>>(
            `select (extract(epoch from sr.replay_lag) * 1000)::text as replay_ms,
                    pg_wal_lsn_diff(pg_current_wal_lsn(), sr.replay_lsn)::text as replay_bytes,
                    age(sr.backend_xmin)::text as bx_age,
                    (select max(age(xmin))::text from pg_replication_slots where xmin is not null) as slot_age,
                    (select max(age(backend_xmin))::text from pg_stat_activity where backend_xmin is not null and pid <> pg_backend_pid() and backend_type = 'client backend') as local_age,
                    (select n_dead_tup::text from pg_stat_user_tables where relid = 'public.rr8_items'::regclass) as dead
             from pg_stat_replication sr limit 1`,
          );
          const x = r.rows[0];
          if (!x) return;
          if (x.replay_ms != null) lag.replayMs.push(Number(x.replay_ms));
          if (x.replay_bytes != null) lag.replayBytes.push(Number(x.replay_bytes));
          if (x.bx_age != null) lag.bxAge.push(Number(x.bx_age));
          if (x.slot_age != null) lag.slotAge.push(Number(x.slot_age));
          if (x.local_age != null) lag.localAge.push(Number(x.local_age));
          if (x.dead != null) lag.dead.push(Number(x.dead));
        });
        // Updater: UPDATE_BATCH rows every UPDATE_EVERY_MS, walking the id range.
        let lo = 0;
        let updated = 0;
        const writer = spec.writer
          ? loopOn(primaryEntry, dbPass, UPDATE_EVERY_MS, async (c) => {
              const r = await c.query(`update public.rr8_items set v = v + 1 where id > ${lo} and id <= ${lo + UPDATE_BATCH}`);
              updated += r.rowCount ?? 0;
              lo = (lo + UPDATE_BATCH) % ROWS;
            })
          : null;
        // VACUUM VERBOSE every VACUUM_EVERY_S on the primary.
        const vacs: (VacuumTuples & { t: number; ms: number })[] = [];
        const vacErrs: string[] = [];
        const vacuumLoop = spec.vacuum
          ? (async () => {
              const c = pgClient(primaryEntry, dbPass, 120_000);
              let notices = "";
              c.on("notice", (n: { message?: string }) => (notices += `${n.message ?? ""}\n`));
              try {
                await c.connect();
                await c.query("set statement_timeout = 0");
                while (!stopAll) {
                  await sleep(VACUUM_EVERY_S * 1000);
                  if (stopAll) break;
                  notices = "";
                  const ts = performance.now();
                  try {
                    await c.query("vacuum (verbose) public.rr8_items");
                    const v = parseVacuumVerbose(notices);
                    if (v) vacs.push({ ...v, t: now(), ms: round(performance.now() - ts, 0) });
                    else vacErrs.push(`no tuples line: ${notices.replace(/\s+/g, " ").slice(0, 100)}`);
                  } catch (e) {
                    vacErrs.push(errText(e).slice(0, 80));
                  }
                }
              } catch (e) {
                vacErrs.push(`connect ${errText(e).slice(0, 80)}`);
              } finally {
                await c.end().catch(() => {});
              }
            })()
          : null;
        // Brief ACCESS EXCLUSIVE locks on the primary.
        const lockRecs: string[] = [];
        const lockLoop = spec.locks
          ? (async () => {
              const c = pgClient(primaryEntry, dbPass, 60_000);
              try {
                await c.connect();
                const every = (spec.durS * 1000) / (spec.locks + 1);
                for (let i = 0; i < spec.locks && !stopAll; i++) {
                  await sleep(every);
                  const ts = performance.now();
                  try {
                    await c.query("begin");
                    await c.query("lock table public.rr8_items in access exclusive mode");
                    const got = round(performance.now() - ts, 0);
                    await c.query("select pg_sleep(0.2)");
                    await c.query("commit");
                    mark(`lock ${i + 1}: acquired on the primary after ${got} ms, committed`);
                    lockRecs.push(`acquired ${got} ms`);
                  } catch (e) {
                    await c.query("rollback").catch(() => {});
                    mark(`lock ${i + 1}: error ${errText(e).slice(0, 80)}`);
                    lockRecs.push(`error`);
                  }
                }
              } catch (e) {
                mark(`lock connect ${errText(e).slice(0, 80)}`);
              } finally {
                await c.end().catch(() => {});
              }
            })()
          : null;
        // One long replica transaction (feedback's bloat cost for a long query).
        let longQ = "not run";
        const longLoop = spec.longQueryS
          ? (async () => {
              const c = pgClient(replicaEntry, dbPass, (spec.longQueryS! + 60) * 1000);
              try {
                await sleep(15_000);
                await c.connect();
                await c.query("set statement_timeout = 0");
                await c.query("begin isolation level repeatable read");
                await c.query("select count(*) from public.rr8_items");
                const ts = performance.now();
                mark(`long replica transaction: snapshot taken, pg_sleep(${spec.longQueryS})`);
                await c.query(`select pg_sleep(${spec.longQueryS})`);
                await c.query("commit");
                longQ = `ran its ${spec.longQueryS} s (${round((performance.now() - ts) / 1000, 1)} s)`;
                mark("long replica transaction: committed");
              } catch (e) {
                longQ = `${String((e as { code?: string }).code ?? "")} ${errText(e).slice(0, 100)}`;
                mark(`long replica transaction: ${longQ}`);
              } finally {
                await c.end().catch(() => {});
              }
            })()
          : null;
        // Readers: back-to-back list reads on the replica host and through -all.
        const reads: ReadRec[] = [];
        const readerLoops = spec.readers
          ? ([...Array(READERS).fill(["replica", replicaBase]), ...Array(READERS).fill(["lb", lbBase])] as [string, string][]).map(([src, base], i) =>
              (async () => {
                await sleep(i * 300);
                while (!stopAll) {
                  const planned = READ_MIN_MS + Math.floor(Math.random() * (READ_MAX_MS - READ_MIN_MS));
                  const tStart = now();
                  const ts = performance.now();
                  let status = 0;
                  let text = "";
                  let ferr: string | undefined;
                  try {
                    const r = await fetch(`${base}/rest/v1/rpc/rr8_list?p_ms=${planned}`, { headers: U, signal: AbortSignal.timeout(30_000) });
                    status = r.status;
                    text = await r.text();
                  } catch (e) {
                    ferr = errText(e).slice(0, 80);
                  }
                  reads.push({ t: tStart, src, planned, ms: round(performance.now() - ts, 0), status, ...classifyRead(status, text, ferr) });
                }
              })(),
            )
          : [];

        await sleep(spec.durS * 1000);
        stopAll = true;
        await Promise.all([...readerLoops, ...pollers, vacuumLoop, lockLoop, longLoop].filter(Boolean));
        const wr = writer ? await writer.stop() : null;
        const lagR = await lagMon.stop();
        const hbR = await hb.stop();
        const post = await tableStats(admin);
        await admin.end().catch(() => {});
        const conflPost = await conflictStats();

        // ---- summarise ----
        const m: Record<string, string | number> = {
          arm: spec.label,
          duration_s: spec.durS,
          replica_settings: cfgNow.replica ? `delay ${cfgNow.replica.s.max_standby_streaming_delay}, feedback ${cfgNow.replica.s.hot_standby_feedback}` : "unread",
          primary_settings: cfgNow.primary ? `delay ${cfgNow.primary.s.max_standby_streaming_delay}, feedback ${cfgNow.primary.s.hot_standby_feedback}` : "unread",
        };
        for (const src of ["replica", "lb"]) {
          const rs = reads.filter((r) => r.src === src);
          if (!rs.length) continue;
          const okR = rs.filter((r) => r.kind === "ok");
          m[`${src}_reads`] = rs.length;
          m[`${src}_ok_replica`] = okR.filter((r) => r.node === "replica").length;
          m[`${src}_ok_primary`] = okR.filter((r) => r.node === "primary").length;
          m[`${src}_40001`] = rs.filter((r) => r.kind === "40001").length;
          m[`${src}_57014`] = rs.filter((r) => r.kind === "57014").length;
          m[`${src}_other`] = rs.filter((r) => r.kind === "other").length;
          m[`${src}_failed_pct`] = round((100 * (rs.length - okR.length)) / rs.length, 1);
          m[`${src}_error_texts`] = tallyBy(rs.filter((r) => r.kind !== "ok").map((r) => `${r.kind} HTTP ${r.status} ${r.text ?? ""}`.trim()));
          const lat = statsOf(okR.filter((r) => r.node === "replica").map((r) => r.ms), 0);
          m[`${src}_replica_ok_ms_p50`] = lat.p50;
          m[`${src}_replica_ok_ms_max`] = lat.max;
          const okReplicaOverrun = okR.filter((r) => r.node === "replica").map((r) => r.ms - r.planned);
          m[`${src}_replica_ok_overrun_ms_p95`] = statsOf(okReplicaOverrun, 0).p95;
          const failMs = rs.filter((r) => r.kind !== "ok").map((r) => r.ms);
          m[`${src}_failed_after_ms_p50`] = statsOf(failMs, 0).p50;
          m[`${src}_failed_after_ms_max`] = statsOf(failMs, 0).max;
          // Data age at query start for replica-served reads.
          m[`${src}_replica_read_stale_ms_max`] = statsOf(okR.filter((r) => r.node === "replica" && r.staleMs !== undefined).map((r) => r.staleMs!), 0).max;
        }
        const rep = stalePts.replica.map((p) => p.staleMs);
        const prim = stalePts.primary.map((p) => p.staleMs);
        const sR = statsOf(rep, 0);
        const sP = statsOf(prim, 0);
        const eps = staleEpisodes(stalePts.replica, STALE_MS);
        m.hb_replica_stale_ms_p50 = sR.p50;
        m.hb_replica_stale_ms_p95 = sR.p95;
        m.hb_replica_stale_ms_max = sR.max;
        m.hb_primary_stale_ms_p50 = sP.p50;
        m.hb_primary_stale_ms_max = sP.max;
        m.hb_polls = rep.length;
        m.hb_poll_failures = pollFails;
        m.stale_episodes = eps.length;
        m.stale_episode_s = eps.map((e) => round((e.endT - e.startT) / 1000 + POLL_MS / 1000, 1)).join(" ") || "none";
        m.stale_episode_max_ms = eps.map((e) => e.maxStaleMs).join(" ") || "none";
        m.stale_time_pct = rep.length ? round((100 * rep.filter((x) => x > STALE_MS).length) / rep.length, 1) : "none";
        const rl = statsOf(lag.replayMs, 1);
        m.replay_lag_ms_p50 = rl.p50;
        m.replay_lag_ms_p95 = rl.p95;
        m.replay_lag_ms_max = rl.max;
        m.replay_bytes_max = statsOf(lag.replayBytes, 0).max;
        m.replica_xmin_age_max_xids = statsOf(lag.bxAge, 0).max;
        m.replica_xmin_seen = `${lag.bxAge.length} of ${lagR.ok}`;
        m.slot_xmin_age_max_xids = statsOf(lag.slotAge, 0).max;
        m.primary_backend_xmin_age_max_xids = statsOf(lag.localAge, 0).max;
        m.dead_tup_pre = pre.dead;
        m.dead_tup_post = post.dead;
        m.dead_tup_max_sampled = statsOf(lag.dead, 0).max;
        m.heap_mb_pre = pre.heapMb;
        m.heap_mb_post = post.heapMb;
        m.heap_growth_mb = round(post.heapMb - pre.heapMb, 1);
        m.total_mb_post = post.totalMb;
        m.autovacuum_runs = post.autovac - pre.autovac;
        m.rows_updated = updated;
        m.update_rows_per_s = wr ? round(updated / spec.durS, 0) : 0;
        m.writer_errors = wr ? `${wr.errors} ${wr.errors ? wr.errs : ""}`.trim() : "n/a";
        m.vacuums = vacs.length;
        m.vacuum_removed = vacs.map((v) => v.removed).join(" ") || "none";
        m.vacuum_not_removable = vacs.map((v) => v.notRemovable).join(" ") || "none";
        m.vacuum_not_removable_max = statsOf(vacs.map((v) => v.notRemovable), 0).max;
        m.vacuum_cutoff_age_xids = vacs.map((v) => v.cutoffAgeXids ?? "?").join(" ") || "none";
        m.vacuum_errors = tallyBy(vacErrs);
        m.heartbeat_rows = hbR.ok;
        m.heartbeat_errors = hbR.errors;
        if (conflPre && conflPost) {
          m.confl_snapshot_delta = conflPost.snapshot - conflPre.snapshot;
          m.confl_lock_delta = conflPost.lock - conflPre.lock;
          m.confl_bufferpin_delta = conflPost.bufferpin - conflPre.bufferpin;
        } else m.confl_delta = "unread";
        if (spec.locks) m.locks = lockRecs.join("; ");
        if (spec.longQueryS) m.long_replica_txn = longQ;

        const r = (s: string) => (m[`${s}_reads`] !== undefined ? `${s} host ${m[`${s}_reads`]} reads: ok replica ${m[`${s}_ok_replica`]} / primary ${m[`${s}_ok_primary`]}, 40001 ${m[`${s}_40001`]}, 57014 ${m[`${s}_57014`]}, other ${m[`${s}_other`]}` : "");
        push({
          id: spec.id,
          title: `${spec.label}: ${spec.readers ? `${READERS}+${READERS} readers (replica host, -all) of ${READ_MIN_MS / 1000}-${READ_MAX_MS / 1000} s` : "no readers"}${spec.writer ? `; ${UPDATE_BATCH} rows updated every ${UPDATE_EVERY_MS} ms` : ""}${spec.vacuum ? `; VACUUM VERBOSE every ${VACUUM_EVERY_S} s` : ""}${spec.locks ? `; ${spec.locks} ACCESS EXCLUSIVE locks` : ""}${spec.longQueryS ? `; one ${spec.longQueryS} s replica transaction` : ""}; ${spec.durS} s`,
          status: "info",
          detail: [
            `replica ${m.replica_settings}`,
            r("replica"),
            r("lb"),
            `heartbeat age on replica host p50 ${m.hb_replica_stale_ms_p50} p95 ${m.hb_replica_stale_ms_p95} max ${m.hb_replica_stale_ms_max} ms; stale episodes ${m.stale_episodes} (${m.stale_episode_s} s)`,
            `replay_lag p95 ${m.replay_lag_ms_p95} max ${m.replay_lag_ms_max} ms`,
            spec.writer ? `dead tuples ${m.dead_tup_pre} -> ${m.dead_tup_post} (max ${m.dead_tup_max_sampled}); heap ${m.heap_mb_pre} -> ${m.heap_mb_post} MB; vacuum not removable ${m.vacuum_not_removable}; replica xmin age max ${m.replica_xmin_age_max_xids}` : "",
            spec.longQueryS ? `long txn ${longQ}` : "",
          ]
            .filter(Boolean)
            .join("; "),
          measurements: m,
          evidence: [
            `marks: ${marks.join(" | ") || "none"}`,
            `vacuums (t s, removed / remain / not removable, cutoff age xids, ms): ${vacs.map((v) => `${round(v.t / 1000, 0)}: ${v.removed}/${v.remain}/${v.notRemovable} ${v.cutoffAgeXids ?? "?"} ${v.ms}`).join(" | ") || "none"}`,
            `stale episodes (start s, end s, max ms): ${eps.map((e) => `${round(e.startT / 1000, 1)}-${round(e.endT / 1000, 1)} ${e.maxStaleMs}`).join(" | ") || "none"}`,
            "failed reads (t s, src, planned ms, took ms, kind, text):",
            ...reads.filter((x) => x.kind !== "ok").slice(0, 200).map((x) => `${round(x.t / 1000, 1)} ${x.src} ${x.planned} ${x.ms} ${x.kind} ${x.text ?? ""}`),
            "replica host heartbeat age, 10 s buckets (max ms):",
            bucketMax(stalePts.replica, 10_000),
          ].join("\n"),
        });
      };

      /* ---- RR08d: steady lag (#276) ---- */
      const roles = await roleTimeouts(replicaEntry);
      ctx.log(`role settings on the replica: ${roles}`);
      if (arms.has("steady")) await runArm({ id: "RR08d", label: "steady lag, heartbeat only (4 inserts/s)", durS: STEADY_S, readers: false, writer: false, vacuum: false, locks: 0 });
      if (arms.has("A")) await runArm({ id: "RR08e", label: "arm A defaults, updates + VACUUM", durS: ARM_S, readers: true, writer: true, vacuum: true, locks: 0 });
      if (arms.has("Alock")) await runArm({ id: "RR08f", label: "arm A defaults, ACCESS EXCLUSIVE lock", durS: LOCK_S, readers: true, writer: false, vacuum: false, locks: LOCKS });
      if (arms.has("D") && (await applyConfig("RR08g", { max_standby_streaming_delay: "5s" }, { delayMs: 5000, feedback: "off" })))
        await runArm({ id: "RR08h", label: "arm D max_standby_streaming_delay 5s, updates + VACUUM", durS: ARM_S, readers: true, writer: true, vacuum: true, locks: 0 });
      if (arms.has("C") && (await applyConfig("RR08i", { max_standby_streaming_delay: "120s" }, { delayMs: 120000, feedback: "off" })))
        await runArm({ id: "RR08j", label: "arm C max_standby_streaming_delay 120s, updates + VACUUM", durS: C_S, readers: true, writer: true, vacuum: true, locks: 0 });
      if (arms.has("B") || arms.has("Blong") || arms.has("Block")) {
        if (await applyConfig("RR08k", { max_standby_streaming_delay: "30s", hot_standby_feedback: true }, { delayMs: 30000, feedback: "on" })) {
          if (arms.has("B")) await runArm({ id: "RR08l", label: "arm B hot_standby_feedback on, updates + VACUUM", durS: ARM_S, readers: true, writer: true, vacuum: true, locks: 0 });
          if (arms.has("Blong"))
            await runArm({ id: "RR08m", label: "arm B hot_standby_feedback on, updates + VACUUM + one long replica transaction", durS: LONG_Q_S + 45, readers: true, writer: true, vacuum: true, locks: 0, longQueryS: LONG_Q_S });
          if (arms.has("Block")) await runArm({ id: "RR08n", label: "arm B hot_standby_feedback on, ACCESS EXCLUSIVE lock", durS: LOCK_S, readers: true, writer: false, vacuum: false, locks: LOCKS });
        }
      }
      push({ id: "RR08o", title: "API role settings on the replica (pg_db_role_setting)", status: "info", detail: roles, measurements: { roles } });
    } catch (e) {
      push({ id: "RR08x", title: "module aborted", status: "fail", detail: san(errText(e)) });
    } finally {
      /* ---- RR08p ---- */
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
          id: "RR08p",
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

/** `+0s 120 | +10s 30500 | ...`: largest value per bucket. */
function bucketMax(pts: { t: number; staleMs: number }[], every: number): string {
  const b = new Map<number, number>();
  for (const p of pts) {
    const k = Math.floor(p.t / every);
    b.set(k, Math.max(b.get(k) ?? 0, p.staleMs));
  }
  return [...b.entries()].sort((a, c) => a[0] - c[0]).map(([k, v]) => `+${(k * every) / 1000}s ${v}`).join(" | ");
}

export default mod;
