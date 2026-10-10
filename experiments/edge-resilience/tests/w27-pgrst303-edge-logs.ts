/**
 * W27 - does the PGRST303 body length survive the edge into edge_logs, and
 * what does Logs Explorer need to split "JWT issued at future" from "JWT
 * expired" without the body?
 *
 * Every row measures the MANAGED project, PostgREST behind the API gateway,
 * with a legacy HS256 token minted under the project's own jwt_secret (the
 * W07 break-glass path - `GET /projects/{ref}/postgrest` returns it) and the
 * publishable key as `apikey`. Requests carry a unique User-Agent so the
 * edge_logs rows can be found without a body.
 *
 *   W27a  wire: an iat +300 s token, an exp -300 s token and a valid token
 *         against an open table.
 *         Expect 401 PGRST303 / 79 bytes, 401 PGRST303 / 70 bytes, 200.
 *         The two error bodies differ only in the message, so the byte count
 *         IS the message.
 *   W27b  edge_logs via the unified `/analytics/endpoints/logs` (ClickHouse
 *         dialect, `source = 'edge_logs'`, nested fields through the
 *         `log_attributes` map): the same three rows read back with
 *         response.headers.content_length, proxy_status and the parsed JWT
 *         payload (issued_at, expires_at). Pass when every content_length
 *         equals the wire byte count and issued_at minus the request
 *         timestamp reproduces the +300s skew. Records the exact SQL that
 *         worked. Until 2026-09-23 this row read `logs.all` (BigQuery
 *         dialect, `unnest(metadata)`); that endpoint answers 410 now, and
 *         one request to it is made here to record the status.
 *   W27d  the incident-window read FAILURE-MATRIX 3.1 cites: select on
 *         `proxy_status = 'PostgREST; error=PGRST303'`, split future-iat from
 *         expired in SQL (`issued_at` minus `toUnixTimestamp(timestamp)`;
 *         `expires_at` below it). The probe's User-Agent prefix is kept in
 *         the predicate so a shared project's other rows stay out. Pass when
 *         the future-iat probe row reads a skew of 290-310 s and not-expired,
 *         and the expired probe row reads expired.
 *   W27c  42501 mapping: a table with all privileges revoked from anon and
 *         authenticated (`revoke all on table`), hit as anon (publishable key
 *         only), as the legacy anon JWT, and as a minted authenticated token.
 *         S21 measured anon 401 / authenticated 403 on 2026-09-03 on the wire
 *         only; this row adds the legacy-anon-JWT-as-bearer case and the
 *         edge_logs shape, and records what proxy_status carries for it.
 *         On the unified table a 42501 row has no `transfer_encoding` and no
 *         `content_length` key at all (read back as ""), where the retired
 *         `logs.all` read showed transfer_encoding "chunked" - the
 *         `log_*_transfer_encoding` measurements record "-" for that reason.
 *
 * Pass means the platform did what a reader of edge_logs would assume;
 * fail is a measured disagreement, not a harness error. Platform error text
 * is quoted verbatim in `detail`, numbers live in `measurements`.
 *
 * Not settled by this module: the stale-time cache itself (a PostgREST build
 * with a one-second skew, out of scope here), and whether a project
 * provisioned in an earlier Logs Explorer era exposes the same field paths -
 * the 2026-10-10 re-run used a project provisioned that day.
 *
 * DESTRUCTIVE: creates public.w27_locked and drops it in finally. Needs
 * public.w_probe (the Makefile seed) for W27a/b.
 */
import { createHmac } from "node:crypto";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, logsQuery, sql } from "../../../harness/src/platform";

const ID = "W27";
const SUB = "00000000-0000-0000-0000-000000000027";
const LOG_WAIT_MS = 180_000;
const LOG_POLL_MS = 10_000;

const b64url = (s: string | Buffer) =>
  Buffer.from(s).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

function mintHs256(secret: string, claims: object): string {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify(claims));
  const sig = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

interface Wire {
  status: number;
  code: string;
  message: string;
  bytes: number;
  contentLength: string;
  proxyStatus: string;
}

async function hit(ctx: Ctx, path: string, ua: string, bearer?: string): Promise<Wire> {
  const headers: Record<string, string> = { apikey: ctx.anonKey!, "User-Agent": ua };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const r = await fetch(`https://${ctx.apiHost}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let code = "";
  let message = "";
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.code === "string") code = j.code;
    if (typeof j.message === "string") message = j.message;
  } catch {
    // non-JSON body (a 200 row set parses, an error body parses; anything else is left blank)
  }
  return {
    status: r.status,
    code,
    message,
    bytes: Buffer.byteLength(text),
    contentLength: r.headers.get("content-length") ?? "",
    proxyStatus: r.headers.get("proxy-status") ?? "",
  };
}

/**
 * The edge_logs read on the unified `logs` table. Nested request/response
 * fields are flat string keys of the `log_attributes` map; a key that is absent
 * on a row reads as the empty string (not null), so "no JWT payload" and
 * "chunked, no content_length" both come back as "". `timestamp` is an ISO
 * string in UTC without a zone suffix (the BigQuery-era `logs.all` returned
 * microseconds since epoch). Kept as one string so the artifact carries
 * exactly what ran.
 */
const A = (k: string) => `log_attributes['${k}']`;
const richSql = (uaPrefix: string) => `select timestamp,
       ${A("request.method")} as method, ${A("request.path")} as path,
       ${A("request.headers.user_agent")} as user_agent,
       ${A("response.status_code")} as status_code,
       ${A("response.headers.content_length")} as content_length,
       ${A("response.headers.transfer_encoding")} as transfer_encoding,
       ${A("response.headers.proxy_status")} as proxy_status,
       ${A("request.sb.jwt.authorization.payload.issued_at")} as issued_at,
       ${A("request.sb.jwt.authorization.payload.expires_at")} as expires_at,
       ${A("request.sb.jwt.authorization.payload.role")} as role,
       ${A("request.sb.auth_user")} as auth_user
from logs
where source = 'edge_logs'
  and ${A("request.headers.user_agent")} like '${uaPrefix}%'
order by timestamp desc
limit 100`;

/**
 * The incident-window form: select on the error class, split future-iat from
 * expired in SQL. `toInt64OrNull` because every map value is a string. The
 * User-Agent predicate is the probe's marker; drop it to scan a real window.
 */
const incidentSql = (uaPrefix: string) => `select timestamp,
       ${A("request.headers.user_agent")} as user_agent,
       ${A("response.headers.content_length")} as content_length,
       toInt64OrNull(${A("request.sb.jwt.authorization.payload.issued_at")}) as issued_at,
       toInt64OrNull(${A("request.sb.jwt.authorization.payload.expires_at")}) as expires_at,
       issued_at - toUnixTimestamp(timestamp) as iat_skew_s,
       expires_at < toUnixTimestamp(timestamp) as is_expired
from logs
where source = 'edge_logs'
  and ${A("response.headers.proxy_status")} = 'PostgREST; error=PGRST303'
  and ${A("request.headers.user_agent")} like '${uaPrefix}%'
order by timestamp desc
limit 100`;

interface LogRow {
  user_agent: string;
  status_code: number;
  content_length: string | null;
  transfer_encoding: string | null;
  proxy_status: string | null;
  issued_at: number | null;
  expires_at: number | null;
  role: string | null;
  auth_user: string | null;
  /** seconds since epoch, from the ISO timestamp (UTC) */
  ts_s: number;
}

const nullIfEmpty = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const numOrNull = (v: unknown): number | null => {
  const s = nullIfEmpty(v);
  return s === null || !Number.isFinite(Number(s)) ? null : Number(s);
};

function parseRow(r: Record<string, unknown>): LogRow {
  return {
    user_agent: String(r.user_agent ?? ""),
    status_code: Number(r.status_code),
    content_length: nullIfEmpty(r.content_length),
    transfer_encoding: nullIfEmpty(r.transfer_encoding),
    proxy_status: nullIfEmpty(r.proxy_status),
    issued_at: numOrNull(r.issued_at),
    expires_at: numOrNull(r.expires_at),
    role: nullIfEmpty(r.role),
    auth_user: nullIfEmpty(r.auth_user),
    ts_s: Math.floor(Date.parse(`${String(r.timestamp)}Z`) / 1000),
  };
}

/** Poll the unified logs endpoint until every expected User-Agent has a row, or the budget is spent. */
async function awaitRows(
  ctx: Ctx,
  uaPrefix: string,
  expected: string[],
): Promise<{ rows: LogRow[]; lagS: number; error: string }> {
  const t0 = Date.now();
  let last: { rows: LogRow[]; error: string } = { rows: [], error: "" };
  while (Date.now() - t0 < LOG_WAIT_MS) {
    const r = await logsQuery(ctx, richSql(uaPrefix), 1);
    last = { rows: (r.rows as Record<string, unknown>[]).map(parseRow), error: r.error };
    const seen = new Set(last.rows.map((x) => x.user_agent));
    if (expected.every((ua) => seen.has(ua))) break;
    await Bun.sleep(LOG_POLL_MS);
  }
  return { ...last, lagS: Math.round((Date.now() - t0) / 1000) };
}

const mod: TestModule = {
  id: ID,
  title: "PGRST303 body length through edge_logs, and the Logs Explorer split",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const nonce = Math.random().toString(36).slice(2, 10);
    const uaPrefix = `pvlab-w27-${nonce}`;
    const ua = (k: string) => `${uaPrefix}-${k}`;
    let lockedCreated = false;

    try {
      const pg = await mgmt(ctx, "GET", `/projects/${ctx.ref}/postgrest`);
      const secret = (pg.json as Record<string, unknown> | undefined)?.jwt_secret;
      if (typeof secret !== "string") {
        return [{ id: ID, title: this.title, status: "fail", detail: `GET /postgrest HTTP ${pg.status}: jwt_secret absent`, evidence: pg.text.slice(0, 300) }];
      }
      const keys = await fetchKeys(ctx);
      const now = Math.floor(Date.now() / 1000);
      const claims = (iat: number, exp: number) => ({ role: "authenticated", aud: "authenticated", sub: SUB, iat, exp });
      const tokens = {
        future: mintHs256(secret, claims(now + 300, now + 3900)),
        expired: mintHs256(secret, claims(now - 3900, now - 300)),
        valid: mintHs256(secret, claims(now, now + 3600)),
      };

      // W27a - wire
      const wire: Record<string, Wire> = {};
      for (const k of ["future", "expired", "valid"] as const) {
        wire[k] = await hit(ctx, "/rest/v1/w_probe?select=id", ua(k), tokens[k]);
      }
      const ma: Record<string, number | string> = { mint_now_epoch: now };
      for (const [k, w] of Object.entries(wire)) {
        ma[`wire_${k}_status`] = w.status;
        ma[`wire_${k}_code`] = w.code || "-";
        ma[`wire_${k}_bytes`] = w.bytes;
        ma[`wire_${k}_content_length`] = w.contentLength || "-";
        ma[`wire_${k}_proxy_status`] = w.proxyStatus || "-";
      }
      const aPass =
        wire.future!.status === 401 && wire.future!.code === "PGRST303" && wire.future!.bytes === 79 &&
        wire.expired!.status === 401 && wire.expired!.code === "PGRST303" && wire.expired!.bytes === 70 &&
        wire.valid!.status === 200;
      out.push({
        id: `${ID}a`,
        title: "wire: future iat vs expired vs valid, body bytes",
        status: aPass ? "pass" : "fail",
        detail:
          `future: ${wire.future!.status} ${wire.future!.code} "${wire.future!.message}" ${wire.future!.bytes}B; ` +
          `expired: ${wire.expired!.status} ${wire.expired!.code} "${wire.expired!.message}" ${wire.expired!.bytes}B; ` +
          `valid: ${wire.valid!.status} ${wire.valid!.bytes}B. proxy-status on the 401s: "${wire.future!.proxyStatus}"`,
        measurements: ma,
      });

      // W27b - edge_logs through the unified logs endpoint
      const expectedUa = ["future", "expired", "valid"].map(ua);
      const logs = await awaitRows(ctx, uaPrefix, expectedUa);
      // One request to the retired endpoint, recorded as data (410 since 2026-09-23).
      const nowIso = new Date();
      const legacyQs =
        `sql=${encodeURIComponent("select 1")}` +
        `&iso_timestamp_start=${encodeURIComponent(new Date(nowIso.getTime() - 3600_000).toISOString())}` +
        `&iso_timestamp_end=${encodeURIComponent(nowIso.toISOString())}`;
      const legacy = await mgmt(ctx, "GET", `/projects/${ctx.ref}/analytics/endpoints/logs.all?${legacyQs}`);
      const legacyMsg = String((legacy.json as Record<string, unknown> | undefined)?.message ?? legacy.text).slice(0, 80);
      const mb: Record<string, number | string> = {
        log_lag_s: logs.lagS,
        log_rows_found: logs.rows.length,
        logs_endpoint_error: logs.error || "-",
        logs_all_http: legacy.status,
        logs_all_message: legacyMsg,
      };
      const byUa = new Map(logs.rows.map((r) => [r.user_agent, r]));
      let bPass = logs.rows.length >= 3;
      const bLines: string[] = [];
      for (const k of ["future", "expired", "valid"] as const) {
        const row = byUa.get(ua(k));
        if (!row) {
          bPass = false;
          bLines.push(`${k}: no edge_logs row within ${logs.lagS}s`);
          continue;
        }
        const skew = row.issued_at == null ? null : row.issued_at - row.ts_s;
        mb[`log_${k}_status`] = row.status_code;
        mb[`log_${k}_content_length`] = row.content_length ?? "-";
        mb[`log_${k}_transfer_encoding`] = row.transfer_encoding ?? "-";
        mb[`log_${k}_proxy_status`] = row.proxy_status ?? "-";
        mb[`log_${k}_issued_at`] = row.issued_at ?? "-";
        mb[`log_${k}_expires_at`] = row.expires_at ?? "-";
        mb[`log_${k}_iat_minus_request_s`] = skew ?? "-";
        mb[`log_${k}_auth_user`] = row.auth_user ? "set" : "null";
        const lenOk = Number(row.content_length) === wire[k]!.bytes;
        if (!lenOk) bPass = false;
        bLines.push(`${k}: status ${row.status_code}, content_length ${row.content_length} (wire ${wire[k]!.bytes}B), proxy_status ${row.proxy_status ?? "null"}, iat-request ${skew ?? "n/a"}s`);
      }
      const futureSkew = mb["log_future_iat_minus_request_s"];
      if (typeof futureSkew !== "number" || futureSkew < 290 || futureSkew > 310) bPass = false;
      out.push({
        id: `${ID}b`,
        title: "edge_logs: content_length, proxy_status and JWT payload via the unified logs endpoint",
        status: bPass ? "pass" : "fail",
        detail: `${bLines.join("; ")}. Rows landed in ${logs.lagS}s. logs.all: HTTP ${legacy.status} "${legacyMsg}"`,
        measurements: mb,
        evidence: `-- /analytics/endpoints/logs, 1h window, the query that returned the rows above:\n${richSql(uaPrefix)}`,
      });

      // W27d - the incident-window form: error class selected on proxy_status, split in SQL
      let inc: { rows: Record<string, unknown>[]; error: string } = { rows: [], error: "" };
      const incT0 = Date.now();
      let incPolls = 0;
      while (Date.now() - incT0 < 60_000) {
        incPolls++;
        const r = await logsQuery(ctx, incidentSql(uaPrefix), 1);
        inc = { rows: r.rows as Record<string, unknown>[], error: r.error };
        if (inc.rows.length >= 2) break;
        await Bun.sleep(LOG_POLL_MS);
      }
      const incBy = new Map(inc.rows.map((r) => [String(r.user_agent), r]));
      const incFuture = incBy.get(ua("future"));
      const incExpired = incBy.get(ua("expired"));
      const sqlSkew = incFuture ? Number(incFuture.iat_skew_s) : NaN;
      const dPass =
        Boolean(incFuture && incExpired) &&
        sqlSkew >= 290 && sqlSkew <= 310 &&
        Number(incFuture!.is_expired) === 0 &&
        Number(incExpired!.is_expired) === 1 &&
        inc.rows.length === 2;
      out.push({
        id: `${ID}d`,
        title: "incident window: PGRST303 selected on proxy_status, future-iat vs expired split in SQL",
        status: dPass ? "pass" : "fail",
        detail:
          `rows matching proxy_status PGRST303: ${inc.rows.length} (expect 2: future, expired). ` +
          `future: iat_skew_s ${incFuture?.iat_skew_s ?? "n/a"}, is_expired ${incFuture?.is_expired ?? "n/a"}, content_length ${incFuture?.content_length ?? "n/a"}; ` +
          `expired: iat_skew_s ${incExpired?.iat_skew_s ?? "n/a"}, is_expired ${incExpired?.is_expired ?? "n/a"}, content_length ${incExpired?.content_length ?? "n/a"}` +
          (inc.error ? `; endpoint error: ${inc.error}` : ""),
        measurements: {
          incident_rows: inc.rows.length,
          incident_polls: incPolls,
          future_iat_skew_sql_s: incFuture ? Number(incFuture.iat_skew_s) : "-",
          future_is_expired: incFuture ? Number(incFuture.is_expired) : "-",
          expired_iat_skew_sql_s: incExpired ? Number(incExpired.iat_skew_s) : "-",
          expired_is_expired: incExpired ? Number(incExpired.is_expired) : "-",
          incident_error: inc.error || "-",
        },
        evidence: `-- /analytics/endpoints/logs, 1h window:\n${incidentSql(uaPrefix)}`,
      });

      // W27c - 42501 mapping
      const create = await sql(
        ctx,
        `create table if not exists public.w27_locked(id int primary key);
         insert into public.w27_locked values (1) on conflict do nothing;
         revoke all on table public.w27_locked from anon, authenticated;`,
      );
      if (create.status >= 300) {
        out.push({ id: `${ID}c`, title: "42501 mapping", status: "fail", detail: `setup failed: ${create.error}` });
      } else {
        lockedCreated = true;
        // PostgREST's schema cache lags DDL: the first W27 run probed 1s after
        // CREATE and both anon rows answered 404 PGRST205 ("Could not find the
        // table ... in the schema cache") while the third request, seconds
        // later, got the 403 the row is about. Warm the cache first and record
        // how long it took; the warm-up rows use a User-Agent outside the
        // `-locked` prefix so they stay out of the log read below.
        await sql(ctx, "notify pgrst, 'reload schema';");
        const warmT0 = Date.now();
        let warm = await hit(ctx, "/rest/v1/w27_locked?select=id", ua("schemawarm"), tokens.valid);
        let warmAttempts = 1;
        while (warm.code === "PGRST205" && Date.now() - warmT0 < 120_000) {
          await Bun.sleep(3_000);
          warm = await hit(ctx, "/rest/v1/w27_locked?select=id", ua("schemawarm"), tokens.valid);
          warmAttempts++;
        }
        const schemaCacheS = Math.round((Date.now() - warmT0) / 1000);
        const cWire: Record<string, Wire> = {
          anon_apikey: await hit(ctx, "/rest/v1/w27_locked?select=id", ua("locked-anon-apikey")),
          anon_jwt: await hit(ctx, "/rest/v1/w27_locked?select=id", ua("locked-anon-jwt"), keys.anon),
          authenticated: await hit(ctx, "/rest/v1/w27_locked?select=id", ua("locked-authenticated"), tokens.valid),
        };
        const cLogs = await awaitRows(ctx, `${uaPrefix}-locked`, Object.keys(cWire).map((k) => ua(`locked-${k.replace("_", "-")}`)));
        const cBy = new Map(cLogs.rows.map((r) => [r.user_agent, r]));
        const mc: Record<string, number | string> = {
          schema_cache_warm_s: schemaCacheS,
          schema_cache_warm_attempts: warmAttempts,
          schema_cache_final_code: warm.code || "-",
          log_lag_s: cLogs.lagS,
          log_rows_found: cLogs.rows.length,
        };
        const cLines: string[] = [];
        for (const [k, w] of Object.entries(cWire)) {
          mc[`wire_${k}_status`] = w.status;
          mc[`wire_${k}_code`] = w.code || "-";
          mc[`wire_${k}_bytes`] = w.bytes;
          mc[`wire_${k}_content_length`] = w.contentLength || "-";
          mc[`wire_${k}_proxy_status`] = w.proxyStatus || "-";
          const row = cBy.get(ua(`locked-${k.replace("_", "-")}`));
          mc[`log_${k}_status`] = row?.status_code ?? "-";
          mc[`log_${k}_content_length`] = row?.content_length ?? "-";
          mc[`log_${k}_transfer_encoding`] = row?.transfer_encoding ?? "-";
          mc[`log_${k}_proxy_status`] = row?.proxy_status ?? "-";
          mc[`log_${k}_role`] = row?.role ?? "-";
          mc[`log_${k}_auth_user`] = row ? (row.auth_user ? "set" : "null") : "-";
          cLines.push(`${k}: ${w.status} ${w.code} "${w.message}" ${w.bytes}B, log proxy_status ${row?.proxy_status ?? "n/a"}`);
        }
        const cPass =
          cWire.anon_apikey!.status === 401 && cWire.anon_apikey!.code === "42501" &&
          cWire.anon_jwt!.status === 401 && cWire.anon_jwt!.code === "42501" &&
          cWire.authenticated!.status === 403 && cWire.authenticated!.code === "42501";
        out.push({
          id: `${ID}c`,
          title: "42501 on a revoked table: anon -> 401, authenticated -> 403",
          status: cPass ? "pass" : "fail",
          detail: cLines.join("; "),
          measurements: mc,
        });
      }
    } catch (e) {
      out.push({ id: ID, title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (lockedCreated) {
        const drop = await sql(ctx, "drop table if exists public.w27_locked;");
        out.push({ id: `${ID}z`, title: "cleanup", status: drop.status < 300 ? "pass" : "fail", detail: drop.status < 300 ? "dropped public.w27_locked" : drop.error });
      }
    }
    return out;
  },
};
export default mod;
