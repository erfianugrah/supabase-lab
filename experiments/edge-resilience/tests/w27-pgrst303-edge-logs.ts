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
 *   W27b  edge_logs via `/analytics/endpoints/logs.all`: the same three rows
 *         read back with response.headers.content_length, proxy_status and
 *         the parsed JWT payload (issued_at, expires_at). Pass when every
 *         content_length equals the wire byte count and issued_at minus the
 *         request timestamp reproduces the +300s skew. Records the exact SQL
 *         that worked, and what the `logs` (stream) endpoint said to it.
 *   W27c  42501 mapping: a table with all privileges revoked from anon and
 *         authenticated (`revoke all on table`), hit as anon (publishable key
 *         only), as the legacy anon JWT, and as a minted authenticated token.
 *         S21 measured anon 401 / authenticated 403 on 2026-09-03 on the wire
 *         only; this row adds the legacy-anon-JWT-as-bearer case and the
 *         edge_logs shape, and records what proxy_status carries for it.
 *
 * Pass means the platform did what a reader of edge_logs would assume;
 * fail is a measured disagreement, not a harness error. Platform error text
 * is quoted verbatim in `detail`, numbers live in `measurements`.
 *
 * Not settled by this module: the stale-time cache itself (a PostgREST build
 * with a one-second skew, out of scope here), and whether a project
 * provisioned in an earlier Logs Explorer era exposes the same field paths -
 * this project is a 2026-09 provision.
 *
 * DESTRUCTIVE: creates public.w27_locked and drops it in finally. Needs
 * public.w_probe (the Makefile seed) for W27a/b.
 */
import { createHmac } from "node:crypto";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, logsQuery as logsStream, sql } from "../../../harness/src/platform";

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
 * The flattened edge_logs read. `logs.all` answers this; the `logs` stream
 * endpoint answered "Backend error! Retry your query." to the identical text
 * on 2026-09-03 (S18) and again here. Kept as one string so the artifact
 * carries exactly what ran.
 */
const richSql = (uaPrefix: string) => `select id, timestamp, r.method, r.path, h.user_agent, res.status_code,
       rh.content_length, rh.transfer_encoding, rh.proxy_status,
       jp.issued_at, jp.expires_at, jp.role, jp.subject, sb.auth_user
from edge_logs
cross join unnest(metadata) as m
cross join unnest(m.request) as r
cross join unnest(r.headers) as h
cross join unnest(m.response) as res
cross join unnest(res.headers) as rh
cross join unnest(r.sb) as sb
left join unnest(sb.jwt) as jwt
left join unnest(jwt.authorization) as auth
left join unnest(auth.payload) as jp
where h.user_agent like '${uaPrefix}%'
order by timestamp desc`;

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
  /** microseconds since epoch */
  timestamp: number;
}

async function logsAll(ctx: Ctx, sqlText: string): Promise<{ rows: LogRow[]; error: string }> {
  const end = new Date();
  const start = new Date(end.getTime() - 3600_000);
  const qs =
    `sql=${encodeURIComponent(sqlText)}` +
    `&iso_timestamp_start=${encodeURIComponent(start.toISOString())}` +
    `&iso_timestamp_end=${encodeURIComponent(end.toISOString())}`;
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/analytics/endpoints/logs.all?${qs}`, undefined, 60_000);
  const j = (r.json ?? {}) as { result?: LogRow[]; error?: unknown };
  if (j.error) return { rows: [], error: JSON.stringify(j.error).slice(0, 300) };
  return { rows: Array.isArray(j.result) ? j.result : [], error: r.status >= 300 ? r.text.slice(0, 300) : "" };
}

/** Poll logs.all until every expected User-Agent has a row, or the budget is spent. */
async function awaitRows(
  ctx: Ctx,
  uaPrefix: string,
  expected: string[],
): Promise<{ rows: LogRow[]; lagS: number; error: string }> {
  const t0 = Date.now();
  let last: { rows: LogRow[]; error: string } = { rows: [], error: "" };
  while (Date.now() - t0 < LOG_WAIT_MS) {
    last = await logsAll(ctx, richSql(uaPrefix));
    const seen = new Set(last.rows.map((r) => r.user_agent));
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

      // W27b - edge_logs through logs.all
      const expectedUa = ["future", "expired", "valid"].map(ua);
      const logs = await awaitRows(ctx, uaPrefix, expectedUa);
      const stream = await logsStream(ctx, richSql(uaPrefix), 1);
      const mb: Record<string, number | string> = {
        log_lag_s: logs.lagS,
        log_rows_found: logs.rows.length,
        logs_all_error: logs.error || "-",
        logs_stream_rows: stream.rows.length,
        logs_stream_error: stream.error || "-",
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
        const reqEpoch = Math.floor(row.timestamp / 1_000_000);
        const skew = row.issued_at == null ? null : row.issued_at - reqEpoch;
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
        title: "edge_logs: content_length, proxy_status and JWT payload via logs.all",
        status: bPass ? "pass" : "fail",
        detail: `${bLines.join("; ")}. Rows landed in ${logs.lagS}s. logs (stream) endpoint: ${stream.error || `${stream.rows.length} rows`}`,
        measurements: mb,
        evidence: `-- logs.all, 1h window, the query that returned the rows above:\n${richSql(uaPrefix)}`,
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
