/**
 * EF08 - the two limits that reject nothing: log message length and the log
 * event threshold.
 *
 * The Limits page lists "Maximum log message length: 10,000 characters" and
 * "Log event threshold: 100 events per 10 seconds". Neither fails a deploy or
 * an invocation; a function that crosses them keeps answering and its logs go
 * thin or truncated. That is why they arrive as "we hit a limit" from someone
 * reading a dashboard. This module crosses both on purpose and reads back what
 * the platform kept, through the Management API logs endpoint.
 *
 *   EF08a  one 12,000-character log line -> stored length (docs: 10,000)
 *   EF08b  150 log events inside one invocation, well under 10 s -> events
 *          stored (docs: 100 per 10 s)
 *
 * The logs endpoint is ClickHouse-only, GET-only, rate limited to 10 requests
 * per window (`x-ratelimit-limit: 10`; the window length is not documented and
 * is treated as a minute here), and ingestion lags by tens of seconds; the
 * module polls slowly
 * and records the source name it found the lines under, because the function
 * log source is not documented on the page it cites.
 *
 * DESTRUCTIVE: deploys one function under pvlab-ef08-, deletes in finally.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { cleanupPrefix, deployViaApi, invokeWhenLive } from "../lib/ef";

const P = "pvlab-ef08-";
const LONG_CHARS = 12_000;
const BURST_EVENTS = 150;

const SRC = `
Deno.serve((req) => {
  const u = new URL(req.url);
  const mode = u.searchParams.get("mode") ?? "long";
  const marker = u.searchParams.get("marker") ?? "pvlab";
  if (mode === "long") {
    console.log(marker + "-LONG-" + "L".repeat(${LONG_CHARS}));
    return Response.json({ mode, marker, chars: ${LONG_CHARS} + marker.length + 6 });
  }
  for (let i = 0; i < ${BURST_EVENTS}; i++) console.log(marker + "-BURST-" + String(i).padStart(3, "0"));
  return Response.json({ mode, marker, events: ${BURST_EVENTS} });
});
`;

interface LogRow {
  event_message?: string;
  source?: string;
  timestamp?: string;
}

/**
 * One logs query; the endpoint is GET-only with the SQL in the query string.
 * It also needs an explicit time window: without `iso_timestamp_start` and
 * `iso_timestamp_end` every query, including the guide's own example,
 * answered `Backend error! Retry your query.` (measured 2026-09-02); with a
 * window the same SQL returned rows. The window here is the last three hours.
 */
async function logs(ctx: Ctx, sql: string): Promise<{ status: number; rows: LogRow[]; error: string }> {
  const end = new Date();
  const start = new Date(end.getTime() - 3 * 3600_000);
  const qs = `sql=${encodeURIComponent(sql)}&iso_timestamp_start=${encodeURIComponent(start.toISOString())}&iso_timestamp_end=${encodeURIComponent(end.toISOString())}`;
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/analytics/endpoints/logs?${qs}`, undefined, 60_000);
  const j = (r.json ?? {}) as { result?: LogRow[]; error?: unknown };
  return {
    status: r.status,
    rows: Array.isArray(j.result) ? j.result : [],
    error: j.error ? JSON.stringify(j.error).slice(0, 200) : r.status >= 300 ? r.text.slice(0, 200) : "",
  };
}

const mod: TestModule = {
  id: "EF08",
  title: "Log limits: message length and event threshold, read back from the logs endpoint",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF08", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    const slug = `${P}logs`;
    const marker = `pvlab${Date.now().toString(36)}`;
    try {
      await cleanupPrefix(ctx, P);
      const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: SRC }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
      if (dep.status >= 300) return [{ id: "EF08", title: this.title, status: "fail", detail: `deploy HTTP ${dep.status} "${dep.error}"` }];

      const long = await invokeWhenLive(ctx, slug, 90_000, { path: `?mode=long&marker=${marker}` });
      const burst = await invokeWhenLive(ctx, slug, 30_000, { path: `?mode=burst&marker=${marker}` });
      if (long.status !== 200 || burst.status !== 200) {
        return [{ id: "EF08", title: this.title, status: "fail", detail: `invocations: long ${long.status}, burst ${burst.status}` }];
      }

      // Ingestion lag: poll every 25 s, at most 8 queries (the endpoint allows
      // 10 per minute; two more are spent on source discovery below).
      const sql = `SELECT event_message, source, timestamp FROM logs WHERE event_message LIKE '%${marker}%' ORDER BY timestamp DESC LIMIT 400`;
      let rows: LogRow[] = [];
      let lastErr = "";
      let queries = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 240_000 && queries < 8) {
        await Bun.sleep(25_000);
        const q = await logs(ctx, sql);
        queries++;
        lastErr = q.error;
        rows = q.rows;
        // Both the long line and a healthy share of the burst have to be
        // present before the count is trusted; otherwise keep waiting.
        const burstSeen = rows.filter((r) => (r.event_message ?? "").includes(`${marker}-BURST-`)).length;
        const longSeen = rows.some((r) => (r.event_message ?? "").includes(`${marker}-LONG-`));
        if (longSeen && burstSeen >= 50) break;
      }
      const sources = [...new Set(rows.map((r) => r.source ?? "?"))].join("|") || "none";

      // EF08a - stored length of the long line.
      const longRow = rows.find((r) => (r.event_message ?? "").includes(`${marker}-LONG-`));
      const stored = longRow?.event_message ?? "";
      // The platform appends a marker to a truncated line; the kept payload is
      // what precedes it. Recovered from the first run: 10,016 chars stored,
      // ending in " ....[truncated]".
      const markerIdx = stored.indexOf("[truncated]");
      const truncMarker = markerIdx >= 0 ? stored.slice(stored.lastIndexOf(" ", markerIdx) + 1) : "";
      const keptChars = markerIdx >= 0 ? stored.slice(0, stored.lastIndexOf(" ", markerIdx)).length : stored.length;
      const sentLen = LONG_CHARS + marker.length + 6;
      out.push({
        id: "EF08a",
        title: "log message length: stored vs sent",
        status: longRow ? (keptChars < sentLen ? "pass" : "info") : "fail",
        detail: longRow
          ? keptChars < sentLen
            ? `sent ${sentLen} chars, kept ${keptChars}${truncMarker ? ` then "${truncMarker}"` : ""} (docs: 10,000)${keptChars === 10_000 ? " - truncated at exactly the documented figure" : ""}`
            : `sent ${sentLen} chars, stored ${stored.length} - not truncated; the documented 10,000 did not bite`
          : `long line not found in ${rows.length} rows after ${queries} queries${lastErr ? ` (last error: ${lastErr})` : ""}`,
        measurements: {
          sent_chars: sentLen,
          kept_chars: keptChars,
          stored_chars_incl_marker: stored.length,
          truncation_marker: truncMarker || "none",
          docs_max_chars: 10_000,
          source: longRow?.source ?? "none",
          queries,
          wait_s: Math.round((Date.now() - t0) / 1000),
        },
      });

      // EF08b - events stored out of the burst.
      const burstRows = rows.filter((r) => (r.event_message ?? "").includes(`${marker}-BURST-`));
      const distinct = new Set(burstRows.map((r) => r.event_message)).size;
      out.push({
        id: "EF08b",
        title: "log event threshold: events stored from one 150-event burst",
        status: burstRows.length ? (distinct < BURST_EVENTS ? "pass" : "info") : "fail",
        detail: burstRows.length
          ? distinct < BURST_EVENTS
            ? `${distinct} of ${BURST_EVENTS} distinct events stored (docs: 100 per 10 s)${distinct === 100 ? " - exactly the documented threshold" : ""}`
            : `all ${distinct} events stored - the documented 100 per 10 s did not bite inside one invocation`
          : `no burst events found in ${rows.length} rows after ${queries} queries`,
        measurements: { sent_events: BURST_EVENTS, stored_distinct: distinct, stored_rows: burstRows.length, docs_threshold: "100 per 10 s", sources_seen: sources },
        evidence: rows.slice(0, 3).map((r) => `${r.source}: ${(r.event_message ?? "").slice(0, 80)}`).join("\n") || undefined,
      });
    } catch (e) {
      out.push({ id: "EF08", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const c = await cleanupPrefix(ctx, P).catch((e) => ({ deleted: 0, left: [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`] }));
      out.push({ id: "EF08z", title: "cleanup: delete pvlab-ef08-* functions", status: c.left.length ? "fail" : "pass", detail: c.left.length ? `LEFT DEPLOYED: ${c.left.join(", ")}` : `deleted ${c.deleted}`, measurements: { deleted: c.deleted, left: c.left.length } });
    }
    return out;
  },
};
export default mod;
