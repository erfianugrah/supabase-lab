/**
 * RT06 - Join and delivery cost of an unfiltered vs a per-user filtered
 * Postgres Changes binding at 5000 subscribers, and the database cost per
 * message of private per-user Broadcast sent with realtime.send.
 *
 * Question (an app with per-user notifications): a load test put 5000
 * clients on ONE shared public topic, each with an unfiltered INSERT binding
 * on an RLS-protected notifications table (shape A). The app itself gives
 * each user its own channel with one INSERT binding filtered by
 * `user_id=eq.<uid>` (shape B). Does the load-test shape measure the app's
 * join cost? And what does per-user private Broadcast (`user:<uid>` topics,
 * a realtime.messages policy tying realtime.topic() to auth.uid(), rows sent
 * with realtime.send) cost the database per message?
 *
 * Docs claims (https://supabase.com/docs/guides/realtime/postgres-changes):
 * "Postgres Changes authorizes every event against each subscriber. When you
 * make a single change to a table with 100 subscribed users, Realtime
 * performs 100 authorization checks". The authorization page
 * (https://supabase.com/docs/guides/realtime/authorization): "Client access
 * policies are cached for the duration of the connection. Your database is
 * not queried for every Channel message."
 *
 * SIDE: managed. PROJECT: one throwaway project created at RT06_COMPUTE
 * (`desired_instance_size`, small by default) on the Pro org, Realtime config
 * as created (postgres_changes_pool not set). USERS: RT06_N rows inserted
 * into auth.users with one SQL statement; access tokens minted locally as
 * HS256 under the project's legacy JWT secret (GET /v1/projects/{ref}/postgrest)
 * with sub = the user id, role and aud `authenticated`. RT06-tokens checks a
 * minted token against a password-grant session token on the same binding
 * before anything is measured. Raw protocol frames (lib/peruser.ts), one
 * channel per WebSocket; sockets opened at RT06_CONNECT_RATE per second,
 * then every join sent at once.
 *
 *   RT06-setup     compute, Realtime config as read, user creation time.
 *   RT06-tokens    minted vs session token: both join a filtered binding and
 *                  receive their own row and not the other's (also the
 *                  first-change warm-up a fresh project needs, RUNLOG).
 *   RT06b-<A|B>-<N>-r<k>
 *                  one burst of N joins, shape A or B. Per channel the
 *                  outcome, join->ready p50/p95, first join -> last
 *                  settled; realtime.subscription rows; Realtime's DB
 *                  connections; pg_stat_statements delta for the
 *                  supabase_admin statements that name realtime (join phase
 *                  and delivery phase separately); node CPU from the
 *                  project's metrics endpoint. Then RT06_ROWS rows inserted
 *                  in one statement, spread over RT06_ROWS users that are
 *                  subscribed, and every client's deliveries counted.
 *   RT06c-join     RT06_BC_N private joins on `user:<uid>` topics; policy
 *                  evaluations counted by a sequence the policy calls
 *                  (nextval is not rolled back with the authorization
 *                  transaction).
 *   RT06c-<rate>-r<k>
 *                  RT06_BC_SECS seconds of realtime.send at <rate> messages
 *                  per second, each to the next subscribed user, batched
 *                  per 50 ms tick through `public.rt06_send_batch(jsonb)`
 *                  on up to 4 pooler sessions. Delivered to the intended
 *                  client, misdelivered, latency (send issued -> arrival),
 *                  per-message statement time from pg_stat_statements,
 *                  realtime.messages rows and size, policy evaluations
 *                  during the sends.
 *   RT06-cpu       node CPU busy share per phase, written after a 75 s wait
 *                  so the metrics endpoint's cached snapshot (it moved about
 *                  once a minute) has passed the last phase; coarse.
 *
 * Status is `info` throughout except RT06-tokens (pass when both tokens get
 * exactly their own row). Not settled: a permissive policy under shape A
 * (every client receives every row), more than one client address, several
 * channels per socket, Realtime's own CPU (not readable), the join and send
 * phases at a pool other than as created.
 *
 * DESTRUCTIVE: creates and deletes a project.
 * Knobs: RT06_COMPUTE (small), RT06_N (5000), RT06_REPS (2), RT06_SHAPES
 * (A,B), RT06_ROWS (20), RT06_CONNECT_RATE (100), RT06_SETTLE_MS (60000),
 * RT06_BC_N (5000; 0 skips the Broadcast part), RT06_BC_RATES (50,200),
 * RT06_BC_SECS (60).
 */
import { createHmac } from "node:crypto";
import type { Client as PgClient } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { closeFleet, joinAll, openFleet, pct, type Cli, type JoinSummary } from "../lib/peruser";
import { ddl, errText, makeUser, mg, pgConnect, rows, skipWithoutOrg, sleep, warmMessages, withProject, type Proj } from "../lib/rt";

const T = "rt06_notifications";
const envList = (k: string, d: string) => (process.env[k] || d).split(",").map((s) => s.trim()).filter(Boolean);
const envNum = (k: string, d: number) => (process.env[k] === undefined || process.env[k] === "" ? d : Number(process.env[k]));

const SCHEMA = `
create table if not exists public.${T} (id bigint generated always as identity primary key, user_id uuid not null, body text not null, created_at timestamptz default now());
create index if not exists ${T}_user on public.${T} (user_id);
alter table public.${T} enable row level security;
drop policy if exists rt06_own on public.${T};
create policy rt06_own on public.${T} for select to authenticated using (user_id = (select auth.uid()));
grant select on public.${T} to authenticated;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = '${T}') then
    alter publication supabase_realtime add table public.${T};
  end if;
end $$;
create sequence if not exists public.rt06_policy_calls;
create or replace function public.rt06_policy_hit() returns boolean language sql volatile security definer set search_path = '' as $$
  select nextval('public.rt06_policy_calls') > 0
$$;
drop policy if exists rt06_user_read on realtime.messages;
create policy rt06_user_read on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and (select realtime.topic()) = 'user:' || (select auth.uid())::text and public.rt06_policy_hit());
create or replace function public.rt06_send_batch(msgs jsonb) returns int language plpgsql as $$
declare x record; n int := 0;
begin
  for x in select * from jsonb_to_recordset(msgs) as t(p jsonb, topic text) loop
    perform realtime.send(x.p, 'note', x.topic, true);
    n := n + 1;
  end loop;
  return n;
end $$;
`;

function b64u(b: Buffer | string) {
  return Buffer.from(b).toString("base64url");
}
function mintHs256(secret: string, payload: Record<string, unknown>): string {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${b64u(createHmac("sha256", secret).update(`${h}.${p}`).digest())}`;
}

/** node_cpu_seconds_total from the project's metrics endpoint (cached snapshot, see data-api-capacity lib/metrics.ts). */
interface CpuSnap {
  t: number;
  busy: number;
  idle: number;
  cpus: number;
}
let lastScrape = "";
async function scrapeCpu(p: Proj): Promise<CpuSnap | null> {
  try {
    const res = await fetch(`${p.url}/customer/v1/privileged/metrics`, {
      headers: { Authorization: `Basic ${Buffer.from(`service_role:${p.service}`).toString("base64")}` },
      signal: AbortSignal.timeout(8000),
    });
    lastScrape = `HTTP ${res.status}`;
    if (!res.ok) return null;
    const s: CpuSnap = { t: Date.now(), busy: 0, idle: 0, cpus: 0 };
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("node_cpu_seconds_total")) continue;
      const v = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (line.includes('mode="idle"')) {
        s.idle += v;
        s.cpus++;
      } else if (!line.includes('mode="steal"') && !line.includes('mode="guest')) s.busy += v;
    }
    lastScrape += ` cpus ${s.cpus}`;
    return s.cpus ? s : null;
  } catch (e) {
    lastScrape = `error ${String(e).slice(0, 60)}`;
    return null;
  }
}
/**
 * Background sampler: scrape every 5 s, keep a snapshot only when the counters
 * moved (the endpoint serves a cached snapshot, DC05). A window's CPU is taken
 * between the first moved snapshot seen at or after its start and the first
 * seen at or after its end, so it is shifted by up to the cache age: coarse,
 * and only meaningful over windows of a minute or more.
 */
function cpuSampler(p: Proj) {
  const snaps: CpuSnap[] = [];
  let stop = false;
  (async () => {
    while (!stop) {
      const s = await scrapeCpu(p);
      const last = snaps[snaps.length - 1];
      if (s && (!last || s.busy + s.idle !== last.busy + last.idle)) snaps.push(s);
      await sleep(5000);
    }
  })();
  const phases: Array<{ label: string; t0: number; t1: number }> = [];
  return {
    window: (t0: number, t1: number) => cpuPct(snaps.find((s) => s.t >= t0) ?? null, snaps.find((s) => s.t >= t1) ?? null),
    phase: (label: string, t0: number, t1: number) => phases.push({ label, t0, t1 }),
    phases: () => phases,
    /** busy % between consecutive moved snapshots, as `+<s from t0>..+<s>: <pct>%` */
    series: (t0: number) =>
      snaps.slice(1).map((s, i) => `+${Math.round((snaps[i]!.t - t0) / 1000)}..+${Math.round((s.t - t0) / 1000)} s: ${cpuPct(snaps[i]!, s)}%`),
    stop: () => {
      stop = true;
    },
    /** moved snapshots so far, and the last scrape's status */
    seen: () => `${snaps.length} moved snapshots, last scrape ${lastScrape}`,
  };
}
/** busy share of node CPU between two snapshots, percent; -1 when the counters did not move (cached snapshot). */
const cpuPct = (a: CpuSnap | null, b: CpuSnap | null) => {
  if (!a || !b) return -1;
  const tot = b.busy - a.busy + (b.idle - a.idle);
  return tot > 0 ? Math.round((1000 * (b.busy - a.busy)) / tot) / 10 : -1;
};

type Pss = Map<string, { role: string; q: string; calls: number; ms: number }>;

const mod: TestModule = {
  id: "RT06",
  title: "Unfiltered shared-topic vs per-user filtered Postgres Changes at 5000 joins; per-message cost of private per-user Broadcast",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const put = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id} ${r.status} ${r.detail ?? ""}`.slice(0, 500));
    };
    const skip = skipWithoutOrg(ctx, "RT06", "RT06");
    if (skip) return skip;
    const compute = process.env.RT06_COMPUTE || "small";
    const N = envNum("RT06_N", 5000);
    const reps = envNum("RT06_REPS", 2);
    const shapes = envList("RT06_SHAPES", "A,B");
    const nRows = envNum("RT06_ROWS", 20);
    const connectRate = envNum("RT06_CONNECT_RATE", 100);
    const settleMs = envNum("RT06_SETTLE_MS", 60_000);
    const bcN = Math.min(envNum("RT06_BC_N", 5000), N);
    const bcRates = envList("RT06_BC_RATES", "50,200").map(Number);
    const bcSecs = envNum("RT06_BC_SECS", 60);
    try {
      await withProject(
        ctx,
        "rt06",
        async (p: Proj) => {
          const mc = Number((await rows(p, "select setting::int as n from pg_settings where name = 'max_connections'"))[0]?.n ?? 0);
          const warm = await warmMessages(p);
          const cpu = cpuSampler(p);
          const tRun = Date.now();
          await ddl(p, SCHEMA);

          /* ---- pooler sessions: one for probes, four for the sender ---- */
          const mkPg = () => {
            let c: PgClient | null = null;
            return {
              query: async (text: string, params?: unknown[]) => {
                for (let i = 0; ; i++) {
                  try {
                    if (!c) {
                      c = await pgConnect(p);
                      c.on("error", () => {
                        c = null;
                      });
                    }
                    return await c.query(text, params as never);
                  } catch (e) {
                    try {
                      await c?.end();
                    } catch {}
                    c = null;
                    if (i >= 2) throw e;
                    await sleep(3000);
                  }
                }
              },
              end: async () => {
                try {
                  await c?.end();
                } catch {}
              },
            };
          };
          const pg = mkPg();
          const senders = [mkPg(), mkPg(), mkPg(), mkPg()];

          /* ---- users: one SQL statement into auth.users ---- */
          const tU = Date.now();
          const created = await pg.query(
            `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
             select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'rt06-' || g || '-' || $2 || '@example.com', '', now(), now(), now(),
                    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false
             from generate_series(1, $1::int) g returning id::text as id`,
            [N, Date.now()],
          );
          const userCreateMs = Date.now() - tU;
          const uids: string[] = created.rows.map((r: { id: string }) => r.id);
          const pgCfg = await mg(p.ctx, "GET", `/projects/${p.ref}/postgrest`);
          const secret = String((pgCfg.json as { jwt_secret?: string } | undefined)?.jwt_secret ?? "");
          if (!secret) throw new Error(`no jwt_secret in GET /postgrest (HTTP ${pgCfg.status})`);
          const iat = Math.floor(Date.now() / 1000);
          const mint = (uid: string) =>
            mintHs256(secret, { aud: "authenticated", exp: iat + 4 * 3600, iat, iss: `${p.url}/auth/v1`, sub: uid, role: "authenticated", aal: "aal1", session_id: crypto.randomUUID(), is_anonymous: false });
          const tokens = uids.map(mint);

          const rc = await mg(p.ctx, "GET", `/projects/${p.ref}/config/realtime`);
          const rcj = (rc.json ?? {}) as Record<string, unknown>;
          const pss0 = await pg.query(`select to_regclass('extensions.pg_stat_statements') is not null as ext, pg_has_role('postgres', 'pg_read_all_stats', 'member') as stats`);
          put({
            id: "RT06-setup",
            title: "RT06-setup: compute, Realtime config as created, users",
            status: uids.length === N ? "info" : "fail",
            detail: `${compute}: max_connections ${mc}; realtime join ready after ${warm.realtimeReadyMs} ms; ${uids.length} auth.users rows in one INSERT in ${userCreateMs} ms; config postgres_changes_pool=${JSON.stringify(rcj.postgres_changes_pool)} connection_pool=${JSON.stringify(rcj.connection_pool)} max_concurrent_users=${JSON.stringify(rcj.max_concurrent_users)} max_joins_per_second=${JSON.stringify(rcj.max_joins_per_second)}; pg_stat_statements ${pss0.rows[0]?.ext}, pg_read_all_stats ${pss0.rows[0]?.stats}`,
            measurements: {
              compute,
              max_connections: mc,
              users: uids.length,
              user_create_ms: userCreateMs,
              postgres_changes_pool: String(rcj.postgres_changes_pool ?? "null"),
              connection_pool: String(rcj.connection_pool ?? "null"),
              max_concurrent_users: String(rcj.max_concurrent_users ?? "null"),
              max_joins_per_second: String(rcj.max_joins_per_second ?? "null"),
            },
          });

          /* ---- probes ---- */
          const pssSnap = async (): Promise<Pss> => {
            const m: Pss = new Map();
            try {
              const r = await pg.query(
                `select r.rolname as role, s.queryid::text as qid, left(regexp_replace(s.query, '\\s+', ' ', 'g'), 140) as q, s.calls::float8 as calls, s.total_exec_time::float8 as ms
                   from extensions.pg_stat_statements s join pg_roles r on r.oid = s.userid`,
              );
              for (const x of r.rows as Array<{ role: string; qid: string; q: string; calls: number; ms: number }>) m.set(`${x.role}|${x.qid}`, { role: x.role, q: x.q, calls: x.calls, ms: x.ms });
            } catch {}
            return m;
          };
          const pssDelta = (a: Pss, b: Pss, pick: (role: string, q: string) => boolean) => {
            const ds: Array<{ role: string; q: string; calls: number; ms: number }> = [];
            for (const [k, v] of b) {
              if (!pick(v.role, v.q)) continue;
              const o = a.get(k);
              const d = { role: v.role, q: v.q, calls: v.calls - (o?.calls ?? 0), ms: v.ms - (o?.ms ?? 0) };
              if (d.calls > 0) ds.push(d);
            }
            ds.sort((x, y) => y.ms - x.ms);
            return {
              calls: ds.reduce((s, d) => s + d.calls, 0),
              ms: Math.round(ds.reduce((s, d) => s + d.ms, 0)),
              top: ds.slice(0, 5).map((d) => `${d.role} calls ${d.calls} ms ${Math.round(d.ms)}: ${d.q}`),
            };
          };
          // Every statement not run by this module's own `postgres` sessions: Realtime runs as supabase_admin and,
          // inside authorization and RLS checks, possibly as the subscriber's role (pg_stat_statements keys by current user).
          const notMine = (role: string) => role !== "postgres";
          const subCount = async () => {
            try {
              const r = await pg.query(`select count(*)::int as n, count(distinct filters::text)::int as nf, count(distinct claims->>'sub')::int as subs from realtime.subscription`);
              return r.rows[0] as { n: number; nf: number; subs: number };
            } catch {
              return { n: -1, nf: -1, subs: -1 };
            }
          };
          const dbConnTick = (into: Record<string, number>) => async () => {
            const r = await pg.query(
              `select coalesce(nullif(application_name,''),'-') as k, count(*)::int as n from pg_stat_activity where usename ilike '%realtime%' or application_name ilike '%realtime%' group by 1`,
            );
            for (const row of r.rows as Array<{ k: string; n: number }>) into[row.k] = Math.max(into[row.k] ?? 0, row.n);
          };
          const waitSubsZero = async () => {
            const t = Date.now();
            while (Date.now() - t < 120_000) {
              if ((await subCount()).n === 0) return Date.now() - t;
              await sleep(2000);
            }
            return -1;
          };

          /* ---- RT06-tokens: minted vs session token, and the first-change warm-up ---- */
          {
            const real = await makeUser(p, "rt06real");
            const pair = [
              { uid: real.id, token: real.token, label: "session" },
              { uid: uids[0]!, token: tokens[0]!, label: "minted" },
            ];
            const clis = await openFleet(p.host, p.anon, 2, 10, ctx.log, "rt06tok");
            const js = await joinAll(clis, (i) => ({ kind: "pc", topic: `rt06-tok:${pair[i]!.uid}`, token: pair[i]!.token, filter: `user_id=eq.${pair[i]!.uid}` }), T, 30_000, async () => {});
            const t0 = Date.now();
            let k = 0;
            const has = (c: Cli, pre: string) => [...c.got.keys()].some((x) => x.startsWith(pre));
            while (Date.now() - t0 < 120_000 && !(has(clis[0]!, "tok-session") && has(clis[1]!, "tok-minted"))) {
              k++;
              await pg.query(`insert into public.${T} (user_id, body) values ($1, $2), ($3, $4)`, [pair[0]!.uid, `tok-session-${k}`, pair[1]!.uid, `tok-minted-${k}`]).catch(() => null);
              await sleep(2000);
            }
            await sleep(2000);
            const own = (c: Cli, l: string) => [...c.got.keys()].filter((x) => x.startsWith(`tok-${l}`)).length;
            const foreign = (c: Cli, l: string) => [...c.got.keys()].filter((x) => x.startsWith("tok-") && !x.startsWith(`tok-${l}`)).length;
            const ok = clis.every((c, i) => c.outcome === "ready" && own(c, pair[i]!.label) > 0 && foreign(c, pair[i]!.label) === 0);
            put({
              id: "RT06-tokens",
              title: "RT06-tokens: a locally minted HS256 token and a password-grant session token on the same filtered binding",
              status: ok ? "pass" : "fail",
              detail: `${pair.map((x, i) => `${x.label}: ${clis[i]!.outcome}, own rows ${own(clis[i]!, x.label)}, other user's rows ${foreign(clis[i]!, x.label)}`).join("; ")}; ${k} insert pairs until both had one (first-change warm-up), join->ready p50 ${js.j2rP50} ms`,
              measurements: { session_ready: clis[0]!.outcome === "ready" ? 1 : 0, minted_ready: clis[1]!.outcome === "ready" ? 1 : 0, insert_pairs: k, session_foreign: foreign(clis[0]!, "session"), minted_foreign: foreign(clis[1]!, "minted") },
            });
            closeFleet(clis);
            await waitSubsZero();
          }

          /* ---- RT06b: shape bursts ---- */
          const shapeBurst = async (shape: string, rep: number) => {
            const tag = `rt06${shape}${N}r${rep}`;
            const tStart = Date.now();
            const clis = await openFleet(p.host, p.anon, N, connectRate, ctx.log, tag);
            const pssA = await pssSnap();
            const conns: Record<string, number> = {};
            const js: JoinSummary = await joinAll(
              clis,
              (i) =>
                shape === "A"
                  ? { kind: "pc", topic: "rt06-shared", token: tokens[i]! }
                  : { kind: "pc", topic: `rt06-n:${uids[i]}`, token: tokens[i]!, filter: `user_id=eq.${uids[i]}` },
              T,
              settleMs,
              dbConnTick(conns),
            );
            const joinWindowMs = Date.now() - js.firstJoinAt;
            const subs = await subCount();
            const pssB = await pssSnap();
            const joinCost = pssDelta(pssA, pssB, (r) => notMine(r));

            /* delivery: canary to a ready client until it arrives, then RT06_ROWS rows in one statement */
            const ready = clis.filter((c) => c.outcome === "ready");
            let canaries = 0;
            let canaryMs = -1;
            const dl = { expected: 0, delivered: 0, misdelivered: 0, dup: 0, clientsWithAny: 0, p50: -1, p95: -1, max: -1, insertAckMs: -1, deliveryMs: 0, cost: { calls: 0, ms: 0, top: [] as string[] } };
            if (ready.length) {
              const c0 = ready[0]!;
              const tc = Date.now();
              while (Date.now() - tc < 60_000 && ![...c0.got.keys()].some((x) => x.startsWith(`${tag}-c`))) {
                canaries++;
                await pg.query(`insert into public.${T} (user_id, body) values ($1, $2)`, [uids[c0.i], `${tag}-c${canaries}`]).catch(() => null);
                await sleep(2000);
              }
              canaryMs = [...c0.got.keys()].some((x) => x.startsWith(`${tag}-c`)) ? Date.now() - tc : -1;
              await sleep(2000);
              const step = Math.max(1, Math.floor(ready.length / nRows));
              const targets = Array.from({ length: Math.min(nRows, ready.length) }, (_, k) => ready[k * step]!);
              const want = new Map<number, string>(); // client index -> body
              targets.forEach((c, k) => want.set(c.i, `${tag}-d${k}`));
              dl.expected = targets.length;
              const pssC = await pssSnap();
              const t0 = Date.now();
              try {
                await pg.query(
                  `insert into public.${T} (user_id, body) select (x->>'u')::uuid, x->>'b' from jsonb_array_elements($1::jsonb) x`,
                  [JSON.stringify(targets.map((c) => ({ u: uids[c.i], b: want.get(c.i) })))],
                );
                dl.insertAckMs = Date.now() - t0;
              } catch (e) {
                ctx.log(`[${tag}] delivery insert failed: ${errText(e)}`);
              }
              const ack = Date.now();
              const end = ack + 30_000;
              while (Date.now() < end && targets.some((c) => !c.got.has(want.get(c.i)!))) await sleep(250);
              await sleep(3000); // late or misdirected deliveries
              dl.deliveryMs = Date.now() - t0;
              const lat: number[] = [];
              for (const c of clis) {
                const mine = [...c.got.keys()].filter((x) => x.startsWith(`${tag}-d`));
                if (mine.length) dl.clientsWithAny++;
                for (const b of mine) {
                  if (want.get(c.i) === b) {
                    dl.delivered++;
                    lat.push(c.got.get(b)! - ack);
                  } else dl.misdelivered++;
                }
                dl.dup += c.dup;
              }
              dl.p50 = pct(lat, 50);
              dl.p95 = pct(lat, 95);
              dl.max = lat.length ? Math.max(...lat) : -1;
              dl.cost = pssDelta(pssC, await pssSnap(), (r) => notMine(r));
            }
            const late = clis.reduce((s, c) => s + c.late.length, 0);
            const closedAfter = clis.filter((c) => c.outcome === "ready" && c.closedWhy).length;
            closeFleet(clis);
            const teardownMs = await waitSubsZero();
            cpu.phase(`RT06b-${shape}-${N}-r${rep}`, tStart, Date.now());
            const nonReady = Object.entries(js.outcomes).filter(([k]) => k !== "ready");
            const m: Record<string, number | string> = {
              shape,
              n: N,
              sockets_opened: clis.filter((c) => c.open).length,
              ready: js.ready,
              not_ready: js.channels - js.ready,
              join_to_ready_p50_ms: js.j2rP50,
              join_to_ready_p95_ms: js.j2rP95,
              join_to_ready_max_ms: js.j2rMax,
              all_settled_ms: js.allSettledMs,
              all_ready_ms: js.allReadyMs,
              subscription_rows: subs.n,
              subscription_distinct_filters: subs.nf,
              subscription_distinct_subs: subs.subs,
              join_stmt_calls: joinCost.calls,
              join_stmt_ms: joinCost.ms,
              join_window_ms: joinWindowMs,
              burst_start_offset_s: Math.round((tStart - tRun) / 1000),
              burst_ms: Date.now() - tStart,
              canaries_sent: canaries,
              canary_wait_ms: canaryMs,
              rows_inserted: dl.expected,
              rows_delivered_to_owner: dl.delivered,
              rows_misdelivered: dl.misdelivered,
              delivery_dups: dl.dup,
              clients_with_any_row: dl.clientsWithAny,
              delivery_p50_ms: dl.p50,
              delivery_p95_ms: dl.p95,
              delivery_max_ms: dl.max,
              insert_ack_ms: dl.insertAckMs,
              delivery_window_ms: dl.deliveryMs,
              delivery_stmt_calls: dl.cost.calls,
              delivery_stmt_ms: dl.cost.ms,
              late_errors: late,
              closed_after_ready: closedAfter,
              teardown_ms: teardownMs,
            };
            for (const [k, v] of nonReady) m[`out_${k}`] = v;
            for (const [k, v] of Object.entries(conns)) m[`dbconn_${k}`] = v;
            put({
              id: `RT06b-${shape}-${N}-r${rep}`,
              title: `RT06b: shape ${shape} (${shape === "A" ? "one shared topic, unfiltered INSERT binding" : "own topic per user, user_id=eq filter"}), ${N} joins, rep ${rep}`,
              status: "info",
              detail: `ready ${js.ready}/${js.channels}; not ready ${nonReady.map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; join->ready p50 ${js.j2rP50} p95 ${js.j2rP95} ms; first join -> last settled ${js.allSettledMs} ms; realtime.subscription ${subs.n} rows (${subs.nf} distinct filters); non-postgres stmt time in join phase ${joinCost.ms} ms over ${joinCost.calls} calls; delivery ${dl.delivered}/${dl.expected} to owner, ${dl.misdelivered} misdelivered, p50 ${dl.p50} p95 ${dl.p95} ms, non-postgres stmt ${dl.cost.ms} ms over ${dl.cost.calls} calls in ${dl.deliveryMs} ms; conns ${JSON.stringify(conns)}`,
              measurements: m,
              evidence: [
                ...Object.entries(js.samples).map(([k, v]) => `${k}: ${v}`),
                "join phase, top non-postgres statements:",
                ...joinCost.top,
                "delivery phase, top non-postgres statements:",
                ...dl.cost.top,
              ].join("\n"),
            });
            await sleep(15_000);
          };
          for (let r = 1; r <= reps; r++) for (const s of shapes) await shapeBurst(s, r);

          /* ---- RT06c: private per-user Broadcast ---- */
          if (bcN > 0) {
            const seqVal = async () => Number((await pg.query(`select case when is_called then last_value else 0 end::bigint as v from public.rt06_policy_calls`)).rows[0]?.v ?? -1);
            const msgStats = async () => {
              const r = await pg.query(
                `select (select count(*) from realtime.messages)::bigint as n,
                        (select coalesce(sum(pg_total_relation_size(inhrelid)), 0) from pg_inherits where inhparent = 'realtime.messages'::regclass)::bigint as bytes,
                        (select count(*) from pg_inherits where inhparent = 'realtime.messages'::regclass)::int as parts`,
              );
              return { n: Number(r.rows[0].n), bytes: Number(r.rows[0].bytes), parts: Number(r.rows[0].parts) };
            };
            const tag = `rt06bc${bcN}`;
            const clis = await openFleet(p.host, p.anon, bcN, connectRate, ctx.log, tag);
            const seq0 = await seqVal();
            const pssA = await pssSnap();
            const tJ = Date.now();
            const conns: Record<string, number> = {};
            const js = await joinAll(clis, (i) => ({ kind: "bc", topic: `user:${uids[i]}`, token: tokens[i]! }), T, settleMs, dbConnTick(conns));
            await sleep(5000);
            const seq1 = await seqVal();
            const joinAll_ = pssDelta(pssA, await pssSnap(), (r) => notMine(r));
            const nonReady = Object.entries(js.outcomes).filter(([k]) => k !== "ready");
            put({
              id: "RT06c-join",
              title: `RT06c: ${bcN} private joins on user:<uid> topics (realtime.messages policy ties the topic to auth.uid())`,
              status: "info",
              detail: `ready ${js.ready}/${js.channels}; not ready ${nonReady.map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; join->ready p50 ${js.j2rP50} p95 ${js.j2rP95} ms; first join -> last settled ${js.allSettledMs} ms; policy evaluations during joins ${seq1 - seq0}; non-postgres statements ${joinAll_.ms} ms over ${joinAll_.calls} calls`,
              measurements: {
                n: bcN,
                ready: js.ready,
                join_to_ready_p50_ms: js.j2rP50,
                join_to_ready_p95_ms: js.j2rP95,
                all_settled_ms: js.allSettledMs,
                policy_evals_join: seq1 - seq0,
                join_stmt_calls: joinAll_.calls,
                join_stmt_ms: joinAll_.ms,
                join_phase_ms: Date.now() - tJ,
                ...Object.fromEntries(nonReady.map(([k, v]) => [`out_${k}`, v])),
                ...Object.fromEntries(Object.entries(conns).map(([k, v]) => [`dbconn_${k}`, v])),
              },
              evidence: [...Object.entries(js.samples).map(([k, v]) => `${k}: ${v}`), ...joinAll_.top].join("\n"),
            });
            const ready = clis.filter((c) => c.outcome === "ready");
            // warm-up: one message to the first ready user until it arrives
            if (ready.length) {
              const tw = Date.now();
              let k = 0;
              while (Date.now() - tw < 90_000 && ![...ready[0]!.got.keys()].some((x) => x.startsWith(`${tag}-w`))) {
                k++;
                await pg.query(`select public.rt06_send_batch($1::jsonb)`, [JSON.stringify([{ p: { k: `${tag}-w${k}` }, topic: `user:${uids[ready[0]!.i]}` }])]).catch(() => null);
                await sleep(2000);
              }
              ctx.log(`[${tag}] broadcast warm-up: ${k} sends, ${Date.now() - tw} ms`);
            }
            const sendPhase = async (rate: number, rep: number) => {
              const ptag = `${tag}r${rate}x${rep}`;
              const seqA = await seqVal();
              const ms0 = await msgStats();
              const pss1 = await pssSnap();
              const tP = Date.now();
              const sentAt = new Map<string, { at: number; to: number }>();
              const acks: number[] = [];
              const errs: Record<string, number> = {};
              let sent = 0;
              let lagMax = 0;
              const busy = senders.map(() => false);
              const inflight: Promise<unknown>[] = [];
              const t0 = Date.now();
              let pending: Array<{ p: { k: string; t: number }; topic: string; to: number }> = [];
              while (Date.now() - t0 < bcSecs * 1000) {
                const due = Math.floor(((Date.now() - t0) / 1000) * rate);
                while (sent + pending.length < due) {
                  const s = sent + pending.length;
                  const c = ready[s % ready.length]!;
                  pending.push({ p: { k: `${ptag}-${s}`, t: Date.now() }, topic: `user:${uids[c.i]}`, to: c.i });
                }
                const free = busy.findIndex((b) => !b);
                if (pending.length && free >= 0) {
                  const batch = pending;
                  pending = [];
                  const now = Date.now();
                  for (const b of batch) {
                    lagMax = Math.max(lagMax, now - b.p.t);
                    sentAt.set(b.p.k, { at: now, to: b.to });
                  }
                  sent += batch.length;
                  busy[free] = true;
                  const q = senders[free]!.query(`select public.rt06_send_batch($1::jsonb) as n`, [JSON.stringify(batch.map((b) => ({ p: b.p, topic: b.topic })))])
                    .then(() => acks.push(Date.now() - now))
                    .catch((e) => {
                      const k = errText(e).slice(0, 80);
                      errs[k] = (errs[k] ?? 0) + batch.length;
                    })
                    .finally(() => (busy[free] = false));
                  inflight.push(q);
                }
                await sleep(50);
              }
              await Promise.all(inflight);
              const sendWallMs = Date.now() - t0;
              const tw = Date.now();
              const allIn = () => [...sentAt.entries()].every(([k, v]) => clis[v.to]!.got.has(k));
              while (Date.now() - tw < 20_000 && !allIn()) await sleep(250);
              await sleep(2000);
              const lat: number[] = [];
              let delivered = 0;
              let misdelivered = 0;
              for (const c of clis)
                for (const [k, at] of c.got) {
                  if (!k.startsWith(`${ptag}-`)) continue;
                  const s = sentAt.get(k);
                  if (s && s.to === c.i) {
                    delivered++;
                    lat.push(at - s.at);
                  } else misdelivered++;
                }
              const ms1 = await msgStats();
              const seqB = await seqVal();
              const pss2 = await pssSnap();
              cpu.phase(`RT06c-${rate}-r${rep}`, tP, Date.now());
              const sendStmt = pssDelta(pss1, pss2, (role, q) => role === "postgres" && /rt06_send_batch/.test(q));
              const rtStmt = pssDelta(pss1, pss2, (r) => notMine(r));
              const late = clis.reduce((s, c) => s + c.late.length, 0);
              const closed = ready.filter((c) => c.closedWhy).length;
              put({
                id: `RT06c-${rate}-r${rep}`,
                title: `RT06c: realtime.send at ${rate}/s for ${bcSecs} s to ${ready.length} private user:<uid> channels, rep ${rep}`,
                status: "info",
                detail: `sent ${sent} (${Math.round((sent * 10000) / sendWallMs) / 10}/s achieved), delivered to the intended client ${delivered}, misdelivered ${misdelivered}, send errors ${JSON.stringify(errs)}; latency send->arrival p50 ${pct(lat, 50)} p95 ${pct(lat, 95)} max ${lat.length ? Math.max(...lat) : -1} ms; send statement ${sendStmt.calls} calls ${sendStmt.ms} ms (${sent ? Math.round((1000 * sendStmt.ms) / sent) / 1000 : -1} ms per message); realtime.messages +${ms1.n - ms0.n} rows, ${ms0.bytes} -> ${ms1.bytes} bytes over ${ms1.parts} partitions; policy evaluations during sends ${seqB - seqA}; non-postgres statements ${rtStmt.ms} ms over ${rtStmt.calls} calls; late channel errors ${late}, closed ${closed}`,
                measurements: {
                  rate,
                  secs: bcSecs,
                  channels: ready.length,
                  sent,
                  achieved_per_s: Math.round((sent * 10000) / sendWallMs) / 10,
                  delivered,
                  misdelivered,
                  missing: sent - delivered,
                  send_errors: Object.values(errs).reduce((a, b) => a + b, 0),
                  latency_p50_ms: pct(lat, 50),
                  latency_p95_ms: pct(lat, 95),
                  latency_max_ms: lat.length ? Math.max(...lat) : -1,
                  batch_ack_p50_ms: pct(acks, 50),
                  batch_ack_p95_ms: pct(acks, 95),
                  enqueue_lag_max_ms: lagMax,
                  send_stmt_calls: sendStmt.calls,
                  send_stmt_ms: sendStmt.ms,
                  send_ms_per_message: sent ? Math.round((1000 * sendStmt.ms) / sent) / 1000 : -1,
                  messages_rows_added: ms1.n - ms0.n,
                  messages_rows_total: ms1.n,
                  messages_bytes_before: ms0.bytes,
                  messages_bytes_after: ms1.bytes,
                  messages_partitions: ms1.parts,
                  policy_evals_during_sends: seqB - seqA,
                  rt_stmt_calls: rtStmt.calls,
                  rt_stmt_ms: rtStmt.ms,
                  phase_start_offset_s: Math.round((tP - tRun) / 1000),
                  late_errors: late,
                  closed_channels: closed,
                },
                evidence: [`errors: ${JSON.stringify(errs)}`, "send statement:", ...sendStmt.top, "non-postgres statements:", ...rtStmt.top].join("\n"),
              });
              await sleep(15_000);
            };
            if (ready.length) for (let r = 1; r <= reps; r++) for (const rate of bcRates) await sendPhase(rate, r);
            closeFleet(clis);
          }
          /* ---- node CPU per phase, once the cached snapshot has moved past the last phase ---- */
          await sleep(75_000);
          cpu.stop();
          const ph = cpu.phases();
          put({
            id: "RT06-cpu",
            title: "RT06-cpu: node CPU busy share per phase from the metrics endpoint (cached snapshots; coarse)",
            status: "info",
            detail: `${ph.map((x) => `${x.label} ${cpu.window(x.t0, x.t1)}%`).join("; ")}; ${cpu.seen()}`,
            measurements: Object.fromEntries(ph.map((x) => [`cpu_busy_pct_${x.label}`, cpu.window(x.t0, x.t1)])),
            evidence: [
              "Phase windows, s from the first burst's setup:",
              ...ph.map((x) => `${x.label}: +${Math.round((x.t0 - tRun) / 1000)}..+${Math.round((x.t1 - tRun) / 1000)} s`),
              "Busy % between consecutive moved snapshots (snapshot observed time):",
              ...cpu.series(tRun),
            ].join("\n"),
          });
          await pg.end();
          for (const s of senders) await s.end();
        },
        { size: compute },
      );
    } catch (e) {
      put({ id: "RT06", title: "RT06", status: "fail", detail: `module threw: ${errText(e)}` });
    }
    return out;
  },
};
export default mod;
