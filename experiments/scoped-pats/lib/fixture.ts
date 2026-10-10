/**
 * Throwaway project for the modules that need one. The modules prefer an
 * operator-supplied ref (`ctx.peers.fixture`) because a project-scoped token
 * can only be created against a project that already exists; when none is
 * supplied they provision one in the Pro org and delete it in `finally`.
 */
import type { Ctx } from "../../../harness/src/types.js";
import { call, sleep } from "./http.js";

export const NAME_PREFIX = process.env.PVLAB_SP_NAME_PREFIX ?? "sp-";

export async function createProject(
  ctx: Ctx,
  org: string,
  tag: string,
  token = ctx.pat ?? "",
): Promise<{ ref: string; status: number; text: string; ms: number }> {
  const t0 = Date.now();
  const r = await call(token, "POST", "/projects", {
    organization_slug: org,
    name: `${NAME_PREFIX}${tag}-${t0}`,
    db_pass: `${crypto.randomUUID()}Aa1!`,
    region_selection: { type: "smartGroup", code: "apac" },
  });
  const ref = (r.json as { ref?: string } | undefined)?.ref ?? "";
  return { ref, status: r.status, text: r.text, ms: Date.now() - t0 };
}

export async function waitHealthy(ctx: Ctx, ref: string, maxIters = 60): Promise<string> {
  let status = "";
  for (let i = 0; i < maxIters && status !== "ACTIVE_HEALTHY"; i++) {
    const p = await call(ctx.pat ?? "", "GET", `/projects/${ref}`);
    status = (p.json as { status?: string } | undefined)?.status ?? "";
    if (status !== "ACTIVE_HEALTHY") await sleep(10_000);
  }
  return status;
}

export async function deleteProject(ctx: Ctx, ref: string): Promise<number> {
  return (await call(ctx.pat ?? "", "DELETE", `/projects/${ref}`)).status;
}

export interface Skip {
  skip: string;
}

/**
 * Run `fn` against a fixture ref. A supplied `peers.fixture` is used as is and
 * never deleted; otherwise one is created in the Pro org and removed after.
 */
export async function withFixture<T>(
  ctx: Ctx,
  fn: (ref: string, provisioned: boolean) => Promise<T>,
): Promise<T | Skip> {
  if (ctx.peers.fixture) return fn(ctx.peers.fixture, false);
  const org = ctx.orgs.pro ?? "";
  if (!org) return { skip: "neither PVLAB_PEER_FIXTURE nor PVLAB_ORG_PRO set" };
  const c = await createProject(ctx, org, "fixture");
  if (!c.ref) return { skip: `fixture create HTTP ${c.status}` };
  try {
    const st = await waitHealthy(ctx, c.ref);
    if (st !== "ACTIVE_HEALTHY") return { skip: `fixture status ${st || "unknown"} after wait` };
    return await fn(c.ref, true);
  } finally {
    await deleteProject(ctx, c.ref).catch(() => 0);
  }
}

export const isSkip = (x: unknown): x is Skip =>
  typeof x === "object" && x !== null && "skip" in (x as Record<string, unknown>);
