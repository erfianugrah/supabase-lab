/**
 * Self-provisioned throwaway project for security-lockdown modules that need a
 * fresh Pro-org Micro of their own (S23). Every other S-module runs against the
 * tofu-managed project in PVLAB_REF; this one creates, measures and deletes in
 * one process, so no tofu state is involved.
 *
 * Adapted from partitioned-tenancy/lib/project.ts (same create / ready /
 * teardown sequence), kept local so this experiment does not import from a
 * sibling.
 */
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

export const REGION = "ap-southeast-1";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Project {
  ref: string;
  host: string;
  dbPass: string;
  anon: string;
  service: string;
  pgVersion: string;
  poolerHost: string;
  poolerUser: string;
  createS: number;
}

/** Create a Micro in the Pro org and wait until the query endpoint answers. `onRef` fires before any wait. */
export async function createProject(ctx: Ctx, namePrefix: string, onRef: (ref: string) => void): Promise<Project> {
  const org = ctx.orgs.pro ?? "";
  if (!org) throw new Error("PVLAB_ORG_PRO not set");
  const t0 = Date.now();
  const dbPass = `${crypto.randomUUID().replaceAll("-", "")}Aa1!`;
  const res = await mgmt(ctx, "POST", "/projects", { organization_slug: org, name: `${namePrefix}${t0}`, db_pass: dbPass, region: REGION });
  const ref = ((res.json as { ref?: string; id?: string } | undefined)?.ref ?? "") as string;
  if (res.status !== 201 || !ref) throw new Error(`create project: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  onRef(ref);

  let status = "";
  for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
    if (i > 0) await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = ((p.json as { status?: string } | undefined)?.status ?? "") as string;
  }
  if (status !== "ACTIVE_HEALTHY") throw Object.assign(new Error(`project not healthy: ${status}`), { ref });

  // ACTIVE_HEALTHY is not readiness: retry the first query.
  let version = "";
  for (let i = 0; i < 24 && !version; i++) {
    const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query: "select version() as v" }, 60_000);
    version = Array.isArray(r.json) ? String((r.json[0] as { v?: string } | undefined)?.v ?? "") : "";
    if (!version) await sleep(5_000);
  }
  if (!version) throw new Error("database never answered the management query");

  const k = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const rows = (Array.isArray(k.json) ? k.json : []) as { name: string; api_key?: string }[];
  const anon = rows.find((x) => x.name === "anon")?.api_key ?? "";
  const service = rows.find((x) => x.name === "service_role")?.api_key ?? "";
  if (!anon || !service) throw new Error("legacy anon/service_role keys absent");

  const pool = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`);
  const p0 = (Array.isArray(pool.json) ? pool.json[0] : undefined) as { db_host?: string; db_user?: string } | undefined;
  return {
    ref,
    host: `${ref}.supabase.co`,
    dbPass,
    anon,
    service,
    pgVersion: version.split(" on ")[0] ?? version,
    poolerHost: p0?.db_host ?? `aws-0-${REGION}.pooler.supabase.com`,
    poolerUser: p0?.db_user ?? `postgres.${ref}`,
    createS: Math.round((Date.now() - t0) / 1000),
  };
}

/** Delete the project and wait until GET /projects stops listing it (the per-ref GET status is not reliable, run 6). */
export async function deleteProject(ctx: Ctx, ref: string): Promise<{ deleteStatus: number; goneS: number }> {
  const del = await mgmt(ctx, "DELETE", `/projects/${ref}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    const l = await mgmt(ctx, "GET", "/projects");
    const arr = (Array.isArray(l.json) ? l.json : []) as { id?: string; ref?: string }[];
    if (l.status === 200 && !arr.some((x) => (x.ref ?? x.id) === ref)) return { deleteStatus: del.status, goneS: Math.round((Date.now() - t0) / 1000) };
    await sleep(10_000);
  }
  return { deleteStatus: del.status, goneS: -1 };
}
