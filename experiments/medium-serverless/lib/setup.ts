/**
 * Shared assembly for the medium-serverless modules.
 *
 * The connection surface is READ off the platform (pooler config, addons,
 * health), never constructed: the shared pooler hostname is region-dependent
 * and the add-on catalogue is per project. The probes are the same shapes
 * platform-downtime measured with on 2026-08-04 (REST/Auth/Storage answer
 * with a non-5xx; Postgres paths connect and `select 1`), extended with the
 * two paths that experiment could not reach from an IPv4-only vantage: direct
 * 5432 and the dedicated PgBouncer on 6543, both on `db.<ref>.supabase.co`.
 */
import { Client } from "pg";
import WebSocket from "ws";
import { mgmt } from "../../../harness/src/mgmt";
import type { Probe, ProbeOutcome } from "../../../harness/src/sampler";
import type { Ctx } from "../../../harness/src/types";

export const HTTP_TIMEOUT_MS = 5000;
export const PG_TIMEOUT_MS = 5000;
export const INTERVAL_MS = 500;
export const SETTLE_MS = 5000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

/* ---------- platform reads ---------- */

export interface SupavisorEntry {
  identifier: string;
  database_type: "PRIMARY" | "READ_REPLICA";
  db_user: string;
  db_host: string;
  db_port: number;
  db_name: string;
  default_pool_size: number | null;
  max_client_conn: number | null;
  connection_string?: string;
}

export async function supavisorConfig(ctx: Ctx): Promise<SupavisorEntry[]> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/database/pooler`);
  return Array.isArray(r.json) ? (r.json as SupavisorEntry[]) : [];
}

export async function primaryPooler(ctx: Ctx): Promise<SupavisorEntry | null> {
  const all = await supavisorConfig(ctx);
  return all.find((e) => e.database_type === "PRIMARY") ?? all[0] ?? null;
}

export interface PgbouncerConfig {
  pool_mode?: string;
  default_pool_size?: number;
  max_client_conn?: number;
  server_idle_timeout?: number;
  server_lifetime?: number;
  query_wait_timeout?: number;
  ignore_startup_parameters?: string;
  connection_string?: string;
  [k: string]: unknown;
}

export async function pgbouncerConfig(ctx: Ctx): Promise<{ status: number; cfg: PgbouncerConfig }> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/database/pgbouncer`);
  return { status: r.status, cfg: (r.json as PgbouncerConfig) ?? {} };
}

export interface AddonsView {
  selected: { type: string; variant: string }[];
  available: string[];
}

export async function addons(ctx: Ctx): Promise<AddonsView> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/billing/addons`);
  const j = (r.json ?? {}) as {
    selected_addons?: { type: string; variant?: { id?: string } }[];
    available_addons?: { type: string }[];
  };
  return {
    selected: (j.selected_addons ?? []).map((a) => ({ type: a.type, variant: a.variant?.id ?? "" })),
    available: (j.available_addons ?? []).map((a) => a.type),
  };
}

/**
 * Add-on application is `PATCH /billing/addons`, the same lever
 * platform-downtime used for compute. A 429 carries "try again in N minute(s)"
 * when a previous addon change is still settling; honoured, bounded.
 */
export async function applyAddon(ctx: Ctx, type: string, variant: string): Promise<{ status: number; text: string }> {
  let r = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/billing/addons`, { addon_type: type, addon_variant: variant });
  for (let attempt = 0; r.status === 429 && attempt < 4; attempt++) {
    const m = /try again in (\d+)/.exec(r.text);
    const waitMs = (m ? Number(m[1]) : 1) * 60_000 + 5000;
    ctx.log(`addon ${variant}: 429, waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
    r = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/billing/addons`, { addon_type: type, addon_variant: variant });
  }
  return { status: r.status, text: r.text.slice(0, 300) };
}

export async function removeAddon(ctx: Ctx, variant: string): Promise<{ status: number; text: string }> {
  const r = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/billing/addons/${variant}`);
  return { status: r.status, text: r.text.slice(0, 300) };
}

export type HealthService = "auth" | "db" | "pooler" | "realtime" | "rest" | "storage" | "pg_bouncer";

export async function health(ctx: Ctx, services: HealthService[]): Promise<Record<string, string>> {
  const qs = services.map((s) => `services=${s}`).join("&");
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/health?${qs}`, undefined, 15_000);
  const out: Record<string, string> = {};
  for (const row of Array.isArray(r.json) ? (r.json as { name?: string; status?: string }[]) : [])
    if (row.name) out[row.name] = row.status ?? "unknown";
  if (!Object.keys(out).length) out._http = String(r.status);
  return out;
}

/** Poll until every named service reports ACTIVE_HEALTHY, or the budget runs out. */
export async function waitHealthy(ctx: Ctx, services: HealthService[], maxWaitMs: number): Promise<{ ok: boolean; waitedMs: number; last: Record<string, string> }> {
  const t0 = Date.now();
  let last: Record<string, string> = {};
  while (Date.now() - t0 < maxWaitMs) {
    last = await health(ctx, services).catch(() => ({ _err: "unreachable" }));
    if (services.every((s) => last[s] === "ACTIVE_HEALTHY")) return { ok: true, waitedMs: Date.now() - t0, last };
    await sleep(5000);
  }
  return { ok: false, waitedMs: Date.now() - t0, last };
}

/* ---------- Postgres paths ---------- */

export interface PgTarget {
  name: string;
  host: string;
  port: number;
  user: string;
}

/** Direct 5432 and dedicated PgBouncer 6543 share the host; the user has NO ref suffix. */
export function directTarget(ctx: Ctx): PgTarget {
  return { name: "direct_5432", host: ctx.phzHost, port: 5432, user: "postgres" };
}
export function dedicatedTarget(ctx: Ctx): PgTarget {
  const [h, p] = (ctx.endpoints.pooler_txn ?? `${ctx.phzHost}:6543`).split(":");
  return { name: "dedicated_6543", host: h ?? ctx.phzHost, port: Number(p ?? 6543), user: ctx.endpoints.pooler_txn_user ?? "postgres" };
}
export function sharedTargets(pooler: SupavisorEntry): { session: PgTarget; txn: PgTarget } {
  return {
    session: { name: "shared_5432", host: pooler.db_host, port: 5432, user: pooler.db_user },
    txn: { name: "shared_6543", host: pooler.db_host, port: 6543, user: pooler.db_user },
  };
}

export function pgClient(t: PgTarget, password: string, timeoutMs = PG_TIMEOUT_MS, user?: string): Client {
  return new Client({
    host: t.host,
    port: t.port,
    user: user ?? t.user,
    database: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: timeoutMs,
  });
}

/** connect + `select 1` + end; returns the verbatim error on failure. */
export async function pgOnce(t: PgTarget, password: string, user?: string): Promise<ProbeOutcome & { ms: number }> {
  const t0 = Date.now();
  const c = pgClient(t, password, PG_TIMEOUT_MS, user);
  try {
    await c.connect();
    await c.query("select 1");
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: errText(e), ms: Date.now() - t0 };
  } finally {
    await c.end().catch(() => {});
  }
}

export function pgProbe(t: PgTarget, password: string): Probe {
  return { name: t.name, run: async () => pgOnce(t, password) };
}

/* ---------- HTTP paths (platform-downtime shapes) ---------- */

function httpProbe(name: string, url: string, headers: Record<string, string>): Probe {
  return {
    name,
    async run() {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
        if (res.status >= 500) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    },
  };
}

export function restProbe(ctx: Ctx): Probe {
  return httpProbe("rest", `https://${ctx.apiHost}/rest/v1/`, { apikey: ctx.anonKey ?? "" });
}
export function authProbe(ctx: Ctx): Probe {
  return httpProbe("auth", `https://${ctx.apiHost}/auth/v1/health`, { apikey: ctx.anonKey ?? "" });
}
export function storageProbe(ctx: Ctx): Probe {
  return httpProbe("storage", `https://${ctx.apiHost}/storage/v1/bucket`, {
    apikey: ctx.anonKey ?? "",
    Authorization: `Bearer ${ctx.anonKey ?? ""}`,
  });
}

/**
 * Realtime handshake. Bun does not raise ws's `unexpected-response`, so a 4xx
 * upgrade reads as down; the probe sends a valid key, so a permanent failure
 * voids the run at the healthy-at-start gate rather than becoming an outage.
 */
export function realtimeProbe(ctx: Ctx): Probe {
  const url = `wss://${ctx.apiHost}/realtime/v1/websocket?apikey=${ctx.anonKey ?? ""}&vsn=1.0.0`;
  return {
    name: "realtime",
    async run() {
      return await new Promise<ProbeOutcome>((resolve) => {
        const ws = new WebSocket(url, { handshakeTimeout: HTTP_TIMEOUT_MS });
        const timer = setTimeout(() => done({ ok: false, error: "handshake timeout" }), HTTP_TIMEOUT_MS + 500);
        const done = (o: ProbeOutcome) => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          resolve(o);
        };
        ws.on("open", () => done({ ok: true }));
        ws.on("error", (e) => done({ ok: false, error: errText(e) }));
      });
    },
  };
}

/** Every path a Vercel-shaped client could be on, plus the HTTP tier. */
export async function allProbes(ctx: Ctx): Promise<{ probes: Probe[]; note: string }> {
  const probes: Probe[] = [restProbe(ctx), authProbe(ctx), storageProbe(ctx), realtimeProbe(ctx)];
  const notes: string[] = [];
  const pooler = await primaryPooler(ctx);
  if (pooler && ctx.dbPassword) {
    const s = sharedTargets(pooler);
    probes.push(pgProbe(s.txn, ctx.dbPassword), pgProbe(s.session, ctx.dbPassword));
    notes.push(`shared ${pooler.db_host}`);
  } else notes.push("shared pooler skipped");
  if (ctx.dbPassword) {
    probes.push(pgProbe(dedicatedTarget(ctx), ctx.dbPassword), pgProbe(directTarget(ctx), ctx.dbPassword));
    notes.push(`dedicated+direct ${ctx.phzHost}`);
  }
  return { probes, note: notes.join("; ") };
}

/* ---------- DNS ---------- */

export async function dnsRecords(host: string): Promise<{ a: string[]; aaaa: string[] }> {
  const dns = await import("node:dns/promises");
  const a = await dns.resolve4(host).catch(() => [] as string[]);
  const aaaa = await dns.resolve6(host).catch(() => [] as string[]);
  return { a, aaaa };
}

/* ---------- report helpers ---------- */

export function flatten(windows: import("../../../harness/src/sampler").PathWindow[]): Record<string, number | string> {
  const m: Record<string, number | string> = { probe_interval_ms: INTERVAL_MS };
  for (const w of windows) {
    m[`${w.name}_first_fail_s`] = w.firstFailMs === null ? "n/a" : Math.round(w.firstFailMs / 1000);
    m[`${w.name}_window_s`] = w.windowMs === null ? "n/a" : Math.round(w.windowMs / 1000);
    m[`${w.name}_mode`] = w.modes[0] ?? "none";
  }
  return m;
}
