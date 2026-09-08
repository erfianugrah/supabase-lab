/**
 * Shared helpers for experiments/audit-integrity. Self-contained (does not
 * import from a sibling experiment); platform-wide helpers come from
 * harness/src/platform.ts.
 *
 * Two lessons are baked in here rather than repeated per module:
 *  - `sqlTry` returns the error instead of throwing, because a "permission
 *    denied" IS the measurement in this experiment. A helper that throws turns
 *    the finding into a test bug.
 *  - `createConfirmedUser` retries the first admin write. A fresh project
 *    answers `500 Database error checking email` for ~10 s after every service
 *    reports ACTIVE_HEALTHY (AGENTS.md, "ACTIVE_HEALTHY is not readiness"), and
 *    that failure is not a finding.
 */
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { logsQuery } from "../../../harness/src/platform.js";

export const nonce = () => Math.random().toString(36).slice(2, 10);

export interface HttpOut {
  status: number;
  text: string;
  json: unknown;
  ms: number;
}

export async function httpBody(
  url: string,
  opts: { method?: string; key?: string; bearer?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<HttpOut> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.key ? { apikey: opts.key, Authorization: `Bearer ${opts.bearer ?? opts.key}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, text, json, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { status: 0, text: `ERR:${e instanceof Error ? e.message : String(e)}`, json: undefined, ms: Math.round(performance.now() - t0) };
  }
}

/** Rows from the Management query endpoint; throws when the statement failed. */
export async function sqlRows(ctx: Ctx, query: string): Promise<Record<string, unknown>[]> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query }, 60_000);
  if (r.status >= 300) throw new Error(`sql http ${r.status}: ${r.text.slice(0, 300)}`);
  return Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
}

/** The same call, with the failure returned rather than thrown - a denial is the measurement here. */
export async function sqlTry(ctx: Ctx, query: string): Promise<{ ok: boolean; rows: Record<string, unknown>[]; error: string; status: number }> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query }, 60_000);
  const msg = String((r.json as Record<string, unknown> | undefined)?.message ?? r.text ?? "").replace(/\s+/g, " ").slice(0, 240);
  return {
    ok: r.status < 300,
    rows: Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [],
    error: r.status >= 300 ? msg : "",
    status: r.status,
  };
}

export async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, pollMs = 5000): Promise<{ ok: boolean; elapsedS: number }> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return { ok: true, elapsedS: Math.round((Date.now() - t0) / 1000) };
    if (Date.now() - t0 >= timeoutMs) return { ok: false, elapsedS: Math.round((Date.now() - t0) / 1000) };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Per-service health, which is the readiness signal the aggregate project status is not. */
export async function waitHealthy(ctx: Ctx, timeoutMs = 600_000): Promise<{ ok: boolean; elapsedS: number; last: string }> {
  let last = "";
  const w = await waitFor(async () => {
    const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/health?services=auth&services=rest&services=db`);
    const arr = Array.isArray(r.json) ? (r.json as { name?: string; status?: string }[]) : [];
    last = arr.map((s) => `${s.name}=${s.status}`).join(" ") || `http ${r.status}`;
    return arr.length >= 3 && arr.every((s) => s.status === "ACTIVE_HEALTHY");
  }, timeoutMs, 10_000);
  return { ...w, last };
}

/** An admin-created, email-confirmed user. Sends no mail, so it is safe to burn dozens. */
export async function createConfirmedUser(
  ctx: Ctx,
  serviceJwt: string,
  email: string,
  password: string,
): Promise<{ id: string; status: number; attempts: number; err: string }> {
  let attempts = 0;
  let status = 0;
  let err = "";
  for (let i = 0; i < 8; i++) {
    attempts++;
    const r = await httpBody(`https://${ctx.apiHost}/auth/v1/admin/users`, {
      method: "POST",
      key: serviceJwt,
      body: { email, password, email_confirm: true },
    });
    status = r.status;
    const id = String((r.json as { id?: string })?.id ?? "");
    if (id) return { id, status, attempts, err: "" };
    err = String((r.json as { msg?: string; message?: string })?.msg ?? (r.json as { message?: string })?.message ?? r.text).slice(0, 160);
    await new Promise((res) => setTimeout(res, 8000));
  }
  return { id: "", status, attempts, err };
}

export async function deleteUser(ctx: Ctx, serviceJwt: string, id: string): Promise<number> {
  const r = await httpBody(`https://${ctx.apiHost}/auth/v1/admin/users/${id}`, { method: "DELETE", key: serviceJwt });
  return r.status;
}

export async function passwordLogin(ctx: Ctx, anonJwt: string, email: string, password: string): Promise<HttpOut> {
  return httpBody(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, {
    method: "POST",
    key: anonJwt,
    body: { email, password },
  });
}

/**
 * One ClickHouse query against the unified log stream. Projects created after
 * June 2026 are ClickHouse-backed, so this is bracket access on
 * `log_attributes` and a `source` filter - not the BigQuery `cross join unnest`
 * shape the older experiments carry.
 */
export async function stream(ctx: Ctx, sqlText: string, windowHours = 1) {
  return logsQuery(ctx, sqlText, windowHours);
}

/** Poll the log stream until a query returns rows, and report the lag. */
export async function findInStream(
  ctx: Ctx,
  sqlText: string,
  timeoutMs: number,
  pollMs = 10_000,
): Promise<{ found: boolean; lagS: number; rows: Record<string, unknown>[]; error: string }> {
  const t0 = Date.now();
  let error = "";
  for (;;) {
    const r = await stream(ctx, sqlText, 1);
    error = r.error;
    if (r.rows.length > 0) return { found: true, lagS: Math.round((Date.now() - t0) / 1000), rows: r.rows as Record<string, unknown>[], error };
    if (Date.now() - t0 >= timeoutMs) return { found: false, lagS: Math.round((Date.now() - t0) / 1000), rows: [], error };
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

/** Count rows in auth.audit_log_entries, optionally filtered by a payload action marker. */
export async function tableCount(ctx: Ctx, where = "true"): Promise<number> {
  const rows = await sqlRows(ctx, `select count(*)::int as n from auth.audit_log_entries where ${where}`);
  return Number((rows[0] as { n?: number })?.n ?? 0);
}

/**
 * One query for SEVERAL markers, polled until they have all shown up or the
 * timeout passes. The logs endpoint is rate limited (10 requests per window),
 * and a module that polls per marker burns that budget three times over -
 * which shows up as an endpoint error and reads like "the statement was never
 * logged". One OR'd query per poll keeps a three-marker search inside the
 * budget of a one-marker search.
 */
export async function findMarkers(
  ctx: Ctx,
  markers: string[],
  timeoutMs: number,
  pollMs = 30_000,
): Promise<{
  hits: Record<string, Record<string, unknown> | undefined>;
  /** Elapsed seconds at which each marker was FIRST seen; absent when it never was. */
  firstSeenS: Record<string, number>;
  /** Elapsed seconds when the loop exited - a search-window bound, not a latency. */
  windowS: number;
  error: string;
  polls: number;
}> {
  const t0 = Date.now();
  const hits: Record<string, Record<string, unknown> | undefined> = Object.fromEntries(markers.map((m) => [m, undefined]));
  const firstSeenS: Record<string, number> = {};
  let error = "";
  let polls = 0;
  const where = markers.map((m) => `event_message like '%${m}%'`).join(" or ");
  for (;;) {
    polls++;
    const r = await stream(
      ctx,
      `select timestamp, log_attributes['parsed.user_name'] as usr, log_attributes['parsed.application_name'] as app, event_message
         from logs where source = 'postgres_logs' and (${where}) limit 25`,
      1,
    );
    error = r.error;
    for (const row of r.rows as Record<string, unknown>[]) {
      const msg = String(row.event_message ?? "");
      for (const m of markers) {
        if (!hits[m] && msg.includes(m)) {
          hits[m] = row;
          // Per-marker, because the loop runs to the timeout whenever ANY
          // marker is missing: a single exit-time figure reported the timeout
          // as though it were the control's ingestion lag, and the
          // audit-integrity write-up published 189 s that way.
          firstSeenS[m] = Math.round((Date.now() - t0) / 1000);
        }
      }
    }
    if (markers.every((m) => hits[m])) break;
    if (Date.now() - t0 >= timeoutMs) break;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return { hits, firstSeenS, windowS: Math.round((Date.now() - t0) / 1000), error, polls };
}

/**
 * Is the in-database copy of the auth audit trail switched on?
 *
 * `audit_log_disable_postgres` is returned by GET config/auth but is NOT in the
 * published spec, and a PATCH of it answers 200 while changing nothing
 * (measured 2026-09-08: PATCH false -> 200, re-read still true). So a module
 * that needs the table populated has to READ this and gate, not set it - the
 * switch is Dashboard-only (Authentication -> Configuration -> Audit Logs).
 */
export async function auditCopyEnabled(ctx: Ctx): Promise<{ enabled: boolean; keyPresent: boolean; raw: string }> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
  const cfg = (r.json ?? {}) as Record<string, unknown>;
  const present = Object.prototype.hasOwnProperty.call(cfg, "audit_log_disable_postgres");
  const disabled = cfg.audit_log_disable_postgres;
  return { enabled: present ? disabled !== true : false, keyPresent: present, raw: String(disabled ?? "absent") };
}
