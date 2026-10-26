/**
 * Realtime reads shared by DC13 and DC16: GET /config/realtime and Realtime's
 * database connections by name around a burst of Postgres Changes joins
 * (realtime-surface lib/burst.ts). Moved out of DC13 when DC16 needed the same
 * row on a project created at a larger size.
 */
import type { Ctx, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { pgConnect, waitRealtime, type Proj } from "../../realtime-surface/lib/rt.js";
import { runBurst, type BurstResult as RtBurst } from "../../realtime-surface/lib/burst.js";
import { fmtCounts, redact, sleep, type DcProject } from "./dc.js";
import { backendsByRole } from "./tier.js";

/** Joins per burst: PVLAB_DC13_JOINS (DC13 and DC16). */
const JOINS = Number(process.env.PVLAB_DC13_JOINS || 100);

export const RT_FIELDS = ["connection_pool", "postgres_changes_pool", "max_concurrent_users", "max_joins_per_second", "max_channels_per_client", "max_events_per_second"];

export const RT_SQL = `
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
export async function userToken(p: DcProject): Promise<string> {
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

export async function realtimeRow(ctx: Ctx, p: DcProject, id: string, label: string): Promise<TestResult> {
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
