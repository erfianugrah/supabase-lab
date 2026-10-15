/**
 * Shared plumbing for logs-volume: phase windows, the per-source footprint
 * query, and a postgres-role pooler session. Provisioning reuses
 * observability-surface's `makeProject` with the `lv-` prefix.
 *
 * Size proxy. Billed ingest bytes are not readable by PAT (observability-surface
 * OB03c: the organization usage route answers 401). What the logs endpoint does
 * expose is each row's `event_message` and its `log_attributes` map, so the
 * proxy is length(event_message) + sum(length(key) + length(value)) over the
 * map. It is the queryable representation of a row, not the metered byte
 * count; ratios between actions are the point, not absolute GB.
 */
import dns from "node:dns/promises";
import pg from "pg";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";
import { logs, sleep } from "../../observability-surface/lib/ob";

export const PREFIX = "lv-";

export interface Window {
  name: string;
  t0: number;
  t1: number;
  /** Actions performed in the window (requests, statements, messages). */
  n: number;
  note?: string;
}

export interface SourceCount {
  source: string;
  rows: number;
  bytes: number;
}

const ts = (ms: number) => new Date(ms).toISOString().slice(0, 23).replace("T", " ");
const BYTES = "length(event_message) + arraySum(arrayMap((k, v) -> length(k) + length(v), mapKeys(log_attributes), mapValues(log_attributes)))";

/** The logs endpoint answers a burst of queries with a ThrottlerException; wait it out. */
async function logsPatient(pc: Ctx, q: string): Promise<Awaited<ReturnType<typeof logs>>> {
  let r = await logs(pc, q, 6);
  for (let i = 0; i < 8 && /Too Many|Throttler/i.test(r.error); i++) {
    await sleep(20_000);
    r = await logs(pc, q, 6);
  }
  return r;
}

/** Rows and size proxy per source with event timestamps in [t0, t1). */
export async function footprint(pc: Ctx, t0: number, t1: number, extraWhere = ""): Promise<{ counts: SourceCount[]; error: string }> {
  const where = `timestamp >= toDateTime64('${ts(t0)}', 6) and timestamp < toDateTime64('${ts(t1)}', 6)${extraWhere ? ` and (${extraWhere})` : ""}`;
  const r = await logsPatient(pc, `select source, count(*) as n, sum(${BYTES}) as b from logs where ${where} group by source order by source`);
  const counts = (r.rows as Array<{ source: string; n: number | string; b: number | string }>).map((x) => ({ source: x.source, rows: Number(x.n), bytes: Number(x.b) }));
  return { counts, error: r.error };
}

/** Rows and size proxy for rows whose message contains `needle`, in [t0, t1). */
export async function markerFootprint(pc: Ctx, t0: number, t1: number, needle: string): Promise<{ counts: SourceCount[]; error: string }> {
  return footprint(pc, t0, t1, `position(event_message, '${needle}') > 0`);
}

/** Idle rate per source, rows and bytes per second. */
export function rates(counts: SourceCount[], seconds: number): Map<string, { rows: number; bytes: number }> {
  return new Map(counts.map((c) => [c.source, { rows: c.rows / seconds, bytes: c.bytes / seconds }]));
}

/**
 * Per-action rows and bytes for one window: window counts minus the idle rate
 * times the window length, divided by the action count. Negative remainders
 * (noise larger than the signal) are reported as they come.
 */
export function perAction(w: Window, counts: SourceCount[], idle: Map<string, { rows: number; bytes: number }>): Record<string, number | string> {
  const secs = (w.t1 - w.t0) / 1000;
  const m: Record<string, number | string> = { actions: w.n, window_s: Math.round(secs * 10) / 10 };
  let totalBytes = 0;
  let totalRows = 0;
  const sources = new Set([...counts.map((c) => c.source), ...idle.keys()]);
  for (const s of [...sources].sort()) {
    const c = counts.find((x) => x.source === s) ?? { source: s, rows: 0, bytes: 0 };
    const base = idle.get(s) ?? { rows: 0, bytes: 0 };
    const rows = c.rows - base.rows * secs;
    const bytes = c.bytes - base.bytes * secs;
    if (c.rows === 0 && Math.abs(rows) < 0.5) continue;
    m[`${s}_rows_raw`] = c.rows;
    m[`${s}_rows_per_action`] = Math.round((rows / w.n) * 100) / 100;
    m[`${s}_bytes_per_action`] = Math.round(bytes / w.n);
    totalBytes += bytes;
    totalRows += rows;
  }
  m.all_sources_rows_per_action = Math.round((totalRows / w.n) * 100) / 100;
  m.all_sources_bytes_per_action = Math.round(totalBytes / w.n);
  return m;
}

/** A session as the customer-facing `postgres` role through the shared pooler (session mode, 5432). */
export async function postgresSession(pc: Ctx, ref: string): Promise<pg.Client> {
  const cfg = await mgmt(pc, "GET", `/projects/${ref}/config/database/pooler`);
  const row = (Array.isArray(cfg.json) ? (cfg.json as Array<{ db_host?: string; database_type?: string }>) : []).find((e) => e.database_type === "PRIMARY");
  if (!row?.db_host) throw new Error(`pooler config HTTP ${cfg.status}`);
  const c = new pg.Client({ host: row.db_host, port: 5432, user: `postgres.${ref}`, password: pc.dbPassword, database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000 });
  await c.connect();
  return c;
}

/** A direct session as `postgres` to db.<ref>.supabase.co:5432 (IPv6 only on projects without the IPv4 add-on). */
export async function directSession(pc: Ctx, ref: string): Promise<pg.Client> {
  // Bun's dns.lookup answered ENOTFOUND for this AAAA-only name on macOS
  // (2026-10-15) while dig resolved it; resolve6 and connect to the address,
  // keeping the hostname for TLS SNI.
  const host = `db.${ref}.supabase.co`;
  const [v6] = await dns.resolve6(host);
  if (!v6) throw new Error(`no AAAA for ${host}`);
  const c = new pg.Client({ host: v6, port: 5432, user: "postgres", password: pc.dbPassword, database: "postgres", ssl: { rejectUnauthorized: false, servername: host }, connectionTimeoutMillis: 20_000 });
  await c.connect();
  return c;
}

/** function_logs rows for one function since t0, grouped by event_type, as "Boot:100 Shutdown:100 Log:100". */
export async function logsTypes(pc: Ctx, t0: number, functionId: string): Promise<string> {
  const r = await logsPatient(pc, `select log_attributes['event_type'] as et, count(*) as n from logs where source = 'function_logs' and timestamp >= toDateTime64('${ts(t0)}', 6) and log_attributes['function_id'] = '${functionId}' group by et order by et`);
  return r.error || (r.rows as Array<{ et: string; n: number }>).map((x) => `${x.et || "-"}:${x.n}`).join(" ");
}

/** Wait until a predicate over a marker count holds, or give up after `maxMs`. */
export async function waitForRows(pc: Ctx, t0: number, needle: string, want: number, maxMs = 6 * 60_000): Promise<number> {
  const deadline = Date.now() + maxMs;
  let got = 0;
  while (Date.now() < deadline) {
    const r = await logsPatient(pc, `select count(*) as n from logs where timestamp >= toDateTime64('${ts(t0)}', 6) and position(event_message, '${needle}') > 0`);
    got = Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
    if (got >= want) return got;
    await sleep(15_000);
  }
  return got;
}

/** Sequential requests; returns status histogram. */
export async function sendN(n: number, f: (i: number) => Promise<Response>): Promise<Record<string, number>> {
  const h: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    let s = "0";
    try {
      const r = await f(i);
      await r.arrayBuffer();
      s = String(r.status);
    } catch {
      /* network error counted as 0 */
    }
    h[s] = (h[s] ?? 0) + 1;
  }
  return h;
}

export const hist = (h: Record<string, number>) =>
  Object.entries(h)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
