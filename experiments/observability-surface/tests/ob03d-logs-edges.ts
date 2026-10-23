/**
 * OB03d - logs endpoint and MCP `query_logs` edge cases: time windows over and
 * under 24 h, the default window, `select *` and `count(*)`, the result row
 * cap, the removed `logs.all` route, and parity between the endpoint and the
 * hosted MCP server's `query_logs` tool on the same SQL and window.
 *
 * Claims under test (read 2026-10-23):
 *  - v1 OpenAPI, `GET /v1/projects/{ref}/analytics/endpoints/logs`: "If both
 *    are not provided, only the last 1 minute of logs will be queried." and
 *    "If the range is more than 24 hours, a validation error will be thrown."
 *  - docs, advanced-log-filtering: "The logs query surface rejects `select *`
 *    and `count(*)`"; "Without `sql`, this endpoint queries API Gateway events
 *    only."
 *  - MCP `query_logs` input schema: start "Defaults to 24 hours before the end
 *    of the window", end "Defaults to the current time", "The API caps the
 *    requested range at 24 hours."
 *  - No public page names a result row cap for the endpoint.
 *
 * One throwaway Pro-org project (ap-southeast-1, default compute), a table
 * with an anon read policy, and a known volume: BURST marked REST GETs (marker
 * in the request URL, so in `edge_logs.event_message`). Every cell is asked
 * REPS times, the repetitions interleaved (all cells once, then all again), so
 * each cell's readings are minutes apart. Vantage: this machine.
 *
 *   OB03d-w*   marker count() for windows ending now: 1 h, 24 h, 24 h + 1, 2 and 10 min,
 *              25 h, 48 h; a 48 h window starting 1 h ago (end 47 h in the
 *              future) and a 23.5 h control starting 30 min ago. A cap that
 *              keeps [start, start + 24 h] predicts 0 for an over-long window
 *              ending now until the markers are older than the overshoot, then
 *              all of them; a cap that keeps the last 24 h predicts all
 *              throughout. Start only; end only; neither.
 *   OB03d-fresh  neither bound, end only, start only, and 1 h, on markers sent
 *              20 s before the query (the documented 1-minute default should see them).
 *   OB03d-q*   1 h window: count(), count(*), select *, a per-source table name,
 *              LIMIT 100 / 1000 / 1001 / 2000 / none over the marker rows, and
 *              an arrayJoin that multiplies the marker rows by 10 with LIMIT
 *              5000 / 20000 / none, to find a row cap above BURST.
 *   OB03d-nosql  1 h window, no `sql` parameter.
 *   OB03d-all  the removed `logs.all` route with the same window.
 *   OB03d-mcp* the hosted MCP server (project-scoped, read_only=true, the PAT
 *              as Bearer), `query_logs` with the same SQL: explicit 1 h window,
 *              no window, 48 h window, count(*), select *, LIMIT 2000.
 *
 * Every cell records the HTTP status and the body's `error` field separately:
 * the endpoint answers query errors with HTTP 200.
 *
 * Not settled: other regions, a project older than 24 h (rows older than a day
 * would separate "48 h is refused" from "48 h scans an empty slice"), the
 * Explorer UI, the degraded-allowance rate limit.
 *
 * DESTRUCTIVE: creates and deletes one project; runs about 10 minutes at
 * OB03D_REPS=2 and 16 at 3.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { McpClient, toolText } from "../../governed-starter-kit/lib/mcp-client";
import { dropProject, evidencePath, makeProject, sleep, sql } from "../lib/ob";

const BURST = Number(process.env.OB03D_BURST ?? 1200);
const REPS = Number(process.env.OB03D_REPS ?? 2);
const GAP_MS = 4000;
const H = 3600_000;
const MCP = "https://mcp.supabase.com/mcp";

interface Answer {
  http: number;
  rows: number;
  value: string;
  error: string;
  keys: string;
  throttleRetries: number;
  /** top-level keys of the JSON body (a truncation or warning flag would show here) */
  bodyKeys?: string;
  /** distinct `source` values among returned rows, when rows carry one */
  sources?: string;
}

const clip = (s: string, ref: string, n = 240) =>
  s.replaceAll(ref, "<ref>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>").replace(/\s+/g, " ").slice(0, n);

/** The logs endpoint with every parameter optional, through 429 / ThrottlerException. */
async function logsRaw(pc: Ctx, ref: string, o: { sql?: string; start?: number; end?: number; path?: string }): Promise<Answer> {
  const qs: string[] = [];
  if (o.sql !== undefined) qs.push(`sql=${encodeURIComponent(o.sql)}`);
  if (o.start !== undefined) qs.push(`iso_timestamp_start=${encodeURIComponent(new Date(o.start).toISOString())}`);
  if (o.end !== undefined) qs.push(`iso_timestamp_end=${encodeURIComponent(new Date(o.end).toISOString())}`);
  const path = `/projects/${ref}/analytics/endpoints/${o.path ?? "logs"}${qs.length ? `?${qs.join("&")}` : ""}`;
  let throttleRetries = 0;
  for (;;) {
    const r = await mgmt(pc, "GET", path, undefined, 60_000);
    const j = (r.json ?? {}) as { result?: Array<Record<string, unknown>>; error?: unknown };
    const error = j.error !== undefined ? (typeof j.error === "string" ? j.error : JSON.stringify(j.error)) : r.status >= 300 ? r.text : "";
    if ((r.status === 429 || /Too Many|Throttler/i.test(error)) && throttleRetries < 8) {
      throttleRetries++;
      await sleep(20_000);
      continue;
    }
    const rows = Array.isArray(j.result) ? j.result : [];
    const first = rows[0] ?? {};
    const value = "n" in first ? String(first.n) : "";
    const srcs = [...new Set(rows.map((x) => x.source).filter((x) => typeof x === "string"))].sort().join(",");
    return {
      bodyKeys: r.json && typeof r.json === "object" ? Object.keys(r.json as object).sort().join(",") : "non-json",
      sources: srcs,
      http: r.status,
      rows: rows.length,
      value,
      error: clip(error, ref),
      keys: Object.keys(first).sort().join(","),
      throttleRetries,
    };
  }
}

/** `query_logs` through the hosted MCP server; the payload sits inside an untrusted-data boundary. */
async function mcpLogs(c: McpClient, ref: string, args: Record<string, unknown>): Promise<Answer & { isError: string; wrapped: string }> {
  const r = await c.callTool("query_logs", args, 90_000);
  let text = toolText(r);
  let payload: { result?: Array<Record<string, unknown>>; error?: unknown } = {};
  try {
    const outer = JSON.parse(text) as { result?: unknown; error?: unknown };
    if (typeof outer.result === "string") text = outer.result;
    else if (outer.error !== undefined) payload = { error: outer.error };
  } catch {
    /* plain text */
  }
  // The preamble names the boundary tag once before the data, so take the text
  // between the LAST opening tag before the first closing tag and that closing tag.
  const close = text.indexOf("</untrusted-data");
  const open = close >= 0 ? text.lastIndexOf("<untrusted-data-", close) : -1;
  const m = open >= 0 ? text.slice(text.indexOf(">", open) + 1, close) : null;
  const inner = m?.trim() ?? "";
  if (inner) {
    try {
      payload = JSON.parse(inner);
    } catch {
      payload = { error: inner };
    }
  }
  const rows = Array.isArray(payload.result) ? payload.result : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
  const first = rows[0] ?? {};
  const err = r.error?.message ?? (payload.error !== undefined ? (typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error)) : !m ? text : "");
  return {
    http: r.http,
    rows: rows.length,
    value: "n" in first ? String(first.n) : "",
    error: clip(err, ref),
    keys: Object.keys(first).sort().join(","),
    throttleRetries: 0,
    isError: String(r.result?.isError ?? false),
    wrapped: String(Boolean(m)),
  };
}

interface Cell {
  id: string;
  title: string;
  run: () => Promise<Answer & { isError?: string; wrapped?: string }>;
  expect: string;
}

const mod: TestModule = {
  id: "OB03d",
  title: "Logs endpoint and MCP query_logs edge cases: windows, default window, select *, count(*), row cap, parity",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "OB03d", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    let ref = "";
    try {
      const proj = await makeProject(ctx, "ob03d");
      ref = proj.ref;
      if (process.env.OB_REF_LOG) appendFileSync(process.env.OB_REF_LOG, `${ref} ${proj.name} created ${new Date().toISOString()}\n`);
      const pc = proj.ctx;
      const run = Date.now().toString(36);
      const base = `https://${pc.apiHost}`;
      const anon = { apikey: pc.anonKey!, authorization: `Bearer ${pc.anonKey}` };
      const hit = async (url: string): Promise<number> => {
        try {
          const r = await fetch(url, { headers: anon });
          await r.arrayBuffer();
          return r.status;
        } catch {
          return 0;
        }
      };
      const listing = await mgmt(ctx, "GET", `/organizations/${ctx.orgs.pro}/projects`);
      const compute =
        (listing.json as { projects?: { ref?: string; databases?: { infra_compute_size?: string }[] }[] } | undefined)?.projects?.find((p) => p?.ref === ref)
          ?.databases?.[0]?.infra_compute_size ?? "unknown";

      const ddl = await sql(pc, "create table public.ob_d(id int primary key, tag text); grant select on table public.ob_d to anon; insert into public.ob_d values (1); alter table public.ob_d enable row level security; create policy ob_anon_read on public.ob_d for select to anon using (true);");
      if (ddl.status >= 300) throw new Error(`ddl: ${ddl.error}`);
      for (let i = 0; i < 10; i++) {
        if ((await hit(`${base}/rest/v1/ob_d?select=id`)) === 200) break;
        await sleep(3000);
      }

      // ---- known volume
      const marker = `obd${run}`;
      const tBurst0 = Date.now();
      let ok = 0;
      for (let b = 0; b < Math.ceil(BURST / 30); b++) {
        const n = Math.min(30, BURST - b * 30);
        const r = await Promise.all(Array.from({ length: n }, (_, j) => hit(`${base}/rest/v1/ob_d?select=id&tag=eq.${marker}-${b * 30 + j}`)));
        ok += r.filter((s) => s === 200).length;
      }
      const tBurst1 = Date.now();
      const W = `position(event_message, '${marker}') > 0`;
      const COUNT = `select count() as n from logs where source = 'edge_logs' and ${W}`;
      // wait for ingestion: two equal readings 30 s apart, or BURST rows, or 8 minutes
      let ingested = -1;
      let prev = -2;
      const tWait = Date.now();
      while (Date.now() - tWait < 8 * 60_000) {
        const a = await logsRaw(pc, ref, { sql: COUNT, start: Date.now() - H, end: Date.now() });
        ingested = Number(a.value || -1);
        if (ingested >= BURST || (ingested === prev && ingested > 0)) break;
        prev = ingested;
        await sleep(30_000);
      }
      out.push({
        id: "OB03d-volume",
        title: "OB03d: known volume sent and ingested",
        status: "info",
        measurements: {
          compute,
          burst_sent: BURST,
          burst_status_200: ok,
          burst_seconds: Math.round((tBurst1 - tBurst0) / 100) / 10,
          edge_logs_rows_with_marker_1h: ingested,
          wait_s: Math.round((Date.now() - tWait) / 1000),
          minutes_since_burst_end_at_first_cell: Math.round((Date.now() - tBurst1) / 6000) / 10,
        },
      });

      // ---- MCP client (legacy initialize, no capabilities)
      const mc = new McpClient({ url: `${MCP}?project_ref=${ref}&read_only=true`, headers: { Authorization: `Bearer ${ctx.pat}` }, capabilities: {}, name: "pvlab-ob03d" });
      const init = await mc.initialize().catch((e) => ({ http: 0, error: { message: String(e) } }) as { http: number; error?: { message?: string } });
      const mcpUp = init.http === 200 && !init.error;
      out.push({
        id: "OB03d-mcp-init",
        title: "OB03d: hosted MCP server reachable (project-scoped, read_only=true)",
        status: mcpUp ? "info" : "fail",
        detail: mcpUp ? undefined : clip(init.error?.message ?? `http ${init.http}`, ref),
        measurements: { http: init.http, server_version: String(mc.serverInfo.version ?? "-"), protocol: mc.protocolVersion },
      });

      const now = () => Date.now();
      const L = (q: string, start?: (t: number) => number, end?: (t: number) => number, path?: string) => () => {
        const t = now();
        return logsRaw(pc, ref, { sql: q, start: start?.(t), end: end?.(t), path });
      };
      const hrs = (h: number) => (t: number) => t - h * H;
      const id = (t: number) => t;
      const fut = (h: number) => (t: number) => t + h * H;
      const ROWS = (lim: string) => `select id, timestamp from logs where source = 'edge_logs' and ${W}${lim}`;
      const X10 = (lim: string) => `select arrayJoin(range(10)) as k, id from logs where source = 'edge_logs' and ${W}${lim}`;
      const M = (args: Record<string, unknown>) => () => mcpLogs(mc, ref, args);
      const iso = (ms: number) => new Date(ms).toISOString();

      const cells: Cell[] = [
        { id: "w-1h", title: "window 1 h ending now", run: L(COUNT, hrs(1), id), expect: "all marker rows" },
        { id: "w-24h", title: "window 24 h ending now", run: L(COUNT, hrs(24), id), expect: "all marker rows" },
        { id: "w-24h1m", title: "window 24 h + 1 min ending now", run: L(COUNT, hrs(24 + 1 / 60), id), expect: "OpenAPI: validation error" },
        { id: "w-24h2m", title: "window 24 h + 2 min ending now", run: L(COUNT, hrs(24 + 2 / 60), id), expect: "start-anchored 24 h cap: 0 while the markers are under 2 min old, all after" },
        { id: "w-24h10m", title: "window 24 h + 10 min ending now", run: L(COUNT, hrs(24 + 10 / 60), id), expect: "start-anchored 24 h cap: 0 while the markers are under 10 min old, all after" },
        { id: "w-25h", title: "window 25 h ending now", run: L(COUNT, hrs(25), id), expect: "OpenAPI: validation error" },
        { id: "w-48h", title: "window 48 h ending now", run: L(COUNT, hrs(48), id), expect: "OpenAPI: validation error" },
        { id: "w-48h-fwd", title: "window 48 h starting 1 h ago (end 47 h ahead)", run: L(COUNT, hrs(1), fut(47)), expect: "OpenAPI: validation error; start-anchored cap would return all, end-anchored 0" },
        { id: "w-23h-fwd", title: "control: 23.5 h starting 30 min ago (end in the future)", run: L(COUNT, hrs(0.5), fut(23)), expect: "all marker rows if a future end is accepted" },
        { id: "w-start-only", title: "start 1 h ago, no end", run: L(COUNT, hrs(1)), expect: "OpenAPI: 'Either ... must be provided'" },
        { id: "w-end-only", title: "end now, no start", run: L(COUNT, undefined, id), expect: "OpenAPI: 'Either ... must be provided'" },
        { id: "w-none", title: "no start, no end (markers several minutes old)", run: L(COUNT), expect: "OpenAPI: last 1 minute, so 0" },
        { id: "q-count", title: "count() 1 h", run: L(COUNT, hrs(1), id), expect: "all marker rows" },
        { id: "q-countstar", title: "count(*) 1 h", run: L(`select count(*) as n from logs where source = 'edge_logs' and ${W}`, hrs(1), id), expect: "docs: rejected" },
        { id: "q-star", title: "select * 1 h", run: L(`select * from logs where source = 'edge_logs' and ${W} limit 1`, hrs(1), id), expect: "docs: rejected" },
        { id: "q-oldtable", title: "per-source table edge_logs", run: L(`select count() as n from edge_logs`, hrs(1), id), expect: "error (unified table only)" },
        { id: "q-lim100", title: "rows, LIMIT 100", run: L(ROWS(" limit 100"), hrs(1), id), expect: "100" },
        { id: "q-lim1000", title: "rows, LIMIT 1000", run: L(ROWS(" limit 1000"), hrs(1), id), expect: "1000" },
        { id: "q-lim1001", title: "rows, LIMIT 1001", run: L(ROWS(" limit 1001"), hrs(1), id), expect: "no documented cap" },
        { id: "q-lim2000", title: "rows, LIMIT 2000 (above the marker count)", run: L(ROWS(" limit 2000"), hrs(1), id), expect: "all marker rows if uncapped" },
        { id: "q-nolimit", title: "rows, no LIMIT", run: L(ROWS(""), hrs(1), id), expect: "no documented default" },
        { id: "q-x10-5000", title: "marker rows x10 (arrayJoin), LIMIT 5000", run: L(X10(" limit 5000"), hrs(1), id), expect: "5000 if uncapped" },
        { id: "q-x10-20000", title: "marker rows x10 (arrayJoin), LIMIT 20000", run: L(X10(" limit 20000"), hrs(1), id), expect: "10x marker rows if uncapped" },
        { id: "q-x10-nolimit", title: "marker rows x10 (arrayJoin), no LIMIT", run: L(X10(""), hrs(1), id), expect: "no documented default" },
        { id: "nosql", title: "no sql parameter, 1 h", run: () => logsRaw(pc, ref, { start: now() - H, end: now() }), expect: "docs: API Gateway events only" },
        { id: "logs-all", title: "removed logs.all route, 1 h", run: L(COUNT, hrs(1), id, "logs.all"), expect: "OpenAPI: 410 Gone" },
      ];
      if (mcpUp) {
        cells.push(
          { id: "mcp-1h", title: "MCP query_logs count(), explicit 1 h", run: () => mcpLogs(mc, ref, { sql: COUNT, iso_timestamp_start: iso(now() - H), iso_timestamp_end: iso(now()) }), expect: "same as q-count" },
          { id: "mcp-none", title: "MCP query_logs count(), no window", run: M({ sql: COUNT }), expect: "tool schema: last 24 h, so all marker rows" },
          { id: "mcp-48h", title: "MCP query_logs count(), 48 h ending now", run: () => mcpLogs(mc, ref, { sql: COUNT, iso_timestamp_start: iso(now() - 48 * H), iso_timestamp_end: iso(now()) }), expect: "tool schema: capped at 24 h" },
          { id: "mcp-countstar", title: "MCP query_logs count(*), 1 h", run: () => mcpLogs(mc, ref, { sql: `select count(*) as n from logs where source = 'edge_logs' and ${W}`, iso_timestamp_start: iso(now() - H), iso_timestamp_end: iso(now()) }), expect: "same as q-countstar" },
          { id: "mcp-star", title: "MCP query_logs select *, 1 h", run: () => mcpLogs(mc, ref, { sql: `select * from logs where source = 'edge_logs' and ${W} limit 1`, iso_timestamp_start: iso(now() - H), iso_timestamp_end: iso(now()) }), expect: "same as q-star" },
          { id: "mcp-lim2000", title: "MCP query_logs rows, LIMIT 2000, 1 h", run: () => mcpLogs(mc, ref, { sql: ROWS(" limit 2000"), iso_timestamp_start: iso(now() - H), iso_timestamp_end: iso(now()) }), expect: "same as q-lim2000" },
        );
      }

      const answers = new Map<string, Array<Answer & { isError?: string; wrapped?: string; at: number }>>();
      const fresh: Array<Answer & { sent: number; kind: string }> = [];
      for (let rep = 0; rep < REPS; rep++) {
        for (const c of cells) {
          const t = Date.now();
          const a = await c.run().catch((e) => ({ http: 0, rows: 0, value: "", error: clip(String(e), ref), keys: "", throttleRetries: 0 }) as Answer);
          answers.set(c.id, [...(answers.get(c.id) ?? []), { ...a, at: Math.round((t - tBurst1) / 1000) }]);
          await sleep(GAP_MS);
        }
        // fresh markers for the no-window default: send 5, wait 20 s, ask with no bounds
        const fm = `obf${run}r${rep}`;
        const tSend = Date.now();
        await Promise.all(Array.from({ length: 5 }, (_, j) => hit(`${base}/rest/v1/ob_d?select=id&tag=eq.${fm}-${j}`)));
        await sleep(20_000);
        const FQ = `select count() as n from logs where source = 'edge_logs' and position(event_message, '${fm}') > 0`;
        const fa = await logsRaw(pc, ref, { sql: FQ });
        await sleep(GAP_MS);
        const fe = await logsRaw(pc, ref, { sql: FQ, end: Date.now() });
        await sleep(GAP_MS);
        const fs = await logsRaw(pc, ref, { sql: FQ, start: tSend - 30_000 });
        await sleep(GAP_MS);
        const fb = await logsRaw(pc, ref, { sql: FQ, start: Date.now() - H, end: Date.now() });
        fresh.push({ ...fa, sent: 5, kind: "nowindow" }, { ...fe, sent: 5, kind: "endonly_now" }, { ...fs, sent: 5, kind: "startonly_30s_before_send" }, { ...fb, sent: 5, kind: "1h" });
        await sleep(GAP_MS);
      }

      for (const c of cells) {
        const as = answers.get(c.id) ?? [];
        const m: Record<string, number | string> = { expect: c.expect };
        as.forEach((a, i) => {
          const k = `r${i + 1}`;
          m[`${k}_http`] = a.http;
          m[`${k}_rows`] = a.rows;
          if (a.value !== "") m[`${k}_n`] = a.value;
          m[`${k}_error`] = a.error || "none";
          if (a.keys && !a.value) m[`${k}_keys`] = a.keys;
          if (a.throttleRetries) m[`${k}_throttle_retries`] = a.throttleRetries;
          if (a.bodyKeys !== undefined) m[`${k}_body_keys`] = a.bodyKeys || "-";
          if (a.sources) m[`${k}_row_sources`] = a.sources;
          if (a.isError !== undefined) m[`${k}_isError`] = a.isError;
          if (a.wrapped !== undefined) m[`${k}_untrusted_wrapper`] = a.wrapped;
          m[`${k}_s_after_burst`] = a.at;
        });
        out.push({ id: `OB03d-${c.id}`, title: `OB03d: ${c.title}`, status: "info", measurements: m });
      }
      const fm: Record<string, number | string> = { sent_per_rep: 5, wait_s: 20 };
      fresh.forEach((a, i) => {
        const k = `r${Math.floor(i / 4) + 1}_${a.kind}`;
        fm[`${k}_http`] = a.http;
        fm[`${k}_n`] = a.value || "-";
        fm[`${k}_error`] = a.error || "none";
      });
      out.push({ id: "OB03d-fresh", title: "OB03d: markers sent 20 s earlier: no window, end only, start only (30 s before the send), and a 1 h window", status: "info", measurements: fm });
      writeFileSync(evidencePath("ob03d-answers.json"), JSON.stringify({ run, burst: BURST, answers: Object.fromEntries(answers), fresh }, null, 1).replaceAll(ref, "<ref>"));
    } catch (e) {
      out.push({ id: "OB03d", title: "OB03d", status: "fail", detail: `threw: ${clip(e instanceof Error ? e.message : String(e), ref, 400)}` });
    } finally {
      const d = await dropProject(ctx, ref);
      if (ref && process.env.OB_REF_LOG) appendFileSync(process.env.OB_REF_LOG, `${ref} delete HTTP ${d} ${new Date().toISOString()}\n`);
    }
    return out;
  },
};
export default mod;
