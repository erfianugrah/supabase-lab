/**
 * RT05 - Subscription bursts: Postgres Changes against its subscription pool,
 * and private Broadcast fed by a database trigger, at increasing burst sizes.
 *
 * Docs claim (https://supabase.com/docs/guides/realtime/settings): the
 * "Postgres Changes connection pool size" (default 2, range 1 to 20) is used
 * only while subscriptions are created; too low and "subscription creation
 * times out during bursts. Clients receive a postgres_changes system error
 * with `Too many database timeouts`". The limits page
 * (https://supabase.com/docs/guides/realtime/limits) gives Pro 500 concurrent
 * connections, 500 channel joins per second and 100 channels per connection,
 * each refused with its own error. The Postgres Changes page says each change
 * is authorised against every subscriber on a single thread, and recommends
 * Broadcast at scale.
 *
 * SIDE: managed. PROJECT: one throwaway project on the Pro org, resized to
 * RT05_COMPUTE (Small, shared CPU, by default). KEY: every WebSocket connects with the anon key and
 * joins with an authenticated user's session access token (password grant,
 * re-issued every 40 minutes); 10 users, round-robin over sockets. Raw
 * protocol frames (lib/burst.ts), one channel per socket, so N subscriptions
 * = N WebSockets, opened at RT05_CONNECT_RATE per second BEFORE the burst;
 * then all N `phx_join` frames are sent at once.
 *
 *   RT05-setup     max_connections (proves the RT05_COMPUTE resize), Realtime ready.
 *   RT05a          Realtime config as the Management API reads it on a new
 *                  project, and whether PATCH accepts and reads back
 *                  postgres_changes_pool (RT05_POOLS, then 21 and 100, above
 *                  the documented 20) and, only if a level exceeds the
 *                  project's max_concurrent_users, that limit. The 21 and 100
 *                  probes run LAST, each followed by a 500-join burst and a
 *                  count of client backends against max_connections plus a
 *                  fresh Management query (does the pool crowd out others).
 *   RT05b-<cfg>-<kind>-<N>-r<k>
 *                  one burst: kind pc (Postgres Changes INSERT on an
 *                  RLS-protected table, membership-table policy) or bc
 *                  (private channel, realtime.messages policy on the same
 *                  membership, rows sent by an AFTER INSERT trigger calling
 *                  realtime.send). Per channel: ready / join_error:<code> /
 *                  pc_error:<message> / sys_error / closed / socket / no_reply
 *                  / no_system. Then canary inserts every 2 s until one
 *                  reaches any channel (first-change-after-subscribe, see
 *                  RUNLOG "Fresh-project warm-up"), then ONE measured insert
 *                  and its arrival on every ready channel (latency from the
 *                  insert's return on the orchestrator, same clock). Realtime's
 *                  own DB connections sampled from pg_stat_activity once a
 *                  second while it settles; pg_postmaster_start_time read
 *                  before and after (postmaster_restarted).
 *                  cfg: `def` = config as created; `lim` = after raising
 *                  max_concurrent_users (only when needed); `pool<k>` = the
 *                  project's config plus postgres_changes_pool k;
 *                  `bound<k>` = the over-range probes.
 *
 * Status is `info` on the burst rows: outcomes are recorded, not graded. The
 * RT05c rows state, per level, whether H1 (pool default -> "Too many database
 * timeouts", raised pool -> none) held.
 *
 * Not settled by this module: Realtime's internal join-rate accounting
 * window; a burst of joins spread over many projects; payload-size effects;
 * filters (`filter=`) per subscriber; sizes other than RT05_COMPUTE; an org whose
 * Realtime limits read differently from this one's; client fleets on many
 * IPs (one orchestrator, one egress address); several channels per socket.
 *
 * DESTRUCTIVE: creates and deletes a project; PATCHes its Realtime config.
 * Knobs: RT05_LEVELS (default 100,500,1000,2000,5000), RT05_REPS (2),
 * RT05_POOLS (1,20), RT05_KINDS (pc,bc), RT05_CONNECT_RATE (100),
 * RT05_SETTLE_MS (60000), RT05_COMPUTE (ci_small; the project is resized to
 * it unless max_connections already reads that size's figure), RT05_BOUNDS
 * (21,100; the over-range pool probes, empty skips them), RT05_BC_LEVELS
 * (every level; the levels the bc kind runs at).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { sql } from "../../../harness/src/platform";
import { runBurst, type BurstResult, type Kind } from "../lib/burst";
import type { Client as PgClient } from "pg";
import { ddl, errText, makeUser, mg, pgConnect, rows, skipWithoutOrg, sleep, waitHealthy, waitRealtime, warmMessages, withProject, type Proj, type TestUser } from "../lib/rt";

const T = "rt05_items";
/** max_connections per compute add-on (compute-disk D01 and data-api-capacity DC01/DC04; xlarge/2xlarge are the docs figures DC13 reads). */
const MAX_CONN: Record<string, number> = { ci_micro: 60, ci_small: 90, ci_medium: 120, ci_large: 160, ci_xlarge: 240, ci_2xlarge: 380, ci_4xlarge: 480 };
const envList = (k: string, d: string) => (process.env[k] || d).split(",").map((s) => s.trim()).filter(Boolean);
const envNum = (k: string, d: number) => Number(process.env[k] || d);

const SCHEMA = `
create table if not exists public.rt05_members (tenant_id uuid not null, user_id uuid not null, primary key (tenant_id, user_id));
create table if not exists public.${T} (id bigint generated always as identity primary key, tenant_id uuid not null, body text, created_at timestamptz default now());
alter table public.rt05_members enable row level security;
alter table public.${T} enable row level security;
drop policy if exists rt05_members_self on public.rt05_members;
create policy rt05_members_self on public.rt05_members for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists rt05_items_member on public.${T};
create policy rt05_items_member on public.${T} for select to authenticated
  using (exists (select 1 from public.rt05_members m where m.tenant_id = ${T}.tenant_id and m.user_id = (select auth.uid())));
grant select on public.rt05_members, public.${T} to authenticated;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = '${T}') then
    alter publication supabase_realtime add table public.${T};
  end if;
end $$;
create or replace function public.rt05_bcast() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(jsonb_build_object('id', new.id, 'body', new.body), 'ins', 'rt05:tenant:' || new.tenant_id::text, true);
  return null;
end $$;
drop trigger if exists rt05_bcast on public.${T};
create trigger rt05_bcast after insert on public.${T} for each row execute function public.rt05_bcast();
`;

const BC_POLICY = `
drop policy if exists rt05_bc_read on realtime.messages;
create policy rt05_bc_read on realtime.messages for select to authenticated
  using (exists (select 1 from public.rt05_members m where m.user_id = (select auth.uid()) and (select realtime.topic()) = 'rt05:tenant:' || m.tenant_id::text));
`;

async function passwordToken(p: Proj, u: TestUser): Promise<string> {
  let last = "";
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${p.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: p.anon, "Content-Type": "application/json" },
      body: JSON.stringify({ email: u.email, password: u.password }),
    });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; error_code?: string; msg?: string };
    if (j.access_token) return j.access_token;
    last = `HTTP ${r.status} ${j.error_code ?? j.msg ?? ""}`;
    await sleep(30_000);
  }
  throw new Error(`password grant failed: ${last}`);
}

function flat(r: BurstResult): Record<string, number | string> {
  const m: Record<string, number | string> = {
    sockets_opened: r.socketsOpened,
    channels: r.channels,
    ready: r.ready,
    not_ready: r.channels - r.ready,
    join_to_ready_p50_ms: r.joinToReadyP50,
    join_to_ready_p95_ms: r.joinToReadyP95,
    join_to_ready_max_ms: r.joinToReadyMax,
    burst_wall_ms: r.burstWallMs,
    server_subscriptions: r.serverSubscriptions,
    fanout_delivered: r.fanout.delivered,
    fanout_of: r.fanout.of,
    fanout_p50_ms: r.fanout.p50,
    fanout_p95_ms: r.fanout.p95,
    fanout_max_ms: r.fanout.max,
    insert_ack_ms: r.fanout.insertAckMs,
    canaries_sent: r.canary.sent,
    first_canary_arrived: r.canary.firstArrivedIdx,
    canary_wait_ms: r.canary.waitMs,
    teardown_ms: r.teardownMs,
  };
  for (const [k, v] of Object.entries(r.outcomes)) if (k !== "ready") m[`out_${k}`] = v;
  for (const [k, v] of Object.entries(r.socketOpenFailures)) m[`sockfail_${k}`] = v;
  for (const [k, v] of Object.entries(r.dbConnMax)) m[`dbconn_${k}`] = v;
  return m;
}

const RT_FIELDS = ["private_only", "connection_pool", "postgres_changes_pool", "max_concurrent_users", "max_events_per_second", "max_bytes_per_second", "max_channels_per_client", "max_joins_per_second", "max_presence_events_per_second", "max_payload_size_in_kb", "suspend", "presence_enabled"];

const mod: TestModule = {
  id: "RT05",
  title: "Subscription bursts: Postgres Changes vs its subscription pool, private Broadcast from a trigger",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const put = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id} ${r.status} ${r.detail ?? ""}`.slice(0, 400));
    };
    const skip = skipWithoutOrg(ctx, "RT05", "RT05");
    if (skip) return skip;
    const levels = envList("RT05_LEVELS", "100,500,1000,2000,5000").map(Number);
    const reps = envNum("RT05_REPS", 2);
    const pools = envList("RT05_POOLS", "1,20").map(Number);
    const kinds = envList("RT05_KINDS", "pc,bc") as Kind[];
    const connectRate = envNum("RT05_CONNECT_RATE", 100);
    const settleMs = envNum("RT05_SETTLE_MS", 60_000);
    const compute = process.env.RT05_COMPUTE || "ci_small";
    const wantMc = MAX_CONN[compute] ?? 0;
    const bounds = (process.env.RT05_BOUNDS ?? "21,100").split(",").filter(Boolean).map(Number);
    const bcLevels = process.env.RT05_BC_LEVELS ? envList("RT05_BC_LEVELS", "").map(Number) : null;
    try {
      await withProject(ctx, "rt05", async (p: Proj) => {
        /* ---- compute (RT05_COMPUTE, Small by default) ---- */
        const mc0 = Number((await rows(p, "select setting::int as n from pg_settings where name = 'max_connections'"))[0]?.n ?? 0);
        if (mc0 !== wantMc) {
          const r = await mg(p.ctx, "PATCH", `/projects/${p.ref}/billing/addons`, { addon_type: "compute_instance", addon_variant: compute });
          ctx.log(`resize to ${compute} HTTP ${r.status}`);
          await sleep(30_000);
          await waitHealthy(p.ctx, p.ref, 20 * 60_000);
        }
        let mc = 0;
        for (let i = 0; i < 30 && mc !== wantMc; i++) {
          try {
            mc = Number((await rows(p, "select setting::int as n from pg_settings where name = 'max_connections'"))[0]?.n ?? 0);
          } catch {}
          if (mc !== wantMc) await sleep(10_000);
        }
        const warm = await warmMessages(p);
        await ddl(p, SCHEMA + BC_POLICY);
        const users: TestUser[] = [];
        for (let i = 0; i < 10; i++) users.push(await makeUser(p, `rt05u${i}`));
        const tenant = crypto.randomUUID();
        await ddl(p, `insert into public.rt05_members (tenant_id, user_id) values ${users.map((u) => `('${tenant}', '${u.id}')`).join(",")} on conflict do nothing`);
        const bcTopic = `rt05:tenant:${tenant}`;
        // One pooler session, reopened on failure: a 57P01 on this session
        // during the first dev run killed the process through an unhandled
        // 'error' event. Restarts are recorded per burst (postmaster_restarted).
        let pgc: PgClient | null = null;
        const pg = {
          query: async (text: string, params?: unknown[]) => {
            for (let i = 0; ; i++) {
              try {
                if (!pgc) {
                  pgc = await pgConnect(p);
                  pgc.on("error", () => {
                    pgc = null;
                  });
                }
                return await pgc.query(text, params as never);
              } catch (e) {
                try {
                  await pgc?.end();
                } catch {}
                pgc = null;
                if (i >= 3) throw e;
                await sleep(5000);
              }
            }
          },
          end: async () => {
            try {
              await pgc?.end();
            } catch {}
          },
        };
        const pmStart = async () => String((await pg.query("select pg_postmaster_start_time()::text as t")).rows[0]?.t ?? "");
        const nproc = (await rows(p, "select version() as v"))[0]?.v;
        put({
          id: "RT05-setup",
          title: "RT05-setup: compute, versions, readiness",
          status: mc === wantMc ? "info" : "fail",
          detail: `${compute}: max_connections ${mc} (expected ${wantMc}); realtime join ready after ${warm.realtimeReadyMs} ms; ${String(nproc).slice(0, 40)}`,
          measurements: { compute, max_connections: mc, max_connections_expected: wantMc, realtime_ready_ms: warm.realtimeReadyMs, users: users.length },
        });

        const readCfg = async () => {
          const r = await mg(p.ctx, "GET", `/projects/${p.ref}/config/realtime`);
          return { status: r.status, json: (r.json ?? {}) as Record<string, unknown> };
        };
        const patchCfg = async (body: Record<string, unknown>) => {
          const r = await mg(p.ctx, "PATCH", `/projects/${p.ref}/config/realtime`, body);
          await sleep(5000);
          const back = await readCfg();
          // a PATCH can restart the tenant; wait for joins to answer again
          const readyMs = await waitRealtime(p, 180_000);
          await sleep(10_000);
          return { status: r.status, text: r.text.slice(0, 200), back: back.json, readyMs };
        };

        /* ---- RT05a: config as created ---- */
        const c0 = await readCfg();
        put({
          id: "RT05a-read",
          title: "RT05a: GET /v1/projects/{ref}/config/realtime on a new Pro project",
          status: c0.status === 200 ? "info" : "fail",
          detail: `HTTP ${c0.status}; ${RT_FIELDS.map((f) => `${f}=${JSON.stringify(c0.json[f])}`).join(" ")}`,
          measurements: Object.fromEntries([["http", c0.status], ...RT_FIELDS.map((f) => [f, String(c0.json[f] ?? "null")])]),
        });

        // Session JWTs live an hour (default jwt_exp); re-issue every 40 min.
        // Re-issuing per burst tripped the password-grant rate limit in a dev
        // run ("password grant failed" after ~10 bursts' worth of sign-ins).
        let tokCache: { t: string[]; at: number } = { t: users.map((u) => u.token), at: Date.now() };
        const tokensFresh = async () => {
          if (Date.now() - tokCache.at < 40 * 60_000) return tokCache.t;
          const t: string[] = [];
          for (const u of users) t.push(await passwordToken(p, u));
          tokCache = { t, at: Date.now() };
          return t;
        };

        const burst = async (cfg: string, kind: Kind, n: number, rep: number) => {
          const tokens = await tokensFresh();
          const pm0 = await pmStart();
          const tag = `rt05${cfg}${kind}${n}r${rep}`;
          const r = await runBurst(
            { host: p.host, anon: p.anon, tokens, kind, sockets: n, channelsPerSocket: 1, connectRate, joinRate: 0, settleMs, table: T, bcTopic, tenantId: tenant, runTag: tag },
            pg,
            ctx.log,
          );
          const pm1 = await pmStart();
          const nonReady = Object.entries(r.outcomes).filter(([k]) => k !== "ready");
          put({
            id: `RT05b-${cfg}-${kind}-${n}-r${rep}`,
            title: `RT05b: ${kind === "pc" ? "Postgres Changes" : "private Broadcast"} burst of ${n} joins, config ${cfg}, rep ${rep}`,
            status: "info",
            detail: `ready ${r.ready}/${r.channels} (sockets ${r.socketsOpened}/${n}); not ready ${nonReady.map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; join->ready p50 ${r.joinToReadyP50} p95 ${r.joinToReadyP95} ms; canary ${r.canary.firstArrivedIdx} of ${r.canary.sent} first arrived after ${r.canary.waitMs} ms; fan-out ${r.fanout.delivered}/${r.fanout.of} p50 ${r.fanout.p50} p95 ${r.fanout.p95} max ${r.fanout.max} ms; realtime db conns ${JSON.stringify(r.dbConnMax)}`,
            measurements: { ...flat(r), postmaster_restarted: pm0 === pm1 ? 0 : 1 },
            evidence: Object.entries(r.samples).map(([k, v]) => `${k}: ${v}`).join("\n") || undefined,
          });
          await sleep(10_000);
          return r;
        };

        const results: Array<{ cfg: string; kind: Kind; n: number; r: BurstResult }> = [];
        const runLevels = async (cfg: string, ks: Kind[], ns: number[]) => {
          for (const n of ns)
            for (const kind of ks) {
              if (kind === "bc" && bcLevels && !bcLevels.includes(n)) continue;
              for (let k = 1; k <= reps; k++) results.push({ cfg, kind, n, r: await burst(cfg, kind, n, k) });
            }
        };

        /* ---- defaults: levels within the plan's connection limit ---- */
        const defLimit = Number(c0.json.max_concurrent_users ?? 500) || 500;
        await runLevels("def", kinds, levels.filter((n) => n <= defLimit));

        /* ---- raise the per-project connection limit, only if a level needs it ----
         * Join rate is left as created so the default-pool and raised-pool
         * rows differ in the pool alone. */
        const maxN = Math.max(...levels);
        const needLim = maxN > defLimit;
        const lim = needLim ? await patchCfg({ max_concurrent_users: Math.max(maxN * 2, 1000) }) : { status: 0, text: "", back: c0.json, readyMs: -1 };
        if (needLim) put({
          id: "RT05a-limits",
          title: "RT05a: PATCH max_concurrent_users",
          status: lim.status < 300 ? "info" : "fail",
          detail: `HTTP ${lim.status} ${lim.status >= 300 ? lim.text : ""}; read back max_concurrent_users=${lim.back.max_concurrent_users} max_joins_per_second=${lim.back.max_joins_per_second}; joins answered again after ${lim.readyMs} ms`,
          measurements: { http: lim.status, max_concurrent_users: String(lim.back.max_concurrent_users), max_joins_per_second: String(lim.back.max_joins_per_second), ready_after_ms: lim.readyMs },
        });
        const limOk = needLim && lim.status < 300;
        if (limOk) await runLevels("lim", kinds, levels.filter((n) => n > defLimit));

        /* ---- raised postgres_changes_pool ---- */
        for (const pool of pools) {
          const pr = await patchCfg({ postgres_changes_pool: pool });
          put({
            id: `RT05a-pool${pool}`,
            title: `RT05a: PATCH postgres_changes_pool ${pool}`,
            status: pr.status < 300 ? "info" : "fail",
            detail: `HTTP ${pr.status} ${pr.status >= 300 ? pr.text : ""}; read back postgres_changes_pool=${pr.back.postgres_changes_pool}`,
            measurements: { http: pr.status, postgres_changes_pool: String(pr.back.postgres_changes_pool), ready_after_ms: pr.readyMs },
          });
          if (pr.status < 300 && kinds.includes("pc")) await runLevels(`pool${pool}`, ["pc"], levels.filter((n) => limOk || n <= defLimit));
        }

        /* ---- RT05c: H1 per level ---- */
        const tmdb = (r: BurstResult) => Object.entries(r.outcomes).filter(([k]) => /too many database timeouts/i.test(k)).reduce((a, [, v]) => a + v, 0);
        for (const n of levels) {
          const base = results.filter((x) => x.kind === "pc" && x.n === n && (x.cfg === "def" || x.cfg === "lim"));
          // "raised" = a pool above the documented default of 2; a pool1 row is a lowered-pool probe, reported on its own row
          const raised = results.filter((x) => x.kind === "pc" && x.n === n && x.cfg.startsWith("pool") && Number(x.cfg.slice(4)) > 2);
          if (!base.length) continue;
          const b = base.map((x) => tmdb(x.r));
          const rz = raised.map((x) => tmdb(x.r));
          const held = b.some((v) => v > 0) && rz.length > 0 && rz.every((v) => v === 0);
          put({
            id: `RT05c-${n}`,
            title: `RT05c: H1 at ${n} Postgres Changes joins (default pool -> Too many database timeouts; raised pool -> none)`,
            // info when the default pool produced no timeouts: H1 was not exercised at this level.
            // The 2026-10-22 run graded those rows `fail`; same data, older label.
            status: held ? "pass" : b.every((v) => v === 0) ? "info" : "fail",
            detail: `"Too many database timeouts" per rep at the default pool [${b}], at raised pool(s) ${raised.map((x) => x.cfg)} [${rz}]`,
            measurements: { tmdb_default_reps: b.join("/"), tmdb_raised_reps: rz.join("/") || "-" },
          });
        }

        /* ---- pool bounds the API accepts (docs range 1-20; OpenAPI 1-100) ---- */
        for (const v of bounds) {
          const pr = await patchCfg({ postgres_changes_pool: v });
          put({
            id: `RT05a-bound${v}`,
            title: `RT05a: PATCH postgres_changes_pool ${v} (above the documented 20)`,
            status: "info",
            detail: `HTTP ${pr.status} ${pr.status >= 300 ? pr.text : ""}; read back ${pr.back.postgres_changes_pool}`,
            measurements: { http: pr.status, read_back: String(pr.back.postgres_changes_pool) },
          });
          if (pr.status >= 300 || !kinds.includes("pc")) continue;
          // What the accepted value does on Small (max_connections 90): a 500-join
          // burst, then a fresh connection through the Management query endpoint.
          await burst(`bound${v}`, "pc", 500, 1);
          let backends = -1;
          try {
            backends = Number((await pg.query("select count(*)::int as n from pg_stat_activity where backend_type = 'client backend'")).rows[0].n);
          } catch {}
          const probe = await sql(p.ctx, "select 1 as ok");
          put({
            id: `RT05a-bound${v}-conns`,
            title: `RT05a: database connections after a 500-join burst at postgres_changes_pool ${v}`,
            status: "info",
            detail: `client backends ${backends} of max_connections ${mc}; Management query endpoint HTTP ${probe.status}${probe.error ? ` ${String(probe.error).slice(0, 120)}` : ""}`,
            measurements: { client_backends: backends, max_connections: mc, query_endpoint_http: probe.status },
            evidence: probe.error ? String(probe.error).slice(0, 300) : undefined,
          });
        }
        await pg.end();
      });
    } catch (e) {
      put({ id: "RT05", title: "RT05", status: "fail", detail: `module threw: ${errText(e)}` });
    }
    return out;
  },
};
export default mod;
