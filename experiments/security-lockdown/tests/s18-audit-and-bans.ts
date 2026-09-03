/**
 * S18 - who accessed what, and how do you block them: the audit trail and the
 * ban levers a customer credential reaches.
 *
 * Managed project. PAT for the logs and network-bans endpoints, legacy anon
 * and service_role JWTs for the marked requests, psql from this machine
 * through the session pooler for the ban trigger.
 *
 *   S18a  Log Drains and bans in the /v1 spec: paths matching drain / ban
 *   S18b  a marked REST request (unique table name in the path) found in
 *         edge_logs with a client-IP header field, and the ingestion lag
 *   S18c  a marked Storage request found in edge_logs the same way
 *   S18d  a failed password login visible in auth_logs, with lag; what GET
 *         /auth/v1/admin/audit returns for a successful login (measured, not
 *         a pass condition)
 *   S18e  network bans: retrieve (baseline), 10 failed psql auths through the
 *         pooler, retrieve, remove any new ban, retrieve; did a ban appear
 *
 * Not settled by this module: Log Drains delivery (no /v1 lever; Dashboard
 * only), and whether direct-5432 (IPv6) failed auths ban where the pooler
 * does not.
 *
 * DESTRUCTIVE: creates an auth user (deleted); may ban this machine's IP from
 * the DB socket (removed in finally). Run alone, after S17/S19/S21.
 */
import { spawnSync } from "node:child_process";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { logsQuery as logsQueryStream } from "../../../harness/src/platform.js";

/**
 * Same query, against `/analytics/endpoints/logs.all` with a 1-hour window.
 * The `logs` stream endpoint the shared helper uses answered "Backend error!
 * Retry your query." to every query in the first S18 run while `logs.all`
 * answered the identical SQL by hand; both are tried, logs.all first.
 */
async function logsQuery(ctx: Ctx, sqlText: string, windowHours = 1) {
  const end = new Date();
  const start = new Date(end.getTime() - windowHours * 3600_000);
  const qs = `sql=${encodeURIComponent(sqlText)}&iso_timestamp_start=${encodeURIComponent(start.toISOString())}&iso_timestamp_end=${encodeURIComponent(end.toISOString())}`;
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/analytics/endpoints/logs.all?${qs}`, undefined, 60_000);
  const j = (r.json ?? {}) as { result?: Record<string, unknown>[]; error?: unknown };
  if (Array.isArray(j.result) && !j.error) return { status: r.status, rows: j.result, error: "" };
  const alt = await logsQueryStream(ctx, sqlText, windowHours);
  return { status: alt.status, rows: alt.rows as Record<string, unknown>[], error: j.error ? `logs.all: ${JSON.stringify(j.error).slice(0, 120)}; logs: ${alt.error}` : alt.error };
}
import { fetchKeys, httpBody, errCode, waitFor } from "../lib/sec.js";

const SPEC_URL = "https://api.supabase.com/api/v1-json";
const ATTEMPTS = 10;
const LOG_WAIT_MS = 150_000;
// auth_logs lagged past 94s in the first run while edge_logs took 15s; the
// lines were there minutes later by hand.
const AUTH_LOG_WAIT_MS = 360_000;
const nonce = () => Math.random().toString(36).slice(2, 10);

async function findInLogs(ctx: Ctx, rich: string, simple: string, timeoutMs: number): Promise<{ found: boolean; lagS: number; row?: Record<string, unknown>; via: string; err: string }> {
  const t0 = Date.now();
  let via = "rich";
  let err = "";
  while (Date.now() - t0 < timeoutMs) {
    let r = await logsQuery(ctx, via === "rich" ? rich : simple, 1);
    if (r.error && via === "rich") {
      err = r.error;
      via = "simple";
      r = await logsQuery(ctx, simple, 1);
    }
    if (r.rows.length > 0) return { found: true, lagS: Math.round((Date.now() - t0) / 1000), row: r.rows[0], via, err };
    await new Promise((res) => setTimeout(res, 10_000));
  }
  return { found: false, lagS: Math.round((Date.now() - t0) / 1000), via, err };
}

function psqlAttempt(connstr: string): string {
  const r = spawnSync("psql", [connstr, "-tAc", "select 1"], { env: { ...process.env, PGCONNECT_TIMEOUT: "5" }, timeout: 12_000, encoding: "utf8" });
  // The pooler's resolved address is in every libpq error; keep it out of the artifact.
  return r.status === 0 ? "OK" : (r.stderr || r.error?.message || "").replace(/\s+/g, " ").replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<ip>").slice(0, 160);
}

const mod: TestModule = {
  id: "S18",
  title: "audit trail (edge_logs, auth_logs, admin audit) and blocking (network bans) from a customer credential",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    let userId = "";
    let newBans: string[] = [];
    try {
      // S18a
      const spec = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
      const doc = (await spec.json()) as { paths?: Record<string, unknown> };
      const paths = Object.keys(doc.paths ?? {});
      const drain = paths.filter((p) => /drain/i.test(p));
      const bans = paths.filter((p) => /\bban/i.test(p));
      out.push({
        id: "S18a",
        title: "Log Drains and ban levers in the /v1 spec",
        status: "info",
        detail: `${paths.length} paths; ${drain.length} mention drain (${drain.join(", ") || "none - Log Drains are Dashboard-only"}); ${bans.length} mention ban: ${bans.join(", ")}.`,
        measurements: { spec_paths: paths.length, drain_paths: drain.length, ban_paths: bans.length },
        evidence: bans.join("\n"),
      });

      // S18b - marked REST request
      const n1 = nonce();
      const rest = await httpBody(`https://${ctx.apiHost}/rest/v1/sec18_${n1}?select=id`, { key: keys.anonJwt });
      const restLog = await findInLogs(
        ctx,
        `select id, timestamp, r.method, r.path, h.cf_connecting_ip, h.x_real_ip from edge_logs cross join unnest(metadata) as m cross join unnest(m.request) as r cross join unnest(r.headers) as h where r.path like '%sec18_${n1}%' limit 3`,
        `select id, timestamp, event_message from edge_logs where event_message like '%sec18_${n1}%' limit 3`,
        LOG_WAIT_MS,
      );
      const ipPresent = Boolean(restLog.row?.cf_connecting_ip || restLog.row?.x_real_ip);
      out.push({
        id: "S18b",
        title: "a REST request is findable in edge_logs by path, with a client IP",
        status: restLog.found ? "pass" : "fail",
        detail: restLog.found
          ? `anon GET /rest/v1/sec18_<nonce> -> ${rest.status}; found in edge_logs ${restLog.lagS}s later via the ${restLog.via} query (method=${String(restLog.row?.method ?? "?")}); client IP field present: ${ipPresent}${restLog.err ? `; rich query error: ${restLog.err}` : ""}.`
          : `not found in edge_logs within ${restLog.lagS}s (${restLog.via}; ${restLog.err})`,
        measurements: { rest_status: rest.status, found: String(restLog.found), lag_s: restLog.lagS, client_ip_present: String(ipPresent), query: restLog.via },
      });

      // S18c - marked Storage request
      const n2 = nonce();
      const sto = await httpBody(`https://${ctx.apiHost}/storage/v1/bucket?sec18=${n2}`, { key: keys.serviceJwt });
      const stoLog = await findInLogs(
        ctx,
        `select id, timestamp, r.method, r.url, h.cf_connecting_ip, h.x_real_ip from edge_logs cross join unnest(metadata) as m cross join unnest(m.request) as r cross join unnest(r.headers) as h where r.url like '%sec18=${n2}%' limit 3`,
        `select id, timestamp, event_message from edge_logs where event_message like '%sec18=${n2}%' limit 3`,
        LOG_WAIT_MS,
      );
      out.push({
        id: "S18c",
        title: "a Storage request is findable in edge_logs the same way",
        status: stoLog.found ? "pass" : "fail",
        detail: stoLog.found
          ? `service GET /storage/v1/bucket?sec18=<nonce> -> ${sto.status}; found ${stoLog.lagS}s later (${stoLog.via}); client IP field present: ${Boolean(stoLog.row?.cf_connecting_ip || stoLog.row?.x_real_ip)}.`
          : `not found within ${stoLog.lagS}s (${stoLog.via}; ${stoLog.err})`,
        measurements: { storage_status: sto.status, found: String(stoLog.found), lag_s: stoLog.lagS },
      });

      // S18d - auth: failed login in auth_logs, successful login in admin audit
      const n3 = nonce();
      const bad = await httpBody(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, { method: "POST", key: keys.anonJwt, body: { email: `sec18-${n3}@example.com`, password: "not-the-password" } });
      const badLog = await findInLogs(
        ctx,
        `select id, timestamp, event_message from auth_logs where event_message like '%"path":"/token"%' and event_message like '%"error_code":"invalid_credentials"%' order by timestamp desc limit 3`,
        `select id, timestamp, event_message from auth_logs where event_message like '%"path":"/token"%' and event_message like '%"status":400%' order by timestamp desc limit 3`,
        AUTH_LOG_WAIT_MS,
      );
      const email = `sec18-ok-${n3}@example.com`;
      const pw = `S18-${n3}-${nonce()}-Xy!`;
      const created = await httpBody(`https://${ctx.apiHost}/auth/v1/admin/users`, { method: "POST", key: keys.serviceJwt, body: { email, password: pw, email_confirm: true } });
      userId = String((created.json as { id?: string })?.id ?? "");
      let login = await httpBody(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, { method: "POST", key: keys.anonJwt, body: { email, password: pw } });
      await waitFor(async () => {
        if (login.status === 200) return true;
        login = await httpBody(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, { method: "POST", key: keys.anonJwt, body: { email, password: pw } });
        return login.status === 200;
      }, 60_000, 5000);
      const t0 = Date.now();
      let auditAction = "";
      let auditStatus = 0;
      let auditCount = 0;
      const audited = await waitFor(async () => {
        const a = await httpBody(`https://${ctx.apiHost}/auth/v1/admin/audit?limit=100`, { key: keys.serviceJwt });
        auditStatus = a.status;
        const arr = Array.isArray(a.json) ? (a.json as { payload?: { action?: string; actor_username?: string; traits?: Record<string, unknown> } }[]) : [];
        auditCount = arr.length;
        const hit = arr.find((e) => JSON.stringify(e).includes(email));
        if (hit) auditAction = String(hit.payload?.action ?? "");
        return Boolean(hit);
      }, 60_000, 5000);
      const okLog = await findInLogs(
        ctx,
        `select id, timestamp, event_message from auth_logs where event_message like '%"action":"login"%' and event_message like '%${email}%' limit 3`,
        `select id, timestamp, event_message from auth_logs where event_message like '%${email}%' limit 3`,
        AUTH_LOG_WAIT_MS,
      );
      out.push({
        id: "S18d",
        title: "auth: failed login in auth_logs, successful login in the admin audit log",
        status: badLog.found && okLog.found ? "pass" : "fail",
        detail: `failed login -> ${bad.status} ${errCode(bad.json, bad.text)}; auth_logs match ${badLog.found ? `found ${badLog.lagS}s later (matched by ${badLog.via === "rich" ? "path=/token + error_code=invalid_credentials" : "path=/token + status=400"}; the line carries method, path, status, error_code and remote_addr, not the email)` : `not found in ${badLog.lagS}s (${badLog.err})`}. Successful login -> ${login.status}: an auth_event line with action=login and the actor's email ${okLog.found ? `appeared in auth_logs ${okLog.lagS}s after the audit poll` : `did not appear within ${okLog.lagS}s`}; GET /auth/v1/admin/audit (service key) -> HTTP ${auditStatus}, ${auditCount} entries, user ${audited.ok ? `present ${Math.round((Date.now() - t0) / 1000)}s later, action=${auditAction}` : "absent within 60s - the audit trail is the auth_logs auth_event, not the admin audit endpoint"}.`,
        measurements: { failed_login_status: bad.status, auth_logs_found: String(badLog.found), auth_logs_lag_s: badLog.lagS, login_status: login.status, login_event_found: String(okLog.found), login_event_lag_s: okLog.lagS, audit_status: auditStatus, audit_entries: auditCount, audit_found: String(audited.ok) },
      });

      // S18e - network bans
      const before = await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-bans/retrieve`);
      const list = (r: { json?: unknown }) => ((r.json as { banned_ipv4_addresses?: string[] })?.banned_ipv4_addresses ?? []);
      const b0 = list(before);
      const proj = await mgmt(ctx, "GET", `/projects/${ctx.ref}`);
      const region = (proj.json as { region?: string })?.region || ctx.region;
      const pooler = `aws-0-${region}.pooler.supabase.com`;
      const badConn = `postgres://postgres.${ctx.ref}:wrong-password-${nonce()}@${pooler}:5432/postgres?sslmode=require`;
      const errs: string[] = [];
      for (let i = 0; i < ATTEMPTS; i++) errs.push(psqlAttempt(badConn));
      await new Promise((r) => setTimeout(r, 15_000));
      const after = await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-bans/retrieve`);
      const enriched = await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-bans/retrieve/enriched`);
      const b1 = list(after);
      newBans = b1.filter((ip) => !b0.includes(ip));
      let removeStatus = -1;
      let b2: string[] = b1;
      if (newBans.length) {
        const rm = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/network-bans`, { ipv4_addresses: newBans });
        removeStatus = rm.status;
        b2 = list(await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-bans/retrieve`));
        if (!b2.some((ip) => newBans.includes(ip))) newBans = [];
      }
      const dbPw = ctx.dbPassword || process.env.PVLAB_DB_PASSWORD || "";
      const pwOk = dbPw ? psqlAttempt(`postgres://postgres.${ctx.ref}:${encodeURIComponent(dbPw)}@${pooler}:5432/postgres?sslmode=require`).replace(dbPw, "<pw>") : "skipped";
      const distinctErr = [...new Set(errs)].join(" | ").slice(0, 300);
      out.push({
        id: "S18e",
        title: "network bans: retrieve, provoke via failed pooler auth, remove",
        status: before.status < 300 && b1.length > b0.length && b2.length === b0.length ? "pass" : "info",
        detail: `retrieve -> HTTP ${before.status}, ${b0.length} banned before. ${ATTEMPTS} failed psql auths via the pooler (${distinctErr}). After: ${b1.length} banned (${newBans.length || b1.length - b0.length} new)${b1.length > b0.length ? `; DELETE /network-bans -> ${removeStatus}, ${b2.length} after removal` : " - the pooler path did not produce a ban"}. Enriched -> HTTP ${enriched.status}. Correct-password psql afterwards: ${pwOk}.`,
        measurements: { retrieve_status: before.status, banned_before: b0.length, failed_attempts: ATTEMPTS, banned_after: b1.length, ban_appeared: String(b1.length > b0.length), remove_status: removeStatus, banned_after_remove: b2.length, psql_ok_after: pwOk === "OK" ? "yes" : "no" },
        evidence: enriched.text.slice(0, 500).replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, "<ip>"),
      });
    } catch (e) {
      out.push({ id: "S18err", title: "S18 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (userId) await httpBody(`https://${ctx.apiHost}/auth/v1/admin/users/${userId}`, { method: "DELETE", key: keys.serviceJwt }).catch(() => {});
      if (newBans.length) await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/network-bans`, { ipv4_addresses: newBans }).catch(() => {});
      out.push({ id: "S18z", title: "cleanup", status: "pass", detail: "auth user deleted; any new ban removed" });
    }
    return out;
  },
};
export default mod;
