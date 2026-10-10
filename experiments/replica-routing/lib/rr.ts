/**
 * Shared plumbing for the replica-routing modules.
 *
 * Everything about the connection surface is READ off the platform (pooler
 * config, add-ons, health) rather than constructed, except the two hostnames
 * the Management API does not return: a replica's REST host and the API load
 * balancer's host. Those are probed (see `findLoadBalancer`) and the result,
 * including a miss, is recorded.
 */
import { resolve4 } from "node:dns/promises";
import { Client } from "pg";
import { mgmt, mgmtBase } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";

export const PREFIX = "rr-";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240);
export const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}

/** Same ctx with the project ref swapped, so shared helpers read the right project. */
export const forRef = (ctx: Ctx, ref: string): Ctx => ({ ...ctx, ref });

/* ---------- project lifecycle ---------- */

export async function waitProjectHealthy(ctx: Ctx, ref: string, maxMs = 15 * 60_000): Promise<{ status: string; waitedS: number }> {
  const t0 = Date.now();
  let status = "";
  while (Date.now() - t0 < maxMs) {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = String((p.json as { status?: string } | undefined)?.status ?? `HTTP ${p.status}`);
    if (status !== "ACTIVE_HEALTHY") continue;
    // The project row can read healthy before the services answer: wait on the health endpoint too.
    const h = await mgmt(ctx, "GET", `/projects/${ref}/health?services=db&services=rest&services=pooler`, undefined, 15_000);
    const rows = Array.isArray(h.json) ? (h.json as { status?: string }[]) : [];
    if (rows.length === 3 && rows.every((r) => r.status === "ACTIVE_HEALTHY")) break;
    status = "ACTIVE_HEALTHY (services not yet)";
  }
  return { status, waitedS: Math.round((Date.now() - t0) / 1000) };
}

export interface Addons {
  selected: string[];
}
export async function selectedAddons(ctx: Ctx, ref: string): Promise<string[]> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/billing/addons`);
  const j = (r.json ?? {}) as { selected_addons?: { type: string; variant?: { id?: string } }[] };
  return (j.selected_addons ?? []).map((a) => a.variant?.id ?? a.type);
}

/** `PATCH billing/addons`; a 429 carries "try again in N minute(s)" and is honoured, bounded. */
export async function applyAddon(ctx: Ctx, ref: string, type: string, variant: string): Promise<{ status: number; text: string }> {
  const send = () => mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, { addon_type: type, addon_variant: variant });
  let r = await send();
  for (let i = 0; i < 4 && r.status === 429; i++) {
    const m = /try again in (\d+)/.exec(r.text);
    await sleep(((m ? Number(m[1]) : 1) * 60 + 5) * 1000);
    r = await send();
  }
  return { status: r.status, text: r.text.slice(0, 300) };
}

export interface PoolerEntry {
  identifier: string;
  database_type: "PRIMARY" | "READ_REPLICA";
  db_user: string;
  db_host: string;
  db_port: number;
  db_name: string;
  connection_string?: string;
}
export async function poolerConfig(ctx: Ctx, ref: string): Promise<PoolerEntry[]> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`);
  return Array.isArray(r.json) ? (r.json as PoolerEntry[]) : [];
}

/** Session-mode (5432) client on a pooler entry: one backend per client, so a transaction block holds. */
export function sessionClient(e: PoolerEntry, password: string, timeoutMs = 10_000): Client {
  const c = new Client({
    host: e.db_host,
    port: 5432,
    user: e.db_user,
    password,
    database: e.db_name || "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: timeoutMs,
  });
  // An idle backend error is an 'error' event; unhandled, it kills the process
  // (run 2, 2026-10-10). The failing query rejects with the same error.
  c.on("error", () => {});
  return c;
}

/**
 * Connect with retries. A pooler can answer `password authentication failed`
 * for a while after the project's password was set or changed (reuse runs
 * 2-5, 2026-10-10: still failing 60 s after a reset on the Tokyo pooler).
 */
export async function connectSession(e: PoolerEntry, password: string, tries = 20, everyMs = 10_000): Promise<Client> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    const c = sessionClient(e, password);
    try {
      await c.connect();
      return c;
    } catch (err) {
      last = err;
      await c.end().catch(() => {});
      await sleep(everyMs);
    }
  }
  throw last;
}

/* ---------- Data API probes ---------- */

export interface WhoAmI {
  in_recovery: boolean;
  addr: string;
  pm: number;
  max_id: number;
  now: string;
}
export interface Sample {
  ms: number;
  status: number;
  node?: WhoAmI;
  headers?: Record<string, string>;
  err?: string;
}

/**
 * GET /rest/v1/rpc/rr_whoami. `get: true` in supabase-js is exactly this: a
 * GET with the function name in the path, which is the only RPC shape the
 * docs say a replica serves.
 */
export async function whoami(base: string, anon: string, opts: { method?: "GET" | "POST"; keepHeaders?: boolean; timeoutMs?: number } = {}): Promise<Sample> {
  const method = opts.method ?? "GET";
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/rest/v1/rpc/rr_whoami`, {
      method,
      headers: { apikey: anon, Authorization: `Bearer ${anon}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    let node: WhoAmI | undefined;
    try {
      node = JSON.parse(text) as WhoAmI;
      if (typeof node?.in_recovery !== "boolean") node = undefined;
    } catch {
      node = undefined;
    }
    const headers: Record<string, string> = {};
    // set-cookie carries a Cloudflare bot-management cookie value: keep the names, not the value.
    if (opts.keepHeaders) res.headers.forEach((v, k) => (headers[k] = k === "set-cookie" ? "<removed>" : v));
    return { ms, status: res.status, node, ...(opts.keepHeaders ? { headers } : {}), ...(node ? {} : { err: text.slice(0, 160) }) };
  } catch (e) {
    return { ms: performance.now() - t0, status: 0, err: errText(e) };
  }
}

export const nodeKey = (n?: WhoAmI) => (n ? `${n.in_recovery ? "replica" : "primary"}@pm${n.pm}` : "none");

/** Tally of which node answered. */
export function tally(samples: Sample[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of samples) out[nodeKey(s.node)] = (out[nodeKey(s.node)] ?? 0) + 1;
  return out;
}

/* ---------- hostnames the Management API does not return ---------- */

export async function resolves(host: string): Promise<string[]> {
  try {
    return await resolve4(host);
  } catch {
    return [];
  }
}

/**
 * The load balancer's endpoint is shown on the Dashboard's API Settings page
 * and returned by `GET /platform/projects/{ref}/load-balancers`, a route the
 * Dashboard calls with a login session. Try the route with the PAT first, then
 * a short candidate list of hostnames against the project ref. Records every
 * probe so a miss is a finding, not silence.
 */
export async function findLoadBalancer(
  ctx: Ctx,
  ref: string,
  anon: string,
): Promise<{ url?: string; tried: string[]; platformStatus: number; platformBody: string }> {
  const tried: string[] = [];
  const origin = mgmtBase(ctx).replace(/\/v1$/, "");
  let platformStatus = 0;
  let platformBody = "";
  try {
    const r = await fetch(`${origin}/platform/projects/${ref}/load-balancers`, {
      headers: { Authorization: `Bearer ${ctx.pat}` },
      signal: AbortSignal.timeout(20_000),
    });
    platformStatus = r.status;
    platformBody = (await r.text()).slice(0, 600);
    try {
      const j = JSON.parse(platformBody) as { endpoint?: string }[];
      const ep = Array.isArray(j) ? j[0]?.endpoint : undefined;
      if (ep) return { url: ep.replace(/\/+$/, ""), tried, platformStatus, platformBody };
    } catch {
      /* not JSON */
    }
  } catch (e) {
    platformBody = errText(e);
  }
  const suffix = ctx.apiHostSuffix ?? "supabase.co";
  for (const tag of ["all", "lb", "loadbalancer", "load-balancer", "balancer", "api", "rr"]) {
    const host = `${ref}-${tag}.${suffix}`;
    const ips = await resolves(host);
    tried.push(`${tag}:${ips.length ? "resolves" : "nxdomain"}`);
    if (!ips.length) continue;
    const s = await whoami(`https://${host}`, anon);
    if (s.node) return { url: `https://${host}`, tried, platformStatus, platformBody };
  }
  return { tried, platformStatus, platformBody };
}

/* ---------- Edge Function vantage ---------- */

export const PROBE_FN_SLUG = "rr-probe";
/** Calls each target N times from wherever the function runs and reports what answered. */
export const PROBE_FN_SRC = `
Deno.serve(async (req) => {
  const { targets, n, anon } = await req.json();
  const out = [];
  for (const t of targets) {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try {
        const r = await fetch(t.url + "/rest/v1/rpc/rr_whoami", { headers: { apikey: anon, Authorization: "Bearer " + anon } });
        const body = await r.json();
        samples.push({ ms: performance.now() - t0, status: r.status, in_recovery: body.in_recovery, pm: body.pm });
      } catch (e) {
        samples.push({ ms: performance.now() - t0, status: 0, err: String(e).slice(0, 120) });
      }
    }
    out.push({ name: t.name, samples });
  }
  return Response.json({ region: Deno.env.get("SB_REGION") ?? null, out });
});
`;

export async function deployProbeFn(ctx: Ctx, ref: string): Promise<{ status: number; text: string }> {
  const form = new FormData();
  form.append("file", new Blob([PROBE_FN_SRC]), "index.ts");
  form.append("metadata", JSON.stringify({ name: PROBE_FN_SLUG, entrypoint_path: "index.ts", verify_jwt: false }));
  const res = await fetch(`${mgmtBase(ctx)}/projects/${ref}/functions/deploy?slug=${PROBE_FN_SLUG}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.pat}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  return { status: res.status, text: (await res.text()).slice(0, 300) };
}

export interface FnVantage {
  requested: string;
  status: number;
  servedRegion: string;
  reportedRegion: string;
  targets: Record<string, { n: number; p50: number; tally: Record<string, number>; first: number }>;
  err?: string;
}

export async function invokeProbeFn(
  ref: string,
  anon: string,
  region: string,
  targets: { name: string; url: string }[],
  n: number,
): Promise<FnVantage> {
  const out: FnVantage = { requested: region, status: 0, servedRegion: "", reportedRegion: "", targets: {} };
  try {
    const res = await fetch(`https://${ref}.supabase.co/functions/v1/${PROBE_FN_SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${anon}`, "x-region": region },
      body: JSON.stringify({ targets, n, anon }),
      signal: AbortSignal.timeout(120_000),
    });
    out.status = res.status;
    out.servedRegion = res.headers.get("x-sb-edge-region") ?? "";
    const text = await res.text();
    const j = JSON.parse(text) as {
      region?: string;
      out?: { name: string; samples: { ms: number; status: number; in_recovery?: boolean; pm?: number }[] }[];
    };
    out.reportedRegion = j.region ?? "";
    for (const t of j.out ?? []) {
      const ok = t.samples.filter((s) => s.status === 200);
      const tl: Record<string, number> = {};
      for (const s of t.samples) {
        const k = s.status === 200 ? `${s.in_recovery ? "replica" : "primary"}@pm${s.pm}` : `HTTP ${s.status}`;
        tl[k] = (tl[k] ?? 0) + 1;
      }
      out.targets[t.name] = {
        n: t.samples.length,
        p50: round(pct(ok.slice(1).map((s) => s.ms), 50)),
        first: round(t.samples[0]?.ms ?? NaN),
        tally: tl,
      };
    }
  } catch (e) {
    out.err = errText(e);
  }
  return out;
}
