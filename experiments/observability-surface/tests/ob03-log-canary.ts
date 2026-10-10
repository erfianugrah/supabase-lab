/**
 * OB03 - log ingestion canary, which sources the logs endpoint carries, and
 * what the API exposes about log usage.
 *
 * One throwaway Pro-org project (ap-southeast-1), a table `ob_canary` and an
 * Edge Function `ob-canary` that prints its marker. Vantage: this machine.
 *
 *   OB03a  canary: once a minute, one marked REST request (lands in
 *          `edge_logs`, marker in the request URL) and one marked function
 *          invoke (lands in `function_edge_logs` by URL and `function_logs` by
 *          the console line). A poller queries the logs endpoint every 15 s for
 *          every marker and records the poll time at which each marker was
 *          first returned. Lag = first-returned time minus the moment the
 *          request was sent; the resolution is the 15 s poll, so lag is an
 *          upper bound within 15 s. The log row's own `timestamp` is recorded
 *          as well (event-time skew against the send time). Markers still
 *          missing 10 minutes after the last send count as not ingested.
 *   OB03b  which `source` values the logs endpoint carries on this project
 *          after one request of each kind (shared pooler through Supavisor on
 *          6543 and 5432, a Realtime websocket join, Auth admin and health,
 *          Storage bucket and object, a failing and a succeeding SQL
 *          statement): count and first timestamp per source.
 *   OB03c  known volume against what the platform reports: 300 marked REST
 *          requests sent in a burst, then (1) the number of those rows the
 *          logs endpoint returns, (2) `usage.api-counts` and
 *          `usage.api-requests-count` (the only usage endpoints in the v1
 *          OpenAPI document), (3) the platform-internal organization usage
 *          route with the PAT, to see whether log ingestion volume is exposed
 *          at all.
 *
 * Not settled: logs per GB metering (no usage
 * figure in GB is reachable by PAT, see OB03c), query-quota billing, the
 * Dashboard Logs Explorer, other regions, load above one request a minute.
 *
 * DESTRUCTIVE: creates and deletes one project; runs about 50 minutes.
 */
import { writeFileSync } from "node:fs";
import pg from "pg";
import WebSocket from "ws";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { deployViaApi } from "../../edge-function-limits/lib/ef";
import { dropProject, evidencePath, logs, makeProject, pct, sleep, sql } from "../lib/ob";

const CANARY_MIN = Number(process.env.OB03_MINUTES ?? 36);
const POLL_MS = 15_000;
const TAIL_MS = 10 * 60_000;
const BURST = 300;

const FN = `Deno.serve((req) => { const m = new URL(req.url).searchParams.get("m"); console.log("obcanary " + m); return new Response("ok"); });`;

interface Sent {
  i: number;
  kind: "r" | "f";
  t: number;
  status: number;
  doneMs: number;
}

const mod: TestModule = {
  id: "OB03",
  title: "Log ingestion canary, log sources, and usage visibility",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "OB03", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    let ref = "";
    try {
      const proj = await makeProject(ctx, "ob03");
      ref = proj.ref;
      const pc = proj.ctx;
      const run = Date.now().toString(36);
      const base = `https://${pc.apiHost}`;
      const anon = { apikey: pc.anonKey!, authorization: `Bearer ${pc.anonKey}` };
      let apiRequests = 0;
      const hit = async (url: string, init: RequestInit = {}): Promise<number> => {
        apiRequests++;
        try {
          const r = await fetch(url, { ...init, headers: { ...anon, ...(init.headers ?? {}) } });
          await r.arrayBuffer();
          return r.status;
        } catch {
          return 0;
        }
      };

      const ddl = await sql(pc, "create table public.ob_canary(id int primary key, tag text); insert into public.ob_canary values (1); alter table public.ob_canary enable row level security; create policy ob_anon_read on public.ob_canary for select to anon using (true);");
      if (ddl.status >= 300) throw new Error(`ddl: ${ddl.error}`);
      const dep = await deployViaApi(pc, "ob-canary", [{ name: "index.ts", content: FN }], { entrypoint_path: "index.ts", name: "ob-canary", verify_jwt: false });
      if (dep.status >= 300) throw new Error(`deploy HTTP ${dep.status} ${dep.error}`);
      for (let i = 0; i < 20; i++) {
        if ((await hit(`${base}/functions/v1/ob-canary?m=warm`)) === 200) break;
        await sleep(3000);
      }
      const warmRequests = apiRequests;

      // ---- loops
      const sent: Sent[] = [];
      const firstSeen = new Map<string, number>(); // `${i}-${k}-${source}` -> poll time
      const evTs = new Map<string, string>();
      const rx = new RegExp(`obc${run}-(\\d+)-([rf])`);
      let stop = false;
      const polls: Array<{ t: number; status: number; error: string; rows: number }> = [];
      const T0 = Date.now();

      const poller = (async () => {
        while (!stop) {
          const t = Date.now();
          const q = await logs(
            pc,
            `select source, timestamp, event_message from logs where source in ('edge_logs', 'function_edge_logs', 'function_logs') and position(event_message, 'obc${run}') > 0 limit 2000`,
            1,
          );
          polls.push({ t, status: q.status, error: q.error, rows: q.rows.length });
          for (const r of q.rows as Array<{ source: string; timestamp: string; event_message: string }>) {
            const m = rx.exec(r.event_message);
            if (!m) continue;
            const k = `${m[1]}-${m[2]}-${r.source}`;
            if (!firstSeen.has(k)) {
              firstSeen.set(k, t);
              evTs.set(k, r.timestamp);
            }
          }
          await sleep(Math.max(1000, POLL_MS - (Date.now() - t)));
        }
      })();

      const canary = (async () => {
        for (let i = 0; i < CANARY_MIN; i++) {
          const at = T0 + i * 60_000;
          await sleep(Math.max(0, at - Date.now()));
          const one = async (kind: "r" | "f") => {
            const t = Date.now();
            const m = `obc${run}-${i}-${kind}`;
            const status = kind === "r" ? await hit(`${base}/rest/v1/ob_canary?select=id&tag=eq.${m}`) : await hit(`${base}/functions/v1/ob-canary?m=${m}`);
            sent.push({ i, kind, t, status, doneMs: Date.now() - t });
          };
          await Promise.all([one("r"), one("f")]);
        }
      })();

      // ---- OB03b: one request of every kind, a few minutes in
      const sourcesTraffic = (async () => {
        await sleep(2 * 60_000);
        const notes: string[] = [];
        // pooler (Supavisor) on 6543 and 5432, then a failing statement
        const cfg = await mgmt(pc, "GET", `/projects/${ref}/config/database/pooler`);
        const row = (Array.isArray(cfg.json) ? (cfg.json as Array<{ db_host?: string; database_type?: string }>) : []).find((e) => e.database_type === "PRIMARY");
        if (row?.db_host) {
          for (const port of [6543, 5432]) {
            const c = new pg.Client({ host: row.db_host, port, user: `postgres.${ref}`, password: pc.dbPassword, database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
            try {
              await c.connect();
              await c.query(`select 'obs${run}ok' as m`);
              await c.query(`select * from obs${run}_missing`).catch(() => null);
              notes.push(`pooler ${port} ok`);
            } catch (e) {
              notes.push(`pooler ${port} ${(e as Error).message.slice(0, 60)}`);
            } finally {
              await c.end().catch(() => null);
            }
          }
        }
        // realtime join
        await new Promise<void>((resolve) => {
          const ws = new WebSocket(`wss://${pc.apiHost}/realtime/v1/websocket?apikey=${pc.anonKey}&vsn=1.0.0`);
          const done = () => {
            try {
              ws.close();
            } catch {
              /* closed */
            }
            resolve();
          };
          ws.on("open", () => ws.send(JSON.stringify({ topic: `realtime:obs${run}`, event: "phx_join", payload: {}, ref: "1" })));
          ws.on("message", () => setTimeout(done, 3000));
          ws.on("error", done);
          setTimeout(done, 15_000);
        });
        notes.push("realtime joined");
        // auth
        await hit(`${base}/auth/v1/health`);
        await hit(`${base}/auth/v1/admin/users`, { method: "POST", headers: { apikey: pc.serviceKey!, authorization: `Bearer ${pc.serviceKey}`, "content-type": "application/json" }, body: JSON.stringify({ email: `obs${run}@example.com`, password: "Passw0rd!xx", email_confirm: true }) });
        // storage
        const sk = { apikey: pc.serviceKey!, authorization: `Bearer ${pc.serviceKey}` };
        await hit(`${base}/storage/v1/bucket`, { method: "POST", headers: { ...sk, "content-type": "application/json" }, body: JSON.stringify({ id: `obs${run}`, name: `obs${run}` }) });
        await hit(`${base}/storage/v1/object/obs${run}/a.txt`, { method: "POST", headers: { ...sk, "content-type": "text/plain" }, body: "x" });
        return notes;
      })();

      // ---- OB03c burst at minute 5
      const burst = (async () => {
        await sleep(5 * 60_000);
        let ok = 0;
        for (let b = 0; b < BURST / 30; b++) {
          const r = await Promise.all(Array.from({ length: 30 }, (_, j) => hit(`${base}/rest/v1/ob_canary?select=id&tag=eq.obv${run}-${b * 30 + j}`)));
          ok += r.filter((s) => s === 200).length;
        }
        return ok;
      })();

      await canary;
      const notes = await sourcesTraffic;
      const burstOk = await burst;
      const lastSend = Math.max(...sent.map((s) => s.t));
      // keep polling until every marker has been seen in its main source, or the tail expires
      const wanted = (s: Sent) => `${s.i}-${s.kind}-${s.kind === "r" ? "edge_logs" : "function_logs"}`;
      while (Date.now() < lastSend + TAIL_MS && !sent.every((s) => firstSeen.has(wanted(s)))) await sleep(5000);
      stop = true;
      await poller;

      // ---- OB03a rows
      const lagFor = (kind: "r" | "f", source: string) => {
        const lags: number[] = [];
        let missing = 0;
        for (const s of sent.filter((x) => x.kind === kind)) {
          const f = firstSeen.get(`${s.i}-${kind}-${source}`);
          if (f === undefined) missing++;
          else lags.push(f - s.t);
        }
        return { lags, missing };
      };
      const sec = (n: number) => (n < 0 ? -1 : Math.round(n / 100) / 10);
      for (const [kind, source] of [["r", "edge_logs"], ["f", "function_edge_logs"], ["f", "function_logs"]] as const) {
        const { lags, missing } = lagFor(kind, source);
        const skew: number[] = [];
        for (const s of sent.filter((x) => x.kind === kind)) {
          const ts = evTs.get(`${s.i}-${kind}-${source}`);
          if (ts) skew.push(Date.parse(`${ts}Z`) - s.t);
        }
        out.push({
          id: `OB03a ${source}`,
          title: `OB03a: canary lag in ${source}`,
          status: "info",
          detail: `${lags.length} of ${sent.filter((x) => x.kind === kind).length} markers returned`,
          measurements: {
            markers_sent: sent.filter((x) => x.kind === kind).length,
            markers_returned: lags.length,
            markers_missing_after_tail: missing,
            lag_s_min: sec(lags.length ? Math.min(...lags) : -1),
            lag_s_p50: sec(pct(lags, 50)),
            lag_s_p90: sec(pct(lags, 90)),
            lag_s_p99: sec(pct(lags, 99)),
            lag_s_max: sec(lags.length ? Math.max(...lags) : -1),
            lag_over_240s: lags.filter((l) => l > 240_000).length,
            event_timestamp_minus_send_s_p50: sec(pct(skew, 50)),
            event_timestamp_minus_send_s_min: sec(skew.length ? Math.min(...skew) : -1),
            event_timestamp_minus_send_s_max: sec(skew.length ? Math.max(...skew) : -1),
            request_status_non200: sent.filter((x) => x.kind === kind && x.status !== 200).length,
            request_ms_p50: pct(sent.filter((x) => x.kind === kind).map((x) => x.doneMs), 50),
          },
        });
      }
      const pollErrs = polls.filter((p) => p.error);
      out.push({
        id: "OB03a polls",
        title: "OB03a: poller health",
        status: "info",
        measurements: {
          polls: polls.length,
          polls_with_error: pollErrs.length,
          first_error: pollErrs[0]?.error.slice(0, 120) ?? "none",
          window_minutes: Math.round((Date.now() - T0) / 60_000),
        },
      });

      // ---- OB03b sources
      const sr = await logs(pc, "select source, count(*) as n, min(timestamp) as first_ts from logs group by source order by source", 3);
      const bySource = (sr.rows as Array<{ source: string; n: number }>).map((r) => `${r.source}=${r.n}`);
      const names = (sr.rows as Array<{ source: string }>).map((r) => r.source);
      out.push({
        id: "OB03b",
        title: "OB03b: log sources returned by the logs endpoint",
        status: sr.error ? "fail" : "info",
        detail: sr.error || notes.join("; "),
        measurements: {
          sources: names.join(","),
          counts: bySource.join(", "),
          has_pgbouncer_logs: String(names.includes("pgbouncer_logs")),
          has_supavisor_logs: String(names.some((n) => /supavisor|pooler/i.test(n))),
          has_realtime_logs: String(names.includes("realtime_logs")),
        },
      });
      // the pooler marker: where did the Supavisor statement go?
      const pm = await logs(pc, `select source, count(*) as n from logs where position(event_message, 'obs${run}') > 0 group by source`, 3);
      out.push({
        id: "OB03b markers",
        title: "OB03b: which sources carry this run's pooler / realtime / storage markers in the message",
        status: pm.error ? "fail" : "info",
        detail: pm.error || undefined,
        measurements: { marker_sources: (pm.rows as Array<{ source: string; n: number }>).map((r) => `${r.source}=${r.n}`).join(", ") || "none" },
      });

      // ---- OB03c volume
      const burstQ = await logs(pc, `select count(*) as n from logs where source = 'edge_logs' and position(event_message, 'obv${run}') > 0`, 3);
      const canaryQ = await logs(pc, `select count(*) as n from logs where source = 'edge_logs' and position(event_message, 'obc${run}') > 0`, 3);
      const allEdge = await logs(pc, "select count(*) as n from logs where source = 'edge_logs'", 3);
      const u1 = await mgmt(pc, "GET", `/projects/${ref}/analytics/endpoints/usage.api-counts?interval=1hr`);
      const u2 = await mgmt(pc, "GET", `/projects/${ref}/analytics/endpoints/usage.api-requests-count`);
      const orgUsage = await fetch(`https://api.supabase.com/platform/organizations/${ctx.orgs.pro}/usage`, { headers: { Authorization: `Bearer ${ctx.pat}` } });
      const orgUsageBody = (await orgUsage.text()).replaceAll(ctx.orgs.pro ?? "", "<org>").slice(0, 120);
      const n = (r: { rows: unknown[] }) => String((r.rows[0] as { n?: number } | undefined)?.n ?? "-");
      out.push({
        id: "OB03c",
        title: "OB03c: known request volume against the logs endpoint and the usage endpoints",
        status: "info",
        measurements: {
          requests_sent_to_project_api_total: apiRequests,
          requests_sent_before_loops: warmRequests,
          burst_sent: BURST,
          burst_status_200: burstOk,
          burst_rows_in_edge_logs: n(burstQ),
          canary_rest_sent: sent.filter((s) => s.kind === "r").length,
          canary_rest_rows_in_edge_logs: n(canaryQ),
          all_edge_logs_rows: n(allEdge),
          usage_api_counts_status: u1.status,
          usage_api_counts_body: JSON.stringify(u1.json ?? u1.text).replaceAll(ref, "<ref>").slice(0, 300),
          usage_api_requests_count_status: u2.status,
          usage_api_requests_count_body: JSON.stringify(u2.json ?? u2.text).replaceAll(ref, "<ref>").slice(0, 300),
          platform_org_usage_with_pat_status: orgUsage.status,
          platform_org_usage_with_pat_body: orgUsageBody,
        },
      });
      writeFileSync(evidencePath("ob03-canary.json"), JSON.stringify({ run, sent, firstSeen: [...firstSeen.entries()].map(([k, v]) => [k, v - T0]), evTs: [...evTs.entries()], polls: polls.map((p) => ({ ...p, t: p.t - T0 })) }, null, 1));
    } catch (e) {
      out.push({ id: "OB03", title: "OB03", status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await dropProject(ctx, ref);
    }
    return out;
  },
};
export default mod;
