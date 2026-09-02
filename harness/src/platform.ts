/**
 * Platform helpers every experiment ends up rewriting, with the lessons that
 * cost a run each baked in. Import from here rather than from another
 * experiment's lib.
 *
 *  - `sql()`      the Management query endpoint answers 201, not 200, to a
 *                 successful statement (self-hosted-auth SH01 failed its first
 *                 run on `=== 200`); multi-statement SQL runs in ONE
 *                 transaction, so a function and a policy that references it
 *                 need two calls.
 *  - `fetchKeys()` new projects carry both key generations; select by `name`
 *                 for the legacy JWTs and by `type` for the sb_ keys, or a
 *                 non-JWT ends up as a bearer and reads like an auth finding.
 *  - `logsQuery()` the logs endpoint answers `Backend error! Retry your query.`
 *                 to any query without BOTH `iso_timestamp_start` and
 *                 `iso_timestamp_end` (2026-09-02), and returns HTTP 200 with
 *                 an `error` field on every failure, so the status code says
 *                 nothing. 10 requests per window. Edge Function console
 *                 output is `source = 'function_logs'`.
 *  - `functionPresent()` a deploy is not done on its status or exit code; this
 *                 is the read that says whether the function exists, with a
 *                 retry through the 429 a burst of deploys provokes.
 */
import { mgmt } from "./mgmt";
import type { Ctx } from "./types";

export interface SqlResult {
  status: number;
  rows: Record<string, unknown>[];
  error: string;
}

export async function sql(ctx: Ctx, query: string, timeoutMs = 60_000): Promise<SqlResult> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query }, timeoutMs);
  const rows = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
  const error = r.status >= 300 ? String((r.json as Record<string, unknown> | undefined)?.message ?? r.text).slice(0, 300) : "";
  return { status: r.status, rows, error };
}

export interface ProjectKeys {
  /** Legacy anon JWT (HS256 under the project's jwt_secret). */
  anon: string;
  /** Legacy service_role JWT. */
  service: string;
  /** New-generation opaque keys, when present. */
  publishable?: string;
  secret?: string;
}

export async function fetchKeys(ctx: Ctx): Promise<ProjectKeys> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=true`);
  const rows = Array.isArray(r.json) ? (r.json as { name?: string; type?: string; api_key?: string }[]) : [];
  const byName = (n: string) => rows.find((k) => k.name === n)?.api_key ?? "";
  const byType = (t: string) => rows.find((k) => k.type === t)?.api_key;
  const anon = byName("anon");
  const service = byName("service_role");
  if (!anon || !service) throw new Error(`legacy anon/service_role keys absent (api-keys HTTP ${r.status})`);
  return { anon, service, publishable: byType("publishable"), secret: byType("secret") };
}

export interface LogRow {
  event_message?: string;
  source?: string;
  timestamp?: string;
  [k: string]: unknown;
}

export interface LogsResult {
  status: number;
  rows: LogRow[];
  /** The endpoint's own error text, verbatim; empty on success. */
  error: string;
}

/**
 * One query against `/analytics/endpoints/logs` with the time window the
 * endpoint requires. `windowHours` back from now; the endpoint refuses windows
 * over 24 hours.
 */
export async function logsQuery(ctx: Ctx, sqlText: string, windowHours = 3): Promise<LogsResult> {
  const end = new Date();
  const start = new Date(end.getTime() - windowHours * 3600_000);
  const qs =
    `sql=${encodeURIComponent(sqlText)}` +
    `&iso_timestamp_start=${encodeURIComponent(start.toISOString())}` +
    `&iso_timestamp_end=${encodeURIComponent(end.toISOString())}`;
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/analytics/endpoints/logs?${qs}`, undefined, 60_000);
  const j = (r.json ?? {}) as { result?: LogRow[]; error?: unknown };
  return {
    status: r.status,
    rows: Array.isArray(j.result) ? j.result : [],
    error: j.error ? JSON.stringify(j.error).slice(0, 200) : r.status >= 300 ? r.text.slice(0, 200) : "",
  };
}

export interface FunctionPresence {
  status: number;
  present: boolean;
  version?: number;
  fnStatus?: string;
}

/** GET /functions/{slug}, retrying through 429 so a verification read survives the throttle a deploy burst provoked. */
export async function functionPresent(ctx: Ctx, slug: string, retries = 4): Promise<FunctionPresence> {
  let r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/functions/${slug}`);
  for (let i = 0; i < retries && r.status === 429; i++) {
    await Bun.sleep(15_000);
    r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/functions/${slug}`);
  }
  const j = (r.json ?? {}) as Record<string, unknown>;
  return {
    status: r.status,
    present: r.status === 200,
    version: typeof j.version === "number" ? j.version : undefined,
    fnStatus: typeof j.status === "string" ? j.status : undefined,
  };
}
