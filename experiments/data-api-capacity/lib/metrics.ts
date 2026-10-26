/**
 * The project's Prometheus endpoint (`/customer/v1/privileged/metrics`, Basic
 * auth as `service_role`), reduced to the PostgREST pool series and node CPU.
 * DC05 (2026-10-23): the whole payload is a snapshot that changed once in
 * 100 s of 1 s scrapes (no refresh in two windows of about 36 s and 18 s),
 * so node CPU over a 40 s step is sometimes not computable (-1) and pool
 * readings can belong to an earlier state. PostgREST v14.18 source:
 * "waiting" counts requests from asking the pool until their session ends
 * (queued plus holding, AppState.hs usePool), "available" is open pool
 * connections not in use (Metrics.hs). DC05's snapshots agree with both.
 */
import type { DcProject } from "./dc.js";

export interface PoolScrape {
  t: number;
  waiting: number;
  available: number;
  max: number;
  timeouts: number;
  /** node_cpu_seconds_total summed over busy modes / the idle mode. */
  busy: number;
  idle: number;
  /** node_cpu_seconds_total series with mode="idle", i.e. the CPUs the node reports. */
  cpus: number;
}

export interface ScrapeResult {
  status: number;
  s: PoolScrape | null;
  /** Every pgrst_* series name seen. */
  names: string[];
  /** Response headers that would reveal a cache in front of the endpoint. */
  cacheHeaders: string;
  /** The raw pgrst_db_pool_* lines, for evidence. */
  poolLines: string[];
}

export async function scrapeMetrics(p: DcProject, timeoutMs = 8_000): Promise<ScrapeResult> {
  const auth = Buffer.from(`service_role:${p.keys.service}`).toString("base64");
  try {
    const res = await fetch(`https://${p.host}/customer/v1/privileged/metrics`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const cacheHeaders = ["cache-control", "age", "cf-cache-status", "date", "last-modified"]
      .map((h) => (res.headers.get(h) ? `${h}=${res.headers.get(h)}` : ""))
      .filter(Boolean)
      .join("; ");
    if (!res.ok) return { status: res.status, s: null, names: [], cacheHeaders, poolLines: [] };
    const text = await res.text();
    const s: PoolScrape = { t: Date.now(), waiting: -1, available: -1, max: -1, timeouts: -1, busy: 0, idle: 0, cpus: 0 };
    const names = new Set<string>();
    const poolLines: string[] = [];
    const add = (k: "waiting" | "available" | "max" | "timeouts", v: number) => (s[k] = (s[k] < 0 ? 0 : s[k]) + v);
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const name = line.split(/[{ ]/)[0] ?? "";
      const v = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (name.startsWith("pgrst_")) names.add(name);
      if (name.startsWith("pgrst_db_pool_")) poolLines.push(line);
      if (name === "pgrst_db_pool_waiting") add("waiting", v);
      else if (name === "pgrst_db_pool_available") add("available", v);
      else if (name === "pgrst_db_pool_max") add("max", v);
      else if (name === "pgrst_db_pool_timeouts_total") add("timeouts", v);
      else if (name === "node_cpu_seconds_total") {
        if (line.includes('mode="idle"')) {
          s.idle += v;
          s.cpus++;
        }
        else if (!line.includes('mode="steal"') && !line.includes('mode="guest')) s.busy += v;
      }
    }
    return { status: res.status, s, names: [...names].sort(), cacheHeaders, poolLines };
  } catch {
    return { status: 0, s: null, names: [], cacheHeaders: "", poolLines: [] };
  }
}
