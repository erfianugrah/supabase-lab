/**
 * One throwaway Micro project shared by PC01..PC04 within a single pvlab
 * process, created on first use and deleted by PC09 (the last id, so it runs
 * last) - or by `make sweep` if the process died. Self-provisioned through the
 * Management API, no OpenTofu state, same pattern as bu-attribution.
 *
 * The pooler surface is READ from /config/database/pooler, not constructed.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestResult } from "../../../harness/src/types";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240);

export interface PoolerEntry {
  database_type: "PRIMARY" | "READ_REPLICA";
  db_user: string;
  db_host: string;
  db_port: number;
  default_pool_size: number | null;
  max_client_conn: number | null;
  pool_mode?: string;
}

export interface PcProject {
  ref: string;
  password: string;
  name: string;
  region: string;
  createdAt: number;
  healthyMs: number;
  instanceSize: string;
  /** Supavisor host from the pooler config, e.g. aws-1-<region>.pooler.supabase.com */
  poolerHost: string;
  poolerUser: string;
  poolerEntry: PoolerEntry;
  /** Context with ref/db fields filled in, for harness helpers that read ctx.ref. */
  ctx: Ctx;
}

let cached: Promise<PcProject> | null = null;

export const REGION = process.env.PVLAB_PC_REGION ?? "ap-southeast-1";
export const PREFIX = process.env.PVLAB_PC_PREFIX ?? "pc-checkout-";

async function createAndWait(ctx: Ctx): Promise<PcProject> {
  const org = ctx.orgs.pro ?? "";
  if (!org) throw new Error("PVLAB_ORG_PRO not set");
  const t0 = Date.now();
  const password = `${crypto.randomUUID()}Aa1!`;
  const name = `${PREFIX}${t0}`;
  const create = await mgmt(ctx, "POST", "/projects", {
    organization_slug: org,
    name,
    db_pass: password,
    region: REGION,
    desired_instance_size: "micro",
  });
  const ref = ((create.json as { ref?: string; id?: string } | undefined)?.ref ?? "") as string;
  if (create.status !== 201 || !ref) throw new Error(`create: HTTP ${create.status}: ${create.text.slice(0, 300)}`);
  ctx.log(`project created (${name})`);
  let status = "";
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = (p.json as { status?: string } | undefined)?.status ?? "";
  }
  if (status !== "ACTIVE_HEALTHY") {
    await mgmt(ctx, "DELETE", `/projects/${ref}`);
    throw new Error(`project never healthy (last status ${status}); deleted`);
  }
  return await describe(ctx, ref, password, name, t0, Date.now() - t0);
}

async function describe(ctx: Ctx, ref: string, password: string, name: string, t0: number, healthyMs: number): Promise<PcProject> {
  const sub: Ctx = { ...ctx, ref, phzHost: `db.${ref}.supabase.co`, dbPassword: password };

  let poolerEntry: PoolerEntry | undefined;
  for (let i = 0; i < 30 && !poolerEntry; i++) {
    const r = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`);
    const arr = Array.isArray(r.json) ? (r.json as PoolerEntry[]) : [];
    poolerEntry = arr.find((e) => e.database_type === "PRIMARY");
    if (!poolerEntry) await sleep(10_000);
  }
  if (!poolerEntry) throw new Error("no PRIMARY pooler entry in /config/database/pooler");

  const sizeRes = await mgmt(ctx, "GET", `/projects/${ref}/billing/addons`);
  const sel = ((sizeRes.json as { selected_addons?: { type: string; variant?: { id?: string } }[] } | undefined)?.selected_addons ?? []).find(
    (a) => a.type === "compute_instance",
  );
  return {
    ref,
    password,
    name,
    region: REGION,
    createdAt: t0,
    healthyMs,
    instanceSize: sel?.variant?.id ?? "unknown",
    poolerHost: poolerEntry.db_host,
    poolerUser: poolerEntry.db_user,
    poolerEntry,
    ctx: sub,
  };
}

/**
 * Development aid: PVLAB_PC_ADOPT=<json file with {ref, pw}> reuses a project
 * created earlier instead of provisioning one. An adopted project is never
 * deleted by PC09 - the caller owns it.
 */
let adopted = false;
async function adopt(ctx: Ctx, file: string): Promise<PcProject> {
  const j = JSON.parse(await Bun.file(file).text()) as { ref: string; pw: string };
  adopted = true;
  return await describe(ctx, j.ref, j.pw, "adopted", Date.now(), 0);
}

export function acquireProject(ctx: Ctx): Promise<PcProject> {
  const a = process.env.PVLAB_PC_ADOPT;
  cached ??= a ? adopt(ctx, a) : createAndWait(ctx);
  return cached;
}

/** Delete if one was created in this process. Safe to call when none was. */
export async function releaseProject(ctx: Ctx): Promise<{ deleted: boolean; status: number; ref?: string }> {
  if (!cached) return { deleted: false, status: 0 };
  const p = await cached.catch(() => null);
  cached = null;
  if (!p) return { deleted: false, status: 0 };
  if (adopted) return { deleted: false, status: 0, ref: p.ref };
  const r = await mgmt(ctx, "DELETE", `/projects/${p.ref}`);
  return { deleted: r.status < 300, status: r.status, ref: p.ref };
}

/**
 * Host sleep detector. On macOS the monotonic clock behind performance.now()
 * and setTimeout does not advance while the machine sleeps, Date.now() does.
 * A first run of this experiment (2026-10-10) had the laptop idle-sleep in the
 * middle of a 100 s deadline: the timer fired 242 s of wall time later. The
 * difference between the two clocks over a module's lifetime is the stall.
 */
export function stallGuard(id: string) {
  const w0 = Date.now();
  const m0 = performance.now();
  return {
    result(): TestResult {
      const s = Math.round(Date.now() - w0 - (performance.now() - m0));
      return {
        id: `${id}-clock`,
        title: `${id}: host clock check (wall clock minus monotonic clock over the module)`,
        status: s < 2000 ? "pass" : "fail",
        detail: s < 2000 ? `no host sleep detected (${s} ms drift)` : `HOST STALLED ${s} ms (machine slept): timings in ${id} are void`,
        measurements: { wall_minus_monotonic_ms: s },
      };
    },
  };
}
