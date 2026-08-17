/**
 * M01 - DIY per-tenant usage metering, put into practice.
 *
 * A platform billing its own tenants for per-tenant Supabase usage has no
 * org-scoped billing read on the Management API. The documented DIY
 * workarounds are: (a) query the tenant project directly for ground truth
 * (pg_database_size, Storage object listing) and (b) read the per-project
 * usage analytics endpoints for request volumes. This module does both on a
 * self-provisioned project and measures fidelity and lag:
 *
 *   M01-control  create a project, poll healthy, fetch API keys.
 *   M01a         DB ground truth: insert a deterministic ~8MB payload via
 *                /database/query, read pg_database_size before and after.
 *   M01b         REST-count reconstruction: send EXACTLY 12 PostgREST GETs,
 *                then poll usage.api-counts (15min interval) once a minute,
 *                bounded, recording whether/when they show up and the count.
 *   M01c         the Prometheus metrics scrape endpoint: status, content
 *                type, metric family count.
 *   M01d         Storage ground truth: upload exactly 262144 bytes, list the
 *                bucket, sum the reported sizes.
 *
 * The project is deleted in `finally`. Measured non-2xx is data, never an
 * exception. Key/token VALUES never appear in results.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const PRO_ORG = "gfqyoavfwjduavsvhbni"; // same Pro org as w21/i01
const REGION = "ap-southeast-1";
const REST_SENT = 12;
const UPLOAD_BYTES = 262144;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}
interface ApiKeyRow {
  name?: string;
  type?: string;
  api_key?: string;
}
interface QueryRow {
  [column: string]: unknown;
}
interface UsageBucket {
  timestamp?: string;
  total_auth_requests?: number;
  total_realtime_requests?: number;
  total_rest_requests?: number;
  total_storage_requests?: number;
}
interface StorageObjectRow {
  name?: string;
  metadata?: { size?: number };
}

function pickKey(keys: ApiKeyRow[], ...names: string[]): string {
  for (const n of names) {
    const hit = keys.find((k) => k.name === n || k.type === n);
    if (hit?.api_key) return hit.api_key;
  }
  return "";
}

async function sql(ctx: Ctx, ref: string, query: string): Promise<{ status: number; rows: QueryRow[]; text: string }> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
  const rows = Array.isArray(r.json) ? (r.json as QueryRow[]) : [];
  return { status: r.status, rows, text: r.text };
}

function firstNumber(rows: QueryRow[], col: string): number {
  const v = rows[0]?.[col];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const mod: TestModule = {
  id: "M01",
  title: "DIY per-tenant usage metering: ground truth vs API signals",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions and deletes its own project
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out = new Map<string, TestResult>();
    const put = (r: TestResult) => out.set(r.id, r);
    let ref = "";

    try {
      // ---- M01-control: provision, health, keys ----
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `m01-metering-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
      if (create.status !== 201 || !ref) {
        put({
          id: "M01-control",
          title: "M01-control: provision + keys",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
      } else {
        let status = "";
        for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
          await sleep(10_000);
          const p = await mgmt(ctx, "GET", `/projects/${ref}`);
          status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
        }
        const keysRes = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
        const keys = Array.isArray(keysRes.json) ? (keysRes.json as ApiKeyRow[]) : [];
        const anon = pickKey(keys, "anon", "publishable");
        const secret = pickKey(keys, "service_role", "secret");
        if (status !== "ACTIVE_HEALTHY" || !anon || !secret) {
          put({
            id: "M01-control",
            title: "M01-control: provision + keys",
            status: "fail",
            detail: `status=${status} anon=${anon ? "ok" : "missing"} secret=${secret ? "ok" : "missing"}`,
            measurements: { provision_s: Math.round((Date.now() - t0) / 1000) },
          });
        } else {
          put({
            id: "M01-control",
            title: "M01-control: provision + keys",
            status: "pass",
            measurements: { provision_s: Math.round((Date.now() - t0) / 1000) },
          });

          const base = `https://${ref}.supabase.co`;

          // ---- M01a: DB ground truth ----
          try {
            const before = await sql(ctx, ref, "select pg_database_size(current_database()) as bytes");
            await sql(ctx, ref, "create table if not exists public.m01_payload (id bigint generated always as identity primary key, body text)");
            const ins = await sql(
              ctx,
              ref,
              "insert into public.m01_payload (body) select repeat(md5(g::text), 2048) from generate_series(1, 128) g",
            );
            const after = await sql(ctx, ref, "select pg_database_size(current_database()) as bytes");
            // PostgREST schema-cache reload so M01b sees the table quickly.
            await sql(ctx, ref, "select pg_notify('pgrst', 'reload schema')");
            const baselineBytes = before.status === 201 || before.status === 200 ? firstNumber(before.rows, "bytes") : 0;
            const finalBytes = after.status === 201 || after.status === 200 ? firstNumber(after.rows, "bytes") : 0;
            put({
              id: "M01a",
              title: "M01a: pg_database_size ground truth",
              status: "info",
              detail: ins.status >= 300 ? `insert: HTTP ${ins.status}: ${ins.text.slice(0, 300)}` : undefined,
              measurements: {
                baseline_bytes: baselineBytes,
                pg_database_size_bytes: finalBytes,
                delta_bytes: finalBytes - baselineBytes,
              },
            });
          } catch (e) {
            put({ id: "M01a", title: "M01a: pg_database_size ground truth", status: "fail", detail: `threw: ${e}` });
          }

          // ---- M01b: REST-count reconstruction + analytics lag ----
          try {
            const sentAt = Date.now();
            let restOk = 0;
            let lastRestStatus = 0;
            for (let attempt = 0; attempt < 30 && restOk === 0; attempt++) {
              // first GET doubles as the schema-cache wait (PGRST205 retry)
              const r0 = await fetch(`${base}/rest/v1/m01_payload?select=id&limit=1`, {
                headers: { apikey: anon, Authorization: `Bearer ${anon}` },
                signal: AbortSignal.timeout(15_000),
              });
              await r0.text();
              lastRestStatus = r0.status;
              if (r0.status === 200) restOk = 1;
              else await sleep(5_000);
            }
            if (restOk === 1) {
              for (let i = 1; i < REST_SENT; i++) {
                const r = await fetch(`${base}/rest/v1/m01_payload?select=id&limit=1`, {
                  headers: { apikey: anon, Authorization: `Bearer ${anon}` },
                  signal: AbortSignal.timeout(15_000),
                });
                await r.text();
                lastRestStatus = r.status;
              }
            }
            const measurements: Record<string, number | string> = {
              rest_requests_sent: restOk === 1 ? REST_SENT : 0,
              last_rest_status: lastRestStatus,
            };
            let observed: number | string = "absent";
            let lag: number | string = "not_observed";
            let buckets = 0;
            if (restOk === 1) {
              for (let poll = 0; poll < 8; poll++) {
                await sleep(60_000);
                const usage = await mgmt(ctx, "GET", `/projects/${ref}/analytics/endpoints/usage.api-counts?interval=15min`);
                const result = (usage.json as { result?: UsageBucket[] } | undefined)?.result ?? [];
                buckets = result.length;
                const latest = result[result.length - 1];
                const restCount = latest?.total_rest_requests ?? 0;
                if (restCount > 0) {
                  observed = restCount;
                  lag = Math.round((Date.now() - sentAt) / 1000);
                  break;
                }
              }
            }
            measurements.rest_count_observed = observed;
            measurements.observation_lag_s = lag;
            measurements.buckets_returned = buckets;
            put({
              id: "M01b",
              title: "M01b: REST-count reconstruction via usage.api-counts",
              status: "info",
              measurements,
            });
          } catch (e) {
            put({ id: "M01b", title: "M01b: REST-count reconstruction via usage.api-counts", status: "fail", detail: `threw: ${e}` });
          }

          // ---- M01c: Prometheus metrics scrape ----
          try {
            const m = await mgmt(ctx, "GET", `/projects/${ref}/analytics/endpoints/metrics`);
            const families = (m.text.match(/^# TYPE /gm) ?? []).length;
            put({
              id: "M01c",
              title: "M01c: per-project Prometheus metrics endpoint",
              status: "info",
              measurements: {
                metrics_http_status: m.status,
                content_type: m.throttled ? "throttled" : m.text.startsWith("{") ? "json" : "text",
                metric_families: families,
              },
              evidence: m.text.slice(0, 300),
            });
          } catch (e) {
            put({ id: "M01c", title: "M01c: per-project Prometheus metrics endpoint", status: "fail", detail: `threw: ${e}` });
          }

          // ---- M01d: Storage ground truth ----
          try {
            const bucket = `m01-${Date.now()}`;
            let bucketStatus = 0;
            let bucketBody = "";
            for (let attempt = 0; attempt < 10; attempt++) {
              const r = await fetch(`${base}/storage/v1/bucket`, {
                method: "POST",
                headers: {
                  apikey: secret,
                  Authorization: `Bearer ${secret}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ id: bucket, name: bucket, public: false }),
                signal: AbortSignal.timeout(15_000),
              });
              bucketBody = await r.text();
              bucketStatus = r.status;
              if (r.status === 200) break;
              // TenantNotFound = storage tenant still provisioning (see w21)
              await sleep(5_000);
            }
            const payload = new Uint8Array(UPLOAD_BYTES);
            crypto.getRandomValues(payload);
            const up = await fetch(`${base}/storage/v1/object/${bucket}/m01.bin`, {
              method: "POST",
              headers: {
                apikey: secret,
                Authorization: `Bearer ${secret}`,
                "Content-Type": "application/octet-stream",
              },
              body: payload,
              signal: AbortSignal.timeout(30_000),
            });
            await up.text();
            const list = await fetch(`${base}/storage/v1/object/list/${bucket}`, {
              method: "POST",
              headers: {
                apikey: secret,
                Authorization: `Bearer ${secret}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ prefix: "" }),
              signal: AbortSignal.timeout(15_000),
            });
            const listText = await list.text();
            let listed = 0;
            try {
              const rows = JSON.parse(listText) as StorageObjectRow[];
              if (Array.isArray(rows)) listed = rows.reduce((sum, o) => sum + (o?.metadata?.size ?? 0), 0);
            } catch {
              listed = 0;
            }
            put({
              id: "M01d",
              title: "M01d: storage ground truth",
              status: "info",
              detail: bucketStatus !== 200 ? `bucket create: HTTP ${bucketStatus}: ${bucketBody.slice(0, 200)}` : undefined,
              measurements: {
                bucket_create_status: bucketStatus,
                upload_status: up.status,
                storage_bytes_uploaded: UPLOAD_BYTES,
                storage_bytes_listed: listed,
              },
            });
          } catch (e) {
            put({ id: "M01d", title: "M01d: storage ground truth", status: "fail", detail: `threw: ${e}` });
          }
        }
      }
    } catch (e) {
      // Only the control path can throw us here - record it on the control row.
      put({
        id: "M01-control",
        title: "M01-control: provision + keys",
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }

    // Exactly one of every row, whatever path we took.
    for (const id of ["M01-control", "M01a", "M01b", "M01c", "M01d"] as const) {
      if (!out.has(id)) {
        out.set(id, { id, title: id, status: "skip", detail: "not runnable: the control project never came up" });
      }
    }
    return [...out.values()];
  },
};
export default mod;
