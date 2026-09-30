/**
 * MS05 - which client-supplied strings reach the project's logs.
 *
 * A regulated tenant asks whether logs can contain row data
 * or identifiers. A single marker string is planted on three surfaces and
 * then searched for across every log source through the analytics endpoint:
 *
 *   MS05a  Storage: an object at `tenant-<marker>/record-<marker>.txt` is
 *          uploaded and downloaded with the service key. Expected in
 *          `edge_logs` (the API gateway sees the URL path) and `storage_logs`.
 *   MS05b  Realtime: a websocket joins topic `realtime:tenant:<marker>`.
 *          Expected in `realtime_logs`.
 *   MS05c  Postgres: through the shared pooler as `postgres`, ONE failing
 *          statement with `<marker>PII` as a literal (SQLSTATE 42P01) and ONE
 *          succeeding statement with `<marker>OK`. Under the defaults measured
 *          in MS01a (`log_statement=ddl`, `log_min_error_statement=error`) the
 *          failing statement's text is expected in `postgres_logs`.
 *   MS05d  the succeeding statement's literal: expected ABSENT.
 *
 * Logs are read through `GET /analytics/endpoints/logs` - since 2026-09-23 the
 * only endpoint: one unified `logs` table, ClickHouse dialect, `source_name`
 * column (the first run here found `logs.all` answering 410 and the changelog
 * that announced it). Both `event_message` and the flattened `log_attributes`
 * map are searched: for edge_logs the URL is `request.path`, for storage the
 * object is `objectPath`, and the second run found ingestion lagging past 4
 * minutes. One query every 30 s for up to 8 minutes, since the endpoint
 * throttles. The evidence keeps only the matching line, trimmed.
 * DESTRUCTIVE: creates and deletes one bucket and one object. Not settled: log
 * DRAINS (dashboard-only, residency-facts R07) and where the logs backend
 * stores them.
 */
import WebSocket from "ws";
import { logsQuery } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { errText, pgClient, primaryPooler, sharedTargets, sleep } from "../lib/setup";

const SEARCH_MAX_MS = 480_000;
const SEARCH_EVERY_MS = 30_000;

interface Hit {
  source: string;
  message: string;
}

const mod: TestModule = {
  id: "MS05",
  title: "Log contents: object paths, channel names and SQL literals, per log source",
  where: "local",
  requires: ["pat", "db", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const marker = `pvlab${Math.random().toString(16).slice(2, 10)}`;
    const svc = ctx.serviceKey ?? "";
    const base = `https://${ctx.apiHost}`;
    const bucket = `ms-logs-${marker}`;
    const objPath = `tenant-${marker}/record-${marker}.txt`;
    const planted: string[] = [];

    // Storage
    if (svc) {
      const h = { apikey: svc, Authorization: `Bearer ${svc}` };
      const mk = await fetch(`${base}/storage/v1/bucket`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ id: bucket, name: bucket, public: false }) });
      const up = await fetch(`${base}/storage/v1/object/${bucket}/${objPath}`, { method: "POST", headers: { ...h, "Content-Type": "text/plain" }, body: `marker ${marker}` });
      const dl = await fetch(`${base}/storage/v1/object/authenticated/${bucket}/${objPath}`, { headers: h });
      planted.push(`storage: bucket ${mk.status}, upload ${up.status}, download ${dl.status}`);
    } else planted.push("storage: skipped, no service key");

    // Realtime join
    const topic = `realtime:tenant:${marker}`;
    const joined = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`wss://${ctx.apiHost}/realtime/v1/websocket?apikey=${ctx.anonKey}&vsn=1.0.0`, { handshakeTimeout: 8000 });
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve("timeout"); }, 10_000);
      ws.on("open", () => ws.send(JSON.stringify({ topic, event: "phx_join", payload: { config: { broadcast: { self: true }, presence: { key: "" }, private: false } }, ref: "1" })));
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString()) as { event?: string; payload?: { status?: string } };
        if (m.event === "phx_reply") { clearTimeout(timer); try { ws.close(); } catch {} resolve(`phx_reply ${m.payload?.status ?? "?"}`); }
      });
      ws.on("error", (e) => { clearTimeout(timer); resolve(`error ${errText(e)}`); });
    });
    planted.push(`realtime: ${joined}`);

    // Postgres statements through the shared pooler
    const sv = await primaryPooler(ctx);
    let pgNote = "postgres: skipped, no pooler";
    let failCode = "";
    if (sv) {
      const c = pgClient(sharedTargets(sv).txn, ctx.dbPassword, 10_000);
      try {
        await c.connect();
        await c.query(`select '${marker}OK' as ok`);
        try {
          await c.query(`insert into ms_missing_${marker} values ('${marker}PII')`);
        } catch (e) {
          failCode = String((e as { code?: string }).code ?? "");
        }
        pgNote = `postgres: success literal sent, failing insert SQLSTATE ${failCode || "none"}`;
      } catch (e) {
        pgNote = `postgres: ${errText(e)}`;
      } finally {
        await c.end().catch(() => {});
      }
    }
    planted.push(pgNote);
    ctx.log(planted.join(" | "));

    // One unified search, paced for the throttle.
    const t0 = Date.now();
    const hits: Hit[] = [];
    const seenSources = new Set<string>();
    let lastError = "";
    let queries = 0;
    let firstHitS: number | string = "none";
    while (Date.now() - t0 < SEARCH_MAX_MS) {
      queries++;
      const q = await logsQuery(ctx, `select timestamp, source, event_message, toString(log_attributes) as attrs from logs where event_message like '%${marker}%' or toString(log_attributes) like '%${marker}%' order by timestamp desc limit 60`, 1);
      if (q.error) lastError = q.error;
      for (const r of q.rows) {
        const src = String(r.source ?? (r as { source_name?: string }).source_name ?? "?");
        const msg = `${String(r.event_message ?? "")} ## ${String((r as { attrs?: string }).attrs ?? "")}`;
        if (!hits.some((h) => h.source === src && h.message === msg)) hits.push({ source: src, message: msg });
        seenSources.add(src);
      }
      if (hits.length && firstHitS === "none") firstHitS = Math.round((Date.now() - t0) / 1000);
      // Stop once the three expected surfaces have reported.
      if (["edge_logs", "realtime_logs", "postgres_logs"].every((s) => seenSources.has(s))) break;
      await sleep(SEARCH_EVERY_MS);
    }
    const snippet = (h: Hit) => {
      const i = h.message.indexOf(marker);
      return h.message.slice(Math.max(0, i - 90), i + marker.length + 70).replace(/\s+/g, " ");
    };
    const bySource = (s: string) => hits.filter((h) => h.source === s);
    const row = (id: string, title: string, sources: string[], expectHit: boolean, extra: Record<string, string | number>): TestResult => {
      const hit = sources.some((s) => bySource(s).length > 0);
      const m: Record<string, string | number> = { ...extra };
      for (const s of sources) m[`${s}_hits`] = bySource(s).length;
      return {
        id,
        title,
        status: hit === expectHit ? "pass" : lastError && !hits.length ? "fail" : "info",
        detail: sources.map((s) => `${s}: ${bySource(s).length ? `${bySource(s).length} line(s)` : "no hit"}`).join("; ") + (lastError ? `; last endpoint error: ${lastError.slice(0, 100)}` : ""),
        measurements: m,
        evidence: sources.flatMap((s) => bySource(s).slice(0, 3).map((h) => `${s}: ...${snippet(h)}...`)).join("\n"),
      };
    };

    const out: TestResult[] = [
      row("MS05a", "Storage object path in the logs", ["edge_logs", "storage_logs"], true, { planted: planted[0] ?? "", queries, first_hit_s: firstHitS }),
      row("MS05b", "Realtime channel name in the logs", ["realtime_logs"], true, { planted: planted[1] ?? "" }),
      row("MS05c", "SQL literal from a FAILING statement (log_min_error_statement=error)", ["postgres_logs", "supavisor_logs", "pgbouncer_logs"], true, { planted: pgNote, failing_sqlstate: failCode }),
    ];
    const okHits = hits.filter((h) => h.source === "postgres_logs" && h.message.includes(`${marker}OK`));
    const piiHits = hits.filter((h) => h.source === "postgres_logs" && h.message.includes(`${marker}PII`));
    out.push({
      id: "MS05d",
      title: "SQL literal from a SUCCEEDING statement (log_statement=ddl): expected absent",
      status: okHits.length === 0 && piiHits.length > 0 ? "pass" : "info",
      detail: `succeeding literal: ${okHits.length} line(s); failing literal: ${piiHits.length} line(s)`,
      measurements: { success_literal_hits: okHits.length, failing_literal_hits: piiHits.length, other_sources_seen: [...seenSources].join(",") },
      evidence: piiHits.slice(0, 2).map(snippet).join("\n"),
    });

    if (svc) {
      const h = { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" };
      await fetch(`${base}/storage/v1/object/${bucket}`, { method: "DELETE", headers: h, body: JSON.stringify({ prefixes: [objPath] }) }).catch(() => {});
      await fetch(`${base}/storage/v1/bucket/${bucket}`, { method: "DELETE", headers: h }).catch(() => {});
    }
    return out;
  },
};
export default mod;
