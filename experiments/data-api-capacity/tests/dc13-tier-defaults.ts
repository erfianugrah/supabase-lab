/**
 * DC13 - With nothing configured, what Data API (PostgREST) pool and what
 * Realtime database connections does a project get at each compute size, on
 * one project resized upward?
 *
 * Measured before (DC01, DC04, DC08): pool 30 on Small, 50 on Large, 70 on
 * 4XL with `db_pool` null; `max_connections` 90 / 160 / 480. Not measured:
 * XL and 2XL. Docs claims tested here: 2XL `max_connections` 380 and XL 240
 * (compute-and-disk page); the Realtime concepts page's table of a
 * subscription-management pool of 7 from XL to 4XL and an authorization pool
 * of 10 (doc-cited-not-tested before this module). Hypotheses: 2XL pool 70
 * with `db_pool` null; Realtime's subscription-manager connections at most 7
 * on 2XL with the Realtime settings as created.
 *
 * Per size (start size, then each of PVLAB_DC13_SIZES, default
 * ci_xlarge,ci_2xlarge):
 *   DC13<x>-pool      GET /postgrest; `pgrst_db_pool_max` scraped every 5 s
 *                     for 90 s (the payload is a stale snapshot, DC05); two
 *                     bursts of PVLAB_DC13_K (150) concurrent 12 s sleeps and
 *                     the mid-burst PgSleep count of `authenticator`;
 *                     `max_connections`; node CPU count from the metrics.
 *   DC13<x>-realtime  GET /config/realtime; one raw-protocol burst of 100
 *                     Postgres Changes joins (realtime-surface lib/burst.ts,
 *                     settings untouched), Realtime's connections by
 *                     usename/application_name sampled each second while it
 *                     settles, then client backends by role/application.
 *
 * Resizes go through the compute add-on PATCH and are waited out as DC08a
 * (any change of `max_connections`, ACTIVE_HEALTHY, 5 pings, 60 s watch).
 *
 * DESTRUCTIVE: creates the shared project (lib/dc.ts) and leaves it at the
 * last size for DC14 (and for RT05 through PVLAB_PEER_RT when PVLAB_DC_DBPASS
 * is set); DC99 deletes it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { pgConnect, waitRealtime, type Proj } from "../../realtime-surface/lib/rt.js";
import { runBurst, type BurstResult as RtBurst } from "../../realtime-surface/lib/burst.js";
import { ensureProject, errText, fmtCounts, redact, resize, skipWithoutPro, sleep, sql, type DcProject } from "../lib/dc.js";
import { backendsByRole, poolColumns, poolLine, readPool } from "../lib/tier.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const SIZES = (process.env.PVLAB_DC13_SIZES || "ci_xlarge,ci_2xlarge").split(",").filter((x) => x && x !== "none");
const K = Number(process.env.PVLAB_DC13_K || 150);
const JOINS = Number(process.env.PVLAB_DC13_JOINS || 100);
const RT_FIELDS = ["connection_pool", "postgres_changes_pool", "max_concurrent_users", "max_joins_per_second", "max_channels_per_client", "max_events_per_second"];

const RT_SQL = `
create table if not exists public.dc13_rt (id bigint generated always as identity primary key, tenant_id uuid not null, body text);
alter table public.dc13_rt enable row level security;
drop policy if exists dc13_rt_read on public.dc13_rt;
create policy dc13_rt_read on public.dc13_rt for select to authenticated using ((select auth.uid()) is not null);
grant select on public.dc13_rt to authenticated;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'dc13_rt') then
    alter publication supabase_realtime add table public.dc13_rt;
  end if;
end $$;`;

/** A fresh confirmed user and its access token (the run outlives one token across resizes). */
async function userToken(p: DcProject): Promise<string> {
  const email = `dc13-${Date.now()}@example.com`;
  const password = `${crypto.randomUUID().replaceAll("-", "")}Aa1!`;
  for (let i = 0; i < 6; i++) {
    const cu = await fetch(`https://${p.host}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: p.keys.service, Authorization: `Bearer ${p.keys.service}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, email_confirm: true }),
    }).catch(() => null);
    if (cu && (cu.status < 300 || cu.status === 422)) break;
    await sleep(5_000);
  }
  for (let i = 0; i < 6; i++) {
    const tok = await fetch(`https://${p.host}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: p.keys.anon, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }).catch(() => null);
    const j = ((await tok?.json().catch(() => ({}))) ?? {}) as { access_token?: string };
    if (j.access_token) return j.access_token;
    await sleep(5_000);
  }
  throw new Error("password sign-in failed");
}

async function realtimeRow(ctx: Ctx, p: DcProject, id: string, label: string): Promise<TestResult> {
  const cfgR = await mgmt(ctx, "GET", `/projects/${p.ref}/config/realtime`);
  const cfg = (cfgR.json ?? {}) as Record<string, unknown>;
  const proj: Proj = { ref: p.ref, url: `https://${p.host}`, host: p.host, anon: p.keys.anon, service: p.keys.service, ctx: { ...ctx, ref: p.ref }, owned: false, dbPass: p.dbPass };
  const readyMs = await waitRealtime(proj, 180_000);
  const before = await backendsByRole(ctx, p.ref);
  const token = await userToken(p);
  const pgc = await pgConnect(proj);
  pgc.on("error", () => undefined);
  let r: RtBurst;
  try {
    r = await runBurst(
      { host: p.host, anon: p.keys.anon, tokens: [token], kind: "pc", sockets: JOINS, channelsPerSocket: 1, connectRate: 100, joinRate: 0, settleMs: 30_000, table: "dc13_rt", bcTopic: "", tenantId: crypto.randomUUID(), runTag: `dc13${id.replace(/[^a-z0-9]/gi, "")}` },
      { query: (t, params) => pgc.query(t, params as never) },
      ctx.log,
    );
  } finally {
    await pgc.end().catch(() => undefined);
  }
  const after = await backendsByRole(ctx, p.ref);
  await sleep(30_000);
  const later = await backendsByRole(ctx, p.ref);
  const rtOnly = (x: typeof after) => (x?.byRoleApp ?? "").split(" ").filter((s) => /realtime/i.test(s)).join(" ") || "none";
  return {
    id,
    title: `${label}: Realtime config and connections around a ${JOINS}-join Postgres Changes burst (settings as created)`,
    status: "info",
    detail:
      `config ${RT_FIELDS.map((f) => `${f}=${JSON.stringify(cfg[f] ?? null)}`).join(" ")}; ready ${r.ready}/${r.channels} (${fmtCounts(r.outcomes)}); ` +
      `realtime conns max during settle ${JSON.stringify(r.dbConnMax)}; after ${rtOnly(after)}; +30 s ${rtOnly(later)}`,
    measurements: {
      config_http: cfgR.status,
      ...Object.fromEntries(RT_FIELDS.map((f) => [`config_${f}`, String(cfg[f] ?? "null")])),
      realtime_ready_ms: readyMs,
      joins: r.channels,
      ready: r.ready,
      outcomes: fmtCounts(r.outcomes),
      join_to_ready_p50_ms: r.joinToReadyP50,
      join_to_ready_p95_ms: r.joinToReadyP95,
      fanout_delivered: `${r.fanout.delivered} of ${r.fanout.of}`,
      ...Object.fromEntries(Object.entries(r.dbConnMax).map(([k, v]) => [`settle_max_${k}`, v])),
      realtime_backends_before: rtOnly(before),
      realtime_backends_after: rtOnly(after),
      realtime_backends_after_30s: rtOnly(later),
      client_backends_by_role_after: (after?.byRoleApp ?? "").slice(0, 600),
      client_backends_after: after?.clients ?? -1,
      max_connections: after?.maxConnections ?? -1,
    },
    evidence: redact(Object.entries(r.samples).map(([k, v]) => `${k}: ${v}`).join("\n")) || undefined,
  };
}

const mod: TestModule = {
  id: "DC13",
  title: "Data API pool and Realtime connections with nothing configured, per compute size (Small, XL, 2XL)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC13");
    if (skip) return skip;
    const out: TestResult[] = [];
    const put = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id}: ${r.detail ?? ""}`.slice(0, 500));
    };
    try {
      const p = await ensureProject(ctx);
      ctx.log(`DC13: project ready in ${Math.round(p.createMs / 1000)} s (${p.pgVersion})`);
      const setup = await sql(ctx, p.ref, RT_SQL);
      if (setup.error) throw new Error(`realtime setup: ${setup.error}`);

      const measure = async (tag: string, label: string) => {
        try {
          const r = await readPool(ctx, p, K);
          put({
            id: `DC13${tag}-pool`,
            title: `${label}: Data API pool with db_pool unset`,
            status: r.pools[0]! > 0 && r.pools[0] === r.pools[1] ? "info" : "fail",
            detail: poolLine(r),
            measurements: { size: label, pg_version: p.pgVersion, ...poolColumns(r) },
          });
        } catch (e) {
          put({ id: `DC13${tag}-pool`, title: `${label}: pool`, status: "fail", detail: redact(`threw: ${errText(e)}`) });
        }
        try {
          put(await realtimeRow(ctx, p, `DC13${tag}-realtime`, label));
        } catch (e) {
          put({ id: `DC13${tag}-realtime`, title: `${label}: realtime`, status: "fail", detail: redact(`threw: ${errText(e)}`) });
        }
      };

      await measure("a", process.env.PVLAB_DC_SIZE || "small");
      const tags = "bcdefg";
      for (const [i, size] of SIZES.entries()) {
        const before = await sql(ctx, p.ref, "select current_setting('max_connections')::int as m");
        const fromMax = Number(before.rows?.[0]?.m ?? -1);
        const rz = await resize(ctx, p, size, -1, 25 * 60_000, 60, fromMax);
        put({
          id: `DC13${tags[i]}-resize`,
          title: `Resize to ${size}`,
          status: rz.settledS >= 0 ? "info" : "fail",
          detail: `PATCH ${rz.status} after ${rz.retries429 ?? 0} x 429; settled ${rz.settledS} s; max_connections ${fromMax} -> ${rz.maxConn}; watch failures ${rz.watch?.failed ?? -1} of ${rz.watch?.samples ?? -1}; ${rz.text}`,
          measurements: { resize_status: rz.status, addon_429_retries: rz.retries429 ?? 0, settled_s: rz.settledS, max_connections_from: fromMax, max_connections: rz.maxConn, watch_failed: rz.watch?.failed ?? -1, watch_samples: rz.watch?.samples ?? -1 },
        });
        if (rz.settledS < 0) return out;
        await measure(tags[i]!, size);
      }
    } catch (e) {
      put({ id: "DC13", title: this.title, status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
