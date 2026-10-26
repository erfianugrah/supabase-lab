/**
 * DC17 - Which layer ends a long Data API request at about 125 s, at what
 * value, and does the statement keep running in Postgres after the 504?
 *
 * Measured before: DC12d (pool held, acquisition timeout 60 s) and DC14
 * (CPU-bound statements on 2XL at `db_pool` 140/200) got 504 `text/plain`
 * `upstream request timeout`, no PostgREST code, at 125055-125066 ms
 * (DC12d; DC12e's one uncoded 504 at 125097 ms) and about 125 s (DC14); DC12's sampled answer carried
 * `x-envoy-attempt-count: 1` and no `x-envoy-upstream-service-time`. DC09g:
 * 70 s requests answered 200. DC12 ordering-inferred that a holder's query
 * kept running after its 504; no end time was measured.
 *
 * Hypotheses: H1 a fixed whole-request timeout in the API gateway's Envoy
 * (body `upstream request timeout`) near 125 s, independent of size, key and
 * pool state; the backend runs to the end of its sleep and the transaction
 * commits, because nothing cancels it. H2 the limit is Cloudflare's or
 * PostgREST's (a different body or status, or a 524). H3 the statement is
 * cancelled when the gateway gives up (row absent, backend gone at ~125 s).
 *
 * Method (one project, PVLAB_DC_SIZE, default small; the pool is far above
 * the concurrent requests): `dc17_sleep(s, tag)` (SECURITY DEFINER, `set
 * statement_timeout = '600s'`, which PostgREST hoists, DC09) sets its
 * transaction's application_name to `dc17-<tag>`, inserts its tag and start
 * time, sleeps `s`, then stamps the finish time; a committed row with a finish
 * time means the statement ran to the end and PostgREST committed it.
 * Per round (PVLAB_DC17_ROUNDS, default 2) all of PVLAB_DC17_S (default
 * 100,115,120,123,124,125,126,127,130,150,180) go out concurrently as POST
 * /rpc with the legacy service_role key, each with its own User-Agent; round
 * 1 adds the anon key at 150 s and GET /rpc/dc17_nap (read-only twin, no
 * row) at 150 s. Alongside,
 * the same 180 s call over a direct Postgres connection (db host, IPv6) and
 * a session-pooler connection, as `postgres` with `statement_timeout = 0`.
 * A poller reads pg_stat_activity for `dc17-%` every ~3 s. Recorded per
 * request: status, client ms, body, response headers (names; values of the
 * routing headers), PostgREST access-log lines and edge_logs rows by
 * User-Agent, when its backend was first and last seen, and whether its row
 * committed. After the rounds: postgres_logs lines in the window that
 * mention cancel/terminate/client/timeout/EOF/broken pipe/could not send or
 * dc17.
 *
 * Not settled by this module: the gateway's configuration (not readable from
 * a project); whether the limit is idle or total (PostgREST sends nothing
 * before the statement ends, so the two cannot differ here); other regions.
 *
 * DESTRUCTIVE: creates the shared project (lib/dc.ts); DC99 deletes it.
 */
import { Client as PgClient } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { logsQuery } from "../../../harness/src/platform.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { ensureProject, errText, fmtCounts, logLinesByUaPrefix, postgrestConfig, redact, rpc, skipWithoutPro, sleep, sql, type DcProject, type UaLogLine } from "../lib/dc.js";

const BRACKET = (process.env.PVLAB_DC17_S || "100,115,120,123,124,125,126,127,130,150,180").split(",").filter(Boolean).map(Number);
const ROUNDS = Number(process.env.PVLAB_DC17_ROUNDS || 2);
const DIRECT_S = Number(process.env.PVLAB_DC17_DIRECT_S || 180);
const CLIENT_TIMEOUT_MS = 400_000;

const SETUP = `
create table if not exists public.dc17_runs (tag text primary key, pid int, started timestamptz, finished timestamptz);
revoke all on public.dc17_runs from anon, authenticated;
create or replace function public.dc17_sleep(s double precision, tag text) returns text
  language plpgsql security definer set search_path = '' set statement_timeout = '600s' as $$
  begin
    perform set_config('application_name', 'dc17-' || tag, true);
    insert into public.dc17_runs (tag, pid, started) values (tag, pg_backend_pid(), clock_timestamp());
    perform pg_sleep(s);
    update public.dc17_runs set finished = clock_timestamp() where public.dc17_runs.tag = dc17_sleep.tag;
    return tag;
  end $$;
-- GET /rpc runs read-only: no insert, application_name only.
create or replace function public.dc17_nap(s double precision, tag text) returns text
  language plpgsql stable set statement_timeout = '600s' as $$
  begin perform set_config('application_name', 'dc17-' || tag, true); perform pg_sleep(s); return tag; end $$;
grant execute on function public.dc17_sleep(double precision, text), public.dc17_nap(double precision, text) to anon, service_role;
notify pgrst, 'reload schema';`;

/** Header values kept verbatim; every other header is kept by name only. */
const KEEP_VALUE = ["server", "via", "content-type", "content-length", "x-envoy-attempt-count", "x-envoy-upstream-service-time", "sb-gateway-version", "proxy-status", "cf-cache-status", "content-profile", "retry-after"];

interface Call {
  tag: string;
  label: string;
  key: string;
  method: string;
  requestedS: number;
  ua: string;
  sentAt: number;
  status: number;
  ms: number;
  body: string;
  headers: Record<string, string>;
  names: string;
}

async function call(p: DcProject, c: Omit<Call, "sentAt" | "status" | "ms" | "body" | "headers" | "names">): Promise<Call> {
  const key = c.key === "anon" ? p.keys.anon : p.keys.service;
  const h: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}`, "User-Agent": c.ua };
  const url =
    c.method === "GET"
      ? `https://${p.host}/rest/v1/rpc/dc17_nap?s=${c.requestedS}&tag=${c.tag}`
      : `https://${p.host}/rest/v1/rpc/dc17_sleep`;
  const sentAt = Date.now();
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: c.method,
      headers: c.method === "GET" ? h : { ...h, "Content-Type": "application/json" },
      body: c.method === "GET" ? undefined : JSON.stringify({ s: c.requestedS, tag: c.tag }),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      keepalive: false,
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    const headers: Record<string, string> = {};
    const names: string[] = [];
    res.headers.forEach((v, k) => {
      const n = k.toLowerCase();
      names.push(n);
      if (KEEP_VALUE.includes(n)) headers[n] = redact(v);
      if (n === "cf-ray") headers["cf-ray-colo"] = v.split("-").pop() ?? "";
    });
    return { ...c, sentAt, status: res.status, ms, body: redact(text.replace(/\s+/g, " ").slice(0, 200)), headers, names: names.sort().join(",") };
  } catch (e) {
    return { ...c, sentAt, status: 0, ms: Math.round(performance.now() - t0), body: `client: ${errText(e)}`, headers: {}, names: "" };
  }
}

interface Seen {
  first: number;
  last: number;
  /** first poll after `last` that did not see it (local ms), -1 if never polled after. */
  goneBy: number;
  queryStartDb: number;
  states: Set<string>;
}

/** pg_stat_activity poller for application_name dc17-%; local clock for seen times, DB clock for query_start. */
function startPoller(ctx: Ctx, ref: string) {
  const seen = new Map<string, Seen>();
  let polls = 0;
  let failed = 0;
  let maxGapMs = 0;
  let stop = false;
  const loop = (async () => {
    let prevAt = 0;
    while (!stop) {
      const at = Date.now();
      const r = await sql(
        ctx,
        ref,
        `select application_name as a, coalesce(state, '-') || '/' || coalesce(wait_event, '-') as s,
                (extract(epoch from query_start) * 1000)::bigint as qs
           from pg_stat_activity where application_name like 'dc17-%'`,
        15_000,
      );
      if (!r.rows) {
        failed++;
      } else {
        polls++;
        if (prevAt) maxGapMs = Math.max(maxGapMs, at - prevAt);
        prevAt = at;
        const now = new Set<string>();
        for (const row of r.rows) {
          const tag = String(row.a).slice("dc17-".length);
          now.add(tag);
          const s = seen.get(tag) ?? { first: at, last: at, goneBy: -1, queryStartDb: Number(row.qs), states: new Set<string>() };
          s.last = at;
          s.goneBy = -1;
          s.states.add(String(row.s));
          seen.set(tag, s);
        }
        for (const [tag, s] of seen) if (!now.has(tag) && s.goneBy < 0) s.goneBy = at;
      }
      await sleep(Math.max(0, 3_000 - (Date.now() - at)));
    }
  })();
  return {
    seen,
    active: () => [...seen.entries()].filter(([, s]) => s.goneBy < 0).map(([t]) => t),
    stats: () => ({ polls, failed, maxGapMs }),
    stop: async () => {
      stop = true;
      await loop;
    },
  };
}

interface DirectResult {
  path: string;
  tag: string;
  ok: boolean;
  ms: number;
  error: string;
  sentAt: number;
}

async function direct(p: DcProject, ctx: Ctx, path: "direct" | "pooler", tag: string, s: number): Promise<DirectResult> {
  const sentAt = Date.now();
  let host = `db.${p.ref}.supabase.co`;
  let user = "postgres";
  if (path === "pooler") {
    const r = await mgmt(ctx, "GET", `/projects/${p.ref}/config/database/pooler`);
    const arr = (Array.isArray(r.json) ? r.json : []) as { database_type?: string; db_host?: string; db_user?: string }[];
    const e = arr.find((x) => x.database_type === "PRIMARY") ?? arr[0];
    if (!e?.db_host) return { path, tag, ok: false, ms: 0, error: "no pooler entry", sentAt };
    host = e.db_host;
    user = e.db_user ?? `postgres.${p.ref}`;
  }
  // Session mode on 5432 for the pooler (transaction mode is 6543).
  const c = new PgClient({ host, port: 5432, user, database: "postgres", password: p.dbPass, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000, query_timeout: CLIENT_TIMEOUT_MS });
  c.on("error", () => undefined);
  const t0 = performance.now();
  try {
    await c.connect();
    await c.query("set statement_timeout = 0");
    const q0 = performance.now();
    await c.query("select public.dc17_sleep($1, $2)", [s, tag]);
    return { path, tag, ok: true, ms: Math.round(performance.now() - q0), error: "", sentAt };
  } catch (e) {
    return { path, tag, ok: false, ms: Math.round(performance.now() - t0), error: redact(errText(e)), sentAt };
  } finally {
    await c.end().catch(() => undefined);
  }
}

const mod: TestModule = {
  id: "DC17",
  title: "Long Data API requests: which layer answers 504 near 125 s, at what value, and does the statement keep running",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC17");
    if (skip) return skip;
    const out: TestResult[] = [];
    const put = (r: TestResult) => {
      out.push(r);
      ctx.log(`${r.id}: ${r.detail ?? ""}`.slice(0, 500));
    };
    try {
      const p = await ensureProject(ctx);
      const setup = await sql(ctx, p.ref, SETUP);
      if (setup.error) throw new Error(`setup: ${setup.error}`);
      for (let i = 0; i < 30; i++) {
        const r = await rpc(p.host, "dc17_sleep", { s: 0, tag: `warm-${i}` }, p.keys.service, p.keys.service, 20_000);
        if (r.status === 200) break;
        await sleep(2_000);
      }
      // Clock offset DB - local, from a query bracketed by two local stamps (half the round trip is the error bound).
      const l0 = Date.now();
      const clk = await sql(ctx, p.ref, "select (extract(epoch from clock_timestamp()) * 1000)::bigint as t, current_setting('max_connections')::int as mc");
      const l1 = Date.now();
      const offsetMs = Number(clk.rows?.[0]?.t ?? 0) - Math.round((l0 + l1) / 2);
      const pings: number[] = [];
      for (let i = 0; i < 3; i++) pings.push((await rpc(p.host, "dc_ping", {}, p.keys.service, p.keys.service, 10_000)).ms);
      const cfg = await postgrestConfig(ctx, p.ref);
      const app = await sql(ctx, p.ref, "select string_agg(distinct application_name, ',') as a from pg_stat_activity where usename = 'authenticator'");
      put({
        id: "DC17a-setup",
        title: "Project, vantage and clock offset",
        status: "info",
        detail: `${p.pgVersion}; PostgREST ${app.rows?.[0]?.a ?? "?"}; db_pool ${cfg.dbPool}; max_connections ${clk.rows?.[0]?.mc ?? -1}; dc_ping ${pings.join("/")} ms; clock offset DB-local ${offsetMs} ms (+-${Math.round((l1 - l0) / 2)})`,
        measurements: {
          size: process.env.PVLAB_DC_SIZE || "small",
          pg_version: p.pgVersion,
          postgrest_app: String(app.rows?.[0]?.a ?? ""),
          db_pool: cfg.dbPool,
          max_connections: Number(clk.rows?.[0]?.mc ?? -1),
          dc_ping_ms: pings.join("/"),
          clock_offset_ms: offsetMs,
          clock_offset_bound_ms: Math.round((l1 - l0) / 2),
        },
      });

      const runId = Date.now().toString(36);
      const uaPrefix = `pvlab-dc17-${runId}`;
      const poller = startPoller(ctx, p.ref);
      const calls: Call[] = [];
      const directs: DirectResult[] = [];
      const t0 = Date.now();
      for (let r = 1; r <= ROUNDS; r++) {
        const specs: Omit<Call, "sentAt" | "status" | "ms" | "body" | "headers" | "names">[] = BRACKET.map((s) => ({ tag: `r${r}-${s}`, label: `${s}`, key: "service", method: "POST", requestedS: s, ua: `${uaPrefix}-r${r}-${s}` }));
        if (r === 1) {
          specs.push({ tag: `r${r}-anon150`, label: "anon150", key: "anon", method: "POST", requestedS: 150, ua: `${uaPrefix}-r${r}-anon150` });
          specs.push({ tag: `r${r}-get150`, label: "get150", key: "service", method: "GET", requestedS: 150, ua: `${uaPrefix}-r${r}-get150` });
        }
        const pending = specs.map((s) => call(p, s));
        const dP = [direct(p, ctx, "direct", `r${r}-direct`, DIRECT_S), direct(p, ctx, "pooler", `r${r}-pooler`, DIRECT_S)];
        const got = await Promise.all(pending);
        calls.push(...got);
        directs.push(...(await Promise.all(dP)));
        ctx.log(`DC17 round ${r}: ${got.map((c) => `${c.label}:${c.status}@${c.ms}`).join(" ")}; direct ${directs.slice(-2).map((d) => `${d.path} ${d.ok ? "ok" : d.error} ${d.ms}`).join(", ")}`);
        // Wait until no dc17 backend is left (sleeps end by max(s) after send), at most 240 s.
        const w0 = Date.now();
        while (Date.now() - w0 < 240_000 && poller.active().length) await sleep(3_000);
        await sleep(6_000);
      }
      await poller.stop();
      const rowsR = await sql(ctx, p.ref, "select tag, (extract(epoch from started) * 1000)::bigint as st, (extract(epoch from finished) * 1000)::bigint as fi from public.dc17_runs where tag not like 'warm-%'");
      const rows = new Map((rowsR.rows ?? []).map((x) => [String(x.tag), { st: Number(x.st), fi: x.fi == null ? -1 : Number(x.fi) }]));

      const pgrst = await logLinesByUaPrefix(ctx, p.ref, "postgrest_logs", uaPrefix);
      const edge = await logLinesByUaPrefix(ctx, p.ref, "edge_logs", uaPrefix);
      const linesFor = (ls: UaLogLine[], ua: string) => {
        const by: Record<string, number> = {};
        for (const l of ls.filter((x) => x.ua === ua)) by[l.status] = (by[l.status] ?? 0) + 1;
        return fmtCounts(by) || "none";
      };
      const toLocal = (dbMs: number) => (dbMs > 0 ? dbMs - offsetMs : -1);
      const rel = (ms: number, from: number) => (ms > 0 ? Math.round((ms - from) / 100) / 10 : -1);

      for (const c of calls) {
        const s = poller.seen.get(c.tag);
        const row = rows.get(c.tag);
        const answerAt = c.sentAt + c.ms;
        const finishedLocal = row ? toLocal(row.fi) : -1;
        put({
          id: `DC17b-${c.tag}`,
          title: `${c.method} /rpc ${c.key} key, sleep ${c.requestedS} s`,
          status: "info",
          detail:
            `${c.status} after ${c.ms} ms; body ${c.body || "(empty)"}; headers ${JSON.stringify(c.headers)}; ` +
            `backend seen ${s ? `${rel(s.first, c.sentAt)}..${rel(s.last, c.sentAt)} s (gone by ${rel(s.goneBy, c.sentAt)} s)` : "never"}; ` +
            `row ${row ? (row.fi > 0 ? `finished ${rel(finishedLocal, c.sentAt)} s after send` : "started, not finished") : "absent"}`,
          measurements: {
            round: Number(c.tag.slice(1, c.tag.indexOf("-"))),
            method: c.method,
            key: c.key,
            requested_s: c.requestedS,
            status: c.status,
            client_ms: c.ms,
            body: c.body,
            ...Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [`h_${k}`, v])),
            header_names: c.names,
            postgrest_lines: linesFor(pgrst.lines, c.ua),
            edge_rows: linesFor(edge.lines, c.ua),
            backend_first_seen_s: s ? rel(s.first, c.sentAt) : -1,
            backend_last_seen_s: s ? rel(s.last, c.sentAt) : -1,
            backend_gone_by_s: s ? rel(s.goneBy, c.sentAt) : -1,
            backend_states: s ? [...s.states].join(",") : "",
            query_start_after_send_s: s ? rel(toLocal(s.queryStartDb), c.sentAt) : -1,
            row: row ? (row.fi > 0 ? "committed, finished" : "committed, no finish") : "absent",
            finished_after_send_s: row && row.fi > 0 ? rel(finishedLocal, c.sentAt) : -1,
            finished_after_answer_s: row && row.fi > 0 ? rel(finishedLocal, answerAt) : -1,
            last_seen_after_answer_s: s ? rel(s.last, answerAt) : -1,
          },
        });
      }
      for (const d of directs) {
        const row = rows.get(d.tag);
        put({
          id: `DC17c-${d.tag}`,
          title: `${d.path === "direct" ? "Direct Postgres (db host)" : "Session pooler"} as postgres, statement_timeout 0, sleep ${DIRECT_S} s`,
          status: "info",
          detail: `${d.ok ? "returned" : `error ${d.error}`} after ${d.ms} ms; row ${row ? (row.fi > 0 ? "finished" : "not finished") : "absent"}`,
          measurements: { path: d.path, requested_s: DIRECT_S, ok: d.ok ? 1 : 0, query_ms: d.ms, error: d.error, row: row ? (row.fi > 0 ? "committed, finished" : "committed, no finish") : "absent" },
        });
      }

      // Postgres's own lines in the window: anything about cancels, terminations, lost clients, timeouts.
      const back = Math.ceil((Date.now() - t0) / 1000) + 60;
      const pl = await logsQuery(
        { ...ctx, ref: p.ref },
        `select timestamp, event_message from logs where source = 'postgres_logs' and timestamp > now() - interval ${back} second and (
           ${["cancel", "terminat", "client", "timeout", "EOF", "dc17", "broken pipe", "could not send"].map((w) => `event_message like '%${w}%'`).join(" or ")}) order by timestamp limit 300`,
        1,
      );
      const norm: Record<string, number> = {};
      for (const r of pl.rows) {
        const m = String(r.event_message ?? "").replace(/\d+/g, "N").replace(/\s+/g, " ").slice(0, 120);
        norm[m] = (norm[m] ?? 0) + 1;
      }
      const st = poller.stats();
      put({
        id: "DC17d-logs",
        title: "postgres_logs lines in the window (cancel/terminate/client/timeout/EOF), log read status, poller",
        status: "info",
        detail: `postgres_logs HTTP ${pl.status} ${pl.error}; ${pl.rows.length} rows; ${Object.entries(norm).map(([k, v]) => `${v} x ${k}`).join(" | ") || "none"}; postgrest lines ${pgrst.lines.length} (${pgrst.error || "ok"}), edge rows ${edge.lines.length} (${edge.error || "ok"}); poller ${st.polls} reads, ${st.failed} failed, max gap ${st.maxGapMs} ms`,
        measurements: {
          postgres_logs_status: pl.status,
          postgres_logs_rows: pl.rows.length,
          postgres_logs_messages: redact(Object.entries(norm).map(([k, v]) => `${v} x ${k}`).join(" | ").slice(0, 1500)),
          postgrest_lines_total: pgrst.lines.length,
          edge_rows_total: edge.lines.length,
          poller_reads: st.polls,
          poller_failed: st.failed,
          poller_max_gap_ms: st.maxGapMs,
        },
        evidence: redact(pl.rows.slice(0, 60).map((r) => `${r.timestamp} ${String(r.event_message ?? "").slice(0, 300)}`).join("\n")) || undefined,
      });
    } catch (e) {
      put({ id: "DC17", title: this.title, status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
