/**
 * Shared plumbing for the observability-surface modules: a self-provisioned
 * throwaway project on the Pro org (named `ob-surface-...`), its keys, and a few
 * helpers around the logs endpoint. Every module that calls `makeProject`
 * deletes the project in its own `finally` through `dropProject`.
 */
import { mkdirSync } from "node:fs";
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, logsQuery, sql as platformSql } from "../../../harness/src/platform";
import type { Ctx } from "../../../harness/src/types";

export const NAME_PREFIX = "ob-surface-";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ObProject {
  ctx: Ctx;
  ref: string;
  name: string;
  createdAt: number;
  healthyMs: number;
  dbPass: string;
}

/** Retry a Management call through 429 / interstitial, honouring a 15 s floor. */
export async function mgmtPatient(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
  tries = 6,
): Promise<Awaited<ReturnType<typeof mgmt>>> {
  let r = await mgmt(ctx, method, path, body);
  for (let i = 0; i < tries && (r.status === 429 || r.throttled); i++) {
    await sleep(15_000);
    r = await mgmt(ctx, method, path, body);
  }
  return r;
}

/**
 * Development hook: `OB_DEV_STATE=<file>` (JSON with ref, anon, service,
 * dbPass) reuses a project made earlier instead of provisioning, and
 * `dropProject` then leaves it alone. Runs that produce evidence do not set it.
 */
async function devProject(ctx: Ctx): Promise<ObProject | null> {
  const f = process.env.OB_DEV_STATE;
  if (!f) return null;
  const st = JSON.parse(await Bun.file(f).text()) as { ref: string; name: string; anon: string; service: string; dbPass: string };
  const child: Ctx = { ...ctx, ref: st.ref, apiHost: `${st.ref}.supabase.co`, dbPassword: st.dbPass, anonKey: st.anon, serviceKey: st.service, region: "ap-southeast-1" };
  return { ctx: child, ref: st.ref, name: st.name, createdAt: Date.now(), healthyMs: 0, dbPass: st.dbPass };
}

export async function makeProject(ctx: Ctx, tag: string): Promise<ObProject> {
  const dev = await devProject(ctx);
  if (dev) return dev;
  const org = ctx.orgs.pro;
  if (!org) throw new Error("PVLAB_ORG_PRO not set");
  const t0 = Date.now();
  const name = `${NAME_PREFIX}${tag}-${t0.toString(36)}`;
  const dbPass = `${crypto.randomUUID()}Aa1!`;
  const create = await mgmtPatient(ctx, "POST", "/projects", {
    organization_slug: org,
    name,
    db_pass: dbPass,
    region: "ap-southeast-1",
  });
  const ref = (create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "";
  if (create.status !== 201 || !ref) throw new Error(`create HTTP ${create.status}: ${create.text.slice(0, 300)}`);
  const child: Ctx = {
    ...ctx,
    ref,
    apiHost: `${ref}.supabase.co`,
    dbPassword: dbPass,
    region: "ap-southeast-1",
  };
  const proj: ObProject = { ctx: child, ref, name, createdAt: t0, healthyMs: -1, dbPass };
  try {
    const deadline = Date.now() + 12 * 60_000;
    let status = "";
    while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
      await sleep(10_000);
      const g = await mgmt(ctx, "GET", `/projects/${ref}`);
      status = String((g.json as { status?: string } | undefined)?.status ?? "");
    }
    if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);
    proj.healthyMs = Date.now() - t0;
    const keys = await fetchKeys(child);
    child.anonKey = keys.anon;
    child.serviceKey = keys.service;
    // ACTIVE_HEALTHY is not readiness: the first SQL races it.
    for (let i = 0; i < 12; i++) {
      const r = await platformSql(child, "select 1");
      if (r.status < 300) break;
      await sleep(5_000);
    }
  } catch (e) {
    await dropProject(ctx, ref);
    throw e;
  }
  return proj;
}

export async function dropProject(ctx: Ctx, ref: string): Promise<number> {
  if (!ref || process.env.OB_DEV_STATE) return 0;
  let status = 0;
  for (let i = 0; i < 6; i++) {
    const r = await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => ({ status: 0 }) as { status: number });
    status = r.status;
    if (status < 300 || status === 404) return status;
    await sleep(status === 429 ? 15_000 : 3_000);
  }
  return status;
}

/** Logs endpoint, ClickHouse dialect over the unified `logs` table. */
export const logs = (ctx: Ctx, q: string, hours = 3) => logsQuery(ctx, q, hours);
export { platformSql as sql };

export const HEALTH_LINTS = [
  "log_data_api_error_rate_high",
  "log_auth_error_rate_high",
  "log_storage_error_rate_high",
  "log_edge_function_error_rate_high",
] as const;

export interface Lint {
  name: string;
  title?: string;
  level?: string;
  detail?: string;
  description?: string;
  cache_key?: string;
  observed_at?: string;
  categories?: string[];
}

/**
 * `POST /v2/projects/{ref}/advisors/run` (the v2 prefix lives outside
 * `mgmtBase`, which ends in /v1). An empty `lints` array means every named
 * check ran and found nothing, per the changelog.
 */
export async function runAdvisors(
  ctx: Ctx,
  names: readonly string[] = HEALTH_LINTS,
): Promise<{ status: number; lints: Lint[]; raw: string; retryAfter: string }> {
  const base = (process.env.SUPABASE_MGMT_BASE_URL ?? "https://api.supabase.com/v1").replace(/\/v1$/, "");
  const res = await fetch(`${base}/v2/projects/${ctx.ref}/advisors/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: { type: "project_advisors", attributes: { lints: names.map((name) => ({ name })) } } }),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  let lints: Lint[] = [];
  try {
    lints = (JSON.parse(raw) as { data?: { attributes?: { lints?: Lint[] } } }).data?.attributes?.lints ?? [];
  } catch {
    /* interstitial or non-JSON */
  }
  return { status: res.status, lints, raw, retryAfter: res.headers.get("retry-after") ?? "" };
}

/** Percentile over a numeric sample (nearest rank). */
export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Raw captures (poll logs, drain batches) go to `evidence/<stamp>/` inside this
 * experiment. It is gitignored: captures carry project refs and client
 * addresses, so only redacted figures reach the RUNLOG.
 */
export function evidencePath(file: string): string {
  const stamp = process.env.OB_STAMP ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = `${import.meta.dir}/../evidence/${stamp}`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/${file}`;
}
