/**
 * OB04 - generic HTTP log drain on a Pro-org project pointed at a Cloudflare
 * Worker the module deploys (`ob-surface-drain-...`, deleted in `finally`).
 *
 * Claims under test (sources: https://supabase.com/blog/log-drains-now-available-on-pro
 * and https://supabase.com/docs/guides/observability/log-drains): HTTP drains
 * batch at most 250 events or one second, whichever comes first; a custom
 * endpoint receives a JSON array by POST; gzip is optional; HTTP/1 and HTTP/2
 * are selectable; Pro includes drains (entitlement `log_drains`).
 *
 * Rows:
 *   OB04a  entitlement `log_drains` on the Pro org (read-only).
 *   OB04b  the sink itself, before any drain exists: a plain and a gzip POST
 *          with the lab key are stored with the right Content-Encoding and the
 *          Worker decodes the gzip body (so a later empty dump means the drain
 *          sent nothing, not that the sink could not read it).
 *   OB04c  drain creation through `POST /v2/projects/{ref}/analytics/log-drains`
 *          (OpenAPI path in https://api.supabase.com/api/v2-json, `x-allowed-plans`
 *          Pro/Team/Enterprise). The status and body are the measurement.
 *   OB04d  only when OB04c returned 201: batch sizes, flush spacing,
 *          Content-Encoding, HTTP protocol seen by the Worker, event field
 *          names, and arrival lag of marked requests. The 2026-10-10 run did NOT
 *          reach this branch (OB04c answered 403), so this code path has never
 *          executed against a live drain: treat its first run as a debugging run.
 *
 * Cost control: a drain bills per drain-hour (docs: pricing page linked from
 * the Log Drains guide); the flow deletes the drain as soon as the capture
 * window closes, and the whole OB04d branch is capped at 25 minutes.
 *
 * Credentials: the Worker is deployed through the Cloudflare REST API with the
 * global key pair (`CLOUDFLARE_EMAIL`, `CLOUDFLARE_API_KEY`,
 * `CLOUDFLARE_ACCOUNT_ID`); without them OB04b onward skip.
 *
 * DESTRUCTIVE: creates and deletes one project, one Worker, one drain.
 */
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { cfEnv, deleteSink, deploySink, sinkExists } from "../lib/cf";
import { dropProject, evidencePath, makeProject, pct, sleep } from "../lib/ob";

interface Batch {
  id: number;
  recv_ms: number;
  raw_len: number;
  enc: string;
  hdr: string;
  proto: string;
  body: string;
}

async function dump(url: string, key: string, since = 0): Promise<Batch[]> {
  const r = await fetch(`${url}/dump?since=${since}`, { headers: { "x-ob-key": key } });
  return (await r.json()) as Batch[];
}

const mod: TestModule = {
  id: "OB04",
  title: "Generic HTTP log drain to a Cloudflare Worker: creation, batches, lag",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "OB04", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    const cf = cfEnv();
    const name = `ob-surface-drain-${Date.now().toString(36)}`;
    const key = crypto.randomUUID();
    let ref = "";
    let drainId = "";
    let pc: Ctx | undefined;
    try {
      // ---- OB04a entitlement
      const ent = await mgmt(ctx, "GET", `/organizations/${ctx.orgs.pro}/entitlements`);
      const feats = ((ent.json as { entitlements?: Array<{ feature?: { key?: string }; hasAccess?: boolean }> } | undefined)?.entitlements ?? []);
      const ld = feats.find((f) => f.feature?.key === "log_drains");
      out.push({
        id: "OB04a",
        title: "OB04a: log_drains entitlement on the Pro org",
        status: "info",
        measurements: { log_drains_hasAccess: String(ld?.hasAccess ?? "absent"), audit_log_drains_hasAccess: String(feats.find((f) => f.feature?.key === "audit_log_drains")?.hasAccess ?? "absent") },
      });

      const proj = await makeProject(ctx, "ob04");
      ref = proj.ref;
      pc = proj.ctx;

      // ---- OB04c first (cheap, and decides whether the rest is worth a Worker)
      const base = (process.env.SUPABASE_MGMT_BASE_URL ?? "https://api.supabase.com/v1").replace(/\/v1$/, "");
      const mk = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${ctx.pat}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        return { status: res.status, text };
      };
      const list = await mk("GET", `/v2/projects/${ref}/analytics/log-drains`);

      let sink: { url: string } | undefined;
      if (cf) {
        const dep = await deploySink(cf, name, key);
        if (dep.url) sink = { url: dep.url };
        out.push({ id: "OB04b-deploy", title: "OB04b: sink Worker deployed", status: dep.url ? "info" : "fail", detail: dep.detail || undefined, measurements: { upload_status: dep.status } });
        if (sink) {
          for (let i = 0; i < 20; i++) {
            const h = await fetch(`${sink.url}/health`).catch(() => null);
            if (h?.status === 200) break;
            await sleep(3000);
          }
          const plain = JSON.stringify([{ probe: "plain" }]);
          const p1 = await fetch(`${sink.url}/ingest`, { method: "POST", headers: { "x-ob-key": key, "content-type": "application/json" }, body: plain });
          const p2 = await fetch(`${sink.url}/ingest`, { method: "POST", headers: { "x-ob-key": key, "content-type": "application/json", "content-encoding": "gzip" }, body: gzipSync(Buffer.from(JSON.stringify([{ probe: "gzip" }]))) });
          const p3 = await fetch(`${sink.url}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: plain });
          const rows = await dump(sink.url, key);
          const decoded = rows.map((r) => ({ enc: r.enc, body: r.body, decoded: (JSON.parse(r.hdr) as Record<string, string>)._decoded }));
          out.push({
            id: "OB04b",
            title: "OB04b: sink stores plain and gzip POSTs, rejects an unkeyed POST",
            status: p1.status === 200 && p2.status === 200 && p3.status === 401 && decoded.length === 2 && decoded[1]?.body.includes("gzip") ? "pass" : "fail",
            measurements: {
              plain_status: p1.status,
              gzip_status: p2.status,
              unkeyed_status: p3.status,
              stored_rows: decoded.length,
              gzip_row_encoding: decoded[1]?.enc ?? "-",
              gzip_row_decoded: decoded[1]?.decoded ?? "-",
              gzip_row_body: (decoded[1]?.body ?? "-").slice(0, 40),
              worker_protocol: rows[0]?.proto ?? "-",
            },
          });
          await fetch(`${sink.url}/clear`, { headers: { "x-ob-key": key } });
        }
      } else {
        out.push({ id: "OB04b", title: "OB04b: sink", status: "skip", detail: "CLOUDFLARE_EMAIL / CLOUDFLARE_API_KEY / CLOUDFLARE_ACCOUNT_ID not set" });
      }

      const target = sink?.url ?? "https://example.invalid";
      const created = await mk("POST", `/v2/projects/${ref}/analytics/log-drains`, {
        data: { type: "log_drain", attributes: { name: "ob-surface-drain", backend_type: "webhook", config: { url: `${target}/ingest`, http: "http1", gzip: true, headers: { "x-ob-key": key } } } },
      });
      const redact = (s: string) => s.replaceAll(key, "<key>").replaceAll(ref, "<ref>").slice(0, 300);
      out.push({
        id: "OB04c",
        title: "OB04c: create a webhook log drain through POST /v2/projects/{ref}/analytics/log-drains",
        status: created.status === 201 ? "pass" : "fail",
        detail: `HTTP ${created.status}: ${redact(created.text)}`,
        measurements: { list_status: list.status, list_body: redact(list.text).slice(0, 160), create_status: created.status },
      });
      if (created.status !== 201 || !sink || !cf) return out;

      // ---- OB04d (not exercised on 2026-10-10: see the header)
      const t0 = Date.now();
      drainId = (JSON.parse(created.text) as { data?: { id?: string } }).data?.id ?? "";
      const marker = `obd${t0.toString(36)}`;
      const sent: Array<{ m: string; t: number }> = [];
      const hit = async (m: string) => {
        sent.push({ m, t: Date.now() });
        await fetch(`https://${pc!.apiHost}/rest/v1/?${marker}=${m}`, { headers: { apikey: pc!.anonKey! } }).then((r) => r.arrayBuffer()).catch(() => null);
      };
      // steady phase: one marked request every 2 s for 3 minutes
      for (let i = 0; i < 90; i++) {
        await hit(`s${i}`);
        await sleep(2000);
      }
      // burst: 1200 requests, 40 at a time
      for (let i = 0; i < 30; i++) await Promise.all(Array.from({ length: 40 }, (_, j) => hit(`b${i * 40 + j}`)));
      await sleep(90_000);
      const batches = await dump(sink.url, key);
      writeFileSync(evidencePath("ob04-batches.json"), JSON.stringify(batches, null, 1));
      const sizes: number[] = [];
      const gaps: number[] = [];
      const encs = new Set<string>();
      const protos = new Set<string>();
      const keys = new Set<string>();
      const lag: number[] = [];
      let prev = 0;
      for (const b of batches) {
        let ev: unknown[] = [];
        try {
          const j = JSON.parse(b.body) as unknown;
          ev = Array.isArray(j) ? j : [j];
        } catch {
          /* non-JSON body, counted as size 0 */
        }
        sizes.push(ev.length);
        encs.add(b.enc || "none");
        protos.add(b.proto);
        if (prev) gaps.push(b.recv_ms - prev);
        prev = b.recv_ms;
        for (const e of ev.slice(0, 3)) if (e && typeof e === "object") for (const k of Object.keys(e)) keys.add(k);
        for (const s of sent) if (b.body.includes(`${marker}=${s.m}`) || b.body.includes(`${marker}%3D${s.m}`)) lag.push(b.recv_ms - s.t);
      }
      out.push({
        id: "OB04d",
        title: "OB04d: batch shape and arrival lag of a drain to the Worker",
        status: batches.length ? "info" : "fail",
        measurements: {
          batches: batches.length,
          events_total: sizes.reduce((a, b) => a + b, 0),
          batch_size_max: Math.max(0, ...sizes),
          batch_size_median: pct(sizes, 50),
          gap_ms_p50: pct(gaps, 50),
          gap_ms_min: gaps.length ? Math.min(...gaps) : -1,
          content_encodings: [...encs].join(","),
          protocols: [...protos].join(","),
          event_keys: [...keys].sort().join(",").slice(0, 300),
          marked_seen: lag.length,
          marked_sent: sent.length,
          lag_ms_p50: pct(lag, 50),
          lag_ms_p95: pct(lag, 95),
          lag_ms_max: lag.length ? Math.max(...lag) : -1,
        },
      });
    } catch (e) {
      out.push({ id: "OB04", title: "OB04", status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (pc && drainId) {
        const base = (process.env.SUPABASE_MGMT_BASE_URL ?? "https://api.supabase.com/v1").replace(/\/v1$/, "");
        await fetch(`${base}/v2/projects/${ref}/analytics/log-drains/${drainId}`, { method: "DELETE", headers: { Authorization: `Bearer ${ctx.pat}` } }).catch(() => null);
      }
      if (cf) {
        const st = await deleteSink(cf, name).catch(() => 0);
        const left = await sinkExists(cf, name).catch(() => false);
        out.push({ id: "OB04-cleanup", title: "OB04: sink Worker deleted", status: left ? "fail" : "info", measurements: { delete_status: st, worker_still_listed: String(left) } });
      }
      await dropProject(ctx, ref);
    }
    return out;
  },
};
export default mod;
